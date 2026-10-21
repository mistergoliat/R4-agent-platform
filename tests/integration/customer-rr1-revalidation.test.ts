import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomerIdentityResolver, CustomerProfilePort } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import type { TrustedExecutionContext } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { customerContextV3Capability, customerPurchaseHistoryV2Capability } from '../../agents/sales/src/capabilities/customer-v3.js';
import { FakeClock, idsFrom } from '../support/deterministic.js';
import { LiveOpsTestbed, OPERATOR, keyOf } from '../support/live-ops.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';

// SEC-S6, RR1-T06 (R4_J4_RR1_BINDING_RACE_ANALYSIS.md §6): customer.get_context@3 against the real
// PostgresProductionStore (binding and task state written by the real ingress and the real
// cancellation), through the real CapabilityInvoker, with in-process CIA and Customer Profile
// doubles. The race is driven by a promise barrier inside the CIA double, never by a timer.
// Not covered here: the worker's fenced recordObservation (no profile registers the capability, so
// the worker path is not exercised); the observation store is in memory.

const CUSTOMER = '56911112222';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

function harness(store: LiveOpsTestbed['store'], beforeResolve: () => Promise<void> = () => Promise.resolve()) {
  const resolve = vi.fn<CustomerIdentityResolver['resolve']>(async (_subject, purposes) => {
    await beforeResolve();
    return { status: 'verified', customerRef: 'prestashop_customer:900000201', grant: { token: 'synthetic.grant.token', expiresAt: new Date(Date.now() + 300_000).toISOString(), purposes: [...purposes] }, resolvedAt: new Date().toISOString() };
  });
  const profile = {
    getSalesContext: vi.fn<CustomerProfilePort['getSalesContext']>(() => Promise.resolve({ status: 'available', purchaseHistory: 'present', validUntil: null })),
    getPurchaseHistory: vi.fn<CustomerProfilePort['getPurchaseHistory']>(() => Promise.reject(new Error('not used'))),
  };
  const deps = { bindings: store, identity: { resolve }, profile };
  const registry = new CapabilityRegistry();
  registry.register(customerContextV3Capability(deps));
  registry.register(customerPurchaseHistoryV2Capability(deps));
  const clock = new FakeClock(new Date().toISOString());
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock: { now: () => new Date() }, logger: createSilentLogger() });
  const context = (taskId: string): TrustedExecutionContext => ({ taskId, runId: '0190a0a0-0000-7000-8000-0000000000ff', agentId: 'sales', agentVersion: 1, correlationId: 'rr1-t06', grantedScopes: ['customer.read'] });
  return { resolve, profile, invoke: (taskId: string) => invoker.invoke({ capabilityId: 'customer.get_context', capabilityVersion: 3, arguments: {} }, context(taskId)) };
}

describe('RR1-T06: real binding and task state (PostgreSQL)', () => {
  it('without a race, a fresh webhook task passes V and reads Customer Profile (verified)', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    await bed.customer(CUSTOMER, 'wamid.rr1.0', 'hola');
    const t = harness(bed.store);
    expect(await t.invoke(await bed.taskOf(CUSTOMER))).toMatchObject({ outcome: 'succeeded', payload: { identity: 'verified', purchaseHistory: 'present' } });
    expect(t.profile.getSalesContext).toHaveBeenCalledTimes(1);
  });

  it('RR1-T06 the task is cancelled and a new inbound closes the binding while the CIA resolves → no Customer Profile request, anonymous; the new inbound opens a NEW binding', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    await bed.customer(CUSTOMER, 'wamid.rr1.1', 'hola');
    const taskId = await bed.taskOf(CUSTOMER);
    const b0 = (await bed.store.bindingByTask(taskId))!;
    expect(b0.status).toBe('open');

    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (enter = resolve));
    const t = harness(bed.store, () => (enter(), gate));

    const pending = t.invoke(taskId);
    await reached;
    await bed.api.temporal.cancelTask(taskId, OPERATOR);
    await bed.customer(CUSTOMER, 'wamid.rr1.2', 'hola de nuevo');
    release();
    const observation = await pending;

    expect(t.resolve).toHaveBeenCalledTimes(1);
    expect(t.profile.getSalesContext).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ outcome: 'succeeded', payload: { identity: 'unavailable', reason: 'anonymous' } });

    expect(await bed.store.bindingByTask(taskId)).toMatchObject({ bindingId: b0.bindingId, status: 'closed', closedReason: 'task_cancelled' });
    const current = (await bed.store.findOpenBinding('whatsapp', keyOf(CUSTOMER)))!;
    expect(current.bindingId).not.toBe(b0.bindingId);
    expect(current.taskId).not.toBe(taskId);
    expect(await bed.rows('select status from channel_conversation_bindings order by created_at')).toEqual([{ status: 'closed' }, { status: 'open' }]);
  });
});
