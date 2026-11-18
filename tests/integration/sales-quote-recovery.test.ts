import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompiledContext } from '@r4/contracts';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { createPlatform } from '@r4/api';
import { CaseIdleCloser } from '@r4/live-ops';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, ContextView, QUOTE_RECOVERY_SOURCE_ID, SALES_AGENT_DIR, read, respond, type ScriptedStep } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryRuntime, syntheticConversationKey, type CanaryEnvironment } from '@r4-sales/agent/canary';
import { SALES_F1_CANARY_LIMITS } from '@r4-sales/agent/production';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { RECONCILIATION_POLICY, freezeTemporalClock } from '../support/temporal.js';

/**
 * M3 — quote recovery. A quote issued in a conversation (sales-production@22, the only profile it is composed on; isolated canary: real ingress, worker,
 * Policy Engine, ActionExecutor, delivery owner; scripted model; fixture owners) is shown to the agent when the
 * customer writes again — later in the same task and in a new task of the same conversation after the case idle close
 * (#97) — with its CURRENT state read from the Quote V2 owner (expired once its validity ends). Read-only: nothing is
 * re-issued, and the earlier offer cannot be accepted again.
 */
const logger = createSilentLogger();
let db: TestDatabase | null = null;
afterEach(async () => {
  await db?.drop();
  db = null;
});

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };
const L = SALES_F1_CANARY_LIMITS;
function canaryEnv(url: string, extra: Record<string, string>): Record<string, string> {
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@22', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'r4-test-canary-identity-key-recovery-01',
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: url, R4_LOG_LEVEL: 'silent',
    R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: String(L.maxGrossClp), R4_AUTONOMOUS_QUOTE_MAX_LINES: String(L.maxLines), R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: String(L.maxUnitsPerLine),
    R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: String(L.maxTotalUnits), R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: String(L.maxQuotesPerConversation),
    R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: String(L.maxQuotesPerHour), R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: String(L.confirmationWindowSeconds),
    ...extra,
  };
  return { ...base, R4_PROD_ROLLOUT_ALLOWLIST: ['recovery', 'other'].map((c) => syntheticConversationKey(loadCanaryEnvironment(base), c)).join(',') };
}

class Router {
  readonly #routes = new Map<string, { steps: ScriptedStep[]; next: number }>();
  readonly script: FakeModelScript = (request) => {
    const taskId = (request.context!.sections.task.find((i) => i.kind === 'task')!.content as { taskId: string }).taskId;
    const route = this.#routes.get(taskId);
    const step = route?.steps[route.next++];
    if (!step) return Promise.resolve({ type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'script done' } });
    return Promise.resolve({ type: 'structured', data: step(new ContextView(request)) });
  };
  route(taskId: string, steps: readonly ScriptedStep[]): void {
    const route = this.#routes.get(taskId);
    if (route) route.steps.push(...steps);
    else this.#routes.set(taskId, { steps: [...steps], next: 0 });
  }
}

const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('not used here')) };
const ws = (operations: unknown[]): ScriptedStep => () => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations } });
const latest = (v: ContextView, id: string) => v.observations(id).filter((o) => o.outcome === 'succeeded').at(-1)!;
const preview = (v: ContextView) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload as { previewId: string; presentation: { offerMessage: string } };
const propose: ScriptedStep = (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: preview(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] });
const ISSUE = [ws([{ op: 'add_item', productId: 'BAR-EZ', quantity: 2 }]), ws([{ op: 'exclude_shipping' }]), read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), respond((v) => preview(v).presentation.offerMessage), propose, respond('Listo, te envié la cotización.')];

type Recovery = { quotes: { quoteNumber: string; state: string; stillValid: boolean | null; stateFrom: string; earlierTask: boolean; items: unknown[] }[] };
/** A model step (by default an answer) that records the quote-recovery state it was shown (undefined when absent). */
function shown(inner: ScriptedStep = respond('Te cuento cómo está tu cotización.')): { step: ScriptedStep; seen: () => (Recovery | undefined)[] } {
  const seen: (Recovery | undefined)[] = [];
  return {
    step: (v) => {
      const context: CompiledContext = v.context;
      seen.push(context.sections.authoritativeState.find((i) => i.sourceId === QUOTE_RECOVERY_SOURCE_ID)?.content as Recovery | undefined);
      return inner(v);
    },
    seen: () => seen,
  };
}

async function conversation(env: Record<string, string>) {
  db = await createTestDatabase('r4_it_recovery_canary');
  let now = new Date();
  const quotes = new FixtureQuoteV2Service({ now: () => now });
  const canary: CanaryEnvironment = loadCanaryEnvironment(canaryEnv(db.url, env));
  await initCanary(canary, logger);
  const router = new Router();
  let ownerCreates = 0;
  const issue = quotes.createAndIssue.bind(quotes);
  quotes.createAndIssue = (...a: Parameters<typeof issue>) => ((ownerCreates += 1), issue(...a));
  const runtime = await startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(new FixtureCatalog()), catalogDiscover: discover, shipping: http(new FixtureShipping()), quotes: http(quotes),
    worker: {
      databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 3, workerId: 'recovery', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
      execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 6 },
      context: { budget: { mode: 'unbounded' } },
    },
    scheduler: { databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 2, owner: 'recovery:scheduler', leaseMs: 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY },
    captureFile: join(mkdtempSync(join(tmpdir(), 'r4-recovery-')), 'capture.jsonl'), logger, isolationCheckMs: 50,
  });
  const drain = async () => {
    for (let i = 0; i < 40; i += 1) {
      const fired = (await runtime.scheduler?.scheduler.runOnce())?.kind === 'fired';
      if ((await runtime.worker.worker.runOnce()).kind === 'idle' && !fired) break;
    }
    await runtime.delivery.tick();
    await runtime.delivery.tick();
  };
  /** The customer writes; `steps` answer it in the task the message lands in. */
  const say = async (text: string, steps: readonly ScriptedStep[], from = 'recovery') => {
    const { taskId } = (await sendSynthetic(canary, { conversation: from, text }, logger)) as { taskId: string };
    router.route(taskId, steps);
    await drain();
    return taskId;
  };
  const rows = async <T>(sql: string) => {
    const pool = openPool(db!.url);
    try {
      return (await pool.query(sql)).rows as T[];
    } finally {
      await pool.end();
    }
  };
  /** (#97) The gateway's idle-case sweep, 25 h of temporal time after the newest input (r4_now() frozen there). */
  const idleClose = async () => {
    const pool = openPool(db!.url);
    const platform = await createPlatform({ databaseUrl: db!.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 2 }, { logger });
    try {
      const at = (await pool.query<{ at: Date }>('select max(received_at) as at from task_inputs')).rows[0]!.at;
      await freezeTemporalClock(pool, new Date(at.getTime() + 25 * 3_600_000));
      const channel = (await pool.query<{ channel: string }>('select channel from channel_conversation_bindings limit 1')).rows[0]!.channel;
      return await new CaseIdleCloser({ store: new PostgresProductionStore(pool), temporal: platform.temporal, channel, idleForMs: 24 * 3_600_000, logger }).sweep();
    } finally {
      await platform.close();
      await pool.end();
    }
  };
  return { quotes, say, rows, idleClose, close: () => runtime.close(), ownerCreates: () => ownerCreates, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('quote recovery (M3, sales-production@22)', { timeout: 150_000 }, () => {
  it('a returning customer sees the quote with its CURRENT owner state — expired after its validity — in the same task and in the new task after an idle close; nothing is re-issued', async () => {
    const c = await conversation({ R4_SALES_QUOTE_RECOVERY: 'enabled' });
    try {
      // Another contact's quote (PC-000001) never appears in this conversation.
      await c.say('Quiero 2 barras Z, sin despacho', ISSUE.slice(0, 4), 'other');
      await c.say('si dale', ISSUE.slice(4), 'other');
      const view = shown(ISSUE[0]);
      const first = await c.say('Quiero 2 barras Z, sin despacho', [view.step, ...ISSUE.slice(1, 4)]);
      let earlierPreviewId = '';
      await c.say('si dale', [(v) => ((earlierPreviewId = preview(v).previewId), propose(v)), ISSUE[5]!]);
      expect(c.ownerCreates()).toBe(2);
      // Before the quote existed, nothing was shown.
      expect(view.seen()).toEqual([undefined]);

      // Same task, still valid.
      const valid = shown();
      expect(await c.say('¿Me confirmas el total?', [valid.step])).toBe(first);
      expect(valid.seen()[0]!.quotes).toEqual([expect.objectContaining({ quoteNumber: 'PC-000002', state: 'issued', stillValid: true, stateFrom: 'quote_owner', earlierTask: false, items: [expect.objectContaining({ itemKey: 'BAR-EZ', quantity: 2 })] })]);

      // Same task, after the validity ended.
      c.advance(6 * 86_400_000);
      const expired = shown();
      await c.say('Hola, ¿sigue vigente mi cotización?', [expired.step]);
      expect(expired.seen()[0]!.quotes[0]).toMatchObject({ quoteNumber: 'PC-000002', state: 'expired', stillValid: false, stateFrom: 'quote_owner' });

      // (#97) 25 h without a contact message: the case closes idle_timeout (cancelled task, closed binding).
      expect((await c.idleClose()).closed).toBe(2);
      expect(await c.rows(`select status, status_reason from agent_tasks where task_id = '${first}'`)).toEqual([{ status: 'cancelled', status_reason: 'idle_timeout' }]);

      // The next message opens a new task of the same conversation: the quote of the cancelled task is found and shown expired.
      const later = shown();
      const second = await c.say('Hola de nuevo, quiero retomar la cotización', [later.step]);
      expect(second).not.toBe(first);
      expect(later.seen()[0]!.quotes).toEqual([expect.objectContaining({ quoteNumber: 'PC-000002', state: 'expired', stillValid: false, earlierTask: true })]);
      expect(later.seen()[0]!.quotes[0]).not.toHaveProperty('totalGrossClp');

      // Recovering never issues: the customer says yes to the OLD quote and the agent even proposes it again with the
      // earlier previewId — refused, since an issuance needs a quote.preview and its offer accepted in this task.
      await c.say('sí, mándamela de nuevo', [() => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: earlierPreviewId }, evidenceRefs: [] }), respond('Esa ya venció; te preparo una actualizada con el precio de hoy.')]);
      expect(c.ownerCreates()).toBe(2);
      expect(await c.rows('select quote_number from sales.quote_v2_issued order by quote_number')).toEqual([{ quote_number: 'PC-000001' }, { quote_number: 'PC-000002' }]);
      expect(await c.rows(`select count(*)::int as n from action_receipts where capability_id = 'quote.create' and status = 'succeeded'`)).toEqual([{ n: 2 }]);
    } finally {
      await c.close();
    }
  });

  it('is off by default: without R4_SALES_QUOTE_RECOVERY the context carries no quote-recovery state', async () => {
    const c = await conversation({});
    try {
      await c.say('Quiero 2 barras Z, sin despacho', ISSUE.slice(0, 4));
      await c.say('si dale', ISSUE.slice(4));
      const view = shown();
      await c.say('¿Me confirmas el total?', [view.step]);
      expect(c.ownerCreates()).toBe(1);
      expect(view.seen()).toEqual([undefined]);
    } finally {
      await c.close();
    }
  });
});
