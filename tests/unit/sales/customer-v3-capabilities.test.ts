import { describe, expect, it, vi } from 'vitest';
import type { CustomerIdentityResolver, CustomerProfilePort, CustomerPurpose, IdentityResolution } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import type { TrustedExecutionContext } from '@r4/contracts';
import type { ConversationBindingRecord, TaskStateFacts } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { composeSyntheticCustomerCapabilities } from '../../../agents/sales/src/capabilities/customer-synthetic.js';
import { CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID, CustomerCapabilityCompositionError } from '../../../agents/sales/src/capabilities/customer-v2.js';
import { customerContextV3Capability, customerPurchaseHistoryV2Capability, type CustomerCapabilityV3Dependencies } from '../../../agents/sales/src/capabilities/customer-v3.js';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';

// SEC-S6 (RR-1): customer.get_context@3 and customer.get_purchase_history@2 revalidate the channel
// association V(taskId, b₀) at T1, T2' and T4' (R4_J4_RR1_BINDING_RACE_ANALYSIS.md §4, §5.1, §6).
// Real capability runtime; test doubles for the binding and task state, the CIA and Customer Profile.
// The races are driven by promise barriers, never by timers.

const T0 = '2026-10-21T12:00:00.000Z';
const NOW = new Date(T0);
const TASK = '0190a0a0-0000-7000-8000-00000000000a';
const B0 = '0190b0b0-0000-7000-8000-000000000001';
const B1 = '0190b0b0-0000-7000-8000-000000000002';
const GRANT_TOKEN = 'eyJzeW50aGV0aWMiOnRydWV9.eyJ0YXNrIjoiYSJ9.c3ludGhldGljLXNpZ25hdHVyZQ';
const ANONYMOUS = { identity: 'unavailable', reason: 'anonymous' };

const binding = (overrides: Partial<ConversationBindingRecord> = {}): ConversationBindingRecord => ({
  bindingId: B0,
  channel: 'whatsapp',
  conversationKey: 'a'.repeat(64),
  accountRef: '100000000000001',
  recipientRef: '15555550101',
  taskId: TASK,
  status: 'open',
  autonomy: 'autonomous',
  eligibilityReason: 'in_cohort',
  rolloutFingerprint: 'r',
  profile: 'synthetic',
  profileFingerprint: 'p',
  createdAt: T0,
  lastInboundAt: T0,
  closedAt: null,
  closedReason: null,
  ...overrides,
});
const closed = (b: ConversationBindingRecord): ConversationBindingRecord => ({ ...b, status: 'closed', closedAt: T0, closedReason: 'task_cancelled' });
const running: TaskStateFacts = { status: 'running', terminalIntent: false, humanOwned: false };

const verifiedFor = (purpose: CustomerPurpose): IdentityResolution => ({
  status: 'verified',
  customerRef: 'prestashop_customer:900000201',
  grant: { token: GRANT_TOKEN, expiresAt: '2026-10-21T12:05:00.000Z', purposes: [purpose] },
  resolvedAt: T0,
});

/** A promise barrier: the double signals `reached`, then waits for `release()`. */
function barrier() {
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (enter = resolve));
  return { release, reached, pass: () => (enter(), gate) };
}

type Kind = 'context' | 'history';
const KINDS: [string, Kind][] = [
  ['customer.get_context@3', 'context'],
  ['customer.get_purchase_history@2', 'history'],
];

function setup(options: { taskState?: TaskStateFacts | null; resolveGate?: ReturnType<typeof barrier>; profileGate?: ReturnType<typeof barrier> } = {}) {
  // Mutable state the doubles read on every call (no caching on the capability side).
  const state = { binding: binding() as ConversationBindingRecord | null, task: options.taskState === undefined ? running : options.taskState };
  const bindingByTask = vi.fn((taskId: string) => Promise.resolve(taskId === TASK ? state.binding : null));
  const taskState = vi.fn((taskId: string) => Promise.resolve(taskId === TASK ? state.task : null));
  const resolve = vi.fn<CustomerIdentityResolver['resolve']>(async (_s, purposes) => {
    await options.resolveGate?.pass();
    return verifiedFor(purposes[0]!);
  });
  const profile = {
    getSalesContext: vi.fn<CustomerProfilePort['getSalesContext']>(async () => {
      await options.profileGate?.pass();
      return { status: 'available', purchaseHistory: 'present', validUntil: '2026-10-21T12:15:00.000Z' };
    }),
    getPurchaseHistory: vi.fn<CustomerProfilePort['getPurchaseHistory']>(async () => {
      await options.profileGate?.pass();
      return { status: 'available', items: [{ productName: 'Rack sintetico', catalogKey: null, lastPurchasedOn: '2026-09-28', totalQuantity: 1, orderCount: 1, lineKind: 'standard' }], offset: 0, hasMore: false, nextOffset: null, datePrecision: 'day_timezone_unverified', validUntil: '2026-10-21T12:15:00.000Z' };
    }),
  };
  const deps: CustomerCapabilityV3Dependencies = { bindings: { bindingByTask, taskState }, identity: { resolve }, profile, now: () => NOW };
  const clock = new FakeClock(T0);
  const registry = new CapabilityRegistry();
  registry.register(customerContextV3Capability(deps));
  registry.register(customerPurchaseHistoryV2Capability(deps));
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
  const context: TrustedExecutionContext = { taskId: TASK, runId: '0190a0a0-0000-7000-8000-0000000000ff', agentId: 'sales', agentVersion: 1, correlationId: 'corr-0a', grantedScopes: ['customer.read'] };
  const invoke = (kind: Kind, args: Record<string, unknown> = {}) =>
    invoker.invoke(kind === 'context' ? { capabilityId: 'customer.get_context', capabilityVersion: 3, arguments: args } : { capabilityId: CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID, capabilityVersion: 2, arguments: args }, context);
  const cpCalls = () => profile.getSalesContext.mock.calls.length + profile.getPurchaseHistory.mock.calls.length;
  return { state, bindingByTask, taskState, resolve, profile, invoke, cpCalls };
}

/** Starts the invocation, waits for the double to reach its barrier, applies `act`, releases it. */
async function raced(t: ReturnType<typeof setup>, kind: Kind, gate: ReturnType<typeof barrier>, act: () => void) {
  const pending = t.invoke(kind);
  await gate.reached;
  act();
  gate.release();
  return pending;
}

describe('RR-1 races (R4_J4_RR1_BINDING_RACE_ANALYSIS.md §6)', () => {
  it.each(KINDS)('RR1-T01 %s: the binding closes while the CIA resolves → no Customer Profile call, anonymous', async (_name, kind) => {
    const gate = barrier();
    const t = setup({ resolveGate: gate });
    const observation = await raced(t, kind, gate, () => (t.state.binding = closed(t.state.binding!)));
    expect(t.resolve).toHaveBeenCalledTimes(1);
    expect(t.cpCalls()).toBe(0);
    expect(observation).toMatchObject({ outcome: 'succeeded', payload: ANONYMOUS });
  });

  it.each(KINDS)('RR1-T02 %s: the task is cancelled while the CIA resolves (binding still open) → no Customer Profile call, anonymous', async (_name, kind) => {
    const gate = barrier();
    const t = setup({ resolveGate: gate });
    const observation = await raced(t, kind, gate, () => (t.state.task = { ...running, status: 'cancelled' }));
    expect(t.state.binding!.status).toBe('open');
    expect(t.cpCalls()).toBe(0);
    expect(observation).toMatchObject({ outcome: 'succeeded', payload: ANONYMOUS });
  });

  it.each(KINDS)('RR1-T03 %s: the binding closes while Customer Profile reads → the data is dropped, anonymous', async (_name, kind) => {
    const gate = barrier();
    const t = setup({ profileGate: gate });
    const observation = await raced(t, kind, gate, () => (t.state.binding = closed(t.state.binding!)));
    expect(t.cpCalls()).toBe(1);
    expect(observation).toMatchObject({ outcome: 'succeeded', payload: ANONYMOUS });
    expect(JSON.stringify(observation)).not.toMatch(/verified|present|Rack sintetico|validUntil":"2026-10-21T12:05/);
  });

  it.each(KINDS)('RR1-T04 %s: terminalIntent before T1 → neither the CIA nor Customer Profile is called', async (_name, kind) => {
    const t = setup({ taskState: { ...running, terminalIntent: true } });
    expect(await t.invoke(kind)).toMatchObject({ outcome: 'succeeded', payload: ANONYMOUS });
    expect(t.resolve).not.toHaveBeenCalled();
    expect(t.cpCalls()).toBe(0);
  });

  it.each(KINDS)('RR1-T05 %s: at T2\' the task has another binding (corruption of one_per_task) → anonymous, no Customer Profile call', async (_name, kind) => {
    const gate = barrier();
    const t = setup({ resolveGate: gate });
    const observation = await raced(t, kind, gate, () => (t.state.binding = binding({ bindingId: B1 })));
    expect(t.cpCalls()).toBe(0);
    expect(observation).toMatchObject({ outcome: 'succeeded', payload: ANONYMOUS });
  });

  it.each(KINDS)('a cancelled, completed or failed task before T1 is anonymous with no external call (%s)', async (_name, kind) => {
    for (const status of ['cancelled', 'completed', 'failed']) {
      const t = setup({ taskState: { ...running, status } });
      expect((await t.invoke(kind)).payload).toEqual(ANONYMOUS);
      expect(t.resolve).not.toHaveBeenCalled();
      expect(t.cpCalls()).toBe(0);
    }
  });
});

describe('OA-09: humanOwned makes the association not apt', () => {
  it.each(KINDS)('humanOwned at T1 → anonymous, no CIA and no Customer Profile call (%s)', async (_name, kind) => {
    const t = setup({ taskState: { ...running, humanOwned: true } });
    expect((await t.invoke(kind)).payload).toEqual(ANONYMOUS);
    expect(t.resolve).not.toHaveBeenCalled();
    expect(t.cpCalls()).toBe(0);
  });

  it.each(KINDS)('humanOwned at T2\' → anonymous, no Customer Profile call (%s)', async (_name, kind) => {
    const gate = barrier();
    const t = setup({ resolveGate: gate });
    const observation = await raced(t, kind, gate, () => (t.state.task = { ...running, humanOwned: true }));
    expect(t.cpCalls()).toBe(0);
    expect(observation.payload).toEqual(ANONYMOUS);
  });

  it.each(KINDS)('humanOwned at T4\' → the data is dropped, anonymous (%s)', async (_name, kind) => {
    const gate = barrier();
    const t = setup({ profileGate: gate });
    const observation = await raced(t, kind, gate, () => (t.state.task = { ...running, humanOwned: true }));
    expect(t.cpCalls()).toBe(1);
    expect(observation.payload).toEqual(ANONYMOUS);
  });
});

describe('V reads the task state on every check', () => {
  it.each(KINDS)('a missing taskState fails V → anonymous, no external call (%s)', async (_name, kind) => {
    const t = setup({ taskState: null });
    expect((await t.invoke(kind)).payload).toEqual(ANONYMOUS);
    expect(t.resolve).not.toHaveBeenCalled();
    expect(t.cpCalls()).toBe(0);
  });

  it('no binding, or a closed one, stays anonymous with no external call', async () => {
    for (const value of [null, closed(binding())]) {
      const t = setup();
      t.state.binding = value;
      expect((await t.invoke('context')).payload).toEqual(ANONYMOUS);
      expect(t.resolve).not.toHaveBeenCalled();
    }
  });

  it('the happy path is still verified, with V checked at T1, T2\' and T4\' (binding and task state read each time)', async () => {
    const t = setup();
    const observation = await t.invoke('context');
    expect(observation).toMatchObject({ outcome: 'succeeded', payload: { identity: 'verified', purchaseHistory: 'present', validUntil: '2026-10-21T12:05:00.000Z' } });
    expect(t.resolve.mock.calls.map(([s, p]) => [s, p])).toEqual([[{ channel: 'whatsapp', accountRef: '100000000000001', subjectRef: '15555550101', sessionRef: B0 }, ['sales_context']]]);
    expect(t.taskState).toHaveBeenCalledTimes(3);
    expect(t.bindingByTask).toHaveBeenCalledTimes(4);
    const history = await setup().invoke('history');
    expect(history).toMatchObject({ outcome: 'succeeded', payload: { identity: 'verified', items: [{ productName: 'Rack sintetico' }] } });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a customerRef', { customerRef: 'prestashop_customer:900000202' }],
    ['a phone', { phone: '+56900000002' }],
    ['a subject', { subjectRef: '15555550199', channel: 'whatsapp' }],
    ['a binding', { bindingId: B1 }],
    ['a grant', { grant: GRANT_TOKEN }],
  ])('the model cannot pass %s: strict input, rejected before anything runs', async (_name, args) => {
    const t = setup();
    for (const kind of ['context', 'history'] as const) expect(await t.invoke(kind, args)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_arguments' } });
    expect(t.bindingByTask).not.toHaveBeenCalled();
    expect(t.taskState).not.toHaveBeenCalled();
    expect(t.resolve).not.toHaveBeenCalled();
  });
});

describe('composition (AG-2)', () => {
  const ENV = {
    R4_CUSTOMER_MODE: 'synthetic',
    R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787',
    R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001',
    R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500',
    R4_CUSTOMER_PROFILE_BASE_URL: 'http://127.0.0.1:3010',
    R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij',
    R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
  };

  it('the builders refuse to compose without taskState (or any other owner)', () => {
    const t = setup();
    const full = { bindings: { bindingByTask: t.bindingByTask, taskState: t.taskState }, identity: { resolve: t.resolve }, profile: t.profile };
    for (const deps of [{ ...full, bindings: { bindingByTask: t.bindingByTask } }, { ...full, bindings: undefined }, { ...full, identity: undefined }, { ...full, profile: undefined }, undefined]) {
      expect(() => customerContextV3Capability(deps as never)).toThrow(CustomerCapabilityCompositionError);
      expect(() => customerPurchaseHistoryV2Capability(deps as never)).toThrow(CustomerCapabilityCompositionError);
    }
    expect(() => customerContextV3Capability({ ...full, bindings: { bindingByTask: t.bindingByTask } } as never)).toThrow(/taskState/);
  });

  it('the synthetic composition returns exactly customer.get_context@3 and customer.get_purchase_history@2', () => {
    const capabilities = composeSyntheticCustomerCapabilities({ env: ENV, bindings: { bindingByTask: () => Promise.resolve(null), taskState: () => Promise.resolve(null) } });
    expect(capabilities.map((c) => `${c.definition.capabilityId}@${c.definition.version}`)).toEqual(['customer.get_context@3', 'customer.get_purchase_history@2']);
  });

  it('the synthetic composition refuses a binding source without taskState', () => {
    expect(() => composeSyntheticCustomerCapabilities({ env: ENV, bindings: { bindingByTask: () => Promise.resolve(null) } as never })).toThrow(CustomerCapabilityCompositionError);
  });
});
