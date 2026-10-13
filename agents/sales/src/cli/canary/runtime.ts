import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Logger } from 'pino';
import { createPlatform, registerAgentDefinitions } from '@r4/api';
import { PlatformError, systemClock, uuidV7Generator, type Clock } from '@r4/contracts';
import type { CatalogPort, QuoteV2Service, ShippingService } from '@r4-adapters/domains';
import {
  AutonomyControls,
  ChannelIngress,
  DeliveryDispatcher,
  OutboundDeliveryRuntime,
  ProductionConfigError,
  conversationKey,
  declaredExecutionMode,
  loadProductionConfig,
  profileLabel,
  rolloutEligibility,
  type IngestOutcome,
  type ProductionConfig,
  type ProductionProfile,
  type ProductionSecrets,
} from '@r4/live-ops';
import type { ModelProvider } from '@r4/model-gateway';
import { PostgresProductionStore, createPool, migrate, migrationStatus, type Pool } from '@r4/persistence-postgres';
import { createSchedulerPlatform, type SchedulerConfig, type SchedulerPlatform } from '@r4/scheduler';
import { createWorkerPlatform, type WorkerConfig, type WorkerPlatform } from '@r4/worker';
import { SALES_AGENT_DIR, SALES_MIGRATIONS_DIR } from '../../definition.js';
import { SALES_AGENT_ID } from '../../ids.js';
import { migrateSales } from '../../migrate.js';
import { composeSalesProductionWorker, salesConversationTaskFactory } from '../../production/composition.js';
import { SALES_PRODUCTION_PROFILE_V4 } from '../../production/profile-v4.js';
import { SALES_PRODUCTION_PROFILE_V5, isAutonomousQuoteProfile, salesProductionAgentVersion } from '../../production/profile-v5.js';
import { loadAutonomousQuoteLimits, type AutonomousQuoteLimits } from '../../capabilities/autonomy-limits.js';
import type { ApprovalInspection } from '../../production/approvals.js';
import { openApprovalInspection } from '../approval-inspection.js';
import { CaptureOutboundAdapter, SYNTHETIC_ACCOUNT, syntheticConversationRef, syntheticInbound } from './channel.js';
import { CANARY_ACTOR, CanaryAdmission, SYNTHETIC_CHANNEL, assertIsolatedCanaryDatabase, foreignTraffic, markCanaryDatabase, readCanaryDatabase } from './isolation.js';

/** The governed-approval profile the canary was built for (J3D). */
export const CANARY_PROFILE: ProductionProfile = SALES_PRODUCTION_PROFILE_V4;
/** Profiles the canary may run: v4 (human approval, J3D) and v5 (autonomous issuance, R4-J3E). Never one a production worker runs today. */
export const CANARY_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_PRODUCTION_PROFILE_V4, SALES_PRODUCTION_PROFILE_V5]);

const DATABASE_URL = /^postgres(ql)?:\/\//;

/** A proven canary environment: production declaration for sales-production@4 or @5 plus a dedicated database. */
export interface CanaryEnvironment {
  readonly databaseUrl: string;
  readonly production: { readonly config: ProductionConfig; readonly secrets: ProductionSecrets };
  /** The canary profile the environment declared (R4_PROD_POLICY_PROFILE). */
  readonly profile: ProductionProfile;
  /** (R4-J3E) The configured limits of autonomous issuance; present exactly for an autonomous profile (v5). */
  readonly autonomousQuoteLimits: AutonomousQuoteLimits | null;
}

function sameDatabase(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.hostname === y.hostname && (x.port || '5432') === (y.port || '5432') && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}

/**
 * Reads the canary environment from the process environment only. The
 * canary database comes from `R4_CANARY_DATABASE_URL` (never from
 * `R4_DATABASE_URL`, which on a production host names the production
 * database); the two must not name the same database.
 */
export function loadCanaryEnvironment(env: Readonly<Record<string, string | undefined>>): CanaryEnvironment {
  if (declaredExecutionMode(env) !== 'production') throw new ProductionConfigError('production_mode_not_declared', 'the canary composes the production Sales worker: R4_EXECUTION_MODE must be "production"');
  const production = loadProductionConfig(env);
  const profile = CANARY_PROFILES.find((p) => profileLabel(p) === production.config.policyProfile);
  if (!profile) {
    throw new ProductionConfigError('invalid_production_config', `the Sales canary runs ${CANARY_PROFILES.map(profileLabel).join(' or ')} only (R4_PROD_POLICY_PROFILE=${production.config.policyProfile})`);
  }
  let autonomousQuoteLimits: AutonomousQuoteLimits | null = null;
  if (isAutonomousQuoteProfile(profile)) {
    try {
      autonomousQuoteLimits = loadAutonomousQuoteLimits(env);
    } catch (error) {
      throw new ProductionConfigError('production_config_incomplete', (error as Error).message);
    }
  }
  const databaseUrl = env.R4_CANARY_DATABASE_URL;
  if (!databaseUrl || !DATABASE_URL.test(databaseUrl)) throw new ProductionConfigError('production_config_incomplete', 'R4_CANARY_DATABASE_URL (postgres://) of the dedicated canary database is required');
  if (env.R4_DATABASE_URL && sameDatabase(env.R4_DATABASE_URL, databaseUrl)) {
    throw new ProductionConfigError('canary_shares_production_database', 'R4_CANARY_DATABASE_URL names the same database as R4_DATABASE_URL; the canary needs its own database');
  }
  return { databaseUrl, production, profile, autonomousQuoteLimits };
}

function canaryPool(canary: CanaryEnvironment, logger: Logger, name: string): Pool {
  return createPool({ connectionString: canary.databaseUrl, logger, applicationName: `r4-sales-canary:${name}`, max: 2 });
}

export interface CanaryInitReport {
  readonly canaryId: string;
  readonly database: string;
  readonly markerCreated: boolean;
  readonly migrations: { readonly core: readonly string[]; readonly sales: readonly string[] };
  readonly definitions: { readonly registered: readonly string[]; readonly unchanged: readonly string[] };
  readonly autonomy: 'enabled' | 'already_enabled';
}

/**
 * Initializes (or re-initializes, idempotently) the dedicated canary
 * database: marker first (so a partial init is resumable and never
 * mistaken for anything else), then Core and Sales migrations with the
 * platform migrator, the Sales definitions through the Agent Registry, and
 * global autonomy in THIS database (attributed to platform:sales-canary).
 */
export async function initCanary(canary: CanaryEnvironment, logger: Logger): Promise<CanaryInitReport> {
  const pool = canaryPool(canary, logger, 'init');
  try {
    const marker = await markCanaryDatabase(pool);
    const core = await migrate(pool, { logger });
    const sales = await migrateSales(pool, logger);
    const canaryId = await assertIsolatedCanaryDatabase(pool);
    const definitions = await registerAgentDefinitions({ databaseUrl: canary.databaseUrl, directory: SALES_AGENT_DIR, agentIds: [SALES_AGENT_ID], migrationDirectories: [SALES_MIGRATIONS_DIR], logger });
    const controls = new AutonomyControls({ store: new PostgresProductionStore(pool), logger });
    const enabled = (await controls.state()).globalEnabled;
    if (!enabled) await controls.set({ scope: 'global', autonomyEnabled: true, reason: 'isolated Sales canary database (synthetic traffic only)', changedBy: CANARY_ACTOR, correlationId: `sales-canary:${canaryId}:init` });
    return {
      canaryId, database: (await readCanaryDatabase(pool)).database, markerCreated: marker.created,
      migrations: { core: core.applied, sales: sales.applied }, definitions: { registered: definitions.registered, unchanged: definitions.unchanged }, autonomy: enabled ? 'already_enabled' : 'enabled',
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function assertCurrentSchema(pool: Pool): Promise<void> {
  for (const directory of [undefined, SALES_MIGRATIONS_DIR]) {
    const status = await migrationStatus(pool, directory);
    if (status.pending.length > 0 || status.modified.length > 0) throw new PlatformError('unavailable', 'schema_not_current', 'the canary database schema is not current; run "sales:canary init"');
  }
}

/** The conversation key of a synthetic conversation (for the canary environment's rollout allowlist). */
export function syntheticConversationKey(canary: CanaryEnvironment, conversation: string): string {
  return conversationKey(canary.production.secrets.identityHashKey, SYNTHETIC_CHANNEL, SYNTHETIC_ACCOUNT, syntheticConversationRef(conversation));
}

/**
 * One synthetic customer message, through the REAL channel ingress
 * (`ChannelIngress.ingest`: durable inbound → binding with rollout
 * eligibility → Sales task opened by the production task factory, i.e. a
 * `provisional` service requester, pinned to the profile's definition →
 * canonical input). Only the transport is synthetic. The Task and Temporal
 * runtimes come from the platform's public composition root (`createPlatform`,
 * never listening, with no operator identity adapter).
 */
export async function sendSynthetic(canary: CanaryEnvironment, message: { readonly conversation: string; readonly text: string; readonly eventId?: string }, logger: Logger, clock: Clock = systemClock): Promise<IngestOutcome & { readonly conversationKey: string }> {
  const pool = canaryPool(canary, logger, 'send');
  let platform: Awaited<ReturnType<typeof createPlatform>> | null = null;
  try {
    const canaryId = await assertIsolatedCanaryDatabase(pool);
    await assertCurrentSchema(pool);
    const key = syntheticConversationKey(canary, message.conversation);
    const eligibility = rolloutEligibility(canary.production.config.rollout, key);
    if (!eligibility.eligible) {
      throw new PlatformError('precondition', 'synthetic_conversation_not_eligible', `the synthetic conversation is ${eligibility.reason} in the canary rollout; add its key to the canary environment's R4_PROD_ROLLOUT_ALLOWLIST (sales:canary identity-key --conversation ${message.conversation})`);
    }
    const ids = uuidV7Generator(clock);
    const store = new PostgresProductionStore(pool);
    platform = await createPlatform({ databaseUrl: canary.databaseUrl, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 2 }, { logger, clock, ids });
    const ingress = new ChannelIngress({
      store, tasks: platform.tasks, temporal: platform.temporal, controls: new AutonomyControls({ store, logger }),
      adapters: [],
      // The synthetic channel has no provider, hence no provider status notifications.
      delivery: { applyProviderStatus: () => Promise.reject(new PlatformError('precondition', 'synthetic_channel_has_no_provider', 'the synthetic channel has no provider status')) },
      config: canary.production.config, secrets: canary.production.secrets, profile: canary.profile,
      taskFactory: salesConversationTaskFactory(pool, salesProductionAgentVersion(canary.profile)), ids, logger,
    });
    const outcome = await ingress.ingest(syntheticInbound({ ...message, canaryId }), `sales-canary:${canaryId}:${randomUUID()}`);
    return { ...outcome, conversationKey: key };
  } finally {
    await platform?.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

export interface CanaryRuntimeOptions {
  readonly modelProvider: ModelProvider;
  readonly catalog: CatalogPort & { readonly bindingKind: string };
  readonly shipping: ShippingService & { readonly bindingKind: string };
  readonly quotes: QuoteV2Service & { readonly bindingKind: string };
  readonly worker: WorkerConfig;
  /** The generic scheduler over the canary database (WAIT_UNTIL, expiries, reconciliation dispatch); null only in tests that drive time themselves. */
  readonly scheduler: SchedulerConfig | null;
  /** JSONL file receiving every captured outbound message (or a function of the canary id). */
  readonly captureFile: string | ((canaryId: string) => string);
  readonly logger: Logger;
  /** How often the running canary re-proves its isolation (it stops on a violation). */
  readonly isolationCheckMs?: number;
}

export interface CanaryRuntime {
  readonly canaryId: string;
  readonly worker: WorkerPlatform;
  readonly scheduler: SchedulerPlatform | null;
  readonly delivery: OutboundDeliveryRuntime;
  readonly capture: CaptureOutboundAdapter;
  /** Starts claiming, firing schedules and capturing outbound. */
  start(): void;
  /** Resolves when the runtime stopped because its isolation no longer held. */
  readonly violation: Promise<string>;
  close(): Promise<void>;
}

/**
 * The canary processes in one: the real production Sales worker
 * composition for the canary profile — sales-production@4 or @5 — (model,
 * Catalog, Shipping, Quote V2, the profile's action policy, ActionExecutor, persistence, recovery),
 * the generic scheduler, and the real delivery owner whose only adapter
 * captures to a local file. Every component points at the canary database
 * only; the worker's admission re-proves isolation before each claim.
 */
export async function startCanaryRuntime(canary: CanaryEnvironment, options: CanaryRuntimeOptions): Promise<CanaryRuntime> {
  if (!sameDatabase(options.worker.databaseUrl, canary.databaseUrl) || (options.scheduler && !sameDatabase(options.scheduler.databaseUrl, canary.databaseUrl))) {
    throw new PlatformError('precondition', 'canary_database_mismatch', 'the canary worker and scheduler must use the canary database');
  }
  const { logger } = options;
  const pool = canaryPool(canary, logger, 'composition');
  let worker: WorkerPlatform | null = null;
  let scheduler: SchedulerPlatform | null = null;
  try {
    const canaryId = await assertIsolatedCanaryDatabase(pool);
    await assertCurrentSchema(pool);
    const store = new PostgresProductionStore(pool);
    const composed = composeSalesProductionWorker({ pool, store, production: canary.production, modelProvider: options.modelProvider, logger, catalog: options.catalog, shipping: options.shipping, quotes: options.quotes, ...(canary.autonomousQuoteLimits ? { autonomousQuoteLimits: canary.autonomousQuoteLimits } : {}) });
    worker = await createWorkerPlatform(options.worker, { ...composed.bindings, admission: new CanaryAdmission(pool, composed.controls) }, { logger });
    scheduler = options.scheduler ? await createSchedulerPlatform(options.scheduler, { logger }) : null;
    const capture = new CaptureOutboundAdapter(typeof options.captureFile === 'string' ? options.captureFile : options.captureFile(canaryId));
    const delivery = new OutboundDeliveryRuntime({ store, adapters: [capture], config: canary.production.config, owner: `sales-canary:${canaryId}:${hostname().slice(0, 32)}:${process.pid}`, logger });
    const dispatcher = new DeliveryDispatcher({ runtime: delivery, pollIntervalMs: canary.production.config.outbound.pollIntervalMs, logger });
    let started = false;
    let closed = false;
    let watch: NodeJS.Timeout | null = null;
    let reportViolation: (code: string) => void = () => undefined;
    const violation = new Promise<string>((resolve) => {
      reportViolation = resolve;
    });
    const w = worker;
    const s = scheduler;
    const runtime: CanaryRuntime = {
      canaryId, worker: w, scheduler: s, delivery, capture, violation,
      start() {
        if (started) return;
        started = true;
        w.worker.start();
        s?.scheduler.start();
        dispatcher.start();
        watch = setInterval(() => {
          void assertIsolatedCanaryDatabase(pool).catch((error: unknown) => {
            const code = error instanceof PlatformError ? error.code : 'canary_isolation_unverifiable';
            logger.error({ event: 'sales_canary.isolation_violated', code }, 'canary isolation no longer holds; stopping');
            void runtime.close().finally(() => reportViolation(code));
          });
        }, options.isolationCheckMs ?? 10_000);
      },
      async close() {
        if (closed) return;
        closed = true;
        if (watch) clearInterval(watch);
        if (started) await dispatcher.stop();
        await w.close().catch(() => undefined);
        await s?.close().catch(() => undefined);
        await pool.end().catch(() => undefined);
      },
    };
    return runtime;
  } catch (error) {
    await worker?.close().catch(() => undefined);
    await scheduler?.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/** Proves the canary database is isolated and current (before an operator decision on it). */
export async function assertCanaryReady(canary: CanaryEnvironment, logger: Logger): Promise<string> {
  const pool = canaryPool(canary, logger, 'ready');
  try {
    const canaryId = await assertIsolatedCanaryDatabase(pool);
    await assertCurrentSchema(pool);
    return canaryId;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Read-only approval inspection over the canary database (after proving isolation). */
export async function openCanaryApprovals(canary: CanaryEnvironment, logger: Logger): Promise<{ readonly inspection: ApprovalInspection; readonly close: () => Promise<void> }> {
  const pool = canaryPool(canary, logger, 'approvals');
  try {
    await assertIsolatedCanaryDatabase(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
  return openApprovalInspection({ databaseUrl: canary.databaseUrl, migrationDirectories: [SALES_MIGRATIONS_DIR], logger });
}

/** What the canary database holds now (counts only; no conversation text). */
export async function canaryStatus(canary: CanaryEnvironment, logger: Logger): Promise<Record<string, unknown>> {
  const pool = canaryPool(canary, logger, 'status');
  try {
    const state = await readCanaryDatabase(pool);
    const isolation = await assertIsolatedCanaryDatabase(pool).then(() => 'verified', (error: unknown) => (error instanceof PlatformError ? error.code : 'unverifiable'));
    if (!state.canaryId) return { database: state.database, canaryId: null, isolation };
    const count = async (sql: string) => Object.fromEntries((await pool.query<{ k: string; n: string }>(sql)).rows.map((r) => [r.k, Number(r.n)]));
    return {
      database: state.database,
      canaryId: state.canaryId,
      isolation,
      foreignTraffic: await foreignTraffic(pool),
      autonomy: (await new AutonomyControls({ store: new PostgresProductionStore(pool), logger }).state()).globalEnabled ? 'enabled' : 'disabled',
      tasks: await count('select status as k, count(*)::text as n from agent_tasks group by 1'),
      openHumanRequests: await count(`select kind as k, count(*)::text as n from human_requests where status in ('requested', 'active') group by 1`),
      outbound: await count('select status as k, count(*)::text as n from outbound_messages group by 1'),
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
