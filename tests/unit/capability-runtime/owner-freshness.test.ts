import { describe, expect, it } from 'vitest';
import { classifyFreshness } from '@r4/context-compiler';
import { observationSchema, type TrustedExecutionContext } from '@r4/contracts';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';
import { GET_TEST_FACT_ID, getTestFactCapability } from '../../fixtures/capabilities/get-test-fact.js';

/**
 * ADR-030 — owner-bounded capability freshness:
 * effectiveValidUntil = min(runtimeValidUntil, ownerValidUntil) over the
 * non-null bounds. Generic: the test capability knows nothing of Catalog.
 */
const context: TrustedExecutionContext = {
  taskId: '0190a0a0-0000-7000-8000-00000000000a',
  runId: '0190a0a0-0000-7000-8000-00000000000b',
  agentId: 'platform-probe',
  agentVersion: 1,
  correlationId: 'corr-fresh',
  grantedScopes: ['platform_test.read'],
};
const T0 = '2026-01-01T00:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function setup(options: { owner?: (output: unknown) => string | null; ttlMs?: number | null }) {
  const clock = new FakeClock(T0);
  const base = getTestFactCapability();
  const registry = new CapabilityRegistry();
  registry.register({
    ...base,
    definition: { ...base.definition, freshnessTtlMs: options.ttlMs === undefined ? 60_000 : options.ttlMs },
    ...(options.owner ? { ownerValidUntil: options.owner } : {}),
  });
  const store = new InMemoryObservationStore();
  const invoker = new CapabilityInvoker({ registry, observations: store, ids: idsFrom(clock), clock, logger: createSilentLogger() });
  const invoke = (invocationId?: string) => invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context, invocationId ? { invocationId } : {});
  return { invoke, clock, store };
}

describe('ADR-030 owner-bounded freshness (CapabilityInvoker)', () => {
  it('owner earlier than the runtime bound → the owner bound is recorded', async () => {
    const { invoke } = setup({ owner: () => at(15_000) });
    const o = await invoke();
    expect(observationSchema.safeParse(o).success).toBe(true);
    expect(o.validUntil).toBe(at(15_000));
    expect(o.provenance).toMatchObject({ freshness: { runtimeValidUntil: at(60_000), ownerValidUntil: at(15_000), bound: 'owner' } });
  });

  it('runtime earlier than the owner bound → the runtime bound is kept (the owner never extends it)', async () => {
    const { invoke } = setup({ owner: () => at(3_600_000) });
    const o = await invoke();
    expect(o.validUntil).toBe(at(60_000));
    expect(o.provenance).toMatchObject({ freshness: { bound: 'runtime' } });
  });

  it('owner declares no window (null) → the runtime bound applies', async () => {
    const { invoke } = setup({ owner: () => null });
    const o = await invoke();
    expect(o.validUntil).toBe(at(60_000));
    expect(o.provenance).toMatchObject({ freshness: { ownerValidUntil: null, bound: 'runtime' } });
  });

  it('no runtime TTL (null) → the owner bound applies; neither → no bound', async () => {
    expect((await setup({ ttlMs: null, owner: () => at(15_000) }).invoke()).validUntil).toBe(at(15_000));
    const none = await setup({ ttlMs: null, owner: () => null }).invoke();
    expect(none.validUntil).toBeNull();
    expect(none.provenance).toMatchObject({ freshness: { bound: 'none' } });
  });

  it('a payload the owner already declared expired is recorded as such: expired (historical) from the first compile', async () => {
    const { invoke, clock } = setup({ owner: () => at(-1_000) });
    const o = await invoke();
    expect(o.outcome).toBe('succeeded');
    expect(o.validUntil).toBe(at(-1_000));
    expect(classifyFreshness({ temporality: 'point_in_time', observedAt: o.observedAt, validUntil: o.validUntil }, clock.now(), undefined)).toBe('expired');
  });

  it('the compiler sees the owner bound: fresh before it, expired after it (not after R4\'s 60 s)', async () => {
    const { invoke } = setup({ owner: () => at(15_000) });
    const o = await invoke();
    const item = { temporality: 'point_in_time' as const, observedAt: o.observedAt, validUntil: o.validUntil };
    expect(classifyFreshness(item, new Date(at(14_999)), undefined)).toBe('fresh');
    expect(classifyFreshness(item, new Date(at(15_000)), undefined)).toBe('expired');
    expect(classifyFreshness(item, new Date(at(30_000)), undefined)).toBe('expired');
  });

  it('owner bounds in another offset are compared as instants and recorded in UTC', async () => {
    const o = await setup({ owner: () => '2025-12-31T21:00:10.000-03:00' }).invoke();
    expect(o.validUntil).toBe(at(10_000));
  });

  it('an owner bound that is not an instant, or an extractor that throws, fails the invocation — nothing is invented', async () => {
    for (const owner of [() => 'soon', () => 42 as unknown as string, () => { throw new Error('boom'); }]) {
      const o = await setup({ owner }).invoke();
      expect(o).toMatchObject({ outcome: 'failed', payload: null, validUntil: null, error: { code: 'invalid_capability_output' } });
    }
  });

  it('a re-used observation (same invocationId) keeps its recorded bound; it is never recomputed or extended', async () => {
    let bound = at(15_000);
    const { invoke, clock, store } = setup({ owner: () => bound });
    const first = await invoke('0190a0a0-0000-7000-8000-0000000000f1');
    clock.advance(30_000);
    bound = at(3_600_000);
    const again = await invoke('0190a0a0-0000-7000-8000-0000000000f1');
    expect(again).toEqual(first);
    expect(again.validUntil).toBe(at(15_000));
    expect(store.byInvocation.size).toBe(1);
  });

  it('the extractor only reads validated output', async () => {
    const seen: unknown[] = [];
    await setup({ owner: (output) => { seen.push(output); return null; } }).invoke();
    expect(seen).toEqual([{ factKey: 'alpha', found: true, value: 'first' }]);
  });

  it('a capability without an extractor behaves exactly as before (no provenance change)', async () => {
    const o = await setup({}).invoke();
    expect(o.validUntil).toBe(at(60_000));
    expect(o.provenance).not.toHaveProperty('freshness');
  });

  it('failures and rejections still carry no validity', async () => {
    const { invoke } = setup({ owner: () => at(15_000) });
    const clock = new FakeClock(T0);
    const registry = new CapabilityRegistry();
    registry.register({ ...getTestFactCapability(() => Promise.reject(new Error('down'))), ownerValidUntil: () => at(15_000) });
    const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
    const failed = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context);
    expect(failed).toMatchObject({ outcome: 'failed', validUntil: null });
    expect(failed.provenance).not.toHaveProperty('freshness');
    expect((await invoke()).outcome).toBe('succeeded');
  });
});
