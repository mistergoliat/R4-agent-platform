import { describe, expect, it, vi } from 'vitest';
import { DomainError, type ChannelSubject, type CustomerIdentityResolver, type CustomerProfilePort, type CustomerPurpose, type IdentityResolution } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import type { TrustedExecutionContext } from '@r4/contracts';
import type { ConversationBindingRecord } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { composeSyntheticCustomerCapabilities } from '../../../agents/sales/src/capabilities/customer-synthetic.js';
import {
  CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID,
  CustomerCapabilityCompositionError,
  customerContextV2Capability,
  customerPurchaseHistoryV1Capability,
  type CustomerCapabilityDependencies,
} from '../../../agents/sales/src/capabilities/customer-v2.js';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';

// R4-J4-R3 (R3.4–R3.7): the two Customer capabilities through the real capability runtime, with
// test doubles for the binding source, the identity authority and Customer Profile. Synthetic only.

const T0 = '2026-10-21T12:00:00.000Z';
const NOW = new Date(T0);
const TASK_A = '0190a0a0-0000-7000-8000-00000000000a';
const TASK_B = '0190a0a0-0000-7000-8000-00000000000b';
const GRANT_TOKEN = 'eyJzeW50aGV0aWMiOnRydWV9.eyJ0YXNrIjoiYSJ9.c3ludGhldGljLXNpZ25hdHVyZQ';

const binding = (taskId: string, n: number, overrides: Partial<ConversationBindingRecord> = {}): ConversationBindingRecord => ({
  bindingId: `0190b0b0-0000-7000-8000-00000000000${n}`,
  channel: 'whatsapp',
  conversationKey: 'a'.repeat(64),
  accountRef: '100000000000001',
  recipientRef: `1555555010${n}`,
  taskId,
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

const verifiedFor = (customerRef: string, purpose: CustomerPurpose, expiresAt = '2026-10-21T12:05:00.000Z', token = GRANT_TOKEN): IdentityResolution => ({
  status: 'verified',
  customerRef,
  grant: { token, expiresAt, purposes: [purpose] },
  resolvedAt: T0,
});

function setup(options: { bindings?: Record<string, ConversationBindingRecord>; resolve?: (subject: ChannelSubject, purposes: readonly CustomerPurpose[]) => Promise<IdentityResolution>; profile?: Partial<CustomerProfilePort> } = {}) {
  const bindings = options.bindings ?? { [TASK_A]: binding(TASK_A, 1) };
  const bindingByTask = vi.fn((taskId: string) => Promise.resolve(bindings[taskId] ?? null));
  const resolve = vi.fn<CustomerIdentityResolver['resolve']>(options.resolve ?? ((_s, purposes) => Promise.resolve(verifiedFor('prestashop_customer:900000201', purposes[0]!))));
  const profile = {
    getSalesContext: vi.fn<CustomerProfilePort['getSalesContext']>(options.profile?.getSalesContext ?? (() => Promise.resolve({ status: 'available', purchaseHistory: 'present', validUntil: '2026-10-21T12:15:00.000Z' }))),
    getPurchaseHistory: vi.fn<CustomerProfilePort['getPurchaseHistory']>(
      options.profile?.getPurchaseHistory ??
        (() => Promise.resolve({ status: 'available', items: [{ productName: 'Rack sintetico', catalogKey: null, lastPurchasedOn: '2026-09-28', totalQuantity: 1, orderCount: 1, lineKind: 'standard' }], offset: 0, hasMore: false, nextOffset: null, datePrecision: 'day_timezone_unverified', validUntil: '2026-10-21T12:15:00.000Z' })),
    ),
  };
  const deps: CustomerCapabilityDependencies = { bindings: { bindingByTask }, identity: { resolve }, profile, now: () => NOW };
  const clock = new FakeClock(T0);
  const registry = new CapabilityRegistry();
  registry.register(customerContextV2Capability(deps));
  registry.register(customerPurchaseHistoryV1Capability(deps));
  const store = new InMemoryObservationStore();
  const invoker = new CapabilityInvoker({ registry, observations: store, ids: idsFrom(clock), clock, logger: createSilentLogger() });
  const context = (taskId: string): TrustedExecutionContext => ({ taskId, runId: '0190a0a0-0000-7000-8000-0000000000ff', agentId: 'sales', agentVersion: 1, correlationId: `corr-${taskId.slice(-2)}`, grantedScopes: ['customer.read'] });
  const contextV2 = (taskId = TASK_A, args: Record<string, unknown> = {}) => invoker.invoke({ capabilityId: 'customer.get_context', capabilityVersion: 2, arguments: args }, context(taskId));
  const history = (taskId = TASK_A, args: Record<string, unknown> = {}) => invoker.invoke({ capabilityId: CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID, capabilityVersion: 1, arguments: args }, context(taskId));
  return { bindingByTask, resolve, profile, contextV2, history };
}

describe('the subject comes only from the trusted binding of the task', () => {
  it('no binding → unavailable/anonymous, with no call to the identity authority or Customer Profile', async () => {
    const t = setup({ bindings: {} });
    for (const observation of [await t.contextV2(), await t.history()]) {
      expect(observation).toMatchObject({ outcome: 'succeeded', payload: { identity: 'unavailable', reason: 'anonymous' } });
    }
    expect(t.resolve).not.toHaveBeenCalled();
    expect(t.profile.getSalesContext).not.toHaveBeenCalled();
  });

  it('a closed binding is anonymous too', async () => {
    const t = setup({ bindings: { [TASK_A]: binding(TASK_A, 1, { status: 'closed', closedAt: T0, closedReason: 'expired' }) } });
    expect((await t.contextV2()).payload).toEqual({ identity: 'unavailable', reason: 'anonymous' });
    expect(t.resolve).not.toHaveBeenCalled();
  });

  it('the CIA receives the binding subject (channel, account, recipient, bindingId as session) and only the capability purpose', async () => {
    const t = setup();
    await t.contextV2();
    await t.history();
    const subject = { channel: 'whatsapp', accountRef: '100000000000001', subjectRef: '15555550101', sessionRef: '0190b0b0-0000-7000-8000-000000000001' };
    expect(t.resolve.mock.calls.map(([s, p, o]) => [s, p, o?.correlationId])).toEqual([
      [subject, ['sales_context'], 'corr-0a'],
      [subject, ['purchase_history'], 'corr-0a'],
    ]);
    expect(t.bindingByTask).toHaveBeenCalledWith(TASK_A);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a customerRef', { customerRef: 'prestashop_customer:900000202' }],
    ['a phone', { phone: '+56900000002' }],
    ['a subject', { subjectRef: '15555550199', channel: 'whatsapp' }],
    ['a grant', { grant: GRANT_TOKEN }],
  ])('model arguments carrying %s are rejected before anything runs', async (_name, args) => {
    const t = setup();
    expect(await t.contextV2(TASK_A, args)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_arguments' } });
    expect(await t.history(TASK_A, args)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_arguments' } });
    expect(t.bindingByTask).not.toHaveBeenCalled();
    expect(t.resolve).not.toHaveBeenCalled();
  });

  it('two tasks resolve their own subjects: no cross-task binding, no shared grant, no cache', async () => {
    const refs: Record<string, string> = { '15555550101': 'prestashop_customer:900000201', '15555550102': 'prestashop_customer:900000202' };
    const t = setup({
      bindings: { [TASK_A]: binding(TASK_A, 1), [TASK_B]: binding(TASK_B, 2) },
      resolve: (subject, purposes) => Promise.resolve(verifiedFor(refs[subject.subjectRef]!, purposes[0]!, undefined, `${GRANT_TOKEN}${subject.subjectRef.slice(-1)}`)),
    });
    await Promise.all([t.contextV2(TASK_A), t.contextV2(TASK_B), t.contextV2(TASK_A)]);
    expect(t.resolve).toHaveBeenCalledTimes(3);
    const calls = t.profile.getSalesContext.mock.calls.map(([ref, grant]) => [ref, grant.token.slice(-1)]).sort();
    expect(calls).toEqual([['prestashop_customer:900000201', '1'], ['prestashop_customer:900000201', '1'], ['prestashop_customer:900000202', '2']]);
  });
});

describe('resolution outcomes (R3.6, specification §7)', () => {
  it.each<[IdentityResolution['status'], string]>([
    ['not_linked', 'not_linked'],
    ['not_verified', 'not_verified'],
    ['ambiguous', 'not_verified'],
    ['conflicted', 'not_verified'],
    ['not_authorized', 'not_authorized'],
  ])('%s → unavailable/%s, never a Customer Profile call', async (status, reason) => {
    const t = setup({ resolve: () => Promise.resolve({ status, resolvedAt: T0 } as IdentityResolution) });
    expect((await t.contextV2()).payload).toEqual({ identity: 'unavailable', reason });
    expect((await t.history()).payload).toEqual({ identity: 'unavailable', reason });
    expect(t.profile.getSalesContext).not.toHaveBeenCalled();
    expect(t.profile.getPurchaseHistory).not.toHaveBeenCalled();
  });

  it('verified + available: a verified output whose validity is min(CP validUntil, grant expiry); the observation is bounded by it', async () => {
    const t = setup();
    const observation = await t.contextV2();
    expect(observation.payload).toEqual({ identity: 'verified', purchaseHistory: 'present', validUntil: '2026-10-21T12:05:00.000Z' });
    expect(observation.validUntil).toBe('2026-10-21T12:05:00.000Z');
    expect(t.profile.getSalesContext).toHaveBeenCalledWith('prestashop_customer:900000201', expect.objectContaining({ token: GRANT_TOKEN }), expect.objectContaining({ correlationId: 'corr-0a' }));
  });

  it('verified + not_found → not_on_file; withheld → withheld', async () => {
    expect((await setup({ profile: { getSalesContext: () => Promise.resolve({ status: 'not_found', validUntil: null }) } }).contextV2()).payload).toEqual({ identity: 'unavailable', reason: 'not_on_file' });
    expect((await setup({ profile: { getSalesContext: () => Promise.resolve({ status: 'withheld', validUntil: null }) } }).contextV2()).payload).toEqual({ identity: 'unavailable', reason: 'withheld' });
  });

  it.each<[string, () => DomainError]>([
    ['unauthorized', () => new DomainError('unauthorized', 'identity_unauthorized', 'x')],
    ['temporarily_unavailable', () => new DomainError('temporarily_unavailable', 'identity_unreachable', 'x')],
    ['timeout', () => new DomainError('timeout', 'deadline_exceeded', 'x')],
    ['contract_violation', () => new DomainError('contract_violation', 'invalid_response', 'x')],
  ])('an identity failure (%s) is a failed observation, never an absence of customer', async (category, error) => {
    const t = setup({ resolve: () => Promise.reject(error()) });
    const observation = await t.contextV2();
    expect(observation).toMatchObject({ outcome: 'failed', payload: null, error: { details: { category } } });
    expect(t.profile.getSalesContext).not.toHaveBeenCalled();
  });

  it.each<[string, DomainError]>([
    ['grant rejected by CP (403)', new DomainError('unauthorized', 'profile_unauthorized', 'x', { ownerCode: 'grant_rejected' })],
    ['CP unavailable', new DomainError('temporarily_unavailable', 'profile_unreachable', 'x')],
    ['CP answered service_scope_only', new DomainError('contract_violation', 'authorization_basis_insufficient', 'x')],
    ['history incomplete', new DomainError('temporarily_unavailable', 'history_unavailable', 'x')],
  ])('a Customer Profile failure (%s) stays a failure', async (_name, error) => {
    const t = setup({ profile: { getSalesContext: () => Promise.reject(error), getPurchaseHistory: () => Promise.reject(error) } });
    for (const observation of [await t.contextV2(), await t.history()]) expect(observation).toMatchObject({ outcome: 'failed', error: { details: { category: error.category, code: error.code } } });
  });

  it.each<[string, IdentityResolution]>([
    ['a verified identity without a grant for the purpose', verifiedFor('prestashop_customer:900000201', 'purchase_history')],
    ['an expired grant', verifiedFor('prestashop_customer:900000201', 'sales_context', '2026-10-21T12:00:00.000Z')],
  ])('%s is incoherent_grant and never reaches Customer Profile', async (_name, resolution) => {
    const t = setup({ resolve: () => Promise.resolve(resolution) });
    expect(await t.contextV2()).toMatchObject({ outcome: 'failed', error: { details: { category: 'contract_violation', code: 'incoherent_grant' } } });
    expect(t.profile.getSalesContext).not.toHaveBeenCalled();
  });
});

describe('history limits and minimization (AG-4, AG-5)', () => {
  it.each([{ offset: 41 }, { limit: 11 }, { limit: 0 }, { offset: -1 }, { offset: 1.5 }])('page %j is rejected by the input schema', async (args) => {
    const t = setup();
    expect(await t.history(TASK_A, args)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_arguments' } });
    expect(t.resolve).not.toHaveBeenCalled();
  });

  it('the observation carries no customerRef, grant, subject, lineKind or binding id', async () => {
    const t = setup();
    const observations = [await t.contextV2(), await t.history()];
    const all = JSON.stringify(observations);
    for (const secret of ['prestashop_customer', GRANT_TOKEN, ...GRANT_TOKEN.split('.'), '15555550101', '100000000000001', '0190b0b0', 'lineKind']) expect(all).not.toContain(secret);
  });
});

describe('construction (AG-2)', () => {
  it('a capability cannot be built without the binding source, the identity authority and Customer Profile', () => {
    const t = setup();
    const full = { bindings: { bindingByTask: t.bindingByTask }, identity: { resolve: t.resolve }, profile: t.profile };
    for (const deps of [{ ...full, bindings: undefined }, { ...full, identity: undefined }, { ...full, profile: undefined }, { ...full, profile: { getSalesContext: t.profile.getSalesContext } }, undefined]) {
      expect(() => customerContextV2Capability(deps as never)).toThrow(CustomerCapabilityCompositionError);
      expect(() => customerPurchaseHistoryV1Capability(deps as never)).toThrow(CustomerCapabilityCompositionError);
    }
  });

  const ENV = {
    R4_CUSTOMER_MODE: 'synthetic',
    R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787',
    R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001',
    R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500',
    R4_CUSTOMER_PROFILE_BASE_URL: 'http://127.0.0.1:3010',
    R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij',
    R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
  };
  const bindings = { bindingByTask: () => Promise.resolve(null) };

  it('the synthetic composition registers exactly the two capabilities from a complete synthetic configuration', () => {
    const capabilities = composeSyntheticCustomerCapabilities({ env: ENV, bindings });
    expect(capabilities.map((c) => `${c.definition.capabilityId}@${c.definition.version}`)).toEqual(['customer.get_context@2', 'customer.get_purchase_history@1']);
  });

  it.each<[string, Record<string, string | undefined>]>([
    ['no mode', { ...ENV, R4_CUSTOMER_MODE: undefined }],
    ['real mode', { ...ENV, R4_CUSTOMER_MODE: 'real' }],
    ['no CIA URL', { ...ENV, R4_CUSTOMER_IDENTITY_BASE_URL: undefined }],
    ['no CP URL', { ...ENV, R4_CUSTOMER_PROFILE_BASE_URL: undefined }],
    ['a non-loopback CIA', { ...ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'https://cia.pesaschile.cl' }],
    ['a non-loopback CP', { ...ENV, R4_CUSTOMER_PROFILE_BASE_URL: 'https://customer-profile.pesaschile.cl' }],
    ['a non-synthetic CIA credential', { ...ENV, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'prod-r4-sales-agent-token-000000000001' }],
    ['a non-synthetic CP credential', { ...ENV, R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'prod-r4-sales-cp-token-0123456789abcdefghijklmnop' }],
  ])('refuses %s', (_name, env) => {
    expect(() => composeSyntheticCustomerCapabilities({ env, bindings })).toThrow();
  });

  it('refuses a missing binding source', () => {
    expect(() => composeSyntheticCustomerCapabilities({ env: ENV, bindings: undefined as never })).toThrow(CustomerCapabilityCompositionError);
  });
});
