import { z } from 'zod';
import { canonicalJson, modelProfileSchema, sha256Schema, stepsOf, type EvaluationSubject } from '@r4/evaluation';
import { BINDING_KINDS, OUTBOUND_BINDING_KINDS, type ShadowCompositionReport } from './bindings.js';
import type { SideEffectRecord } from './effects.js';
import { safetyCheckSchema, sideEffectManifestSchema } from './manifest.js';
import { SHADOW_SUITE_MODES } from './mode.js';
import type { ShadowModelCall } from './model.js';
import { WORKLOAD_SOURCE_TYPES } from './workload.js';

/**
 * ShadowRun (R4-H): metadata of ONE shadow execution of one WorkloadCase.
 * It does not replace AgentTask — the task, its runs, steps, observations
 * and ledger stay the execution truth in PostgreSQL (and are what R4-G
 * evaluates). A ShadowRun only ties that execution to the conditions it ran
 * under (case version, model profile, domain bindings, policy profile, shadow
 * configuration, code version) and to what it did outside (side-effect
 * manifest, shadow outbound), so it is reproducible and auditable.
 */
export const SHADOW_RUN_SCHEMA_VERSION = 'r4.shadow_run.v1';
export const SHADOW_RUN_STATUSES = ['executed', 'execution_failed', 'not_run_due_to_budget', 'not_run_due_to_stop_condition'] as const;

const counts = z.record(z.string(), z.int().nonnegative());
const values = z.array(z.number());

export const turnTimingSchema = z.strictObject({
  index: z.int().positive(),
  kind: z.enum(['input', 'operator']),
  submittedAt: z.string(),
  wallClockMs: z.int().nonnegative(),
  /** Input received → first `respond` recorded after it (same process clock); null when none. */
  userPerceivedMs: z.int().nonnegative().nullable(),
  runsExecuted: z.int().nonnegative(),
});
export type TurnTiming = z.infer<typeof turnTimingSchema>;

export const operationalMetricsSchema = z.strictObject({
  inputTurns: z.int().nonnegative(),
  operatorActions: z.int().nonnegative(),
  modelCalls: z.strictObject({ total: z.int().nonnegative(), byOutcome: counts, errorsByKind: counts, injected: z.int().nonnegative() }),
  tokens: z.strictObject({ input: z.int().nonnegative(), output: z.int().nonnegative(), reasoning: z.int().nonnegative().nullable(), note: z.string().nullable() }),
  latency: z.strictObject({ modelCallMs: values, domainCallMs: values, domainCallMsByDomain: z.record(z.string(), values), turnWallClockMs: values, userPerceivedMs: values }),
  amplification: z.strictObject({
    modelCallsPerInputTurn: z.number().nullable(),
    inputTokensPerInputTurn: z.number().nullable(),
    capabilityReadsPerInputTurn: z.number().nullable(),
    capabilityReads: z.int().nonnegative(),
    duplicateReads: z.int().nonnegative(),
    refreshReads: z.int().nonnegative(),
    writeProposals: z.int().nonnegative(),
  }),
  context: z.strictObject({ snapshots: z.int().nonnegative(), firstTokens: z.int().nullable(), maxTokens: z.int().nullable(), lastTokens: z.int().nullable(), growthTokens: z.int().nullable(), byKindAtMax: counts }),
  runs: z.strictObject({ total: z.int().nonnegative(), failed: z.int().nonnegative(), recoveries: z.int().nonnegative(), terminationCodes: counts }),
  domain: z.strictObject({ calls: z.int().nonnegative(), errors: z.int().nonnegative(), errorsByCategory: counts, rateLimited: z.int().nonnegative() }),
});
export type OperationalMetrics = z.infer<typeof operationalMetricsSchema>;

/** `exercised: false` — the property only applies if something happened (e.g. the agent proposed a write) and it did not; neither a pass nor a fail. */
export const invariantOutcomeSchema = z.strictObject({ kind: z.string(), class: z.enum(['safety', 'technical', 'behavioral']), exercised: z.boolean(), passed: z.boolean(), detail: z.string().max(500) });
export type InvariantOutcome = z.infer<typeof invariantOutcomeSchema>;

export const eventLogEntrySchema = z.strictObject({ index: z.int().nonnegative(), kind: z.string(), applied: z.boolean(), note: z.string().max(300) });
export type EventLogEntry = z.infer<typeof eventLogEntrySchema>;

const bindingEntry = z.strictObject({ domain: z.string(), bindingId: z.string(), kind: z.enum(BINDING_KINDS), version: z.int().positive(), fingerprint: sha256Schema, label: z.string(), classifications: z.record(z.string(), z.string()), contractRef: z.string().nullable() });

export const shadowRunSchema = z.strictObject({
  schemaVersion: z.literal(SHADOW_RUN_SCHEMA_VERSION),
  shadowRunId: z.string(),
  suiteRunId: z.string(),
  case: z.strictObject({ id: z.string(), version: z.int().positive(), fingerprint: sha256Schema, sourceType: z.enum(WORKLOAD_SOURCE_TYPES), tags: z.array(z.string()) }),
  repetition: z.int().positive(),
  status: z.enum(SHADOW_RUN_STATUSES),
  error: z.string().max(500).nullable(),
  taskId: z.string().nullable(),
  execution: z.strictObject({ mode: z.literal('shadow'), suiteMode: z.enum(SHADOW_SUITE_MODES), declaredBy: z.enum(['environment', 'command']), shadowConfigFingerprint: sha256Schema }),
  reproducibility: z.strictObject({
    gitSha: z.string(),
    gitDirty: z.boolean().nullable(),
    agent: z.strictObject({ agentId: z.string(), version: z.int().positive(), contentHash: z.string().nullable() }),
    protocolVersion: z.string(),
    modelProfile: modelProfileSchema.extend({ fingerprint: sha256Schema }).nullable(),
    corpus: z.strictObject({ id: z.string(), version: z.int().positive(), fingerprint: sha256Schema }),
    evaluationDefinition: z.strictObject({ id: z.string(), version: z.int().positive(), fingerprint: sha256Schema }).nullable(),
  }),
  /** Exactly which domain source each owner used — never "maybe real". Required for any executed run. */
  bindings: z.array(bindingEntry),
  outbound: z.strictObject({ bindingId: z.string(), kind: z.enum(OUTBOUND_BINDING_KINDS), version: z.int().positive(), fingerprint: sha256Schema }).nullable(),
  policyProfile: z.strictObject({ name: z.string(), policyId: z.string(), version: z.int().positive(), hash: z.string() }).nullable(),
  evaluationRunId: z.string().nullable(),
  evaluationLatencyMs: z.int().nonnegative().nullable(),
  sideEffects: sideEffectManifestSchema.nullable(),
  safety: z.array(safetyCheckSchema),
  caseInvariants: z.array(invariantOutcomeSchema),
  events: z.array(eventLogEntrySchema),
  operational: operationalMetricsSchema.nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
}).refine((r) => r.status !== 'executed' || (r.bindings.length > 0 && r.outbound !== null && r.sideEffects !== null && r.safety.length > 0), { message: 'an executed shadow run records its bindings, outbound binding, side-effect manifest and safety checks', path: ['bindings'] });
export type ShadowRun = z.infer<typeof shadowRunSchema>;

export function compositionEntries(report: ShadowCompositionReport): ShadowRun['bindings'] {
  return report.bindings.map((b) => ({ domain: b.domain, bindingId: b.bindingId, kind: b.kind, version: b.version, fingerprint: b.fingerprint, label: `${b.domain}=${b.kind}:${b.bindingId}@${b.version}`, classifications: { ...b.classifications }, contractRef: b.contractRef }));
}

const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);
const tally = (list: readonly string[]) => {
  const out: Record<string, number> = {};
  for (const v of list) out[v] = (out[v] ?? 0) + 1;
  return out;
};

/** Operational metrics of one execution, from durable state (subject) + what the shadow harness measured. */
export function operationalMetrics(input: { subject: EvaluationSubject; modelCalls: readonly ShadowModelCall[]; records: readonly SideEffectRecord[]; turns: readonly TurnTiming[] }): OperationalMetrics {
  const { subject, modelCalls, records, turns } = input;
  const inputTurns = turns.filter((t) => t.kind === 'input').length;
  const steps = stepsOf(subject);
  const observationById = new Map(subject.observations.map((o) => [o.observationId, o]));
  // Duplicate vs refresh: the same capability + arguments read again while the earlier answer was still fresh (duplicate) or after it expired (refresh).
  const lastRead = new Map<string, { validUntil: string | null }>();
  let duplicateReads = 0;
  let refreshReads = 0;
  let capabilityReads = 0;
  for (const s of steps) {
    if (s.decision?.type !== 'read_capability' || s.observationId === null) continue;
    capabilityReads += 1;
    const key = `${s.decision.capabilityId}:${canonicalJson(s.decision.arguments ?? {})}`;
    const prior = lastRead.get(key);
    if (prior) {
      if (prior.validUntil === null || Date.parse(prior.validUntil) > Date.parse(s.createdAt)) duplicateReads += 1;
      else refreshReads += 1;
    }
    lastRead.set(key, { validUntil: observationById.get(s.observationId)?.validUntil ?? null });
  }
  const input_ = subject.runs.reduce((sum, r) => sum + r.usage.inputTokens, 0);
  const output = subject.runs.reduce((sum, r) => sum + r.usage.outputTokens, 0);
  const snapshots = subject.runs.flatMap((r) => {
    const byIteration = new Map<number, (typeof r.contexts)[number]>();
    for (const c of r.contexts) if (!byIteration.has(c.iteration) || byIteration.get(c.iteration)!.attempt < c.attempt) byIteration.set(c.iteration, c);
    return [...byIteration.values()].sort((a, b) => a.iteration - b.iteration);
  });
  const max = snapshots.reduce<(typeof snapshots)[number] | null>((m, s) => (m === null || s.estimatedTokens > m.estimatedTokens ? s : m), null);
  const domainCalls = records.filter((r) => r.outcome !== 'blocked');
  const byDomain: Record<string, number[]> = {};
  for (const r of domainCalls) (byDomain[r.domain] ??= []).push(r.latencyMs);
  const domainErrors = domainCalls.filter((r) => r.outcome === 'error');
  return operationalMetricsSchema.parse({
    inputTurns,
    operatorActions: turns.filter((t) => t.kind === 'operator').length,
    modelCalls: { total: modelCalls.length, byOutcome: tally(modelCalls.map((c) => c.outcome)), errorsByKind: tally(modelCalls.filter((c) => c.errorKind !== null).map((c) => `${c.injected ? 'injected:' : ''}${c.errorKind!}`)), injected: modelCalls.filter((c) => c.injected).length },
    tokens: { input: input_, output, reasoning: null, note: 'reasoning tokens are not exposed through ModelUsage (ADR-025 deferral)' },
    latency: {
      modelCallMs: modelCalls.filter((c) => !c.injected).map((c) => c.latencyMs),
      domainCallMs: domainCalls.map((r) => r.latencyMs),
      domainCallMsByDomain: byDomain,
      turnWallClockMs: turns.map((t) => t.wallClockMs),
      userPerceivedMs: turns.flatMap((t) => (t.kind === 'input' && t.userPerceivedMs !== null ? [t.userPerceivedMs] : [])),
    },
    amplification: {
      modelCallsPerInputTurn: ratio(steps.length, inputTurns),
      inputTokensPerInputTurn: ratio(input_, inputTurns),
      capabilityReadsPerInputTurn: ratio(capabilityReads, inputTurns),
      capabilityReads,
      duplicateReads,
      refreshReads,
      writeProposals: subject.actions.proposals.length,
    },
    context: {
      snapshots: snapshots.length,
      firstTokens: snapshots[0]?.estimatedTokens ?? null,
      maxTokens: max?.estimatedTokens ?? null,
      lastTokens: snapshots.at(-1)?.estimatedTokens ?? null,
      growthTokens: snapshots.length > 0 ? snapshots.at(-1)!.estimatedTokens - snapshots[0]!.estimatedTokens : null,
      byKindAtMax: max ? { ...max.includedTokensByKind } : {},
    },
    runs: { total: subject.runs.length, failed: subject.runs.filter((r) => r.status === 'failed').length, recoveries: subject.runs.reduce((s, r) => s + r.recoveries, 0), terminationCodes: tally(subject.runs.flatMap((r) => (r.termination ? [`${r.termination.reason}:${r.termination.code}`] : []))) },
    domain: { calls: domainCalls.length, errors: domainErrors.length, errorsByCategory: tally(domainErrors.map((r) => r.errorCategory ?? 'unclassified')), rateLimited: domainErrors.filter((r) => r.errorCategory === 'rate_limited').length },
  });
}
