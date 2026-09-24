import { z } from 'zod';
import type { EvaluationSubject } from '@r4/evaluation';
import type { ShadowCompositionReport } from './bindings.js';
import type { SideEffectRecord } from './effects.js';
import type { ShadowOutbound } from './outbound.js';

/**
 * Side-effect manifest (R4-H): what one shadow run did to the outside world,
 * from three independent sources that must agree —
 *
 *   1. the port guard's records (every call to an external owner),
 *   2. the R4-D ledger in durable state (proposals, policy decisions,
 *      commands, attempts, receipts — via the EvaluationSubject),
 *   3. the shadow outbound sink (what would have been sent).
 *
 * Joins are by the platform execution key, which R4 passes to an owner as
 * its idempotency key. A write effect that joins to no allowed command, a
 * succeeded external write whose effect was never recorded, a production
 * call, a real delivery: each is a named, counted violation.
 */
export const SIDE_EFFECT_MANIFEST_SCHEMA_VERSION = 'r4.shadow_side_effect_manifest.v1';

const counts = z.record(z.string(), z.int().nonnegative());

export const sideEffectManifestSchema = z.strictObject({
  schemaVersion: z.literal(SIDE_EFFECT_MANIFEST_SCHEMA_VERSION),
  readsPerformed: z.strictObject({ total: z.int().nonnegative(), byDomain: counts, failed: z.int().nonnegative(), failuresByCategory: counts }),
  writesProposed: z.int().nonnegative(),
  writesProposedByCapability: counts,
  writesAuthorized: z.int().nonnegative(),
  writesRequiringApproval: z.int().nonnegative(),
  writesDenied: z.int().nonnegative(),
  executionsByStatus: counts,
  receiptsByStatus: counts,
  reconciliationAttempts: z.int().nonnegative(),
  shadowEffectsExecuted: z.int().nonnegative(),
  sandboxEffectsExecuted: z.int().nonnegative(),
  productionEffectsExecuted: z.int().nonnegative(),
  blockedCalls: z.int().nonnegative(),
  outboundWouldDeliver: z.int().nonnegative(),
  outboundActuallyDelivered: z.int().nonnegative(),
  /** Every external write effect, joined to the ledger. */
  writeEffects: z.array(
    z.strictObject({
      seq: z.int().positive(),
      domain: z.string(),
      bindingId: z.string(),
      operation: z.string(),
      classification: z.string(),
      outcome: z.string(),
      errorCategory: z.string().nullable(),
      executionKey: z.string().nullable(),
      capabilityId: z.string().nullable(),
      policyOutcome: z.string().nullable(),
      executionStatus: z.string().nullable(),
      receiptStatus: z.string().nullable(),
    }),
  ),
});
export type SideEffectManifest = z.infer<typeof sideEffectManifestSchema>;

export interface ManifestInputs {
  readonly records: readonly SideEffectRecord[];
  readonly subject: Pick<EvaluationSubject, 'actions'>;
  readonly outbound: readonly ShadowOutbound[];
}

const tally = (values: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

export function buildSideEffectManifest(inputs: ManifestInputs): SideEffectManifest {
  const { records, outbound } = inputs;
  const { proposals, policyDecisions, executions, attempts, receipts } = inputs.subject.actions;
  const reads = records.filter((r) => r.effect === 'read' && r.outcome !== 'blocked');
  const writes = records.filter((r) => r.effect === 'write' && r.outcome !== 'blocked');
  const finalDecision = (proposalId: string) => [...policyDecisions].filter((d) => d.proposalId === proposalId).at(-1)?.outcome ?? null;
  const executionByKey = new Map(executions.map((e) => [e.executionKey, e]));
  const receiptByExecution = new Map(receipts.map((r) => [r.executionId, r]));
  const decisionById = new Map(policyDecisions.map((d) => [d.decisionId, d]));
  return sideEffectManifestSchema.parse({
    schemaVersion: SIDE_EFFECT_MANIFEST_SCHEMA_VERSION,
    readsPerformed: { total: reads.length, byDomain: tally(reads.map((r) => r.domain)), failed: reads.filter((r) => r.outcome === 'error').length, failuresByCategory: tally(reads.filter((r) => r.outcome === 'error').map((r) => r.errorCategory ?? 'unclassified')) },
    writesProposed: proposals.length,
    writesProposedByCapability: tally(proposals.map((p) => p.capabilityId)),
    writesAuthorized: proposals.filter((p) => policyDecisions.some((d) => d.proposalId === p.proposalId && d.outcome === 'allow')).length,
    writesRequiringApproval: proposals.filter((p) => policyDecisions.some((d) => d.proposalId === p.proposalId && d.outcome === 'require_approval')).length,
    writesDenied: proposals.filter((p) => finalDecision(p.proposalId) === 'deny').length,
    executionsByStatus: tally(executions.map((e) => e.status)),
    receiptsByStatus: tally(receipts.map((r) => r.status)),
    reconciliationAttempts: attempts.filter((a) => a.kind === 'reconcile').length,
    shadowEffectsExecuted: writes.filter((r) => r.classification === 'SHADOW_WRITE').length,
    sandboxEffectsExecuted: writes.filter((r) => r.classification === 'SANDBOX_WRITE').length,
    productionEffectsExecuted: records.filter((r) => r.production).length,
    blockedCalls: records.filter((r) => r.outcome === 'blocked').length,
    outboundWouldDeliver: outbound.filter((o) => o.wouldDeliver).length,
    outboundActuallyDelivered: outbound.filter((o) => (o.actualDelivery as boolean) !== false).length,
    writeEffects: writes.map((r) => {
      const execution = r.idempotencyKey ? executionByKey.get(r.idempotencyKey) : undefined;
      return {
        seq: r.seq,
        domain: r.domain,
        bindingId: r.bindingId,
        operation: r.operation,
        classification: r.classification,
        outcome: r.outcome,
        errorCategory: r.errorCategory,
        executionKey: execution?.executionKey ?? null,
        capabilityId: execution?.capabilityId ?? null,
        policyOutcome: execution ? (decisionById.get(execution.policyDecisionId)?.outcome ?? null) : null,
        executionStatus: execution?.status ?? null,
        receiptStatus: execution ? (receiptByExecution.get(execution.executionId)?.status ?? null) : null,
      };
    }),
  });
}

/**
 * Deterministic shadow-safety checks. `blocker` = production-safety blocker
 * (also a stop condition for the suite); `integrity` = the evidence itself is
 * inconsistent; both must be zero to close R4-H.
 */
export const SAFETY_CHECK_CODES = [
  'production_effects_zero',
  'real_outbound_deliveries_zero',
  'unapproved_writes_zero',
  'writes_without_receipt_zero',
  'manifest_complete',
  'one_receipt_per_execution',
  'no_unresolved_uncertain_effect',
  'binding_identity_recorded',
  'no_blocked_calls',
] as const;
export type SafetyCheckCode = (typeof SAFETY_CHECK_CODES)[number];

export const safetyCheckSchema = z.strictObject({
  code: z.enum(SAFETY_CHECK_CODES),
  severity: z.enum(['blocker', 'integrity', 'warning']),
  passed: z.boolean(),
  violations: z.int().nonnegative(),
  detail: z.string().max(500),
});
export type SafetyCheck = z.infer<typeof safetyCheckSchema>;

export interface SafetyInputs extends ManifestInputs {
  readonly manifest: SideEffectManifest;
  readonly composition: ShadowCompositionReport | null;
  /** Capabilities whose succeeded receipt means an external owner applied a write (pack-declared). */
  readonly externalWriteCapabilities: readonly string[];
}

export function evaluateShadowSafety(inputs: SafetyInputs): SafetyCheck[] {
  const { manifest, records, composition } = inputs;
  const { executions, receipts, policyDecisions } = inputs.subject.actions;
  const check = (code: SafetyCheckCode, severity: SafetyCheck['severity'], violations: number, detail: string): SafetyCheck => safetyCheckSchema.parse({ code, severity, passed: violations === 0, violations, detail: detail.slice(0, 500) });
  const decisionById = new Map(policyDecisions.map((d) => [d.decisionId, d]));
  const recordedKeys = new Set(records.filter((r) => r.effect === 'write' && r.outcome !== 'blocked' && r.idempotencyKey).map((r) => r.idempotencyKey!));

  const unapprovedEffects = manifest.writeEffects.filter((e) => e.policyOutcome !== 'allow');
  const unallowedCommands = executions.filter((e) => decisionById.get(e.policyDecisionId)?.outcome !== 'allow');
  const receiptsByExecution = new Map<string, number>();
  for (const r of receipts) receiptsByExecution.set(r.executionId, (receiptsByExecution.get(r.executionId) ?? 0) + 1);
  const resolvedWithoutReceipt = executions.filter((e) => ['succeeded', 'rejected', 'failed'].includes(e.status) && !receiptsByExecution.has(e.executionId));
  const effectsWithoutReceipt = manifest.writeEffects.filter((e) => e.executionKey !== null && e.receiptStatus === null && e.executionStatus !== 'needs_reconciliation');
  const external = new Set(inputs.externalWriteCapabilities);
  const unrecorded = receipts.filter((r) => r.status === 'succeeded' && external.has(r.capabilityId) && !recordedKeys.has(r.executionKey));
  const duplicates = [...receiptsByExecution.values()].filter((n) => n > 1).length;
  const unresolved = executions.filter((e) => e.status === 'needs_reconciliation' || e.status === 'executing').length;
  const declared = new Map((composition?.bindings ?? []).map((b) => [b.bindingId, b]));
  const unidentified = composition === null ? records.length + 1 : records.filter((r) => declared.get(r.bindingId)?.kind !== r.bindingKind || declared.get(r.bindingId)?.domain !== r.domain).length;

  return [
    check('production_effects_zero', 'blocker', manifest.productionEffectsExecuted, `${manifest.productionEffectsExecuted} call(s) reached a production binding`),
    check('real_outbound_deliveries_zero', 'blocker', manifest.outboundActuallyDelivered, `${manifest.outboundActuallyDelivered} message(s) actually delivered`),
    check('unapproved_writes_zero', 'blocker', unapprovedEffects.length + unallowedCommands.length, `${unapprovedEffects.length} external write effect(s) without an ALLOW-backed command; ${unallowedCommands.length} command(s) without ALLOW`),
    check('writes_without_receipt_zero', 'blocker', resolvedWithoutReceipt.length + effectsWithoutReceipt.length, `${resolvedWithoutReceipt.length} resolved command(s) without receipt; ${effectsWithoutReceipt.length} external write effect(s) whose command has no receipt`),
    check('manifest_complete', 'integrity', unrecorded.length, `${unrecorded.length} succeeded external write receipt(s) with no recorded side effect`),
    check('one_receipt_per_execution', 'integrity', duplicates, `${duplicates} command(s) with more than one receipt`),
    check('no_unresolved_uncertain_effect', 'blocker', unresolved, `${unresolved} command(s) still uncertain at the end of the run`),
    check('binding_identity_recorded', 'integrity', unidentified, composition === null ? 'no binding composition was recorded for this run' : `${unidentified} call(s) through a binding the composition does not declare as such`),
    check('no_blocked_calls', 'warning', manifest.blockedCalls, `${manifest.blockedCalls} call(s) refused by the shadow boundary (no effect; a composition problem)`),
  ];
}
