import { createPlatform, type Platform } from '@r4/api';
import { createGatewayPlatform, type GatewayPlatform } from '@r4/channel-gateway';
import type { TrustedHumanContext } from '@r4/contracts';
import type { CatalogPort } from '@r4-adapters/domains';
import { FakeModelProvider, type FakeModelStep, type ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresProductionStore, type Pool } from '@r4/persistence-postgres';
import { conversationKey, loadProductionConfig, type ProductionConfig, type ProductionSecrets } from '@r4/live-ops';
import { createWorkerPlatform, type WorkerAdmission, type WorkerCycle, type WorkerPlatform, type WorkerPresenceBinding } from '@r4/worker';
import { SALES_AGENT_DIR, migrateSales } from '@r4-sales/agent';
import { composeSalesGateway, composeSalesProductionWorker } from '@r4-sales/agent/production';
import { identityVerificationInspection, migrateIdentityVerification, type IdentityVerificationInspectionOptions } from '@r4-adapters/identity-verification';
import { FakeWhatsAppProvider, notification, signNotification, type NotificationMessage, type NotificationStatus } from '@r4-adapters/whatsapp-cloud/testing';
import { createMigratedTestDatabase, openPool, type TestDatabase } from './database.js';

export const CANARY_PHONE_ID = '1098765432';
export const APP_SECRET = 'r4-test-app-secret';
export const ACCESS_TOKEN = 'r4-test-access-token';
export const VERIFY_TOKEN = 'r4-test-verify-token';
export const IDENTITY_KEY = 'r4-test-identity-hash-key-0123456789abcdef';
export const OPERATOR: TrustedHumanContext = { humanRef: 'operator-1', scopes: ['consultation.answer', 'approval.decide', 'handoff.manage', 'task.cancel', 'reconciliation.manage', 'autonomy.control'], correlationId: 'operator-test' };

export function keyOf(waId: string): string {
  return conversationKey(IDENTITY_KEY, 'whatsapp', CANARY_PHONE_ID, waId);
}

/** A scripted model answer, or a function run DURING that model call (e.g. to inject a concurrent inbound). */
export type QueuedStep = FakeModelStep | ((request: ModelRequest) => FakeModelStep | Promise<FakeModelStep>);

export interface TestbedOptions {
  /** wa_ids allowed into the canary cohort (default: none → everything held as rollout_excluded). */
  readonly allowlist?: readonly string[];
  readonly denylist?: readonly string[];
  readonly percent?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Enable autonomy (the migration leaves it disabled). */
  readonly autonomy?: boolean;
  readonly leaseMs?: number;
  readonly providerTimeoutMs?: number;
  /**
   * Definitions the bed's API registers at boot (default: the Sales pack). An empty
   * directory reproduces a production deployment (gateway + worker, no API): nothing registered.
   */
  readonly agentDefinitionsDir?: string;
  /** The Catalog binding of a profile that makes Catalog REAL (sales-production@2): a local stand-in of catalog-service. */
  readonly catalog?: CatalogPort & { readonly bindingKind: string };
  /** (SEC-OTP) The gateway's identity-verification composition; the bed then migrates its schema. Absent: none (R4-I). */
  readonly identityVerification?: IdentityVerificationInspectionOptions;
}

/**
 * One production composition, in-process, over a disposable database: the
 * real API (agent registry + operator plane), the real channel gateway
 * (webhook via Fastify inject; delivery runtime), the real production
 * worker composition with a scripted stand-in model, and a local fake of
 * the WhatsApp Cloud API. No network, no credentials.
 */
export class LiveOpsTestbed {
  readonly db: TestDatabase;
  readonly pool: Pool;
  readonly api: Platform;
  /** Replaced by `redeployGateway` (a rollout configuration change). */
  gateway: GatewayPlatform;
  readonly provider: FakeWhatsAppProvider;
  readonly store: PostgresProductionStore;
  production: { config: ProductionConfig; secrets: ProductionSecrets };
  readonly model: FakeModelProvider;
  /** The production environment of this bed (for child processes). */
  env: Readonly<Record<string, string>>;
  readonly #queue: QueuedStep[];
  #workers: WorkerPlatform[] = [];
  readonly #catalog: (CatalogPort & { readonly bindingKind: string }) | undefined;
  #identityVerification: IdentityVerificationInspectionOptions | undefined;
  #timestamp = Math.floor(Date.now() / 1000) - 600;

  private constructor(fields: { db: TestDatabase; pool: Pool; api: Platform; gateway: GatewayPlatform; provider: FakeWhatsAppProvider; production: { config: ProductionConfig; secrets: ProductionSecrets }; model: FakeModelProvider; queue: QueuedStep[]; env: Record<string, string>; catalog?: CatalogPort & { readonly bindingKind: string } }) {
    this.db = fields.db;
    this.pool = fields.pool;
    this.api = fields.api;
    this.gateway = fields.gateway;
    this.provider = fields.provider;
    this.store = new PostgresProductionStore(fields.pool);
    this.production = fields.production;
    this.model = fields.model;
    this.#queue = fields.queue;
    this.env = fields.env;
    this.#catalog = fields.catalog;
  }

  static async start(options: TestbedOptions = {}): Promise<LiveOpsTestbed> {
    const db = await createMigratedTestDatabase();
    const pool = openPool(db.url);
    await migrateSales(pool);
    if (options.identityVerification) await migrateIdentityVerification(pool);
    const provider = new FakeWhatsAppProvider({ accessToken: ACCESS_TOKEN });
    await provider.start();
    const env = {
      R4_EXECUTION_MODE: 'production',
      R4_PROD_POLICY_PROFILE: 'sales-production@1',
      R4_PROD_ROLLOUT_PERCENT: String(options.percent ?? 0),
      R4_PROD_ROLLOUT_ALLOWLIST: (options.allowlist ?? []).map(keyOf).join(','),
      R4_PROD_ROLLOUT_DENYLIST: (options.denylist ?? []).map(keyOf).join(','),
      R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
      R4_PROD_ALLOW_NETWORK: 'false',
      R4_PROD_OUTBOUND_LEASE_MS: String(options.leaseMs ?? 30_000),
      R4_PROD_PROVIDER_TIMEOUT_MS: String(options.providerTimeoutMs ?? 2000),
      R4_PROD_HOLD_RECHECK_MS: '10',
      R4_WHATSAPP_APP_SECRET: APP_SECRET,
      R4_WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
      R4_WHATSAPP_ACCESS_TOKEN: ACCESS_TOKEN,
      R4_WHATSAPP_PHONE_NUMBER_ID: CANARY_PHONE_ID,
      R4_WHATSAPP_GRAPH_BASE_URL: provider.baseUrl,
      ...options.env,
    };
    const production = loadProductionConfig(env);
    const logger = createSilentLogger();
    const api = await createPlatform({ databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: options.agentDefinitionsDir ?? SALES_AGENT_DIR, dbPoolMax: 4 }, { logger, humanContext: () => OPERATOR });
    const gateway = await startGateway(db.url, pool, production, env, options.identityVerification);
    const queue: QueuedStep[] = [];
    const model = new FakeModelProvider((request, index) => {
      const next = queue.shift();
      if (next === undefined) return { type: 'provider_error', message: `no scripted step for model call ${index + 1}` };
      return typeof next === 'function' ? next(request) : next;
    });
    const bed = new LiveOpsTestbed({ db, pool, api, gateway, provider, production, model, queue, env: { ...env, R4_DATABASE_URL: db.url }, ...(options.catalog ? { catalog: options.catalog } : {}) });
    bed.#identityVerification = options.identityVerification;
    if (options.autonomy) await bed.setAutonomy(true);
    return bed;
  }

  /**
   * A rollout configuration change: the gateway is redeployed over the same
   * database with another allowlist (everything else unchanged). Open
   * bindings keep the eligibility they were opened with.
   */
  async redeployGateway(rollout: { readonly allowlist: readonly string[] }): Promise<void> {
    const env = { ...this.env, R4_PROD_ROLLOUT_ALLOWLIST: rollout.allowlist.map(keyOf).join(',') };
    const production = loadProductionConfig(env);
    await this.gateway.close();
    this.gateway = await startGateway(this.db.url, this.pool, production, env, this.#identityVerification);
    this.production = production;
    this.env = env;
  }

  /**
   * (SEC-OTP) Redeploys the gateway over the same database with another identity-verification
   * composition (a rollback step or a mode change). Rejects when the new gateway refuses to start;
   * the previous gateway is closed either way.
   */
  async recomposeGateway(identityVerification: IdentityVerificationInspectionOptions | undefined): Promise<void> {
    // A gateway that refused to start left the previous (closed) one in place.
    await this.gateway.close().catch(() => undefined);
    this.#identityVerification = identityVerification;
    this.gateway = await startGateway(this.db.url, this.pool, this.production, this.env, identityVerification);
  }

  /** Queues the stand-in model's next decisions, one per model call. */
  next(...steps: QueuedStep[]): void {
    this.#queue.push(...steps);
  }

  get pendingSteps(): number {
    return this.#queue.length;
  }

  async setAutonomy(enabled: boolean, scope = 'global'): Promise<void> {
    await this.store.setControl({ scope, autonomyEnabled: enabled, reason: enabled ? 'test: enable canary autonomy' : 'test: kill switch', changedBy: 'test', correlationId: 'test' });
  }

  /** The real production worker composition; `overrides` only for worker-readiness scenarios (timing, declared presence, admission). */
  async worker(workerId = 'worker-1', overrides: WorkerOverridesForTest = {}): Promise<WorkerPlatform> {
    const composition = composeSalesProductionWorker({ pool: this.pool, store: this.store, production: this.production, modelProvider: this.model, logger: createSilentLogger(), ...(this.#catalog ? { catalog: this.#catalog } : {}) });
    const bindings = {
      ...composition.bindings,
      ...(overrides.presence ? { presence: overrides.presence } : {}),
      ...(overrides.admission ? { admission: overrides.admission } : {}),
    };
    const worker = await createWorkerPlatform(
      {
        ...(overrides.buildRef === undefined ? {} : { buildRef: overrides.buildRef }),
        databaseUrl: this.db.url, logLevel: 'silent', dbPoolMax: 3, workerId, leaseDurationMs: overrides.leaseDurationMs ?? 60_000, heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
        execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 50 },
        context: { budget: { mode: 'unbounded' } },
      },
      bindings,
      { logger: createSilentLogger() },
    );
    this.#workers.push(worker);
    return worker;
  }

  /** Worker cycles until idle. */
  async runAgent(maxCycles = 20): Promise<WorkerCycle['kind'][]> {
    const worker = this.#workers[0] ?? (await this.worker());
    const cycles: WorkerCycle['kind'][] = [];
    for (let i = 0; i < maxCycles; i += 1) {
      const cycle = await worker.worker.runOnce();
      if (cycle.kind === 'idle') break;
      cycles.push(cycle.kind);
    }
    return cycles;
  }

  /** One delivery pass (sweep, materialize, dispatch). */
  deliver() {
    return this.gateway.delivery.tick();
  }

  /** A signed provider notification through the real webhook route. */
  async webhook(body: string, signature: string | null = signNotification(APP_SECRET, body)) {
    const response = await this.gateway.app.inject({ method: 'POST', url: '/v1/channels/whatsapp/webhook', payload: body, headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) } });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  }

  /** A customer message from `from` (provider id `id`). */
  customer(from: string, id: string, text: string, extra: Partial<NotificationMessage> = {}) {
    this.#timestamp += 5;
    return this.webhook(notification(CANARY_PHONE_ID, { messages: [{ id, from, text, timestamp: this.#timestamp, ...extra }] }));
  }

  status(statuses: readonly NotificationStatus[]) {
    return this.webhook(notification(CANARY_PHONE_ID, { statuses }));
  }

  async taskOf(waId: string): Promise<string> {
    const binding = await this.store.findOpenBinding('whatsapp', keyOf(waId));
    if (!binding?.taskId) throw new Error(`no open binding with a task for ${waId}`);
    return binding.taskId;
  }

  async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }

  async close(): Promise<void> {
    for (const w of this.#workers) await w.close().catch(() => undefined);
    await this.gateway.close().catch(() => undefined);
    await this.api.close().catch(() => undefined);
    await this.provider.stop().catch(() => undefined);
    await this.pool.end().catch(() => undefined);
    await this.db.drop().catch(() => undefined);
  }
}

function startGateway(databaseUrl: string, pool: Pool, production: { config: ProductionConfig; secrets: ProductionSecrets }, env: Readonly<Record<string, string | undefined>>, identityVerification?: IdentityVerificationInspectionOptions): Promise<GatewayPlatform> {
  const { bindings } = composeSalesGateway({ pool, production, env });
  // (SEC-OTP) The synthetic composition plugs the inspector in, as a deployment would; absent: exactly R4-I.
  const inspected = identityVerification ? { ...bindings, inspection: identityVerificationInspection(identityVerification) } : bindings;
  return createGatewayPlatform({ databaseUrl, host: '127.0.0.1', port: 0, logLevel: 'silent', dbPoolMax: 4, gatewayId: 'gateway-test', dispatch: false, resumeAfterMs: 1000 }, inspected, { logger: createSilentLogger() });
}

export interface WorkerOverridesForTest {
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly presence?: WorkerPresenceBinding;
  readonly admission?: WorkerAdmission;
  /** WorkerConfig.buildRef (what R4_BUILD_REF becomes). */
  readonly buildRef?: string | null;
}

/** Scripted decisions (the model-facing protocol). */
export const say = (content: string) => ({ type: 'structured' as const, data: { type: 'respond', content } });
export const waitInput = () => ({ type: 'structured' as const, data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'waiting for the customer' } });
/** An invalid decision (schema violation): ADR-008 invalid step, ADR-028 recoverable run failure. */
export const invalid = () => ({ type: 'structured' as const, data: { type: 'respond' } });
