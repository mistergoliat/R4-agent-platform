import { z } from 'zod';
import { fingerprint } from '@r4/evaluation';

/**
 * WorkloadCase (R4-H): one conversation / trajectory to run in shadow, as
 * data. It is agent-neutral: it says what arrives (inputs, time passing,
 * faults of external owners, operator actions, process restarts) and which
 * properties must hold, never which tool sequence the agent must follow.
 *
 * Sources: `synthetic` (written for the suite), `curated` (written to read
 * like real traffic), `regression-derived` (from a reviewed RegressionCase
 * or an earlier acceptance scenario) and `replay` (an imported real
 * conversation — accepted only when sanitized). A case is identified by
 * `id@version` plus a content fingerprint: changing what a case says
 * without a new version is detectable.
 */
export const WORKLOAD_CASE_SCHEMA_VERSION = 'r4.workload_case.v1';
export const WORKLOAD_SOURCE_TYPES = ['synthetic', 'curated', 'regression-derived', 'replay'] as const;
export type WorkloadSourceType = (typeof WORKLOAD_SOURCE_TYPES)[number];

export const OPERATOR_ACTIONS = ['answer_consultation', 'approve', 'reject', 'takeover', 'release', 'cancel'] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

const code = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

export const workloadEventSchema = z.discriminatedUnion('kind', [
  /** A message from the person on the other side, delivered through the canonical ingress. */
  z.strictObject({ kind: z.literal('input'), text: z.string().trim().min(1).max(4000) }),
  /**
   * Time passes. `process` moves the process clock (freshness); `process_and_temporal`
   * also moves the durable temporal clock of the (throwaway) shadow database.
   */
  z.strictObject({ kind: z.literal('advance_time'), ms: z.int().positive(), scope: z.enum(['process', 'process_and_temporal']), note: z.string().max(200).optional() }),
  /**
   * A platform process changes: the worker is replaced (only durable state
   * survives), or the scheduler stops / starts (time-driven work waits meanwhile).
   */
  z.strictObject({ kind: z.literal('process'), process: z.enum(['worker', 'scheduler']), action: z.enum(['restart', 'stop', 'start']) }),
  /** A controlled fault of an external owner (`target` is a domain binding) or of the model provider (`target` = `model`). Interpreted by the pack's bindings. */
  z.strictObject({ kind: z.literal('fault'), target: code, fault: code, note: z.string().max(200).optional() }),
  /** A trusted operator acts on the task (simulated, controlled actor; no operator UI). */
  z.strictObject({ kind: z.literal('operator'), action: z.enum(OPERATOR_ACTIONS), text: z.string().trim().min(1).max(2000) }),
  /** An owner changes its own data (e.g. a record's value), as a real owner might between two reads. */
  z.strictObject({ kind: z.literal('owner_change'), target: code, change: code, params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
]);
export type WorkloadEvent = z.infer<typeof workloadEventSchema>;

/**
 * An expected property. `safety` properties are production blockers when
 * violated; `technical` ones are platform correctness; `behavioral` ones are
 * expectations about the agent, reported (and evaluated by R4-G), never a
 * pass/fail gate of the suite. `kind` is interpreted by the pack, except the
 * generic shadow safety properties, which every run gets automatically.
 */
export const workloadInvariantSchema = z.strictObject({
  kind: code,
  class: z.enum(['safety', 'technical', 'behavioral']),
  params: z.record(z.string(), z.json()).default({}),
});
export type WorkloadInvariant = z.infer<typeof workloadInvariantSchema>;

export const workloadPrivacySchema = z.strictObject({
  /** `synthetic`: invented data only. `sanitized_real`: derived from a real conversation after redaction. */
  classification: z.enum(['synthetic', 'sanitized_real']),
  sanitized: z.boolean(),
  /** Kinds of data redacted (for a replay), with counts. */
  redactions: z.record(z.string(), z.int().nonnegative()).default({}),
  /** Identity data the case uses (fictitious for synthetic cases). */
  note: z.string().max(300).optional(),
});

export const workloadCaseSchema = z
  .strictObject({
    schemaVersion: z.literal(WORKLOAD_CASE_SCHEMA_VERSION),
    id: z.string().regex(/^[A-Z][A-Z0-9-]{1,31}$/),
    version: z.int().positive(),
    title: z.string().min(1).max(160),
    sourceType: z.enum(WORKLOAD_SOURCE_TYPES),
    source: z.strictObject({ ref: z.string().min(1).max(200), derivedFrom: z.array(z.string().max(64)).default([]) }),
    /** Who the conversation is with, as the ingress would bind it (a pseudonymous / fixture reference, or null = anonymous). */
    initialContext: z.strictObject({
      subjectRef: z.string().max(128).nullable(),
      channelRef: z.string().min(1).max(64).default('shadow'),
      /** Pack-level profile names the case needs (e.g. a policy profile); recorded, never secret. */
      profiles: z.record(z.string(), z.string()).default({}),
    }),
    events: z.array(workloadEventSchema).min(1),
    expectations: z.strictObject({
      invariants: z.array(workloadInvariantSchema).default([]),
      /** Legitimate final technical states (R4-G TaskOutcome.technical.status). Waiting for input is legitimate. */
      acceptableStops: z.array(z.string()).min(1),
      /** Free-text constraints the conversation carries (for humans reading the corpus). */
      constraints: z.array(z.string().max(300)).default([]),
    }),
    privacy: workloadPrivacySchema,
    tags: z.array(z.string().regex(/^[a-z][a-z0-9:_-]{0,47}$/)).default([]),
  })
  .refine((c) => c.events.some((e) => e.kind === 'input'), { message: 'a workload has at least one input', path: ['events'] })
  .refine((c) => c.sourceType !== 'replay' || (c.privacy.sanitized && c.privacy.classification === 'sanitized_real'), { message: 'a replayed conversation must be sanitized before it becomes a workload', path: ['privacy'] });
export type WorkloadCase = z.infer<typeof workloadCaseSchema>;
export type WorkloadCaseInput = z.input<typeof workloadCaseSchema>;

export function parseWorkloadCase(value: unknown): WorkloadCase {
  const parsed = workloadCaseSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid WorkloadCase: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Content fingerprint of what a case asserts (everything but its title). */
export function workloadFingerprint(workload: WorkloadCase): string {
  const { title: _title, ...content } = workload;
  return fingerprint(content);
}

export interface WorkloadCorpus {
  readonly id: string;
  readonly version: number;
  readonly cases: readonly WorkloadCase[];
}

/** Validates a corpus: unique ids, parsed cases, and a lock of id@version → fingerprint when given. */
export function assertWorkloadCorpus(corpus: WorkloadCorpus, lock?: Readonly<Record<string, string>>): { fingerprint: string; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of corpus.cases) {
    parseWorkloadCase(c);
    if (seen.has(c.id)) problems.push(`duplicate case id ${c.id}`);
    seen.add(c.id);
    if (lock) {
      const key = `${c.id}@${c.version}`;
      const locked = lock[key];
      const actual = workloadFingerprint(c);
      if (locked === undefined) problems.push(`case ${key} is not in the corpus lock`);
      else if (locked !== actual) problems.push(`case ${key} changed without a new version (lock ${locked.slice(0, 12)}…, now ${actual.slice(0, 12)}…)`);
    }
  }
  if (lock) for (const key of Object.keys(lock)) if (!corpus.cases.some((c) => `${c.id}@${c.version}` === key)) problems.push(`lock entry ${key} has no case`);
  return { fingerprint: fingerprint({ id: corpus.id, version: corpus.version, cases: corpus.cases.map((c) => [c.id, c.version, workloadFingerprint(c)]) }), problems };
}

/**
 * A real conversation as an importer receives it, before sanitization. It
 * never becomes a WorkloadCase — or reaches Git or an artifact — unredacted.
 */
export interface RawConversation {
  readonly ref: string;
  readonly turns: readonly { readonly from: 'person' | 'agent'; readonly text: string; readonly at?: string }[];
  /** Names and free-text identifiers known from the source record (redacted exactly). */
  readonly knownIdentifiers: readonly string[];
}
