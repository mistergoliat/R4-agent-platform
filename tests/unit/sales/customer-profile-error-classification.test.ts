import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { CustomerProfileFetch } from '@r4-adapters/customer-http';
import { CustomerProfileHttpClient } from '@r4-adapters/customer-http';
import type { IdentityResolution } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import type { Observation, TrustedExecutionContext } from '@r4/contracts';
import type { ConversationBindingRecord } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { customerContextV3Capability, type CustomerCapabilityV3Dependencies } from '../../../agents/sales/src/capabilities/customer-v3.js';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';
import { answer, CONFIG, GRANT_TOKEN, NOW, TOKEN } from '../customer-profile/support.js';

// R4-J5: a Customer Profile outage (J4-R5 canary, CP stopped → ECONNREFUSED) surfaced as
// `capability.invocation.completed { errorCode: handler_error }`. The adapter already classified it
// (temporarily_unavailable / profile_unreachable); the type was lost at the capability runtime, which
// recorded every handler failure as `handler_error`. These tests run the real adapter, the real
// customer.get_context@3 and the real invoker, and check the typed code end to end and that nothing
// internal (host, transport code, HTTP status, owner code, scope, token) reaches the observation.

const TASK = '0190a0a0-0000-7000-8000-00000000000a';
const REF = 'prestashop_customer:900000201';
const binding: ConversationBindingRecord = {
  bindingId: '0190b0b0-0000-7000-8000-000000000001',
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
  createdAt: NOW.toISOString(),
  lastInboundAt: NOW.toISOString(),
  closedAt: null,
  closedReason: null,
};
const verified: IdentityResolution = { status: 'verified', customerRef: REF, grant: { token: GRANT_TOKEN, expiresAt: '2026-10-15T12:15:00.000Z', purposes: ['sales_context'] }, resolvedAt: NOW.toISOString() };
const context: TrustedExecutionContext = { taskId: TASK, runId: '0190a0a0-0000-7000-8000-0000000000ff', agentId: 'sales', agentVersion: 8, correlationId: 'corr-j5', grantedScopes: ['customer.read'] };

const GENERIC_MESSAGES = [
  'the capability owner is temporarily unavailable',
  'the capability owner did not answer in time',
  'the capability owner refused the platform credential',
  'the capability owner answered outside its contract',
];

async function invokeWith(fetch: CustomerProfileFetch, overrides: Partial<typeof CONFIG> = {}) {
  const profile = new CustomerProfileHttpClient({ config: { ...CONFIG, ...overrides }, fetch, now: () => NOW });
  const deps: CustomerCapabilityV3Dependencies = {
    bindings: { bindingByTask: vi.fn(() => Promise.resolve(binding)), taskState: vi.fn(() => Promise.resolve({ status: 'running' as const, terminalIntent: false, humanOwned: false })) },
    identity: { resolve: vi.fn(() => Promise.resolve(verified)) },
    profile,
    now: () => NOW,
  };
  const registry = new CapabilityRegistry();
  registry.register(customerContextV3Capability(deps));
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: 'j5-test', destination: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) } });
  const clock = new FakeClock(NOW.toISOString());
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger });
  const observation = await invoker.invoke({ capabilityId: 'customer.get_context', capabilityVersion: 3, arguments: {} }, context);
  const completed = lines.find((line) => line.event === 'capability.invocation.completed');
  return { observation, completed };
}

function expectOpaque(observation: Observation, category: string) {
  expect(GENERIC_MESSAGES).toContain(observation.error?.message);
  const details = observation.error?.details as Record<string, unknown>;
  expect(Object.keys(details).sort()).toEqual(['category', 'code', 'retryable']);
  expect(details.category).toBe(category);
  const serialized = JSON.stringify(observation.error);
  for (const internal of ['127.0.0.1', 'localhost', '4310', 'ECONNREFUSED', 'ENOTFOUND', 'HTTP', 'httpStatus', 'ownerCode', 'requiredScope', 'customer.sales_context.read', TOKEN, GRANT_TOKEN, REF, 'fetch failed', 'stack']) {
    expect(serialized, internal).not.toContain(internal);
  }
}

const refused = (code: string): CustomerProfileFetch => () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code, message: `connect ${code} 127.0.0.1:4310` } }));

describe('Customer Profile failures reach the observation typed and opaque (R4-J5)', () => {
  it.each([
    ['connection refused', refused('ECONNREFUSED'), 'dependency_unavailable', 'temporarily_unavailable'],
    ['DNS failure', refused('ENOTFOUND'), 'dependency_unavailable', 'temporarily_unavailable'],
    ['HTTP 401', () => answer(401, { error: 'unauthorized' }), 'dependency_unauthorized', 'unauthorized'],
    ['HTTP 403', () => answer(403, { error: 'forbidden', requiredScope: 'customer.sales_context.read' }), 'dependency_unauthorized', 'unauthorized'],
    ['HTTP 403 grant_rejected', () => answer(403, { error: 'grant_rejected' }), 'dependency_unauthorized', 'unauthorized'],
    ['a 200 that is not JSON', () => answer(200, '<html>HTTP 200 from 127.0.0.1</html>', { 'content-type': 'text/html' }), 'dependency_contract_violation', 'contract_violation'],
    ['a 200 outside the contract', () => answer(200, { schemaVersion: 'customer-sales-context-v1', unexpected: true }), 'dependency_contract_violation', 'contract_violation'],
    ['HTTP 500', () => answer(500, { error: 'internal_error' }), 'dependency_unavailable', 'temporarily_unavailable'],
    ['HTTP 502 without body', () => answer(502, '', { 'content-type': 'text/plain' }), 'dependency_unavailable', 'temporarily_unavailable'],
    ['HTTP 503 not degraded', () => answer(503, 'Service Unavailable', { 'content-type': 'text/plain' }), 'dependency_unavailable', 'temporarily_unavailable'],
  ] as [string, CustomerProfileFetch, string, string][])('%s → %s', async (_name, fetch, code, category) => {
    const { observation, completed } = await invokeWith(fetch);
    expect(observation.outcome).toBe('failed');
    expect(observation.error?.code).toBe(code);
    expect(completed).toMatchObject({ capabilityId: 'customer.get_context', outcome: 'failed', errorCode: code });
    expectOpaque(observation, category);
  });

  it('the adapter deadline → dependency_timeout', async () => {
    const silent: CustomerProfileFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const { observation, completed } = await invokeWith(silent, { timeoutMs: 30 });
    expect(observation.error?.code).toBe('dependency_timeout');
    expect(completed).toMatchObject({ errorCode: 'dependency_timeout' });
    expectOpaque(observation, 'timeout');
  });

  it('a real refused TCP connection (the J4-R5 canary case) → dependency_unavailable', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const realFetch: CustomerProfileFetch = (url, init) => fetch(url, init).then((r) => ({ status: r.status, headers: r.headers, body: r.body }));
    const { observation, completed } = await invokeWith(realFetch, { baseUrl: `http://127.0.0.1:${port}` });
    expect(observation.error?.code).toBe('dependency_unavailable');
    expect(completed).toMatchObject({ errorCode: 'dependency_unavailable' });
    expectOpaque(observation, 'temporarily_unavailable');
    expect(JSON.stringify(observation.error)).not.toContain(String(port));
  });
});
