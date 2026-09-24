import { randomBytes } from 'node:crypto';
import { createPlatform } from '@r4/api';
import { createGatewayPlatform, type GatewayPlatform } from '@r4/channel-gateway';
import type { TrustedHumanContext } from '@r4/contracts';
import { PostgresTrajectoryReader } from '@r4/evaluator';
import { FakeModelProvider, type FakeModelStep } from '@r4/model-gateway';
import { createLogger } from '@r4/observability';
import { PostgresProductionStore, createPool, type Pool } from '@r4/persistence-postgres';
import { conversationKey, loadProductionConfig, productionConfigFingerprint, profileFingerprint, profileLabel, rolloutFingerprint, type ProductionMetrics } from '@r4/live-ops';
import { createWorkerPlatform, type WorkerPlatform } from '@r4/worker';
import { FakeWhatsAppProvider, notification, signNotification } from '@r4-adapters/whatsapp-cloud/testing';
import { SALES_AGENT_DIR } from '../definition.js';
import { SCRIPTED_MODEL_PROFILE, evaluateSalesSubject, salesWorkspaceProjection } from '../evaluations/index.js';
import { createScenarioDatabase } from '../harness/database.js';
import { composeSalesGateway, composeSalesProductionWorker } from '../production/composition.js';
import { SALES_PRODUCTION_PROFILE } from '../production/profile.js';
import { PostgresSalesStore } from '../workspace/store.js';

/**
 * Offline production validation (R4-I): the real production composition —
 * API, channel gateway, production worker, delivery owner — over a
 * disposable database, a scripted stand-in model and a LOCAL fake of the
 * channel provider. No network, no credentials, no real person. Produces the
 * evidence of `artifacts/production-validation/<id>/`.
 */
export const VALIDATION_SECRETS = { appSecret: `validation-app-${randomBytes(6).toString('hex')}`, accessToken: `validation-token-${randomBytes(6).toString('hex')}`, verifyToken: `validation-verify-${randomBytes(6).toString('hex')}`, identityKey: `validation-identity-${randomBytes(16).toString('hex')}` };
const PHONE = '1098765432';
const OPERATOR: TrustedHumanContext = { humanRef: 'validation-operator', scopes: ['handoff.manage', 'task.cancel', 'reconciliation.manage', 'autonomy.control', 'consultation.answer', 'approval.decide'], correlationId: 'production-validation' };

export interface CheckResult {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly CheckResult[];
  readonly metrics: ProductionMetrics;
  readonly evaluation: { readonly technical: string; readonly governance: string; readonly findings: readonly string[] } | null;
}

interface Bed {
  readonly pool: Pool;
  readonly gateway: GatewayPlatform;
  readonly worker: WorkerPlatform;
  readonly provider: FakeWhatsAppProvider;
  readonly store: PostgresProductionStore;
  readonly queue: FakeModelStep[];
  readonly env: Record<string, string>;
  readonly close: () => Promise<void>;
  readonly api: Awaited<ReturnType<typeof createPlatform>>;
}

const say = (content: string): FakeModelStep => ({ type: 'structured', data: { type: 'respond', content } });
const waitInput = (): FakeModelStep => ({ type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'waiting for the contact' } });
const invalid = (): FakeModelStep => ({ type: 'structured', data: { type: 'respond' } });

async function bed(adminUrl: string, options: { allow: readonly string[]; autonomy: boolean; providerTimeoutMs?: number }): Promise<Bed> {
  const db = await createScenarioDatabase(adminUrl, 'r4_prodval');
  const logger = createLogger({ service: 'production-validation', level: 'silent' });
  const pool = createPool({ connectionString: db.url, logger, applicationName: 'production-validation', max: 4 });
  const provider = new FakeWhatsAppProvider({ accessToken: VALIDATION_SECRETS.accessToken });
  await provider.start();
  const env: Record<string, string> = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profileLabel(SALES_PRODUCTION_PROFILE), R4_PROD_ROLLOUT_PERCENT: '0',
    R4_PROD_ROLLOUT_ALLOWLIST: options.allow.map((w) => conversationKey(VALIDATION_SECRETS.identityKey, 'whatsapp', PHONE, w)).join(','),
    R4_PROD_IDENTITY_HASH_KEY: VALIDATION_SECRETS.identityKey, R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_PROD_PROVIDER_TIMEOUT_MS: String(options.providerTimeoutMs ?? 2000),
    R4_WHATSAPP_APP_SECRET: VALIDATION_SECRETS.appSecret, R4_WHATSAPP_VERIFY_TOKEN: VALIDATION_SECRETS.verifyToken, R4_WHATSAPP_ACCESS_TOKEN: VALIDATION_SECRETS.accessToken,
    R4_WHATSAPP_PHONE_NUMBER_ID: PHONE, R4_WHATSAPP_GRAPH_BASE_URL: provider.baseUrl,
  };
  const production = loadProductionConfig(env);
  const api = await createPlatform({ databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 3 }, { logger, humanContext: () => OPERATOR });
  const store = new PostgresProductionStore(pool);
  const gateway = await createGatewayPlatform({ databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', dbPoolMax: 3, gatewayId: 'validation-gateway', dispatch: false, resumeAfterMs: 60_000 }, composeSalesGateway({ pool, production, env }).bindings, { logger });
  const queue: FakeModelStep[] = [];
  const model = new FakeModelProvider(() => queue.shift() ?? { type: 'provider_error', message: 'no scripted step' });
  const worker = await createWorkerPlatform(
    {
      databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 3, workerId: 'validation-worker', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
      execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 50 },
      context: { budget: { mode: 'unbounded' } },
    },
    composeSalesProductionWorker({ pool, store, production, modelProvider: model, logger }).bindings,
    { logger },
  );
  if (options.autonomy) await store.setControl({ scope: 'global', autonomyEnabled: true, reason: 'offline validation', changedBy: 'production-validation', correlationId: 'production-validation' });
  return {
    pool, gateway, worker, provider, store, queue, env, api,
    close: async () => {
      await worker.close().catch(() => undefined);
      await gateway.close().catch(() => undefined);
      await api.close().catch(() => undefined);
      await provider.stop().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await db.drop().catch(() => undefined);
    },
  };
}

let clock = Math.floor(Date.now() / 1000) - 600;
async function inbound(b: Bed, from: string, id: string, text: string): Promise<number> {
  clock += 5;
  const body = notification(PHONE, { messages: [{ id, from, text, timestamp: clock }] });
  const r = await b.gateway.app.inject({ method: 'POST', url: '/v1/channels/whatsapp/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signNotification(VALIDATION_SECRETS.appSecret, body) } });
  return r.statusCode;
}
async function statusCallback(b: Bed, id: string, status: 'delivered' | 'read', to: string): Promise<void> {
  const body = notification(PHONE, { statuses: [{ id, status, recipientId: to }] });
  await b.gateway.app.inject({ method: 'POST', url: '/v1/channels/whatsapp/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signNotification(VALIDATION_SECRETS.appSecret, body) } });
}
async function runAgent(b: Bed): Promise<void> {
  for (let i = 0; i < 20; i += 1) if ((await b.worker.worker.runOnce()).kind === 'idle') return;
}
async function taskOf(b: Bed, waId: string): Promise<string> {
  const binding = await b.store.findOpenBinding('whatsapp', conversationKey(VALIDATION_SECRETS.identityKey, 'whatsapp', PHONE, waId));
  if (!binding?.taskId) throw new Error('no bound task');
  return binding.taskId;
}
const check = (id: string, passed: boolean, detail: string): CheckResult => ({ id, passed, detail });

async function evaluate(b: Bed, taskId: string): Promise<ScenarioResult['evaluation']> {
  const reader = new PostgresTrajectoryReader(b.pool, { projections: [salesWorkspaceProjection(new PostgresSalesStore(b.pool))] });
  const subject = await reader.subject(taskId, { sourceRef: 'production-validation' });
  const { run } = await evaluateSalesSubject(subject, { judge: null, modelUnderTest: SCRIPTED_MODEL_PROFILE, repro: { gitSha: 'unknown' } });
  return { technical: run.result.outcome.technical.status, governance: run.result.outcome.governance.status, findings: run.result.findings.map((f) => f.code) };
}

const CONTACT = '56900000011';

export const VALIDATION_SCENARIOS: readonly { id: string; title: string; run: (adminUrl: string) => Promise<ScenarioResult> }[] = [
  {
    id: 'P01', title: 'reference path: inbound → task → respond → durable outbound → accepted → delivered/read → evaluation',
    async run(adminUrl) {
      const b = await bed(adminUrl, { allow: [CONTACT], autonomy: true });
      try {
        b.queue.push(say('¡Hola! ¿Qué estás buscando?'), waitInput());
        const status = await inbound(b, CONTACT, 'wamid.v.p01.1', 'Hola, busco una trotadora');
        const taskId = await taskOf(b, CONTACT);
        await runAgent(b);
        const sentBefore = b.provider.sends.length;
        await b.gateway.delivery.tick();
        const [o] = await b.store.outboundForTask(taskId);
        await statusCallback(b, o!.providerMessageId ?? 'none', 'delivered', CONTACT);
        await statusCallback(b, o!.providerMessageId ?? 'none', 'read', CONTACT);
        await statusCallback(b, o!.providerMessageId ?? 'none', 'delivered', CONTACT);
        const final = await b.store.outbound(o!.outboundId);
        return {
          id: 'P01', title: this.title, metrics: await b.store.metrics(), evaluation: await evaluate(b, taskId),
          checks: [
            check('webhook_acknowledged', status === 200, `HTTP ${status}`),
            check('respond_not_delivered_before_owner', sentBefore === 0, `${sentBefore} sends before the delivery owner acted`),
            check('single_submission', b.provider.sends.length === 1, `${b.provider.sends.length} provider submissions`),
            check('read_monotonic', final?.status === 'read', `final status ${final?.status ?? 'none'} (late delivered ignored)`),
          ],
        };
      } finally {
        await b.close();
      }
    },
  },
  {
    id: 'P02', title: 'ADR-028: protocol failure after a delivered response → recovery run → no duplicate, same task',
    async run(adminUrl) {
      const b = await bed(adminUrl, { allow: [CONTACT], autonomy: true });
      try {
        b.queue.push(say('Tenemos trotadoras desde $299.990.'), waitInput());
        await inbound(b, CONTACT, 'wamid.v.p02.1', 'Hola');
        const taskId = await taskOf(b, CONTACT);
        await runAgent(b);
        await b.gateway.delivery.tick();
        b.queue.push(invalid(), say('Te cuento las opciones de pago.'), waitInput());
        await inbound(b, CONTACT, 'wamid.v.p02.2', '¿Aceptan tarjeta?');
        await runAgent(b);
        await b.gateway.delivery.tick();
        const runs = (await b.pool.query<{ status: string }>('select status from agent_runs where task_id = $1 order by sequence', [taskId])).rows.map((r) => r.status);
        const texts = b.provider.sends.map((s) => s.text);
        return {
          id: 'P02', title: this.title, metrics: await b.store.metrics(), evaluation: await evaluate(b, taskId),
          checks: [
            check('recovery_run', runs.join(',') === 'suspended,failed,suspended', runs.join(',')),
            check('same_task', (await taskOf(b, CONTACT)) === taskId, 'binding still points at the same task'),
            check('no_duplicate_outbound', texts.length === 2 && new Set(texts).size === 2, `${texts.length} submissions, ${new Set(texts).size} distinct`),
          ],
        };
      } finally {
        await b.close();
      }
    },
  },
  {
    id: 'P03', title: 'kill switch (default state): inbound persisted and held; no cognition, no delivery, visible',
    async run(adminUrl) {
      const b = await bed(adminUrl, { allow: [CONTACT], autonomy: false });
      try {
        const status = await inbound(b, CONTACT, 'wamid.v.p03.1', 'Hola');
        const taskId = await taskOf(b, CONTACT);
        await runAgent(b);
        await b.gateway.delivery.tick();
        const task = (await b.api.tasks.getTask(taskId)).task;
        const attention = await b.api.production.attention();
        return {
          id: 'P03', title: this.title, metrics: await b.store.metrics(), evaluation: null,
          checks: [
            check('inbound_durable', status === 200 && (await b.pool.query('select 1 from task_inputs')).rowCount === 1, 'one durable input'),
            check('held_for_humans', task.status === 'blocked' && task.statusReason === 'autonomy_disabled', `${task.status}/${task.statusReason ?? '-'}`),
            check('no_cognition', b.queue.length === 0 && (await b.pool.query('select 1 from agent_runs')).rowCount === 0, 'no run was started'),
            check('no_delivery', b.provider.sends.length === 0, `${b.provider.sends.length} submissions`),
            check('visible_in_attention', attention.tasks.requests.some((r) => r.taskId === taskId), 'platform handoff in /v1/attention'),
          ],
        };
      } finally {
        await b.close();
      }
    },
  },
  {
    id: 'P04', title: 'rollout exclusion: a conversation outside the cohort is kept and visible, never autonomous',
    async run(adminUrl) {
      const b = await bed(adminUrl, { allow: ['56900000099'], autonomy: true });
      try {
        await inbound(b, CONTACT, 'wamid.v.p04.1', 'Hola');
        const taskId = await taskOf(b, CONTACT);
        await runAgent(b);
        const task = (await b.api.tasks.getTask(taskId)).task;
        return {
          id: 'P04', title: this.title, metrics: await b.store.metrics(), evaluation: null,
          checks: [
            check('held_rollout_excluded', task.statusReason === 'rollout_excluded', task.statusReason ?? '-'),
            check('no_cognition', (await b.pool.query('select 1 from agent_runs')).rowCount === 0, 'no run was started'),
          ],
        };
      } finally {
        await b.close();
      }
    },
  },
  {
    id: 'P05', title: 'unknown outcome: provider timeout → unknown, never retried blindly, visible for reconciliation',
    async run(adminUrl) {
      const b = await bed(adminUrl, { allow: [CONTACT], autonomy: true, providerTimeoutMs: 200 });
      try {
        b.queue.push(say('Mensaje con resultado incierto.'), waitInput());
        await inbound(b, CONTACT, 'wamid.v.p05.1', 'Hola');
        const taskId = await taskOf(b, CONTACT);
        await runAgent(b);
        b.provider.script({ kind: 'hang', ms: 800 });
        for (let i = 0; i < 3; i += 1) await b.gateway.delivery.tick();
        const [o] = await b.store.outboundForTask(taskId);
        const attention = await b.api.production.attention();
        return {
          id: 'P05', title: this.title, metrics: await b.store.metrics(), evaluation: null,
          checks: [
            check('unknown_explicit', o?.status === 'unknown' && o.errorClass === 'timeout', `${o?.status ?? '-'}/${o?.errorClass ?? '-'}`),
            check('not_retried', b.provider.sends.length === 1, `${b.provider.sends.length} submissions`),
            check('in_attention', attention.production.unknownOutbound.length === 1, 'unknown outbound listed for operators'),
          ],
        };
      } finally {
        await b.close();
      }
    },
  },
];

export function validationIdentity(): Record<string, string> {
  const production = loadProductionConfig({
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profileLabel(SALES_PRODUCTION_PROFILE), R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: VALIDATION_SECRETS.identityKey, R4_PROD_ALLOW_NETWORK: 'false',
  });
  return {
    profile: profileLabel(SALES_PRODUCTION_PROFILE),
    profileFingerprint: profileFingerprint(SALES_PRODUCTION_PROFILE),
    productionConfigFingerprint: productionConfigFingerprint(production.config),
    rolloutFingerprintDefault: rolloutFingerprint(production.config.rollout),
  };
}
