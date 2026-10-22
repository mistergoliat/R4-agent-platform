import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { migrateIdentityVerification } from '@r4-adapters/identity-verification';
import { CapabilityInvoker } from '@r4/capability-runtime';
import type { TrustedExecutionContext } from '@r4/contracts';
import { loadProductionConfig } from '@r4/live-ops';
import { FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, ContextView, read, respond, type ScriptedStep } from '@r4-sales/agent';
import { createPool } from '@r4/persistence-postgres';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryGateway, startCanaryRuntime, syntheticConversationKey, type CanaryEnvironment, type CanaryRuntime } from '@r4-sales/agent/canary';
import { SALES_PRODUCTION_PROFILE_V8, assertSalesProductionPrerequisites, composeSalesProductionWorker } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { FakeClock, idsFrom } from '../support/deterministic.js';
import { LiveOpsTestbed, OPERATOR, keyOf } from '../support/live-ops.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';
import { RECONCILIATION_POLICY } from '../support/temporal.js';
import { GRANT_TOKEN, fixture, grantVerified } from '../unit/customer-profile/support.js';

/**
 * R4-J4-R4: sales-production@8 against PostgreSQL, synthetic only. The CIA and Customer Profile are
 * in-process HTTP stubs answering with the owners' pinned shapes (no network, no real data); Catalog,
 * Shipping and Quote V2 are the fixture owners as HTTP-kind ports; the model is scripted.
 *
 *   A  end to end in the isolated local runtime: CIA verified, Customer Profile DOWN → the guest quote is
 *      still issued (ADR-039 §9, I7); the task runs definition v8.
 *   B  the degradation matrix through the @8 registry over the real binding and task state.
 *   C  what a v8 process checks before it starts, and the gateway guard of the ADR-040 addendum.
 */
const logger = createSilentLogger();
const CIA = 'http://127.0.0.1:8787';
const CP = 'http://127.0.0.1:3010';
const CUSTOMER_ENV = {
  R4_CUSTOMER_MODE: 'synthetic',
  R4_CUSTOMER_IDENTITY_BASE_URL: CIA,
  R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001',
  R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '300',
  R4_CUSTOMER_PROFILE_BASE_URL: CP,
  R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij',
  R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
};

type CiaMode = 'verified' | 'not_verified' | 'down' | 'hang';
type CpMode = 'available' | 'expired' | 'grant_rejected' | 'down';

/** The CIA (resolve) and Customer Profile (sales-context) as in-process stubs; every call is recorded. */
function owners() {
  const state = { cia: 'verified' as CiaMode, cp: 'available' as CpMode, calls: [] as string[] };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const now = Date.now();
    if (url.startsWith(CIA)) {
      state.calls.push('cia');
      if (state.cia === 'down') throw new TypeError('fetch failed');
      if (state.cia === 'hang') return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error)));
      const resolvedAt = new Date(now - 1_000).toISOString();
      if (state.cia === 'not_verified') return json(200, { schemaVersion: 1, status: 'not_verified', resolvedAt });
      const { purposes } = JSON.parse(init.body as string) as { purposes: string[] };
      return json(200, { schemaVersion: 1, status: 'verified', customerRef: 'prestashop_customer:900000201', grant: { token: GRANT_TOKEN, expiresAt: new Date(now + 240_000).toISOString(), purposes }, resolvedAt });
    }
    if (url.startsWith(CP)) {
      state.calls.push('cp');
      if (state.cp === 'down') return json(503, { error: 'temporarily_unavailable' });
      if (state.cp === 'grant_rejected') return json(403, { error: 'grant_rejected' });
      const body = grantVerified(fixture('sales-context-available-with-purchases.json')) as { freshness: { asOf: string; validUntil: string } };
      body.freshness.asOf = new Date(now - 2_000).toISOString();
      body.freshness.validUntil = new Date(state.cp === 'expired' ? now - 1_000 : now + 120_000).toISOString();
      return json(200, body);
    }
    throw new Error(`unexpected call to ${url}`);
  };
  return { state, fetch };
}

// ── A ────────────────────────────────────────────────────────────────────────────────────────────

const IDENTITY_KEY = 'r4-test-canary-identity-key-profile-v8-000001';
const LIMITS = {
  R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '500000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '5',
  R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '1', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '20', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900',
};
let canaryDb: TestDatabase;
let captureDir: string;

function canaryEnv(profile: string): Record<string, string> {
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@7', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: canaryDb.url, R4_LOG_LEVEL: 'silent', R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'exclude', ...LIMITS,
  };
  return { ...base, R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_ALLOWLIST: syntheticConversationKey(loadCanaryEnvironment(base), 'v8-cp-down') };
}

/** The @8 canary environment (R4-J4-R5 preparation: the J4 expired-evidence policy `exclude`, required for @8). */
function v8Environment(): CanaryEnvironment {
  const canary = loadCanaryEnvironment(canaryEnv('sales-production@8'));
  expect(canary).toMatchObject({ profile: SALES_PRODUCTION_PROFILE_V8, contextExpiredEvidence: 'exclude' });
  return canary;
}

/** The gateway-role environment of the canary's single gateway and inspected ingest (the worker never holds it). */
const GATEWAY_ENV = { R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: CIA, R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'synthetic-channel-confirm-token-0001', R4_PROD_VERIFICATION_CODE_KEYS: `k1:${Buffer.alloc(32, 3).toString('base64')}` };

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };

function scripted(steps: readonly ScriptedStep[]): FakeModelScript {
  let next = 0;
  return (request) => {
    const step = steps[next++];
    if (!step) return { type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'end of the scenario' } };
    return { type: 'structured', data: step(new ContextView(request)) };
  };
}

const workspace = (operations: (v: ContextView) => unknown[]): ScriptedStep => (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations: operations(v) } });
const ORDER = [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'BAR-EZ', quantity: 2 }];
const latest = (v: ContextView, capabilityId: string) => v.observations(capabilityId).filter((o) => o.outcome === 'succeeded').at(-1)!;
const courier = (v: ContextView) => (latest(v, CAPABILITY_IDS.shippingQuote).payload as { offers: { carrierName: string; serviceType: string; price: { ownerNet: { amount: number } } }[] }).offers.find((o) => o.carrierName === 'Fixture Courier')!;
const preview = (v: ContextView) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload as { previewId: string; presentation: { offerMessage: string } };

describe('A. sales-production@8 end to end: Customer Profile down never blocks the guest quote', () => {
  beforeAll(async () => {
    captureDir = mkdtempSync(join(tmpdir(), 'r4-profile-v8-'));
    canaryDb = await createTestDatabase('r4_it_profile_v8_canary');
    const init = await initCanary(loadCanaryEnvironment(canaryEnv('sales-production@7')), logger);
    expect(init.definitions.registered).toEqual(expect.arrayContaining(['sales@8']));
    // (R4-J4-R5 preparation) The canary init migrates the identity-verification schema, so the v8 prerequisite holds.
    expect(init.migrations.identityVerification.length).toBeGreaterThan(0);
    const pool = openPool(canaryDb.url);
    try {
      await assertSalesProductionPrerequisites(SALES_PRODUCTION_PROFILE_V8, pool);
    } finally {
      await pool.end();
    }
    // A core database without the identity-verification schema is refused for v8.
    const bare = await createMigratedTestDatabase();
    const barePool = openPool(bare.url);
    try {
      await expect(assertSalesProductionPrerequisites(SALES_PRODUCTION_PROFILE_V8, barePool)).rejects.toThrow(/identity-verification migrations/);
      await migrateIdentityVerification(barePool);
      await assertSalesProductionPrerequisites(SALES_PRODUCTION_PROFILE_V8, barePool);
    } finally {
      await barePool.end();
      await bare.drop();
    }
  });

  afterAll(async () => {
    await canaryDb?.drop();
  });

  it('CIA verified, Customer Profile 503: customer.get_context fails, the quote is issued for a guest, autonomously, once', async () => {
    const canary = v8Environment();
    const gateway = await startCanaryGateway(canary, {
      env: GATEWAY_ENV, logger, openPool: (name) => createPool({ connectionString: canaryDb.url, logger, applicationName: `r4-sales-canary:${name}`, max: 2 }),
      transport: () => Promise.reject(new Error('no confirm in this scenario')),
    });
    const stubs = owners();
    stubs.state.cp = 'down';
    const quotes = new FixtureQuoteV2Service();
    const steps: ScriptedStep[] = [
      read(CAPABILITY_IDS.customerContext, {}),
      workspace(() => [...ORDER.map((i) => ({ op: 'add_item', ...i })), { op: 'set_delivery_destination', commune: 'Ñuñoa' }]),
      read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, basis: 'order', items: ORDER }),
      respond((v) => `Despacho a Ñuñoa: ${courier(v).carrierName} ${courier(v).serviceType}. ¿Cuál prefieres?`),
      workspace((v) => [{ op: 'select_shipping_offer', carrierName: courier(v).carrierName, serviceType: courier(v).serviceType, ownerNetClp: courier(v).price.ownerNet.amount }]),
      read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}),
      respond((v) => preview(v).presentation.offerMessage),
      (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: preview(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] }),
      respond('Listo.'),
    ];
    const runtime: CanaryRuntime = await startCanaryRuntime(canary, {
      modelProvider: new FakeModelProvider(scripted(steps)), catalog: http(new FixtureCatalog()), shipping: http(new FixtureShipping()), quotes: http(quotes),
      worker: {
        databaseUrl: canaryDb.url, logLevel: 'silent', dbPoolMax: 3, workerId: 'profile-v8:cp-down', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
        execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 50 },
        context: { budget: { mode: 'unbounded' }, expiredEvidence: 'exclude' },
      },
      scheduler: { databaseUrl: canaryDb.url, logLevel: 'silent', dbPoolMax: 2, owner: 'profile-v8:scheduler', leaseMs: 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY },
      captureFile: join(captureDir, 'cp-down.jsonl'), logger, isolationCheckMs: 50,
      customer: { env: CUSTOMER_ENV, fetch: stubs.fetch },
    });
    const pool = openPool(canaryDb.url);
    const drain = async () => {
      for (let i = 0; i < 30; i += 1) {
        const fired = (await runtime.scheduler?.scheduler.runOnce())?.kind === 'fired';
        if ((await runtime.worker.worker.runOnce()).kind === 'idle' && !fired) break;
      }
      await runtime.delivery.tick();
    };
    try {
      const { taskId } = (await sendSynthetic(canary, { conversation: 'v8-cp-down', text: 'Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa' }, logger, undefined, GATEWAY_ENV)) as { taskId: string };
      await drain();
      await sendSynthetic(canary, { conversation: 'v8-cp-down', text: 'Fixture Courier normal' }, logger, undefined, GATEWAY_ENV);
      await drain();
      await sendSynthetic(canary, { conversation: 'v8-cp-down', text: 'Sí, emítela.' }, logger, undefined, GATEWAY_ENV);
      await drain();

      expect((await pool.query('select agent_version from agent_tasks where task_id = $1', [taskId])).rows).toEqual([{ agent_version: 8 }]);
      expect(stubs.state.calls).toEqual(['cia', 'cp']);
      expect((await pool.query("select capability_version, outcome, error_code from observations where task_id = $1 and capability_id = 'customer.get_context'", [taskId])).rows).toEqual([{ capability_version: 3, outcome: 'failed', error_code: expect.any(String) as string }]);
      expect(quotes.quotes).toHaveLength(1);
      expect((await pool.query("select capability_version, outcome, reason_code, policy_id from policy_decisions where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ capability_version: 5, outcome: 'allow', reason_code: 'autonomous', policy_id: 'sales-production-autonomous-policy' }]);
      expect((await pool.query("select status from action_receipts where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ status: 'succeeded' }]);
      expect((await pool.query<{ customer: { kind: string } }>("select request->'customer' as customer from sales.quote_v2_requests where task_id = $1", [taskId])).rows).toEqual([{ customer: { kind: 'guest' } }]);
      expect((await pool.query('select count(*)::int as n from human_requests where task_id = $1', [taskId])).rows[0]).toEqual({ n: 0 });
    } finally {
      await pool.end();
      await runtime.close();
      await gateway.close();
    }
  });
});

// ── B ────────────────────────────────────────────────────────────────────────────────────────────

const CUSTOMER = '56933334444';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

/** The @8 registry (the real composition) over the bed's real store, invoked through the real CapabilityInvoker. */
function v8Registry(testbed: LiveOpsTestbed) {
  const stubs = owners();
  const { bindings } = composeSalesProductionWorker({
    pool: testbed.pool, store: testbed.store, production: loadProductionConfig({ ...testbed.env, R4_PROD_POLICY_PROFILE: 'sales-production@8', ...LIMITS }),
    modelProvider: testbed.model, logger, catalog: http(new FixtureCatalog()), shipping: http(new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()),
    autonomousQuoteLimits: { maxGrossClp: 500_000, maxLines: 3, maxUnitsPerLine: 5, maxQuotesPerConversation: 1, maxQuotesPerHour: 20, maxTotalUnits: 5, confirmationWindowSeconds: 900 },
    customer: { env: CUSTOMER_ENV, fetch: stubs.fetch },
  });
  const clock = new FakeClock(new Date().toISOString());
  const invoker = new CapabilityInvoker({ registry: bindings.capabilities, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock: { now: () => new Date() }, logger });
  const context = (taskId: string): TrustedExecutionContext => ({ taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 8, correlationId: 'j4-r4-b5', grantedScopes: ['customer.read', 'identity.verify'] });
  const invoke = (capabilityId: string, capabilityVersion: number, taskId: string) => invoker.invoke({ capabilityId, capabilityVersion, arguments: {} }, context(taskId));
  return { stubs, invoke, context: (taskId: string) => invoke('customer.get_context', 3, taskId), status: (taskId: string) => invoke('identity.verification_status', 1, taskId) };
}

describe('B. degradation matrix of sales-production@8 (real binding and task state)', () => {
  it('anonymous, provisional, verified, grant rejected, CIA down, CP down, timeout, expired context, cancelled task, changed binding', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, identityVerification: { requested: 'protect_only', codeKeys: null } });
    await bed.customer(CUSTOMER, 'wamid.v8.0', 'hola');
    const taskId = await bed.taskOf(CUSTOMER);
    const r = v8Registry(bed);
    // A failed observation as the model sees it: the owner category and code (no payload, no partial data).
    const outcome = async (run: () => Promise<{ outcome: string; payload?: unknown; error?: { code: string; details?: unknown } | null }>) => {
      const o = await run();
      if (o.outcome === 'succeeded') return o.payload;
      const details = (o.error?.details ?? {}) as { category?: string; code?: string };
      return { outcome: o.outcome, category: details.category, code: details.code };
    };

    // anonymous: a task with no channel binding → no CIA, no Customer Profile.
    r.stubs.state.calls.length = 0;
    expect(await outcome(() => r.context(randomUUID()))).toEqual({ identity: 'unavailable', reason: 'anonymous' });
    expect(r.stubs.state.calls).toEqual([]);
    // provisional: the channel subject is not verified by the CIA → no Customer Profile call.
    r.stubs.state.cia = 'not_verified';
    expect(await outcome(() => r.context(taskId))).toEqual({ identity: 'unavailable', reason: 'not_verified' });
    expect(r.stubs.state.calls).toEqual(['cia']);
    // verified.
    r.stubs.state.cia = 'verified';
    r.stubs.state.cp = 'available';
    expect(await outcome(() => r.context(taskId))).toMatchObject({ identity: 'verified', purchaseHistory: 'present' });
    // grant rejected by Customer Profile.
    r.stubs.state.cp = 'grant_rejected';
    const rejected = await outcome(() => r.context(taskId));
    // CIA down, Customer Profile down, CIA timeout.
    r.stubs.state.cp = 'available';
    r.stubs.state.cia = 'down';
    const ciaDown = await outcome(() => r.context(taskId));
    r.stubs.state.cia = 'verified';
    r.stubs.state.cp = 'down';
    const cpDown = await outcome(() => r.context(taskId));
    r.stubs.state.cp = 'available';
    r.stubs.state.cia = 'hang';
    const timeout = await outcome(() => r.context(taskId));
    // expired context: Customer Profile answers with a validUntil already past.
    r.stubs.state.cia = 'verified';
    r.stubs.state.cp = 'expired';
    const expired = await outcome(() => r.context(taskId));
    expect({ rejected, ciaDown, cpDown, timeout, expired }).toEqual({
      rejected: { outcome: 'failed', category: 'unauthorized', code: 'profile_unauthorized' },
      ciaDown: { outcome: 'failed', category: 'temporarily_unavailable', code: 'identity_unreachable' },
      cpDown: { outcome: 'failed', category: 'temporarily_unavailable', code: 'profile_unavailable' },
      timeout: { outcome: 'failed', category: 'timeout', code: 'deadline_exceeded' },
      // Facts already expired on arrival are refused (never presented as current); see the J4-R4 report on ADR-039 Cond. 3.
      expired: { outcome: 'failed', category: 'contract_violation', code: 'freshness_expired' },
    });

    // identity.verification_status of a bound task with no verification: none.
    expect(await outcome(() => r.status(taskId))).toEqual({ status: 'none' });

    // cancelled task, then a new inbound opens a NEW binding: the old task is anonymous, with no owner call.
    await bed.api.temporal.cancelTask(taskId, OPERATOR);
    r.stubs.state.cp = 'available';
    r.stubs.state.calls.length = 0;
    expect(await outcome(() => r.context(taskId))).toEqual({ identity: 'unavailable', reason: 'anonymous' });
    expect(await outcome(() => r.status(taskId))).toEqual({ status: 'none' });
    expect(r.stubs.state.calls).toEqual([]);
    await bed.customer(CUSTOMER, 'wamid.v8.1', 'hola de nuevo');
    const current = (await bed.store.findOpenBinding('whatsapp', keyOf(CUSTOMER)))!;
    expect(current.taskId).not.toBe(taskId);
    expect(await outcome(() => r.context(taskId))).toEqual({ identity: 'unavailable', reason: 'anonymous' });
    expect(await outcome(() => r.context(current.taskId!))).toMatchObject({ identity: 'verified' });
  }, 120_000);
});

// ── C ────────────────────────────────────────────────────────────────────────────────────────────

describe('C. the v8 process prerequisites and the gateway guard (ADR-040 addendum)', () => {
  it('a gateway without the inspector refuses to start while the component mode is full, even with no protection window; protect_only first, then absent', async () => {
    bed = await LiveOpsTestbed.start({ identityVerification: { requested: 'full', codeKeys: `k1:${Buffer.alloc(32, 9).toString('base64')}`, confirm: { confirm: () => Promise.reject(new Error('unused')) } } });
    expect(bed.gateway.inspection?.mode).toBe('full');
    expect((await bed.rows("select count(*)::int as n from identity_verification.expectations where protect_until > clock_timestamp()"))[0]).toEqual({ n: 0 });
    await expect(bed.recomposeGateway(undefined)).rejects.toMatchObject({ code: 'identity_verification_mode_full' });
    await bed.recomposeGateway({ requested: 'protect_only', codeKeys: null });
    await bed.recomposeGateway(undefined);
    expect(bed.gateway.inspection).toBeNull();
  }, 120_000);
});
