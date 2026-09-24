import { describe, expect, it } from 'vitest';
import type { EvaluationSubject } from '@r4/evaluation';
import {
  SideEffectRecorder,
  assertShadowComposition,
  buildSideEffectManifest,
  evaluateShadowSafety,
  loadShadowExecutionConfig,
  shadowOutboundSchema,
  type SideEffectRecord,
} from '@r4/shadow';
import { SalesFixture } from '@r4-sales/agent/evaluations';
import { SALES_EXTERNAL_WRITE_CAPABILITIES, SALES_SHADOW_BINDINGS, SALES_SHADOW_OUTBOUND } from '@r4-sales/agent/shadow';

const config = loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow' });
const composition = assertShadowComposition(config, SALES_SHADOW_BINDINGS, SALES_SHADOW_OUTBOUND);

/** A finished quote trajectory (R4-G fixture) and the side effects a correct shadow run records for it. */
function quoteRun(): { subject: EvaluationSubject; records: SideEffectRecord[] } {
  const f = new SalesFixture({ id: 'manifest', customerRef: 'cust-demo-001' });
  f.turn('Cotízame la barra olímpica con despacho a Ñuñoa');
  f.customerContext();
  f.productContext('BAR-OLY20');
  f.update([{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }, { op: 'set_delivery_destination', commune: 'Ñuñoa' }]);
  f.quote({ name: 'Camila Rojas', email: 'camila.rojas@example.test' });
  f.respond('Listo');
  f.wait();
  const subject = f.build();
  const key = subject.actions.executions.find((e) => e.capabilityId === 'quote.create')!.executionKey;
  const recorder = new SideEffectRecorder();
  recorder.record({ domain: 'customer', bindingId: 'fixture-customer', bindingKind: 'fixture', operation: 'getContext', effect: 'read', classification: 'READ_ALLOWED', outcome: 'ok', errorCategory: null, latencyMs: 1, idempotencyKey: null, production: false });
  recorder.record({ domain: 'catalog', bindingId: 'fixture-catalog', bindingKind: 'fixture', operation: 'getProduct', effect: 'read', classification: 'READ_ALLOWED', outcome: 'ok', errorCategory: null, latencyMs: 1, idempotencyKey: null, production: false });
  recorder.record({ domain: 'quote', bindingId: 'shadow-quote-owner', bindingKind: 'shadow', operation: 'create', effect: 'write', classification: 'SHADOW_WRITE', outcome: 'ok', errorCategory: null, latencyMs: 2, idempotencyKey: key, production: false });
  return { subject, records: [...recorder.records] };
}

const safety = (subject: EvaluationSubject, records: readonly SideEffectRecord[], outbound = [] as never[]) => {
  const manifest = buildSideEffectManifest({ records, subject, outbound });
  return { manifest, checks: evaluateShadowSafety({ records, subject, outbound, manifest, composition, externalWriteCapabilities: SALES_EXTERNAL_WRITE_CAPABILITIES }) };
};
const failed = (checks: ReturnType<typeof safety>['checks']) => checks.filter((c) => !c.passed).map((c) => c.code);

describe('side-effect manifest', () => {
  it('joins every external write to the governed command that allowed it, by execution key', () => {
    const { subject, records } = quoteRun();
    const { manifest, checks } = safety(subject, records);
    expect(manifest).toMatchObject({ writesProposed: 2, writesAuthorized: 2, writesDenied: 0, shadowEffectsExecuted: 1, productionEffectsExecuted: 0, outboundActuallyDelivered: 0, readsPerformed: { total: 2, byDomain: { customer: 1, catalog: 1 } } });
    expect(manifest.writeEffects).toEqual([expect.objectContaining({ domain: 'quote', operation: 'create', capabilityId: 'quote.create', policyOutcome: 'allow', executionStatus: 'succeeded', receiptStatus: 'succeeded' })]);
    expect(failed(checks)).toEqual([]);
  });
});

describe('deterministic shadow safety', () => {
  it('a production call is a blocker', () => {
    const { subject, records } = quoteRun();
    const production = [...records, { ...records[0]!, seq: 99, bindingKind: 'production' as const, production: true }];
    expect(failed(safety(subject, production).checks)).toContain('production_effects_zero');
  });

  it('a write effect that no ALLOW-backed command explains is a blocker (ungoverned write)', () => {
    const { subject, records } = quoteRun();
    const rogue = [...records, { ...records[2]!, seq: 50, idempotencyKey: 'r4x_ffffffffffffffffffffffffffffffff' }];
    expect(failed(safety(subject, rogue).checks)).toContain('unapproved_writes_zero');
  });

  it('a succeeded external write with no recorded side effect is an incomplete manifest', () => {
    const { subject, records } = quoteRun();
    expect(failed(safety(subject, records.filter((r) => r.operation !== 'create')).checks)).toEqual(['manifest_complete']);
  });

  it('a resolved command without receipt, or two receipts for one command, is caught', () => {
    const { subject, records } = quoteRun();
    const noReceipt = { ...subject, actions: { ...subject.actions, receipts: subject.actions.receipts.filter((r) => r.capabilityId !== 'quote.create') } };
    expect(failed(safety(noReceipt, records).checks)).toEqual(expect.arrayContaining(['writes_without_receipt_zero']));
    const quoteReceipt = subject.actions.receipts.find((r) => r.capabilityId === 'quote.create')!;
    const twice = { ...subject, actions: { ...subject.actions, receipts: [...subject.actions.receipts, { ...quoteReceipt, receiptId: '0190a0a0-0000-7000-8000-00000000ffff' }] } };
    expect(failed(safety(twice, records).checks)).toContain('one_receipt_per_execution');
  });

  it('a call through a binding the composition did not declare (or declared as something else) is caught', () => {
    const { subject, records } = quoteRun();
    const relabeled = records.map((r) => (r.domain === 'catalog' ? { ...r, bindingKind: 'live-read' as const } : r));
    expect(failed(safety(subject, relabeled).checks)).toContain('binding_identity_recorded');
    const manifest = buildSideEffectManifest({ records, subject, outbound: [] });
    expect(evaluateShadowSafety({ records, subject, outbound: [], manifest, composition: null, externalWriteCapabilities: [] }).find((c) => c.code === 'binding_identity_recorded')!.passed).toBe(false);
  });

  it('an uncertain command left at the end of a run is a blocker (non-recoverable unknown effect)', () => {
    const { subject, records } = quoteRun();
    const stuck = { ...subject, actions: { ...subject.actions, executions: subject.actions.executions.map((e) => (e.capabilityId === 'quote.create' ? { ...e, status: 'needs_reconciliation' as const } : e)), receipts: subject.actions.receipts.filter((r) => r.capabilityId !== 'quote.create') } };
    expect(failed(safety(stuck, records).checks)).toContain('no_unresolved_uncertain_effect');
  });

  it('an outbound record that claims a real delivery cannot even be represented', () => {
    const record = { outboundId: 'o', bindingId: 'sink', taskRef: 't', turnIndex: 1, responseRef: 'r', recipientRef: 'anonymous', message: 'hola', messageSha256: 'a'.repeat(64), redactions: {}, respondedAt: 'x', recordedAt: 'x', wouldDeliver: true, actualDelivery: false };
    expect(shadowOutboundSchema.safeParse(record).success).toBe(true);
    expect(shadowOutboundSchema.safeParse({ ...record, actualDelivery: true }).success).toBe(false);
  });
});
