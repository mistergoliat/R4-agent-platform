import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { PlatformError, systemClock, uuidV7Generator, type Clock, type IdGenerator } from '@r4/contracts';
import { AgentRegistry } from '@r4/agent-registry';
import { createLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresExecutionStore, PostgresProductionStore, PostgresTaskRuntimeStore, PostgresWorkerPresenceStore, checkDatabaseReadiness, coreSchemaHead, createPool, migrationStatus, type Pool } from '@r4/persistence-postgres';
import {
  AutonomyControls,
  ChannelIngress,
  DeliveryDispatcher,
  OutboundDeliveryRuntime,
  assertProductionMode,
  assertProductionProfile,
  profileLabel,
  type ConversationTaskFactory,
  type InboundChannelAdapter,
  type OutboundChannelAdapter,
  type ProductionConfig,
  type ProductionProfile,
  type ProductionSecrets,
} from '@r4/live-ops';
import { ExecutionRuntime, TaskRuntime, TemporalRuntime, executionReadinessStatus, workerCompatibility, type ExecutionExpectation } from '@r4/task-runtime';
import type { GatewayConfig } from './config.js';

/** What the deploying composition plugs in (a pack's production composition). */
export interface GatewayBindings {
  /** The proven production declaration (`loadProductionConfig`). */
  readonly production: { readonly config: ProductionConfig; readonly secrets: ProductionSecrets };
  readonly profile: ProductionProfile;
  readonly inbound: readonly InboundChannelAdapter[];
  readonly outbound: readonly OutboundChannelAdapter[];
  readonly taskFactory: ConversationTaskFactory;
}

export interface GatewayOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface GatewayPlatform {
  readonly app: FastifyInstance;
  readonly pool: Pool;
  readonly ingress: ChannelIngress;
  readonly delivery: OutboundDeliveryRuntime;
  readonly controls: AutonomyControls;
  readonly logger: Logger;
  /** Starts the dispatcher (if configured) and the unsettled-inbound resume timer. */
  start(): void;
  /** Graceful: stop claiming, finish the submission in flight, close the server and connections. */
  close(): Promise<void>;
}

const MAX_WEBHOOK_BYTES = 1024 * 1024;

/**
 * Composition root of the channel gateway (R4-I) — the only process that talks
 * to a channel provider. Refuses to start (fail closed) unless: production is
 * proven; the composed profile is exactly the declared one and valid; every
 * channel of the profile has an inbound and an outbound adapter of the
 * declared kind (a local fake is never a production binding); the schema is
 * current; and the autonomy controls are readable (kill switch state known).
 *
 * Readiness is split on purpose (R4-I):
 *   /health    process liveness only.
 *   /ready     CHANNEL readiness — this gateway can durably accept channel work
 *              (database, schema, controls, channel bindings). Never depends on
 *              workers: an execution outage must not take ingress out of rotation.
 *   /ready/r4  AGGREGATE readiness — channel ready AND at least one fresh,
 *              compatible production worker ready (worker_presence, DB clock).
 */
export async function createGatewayPlatform(config: GatewayConfig, bindings: GatewayBindings, overrides: GatewayOverrides = {}): Promise<GatewayPlatform> {
  const production = assertProductionMode(bindings.production.config);
  const profile = assertProductionProfile(bindings.profile);
  const problems: string[] = [];
  if (profileLabel(profile) !== production.policyProfile) problems.push(`the composed profile ${profileLabel(profile)} is not the declared R4_PROD_POLICY_PROFILE ${production.policyProfile}`);
  const inbound = bindings.inbound.find((a) => a.channel === profile.channel.id);
  const outbound = bindings.outbound.find((a) => a.channel === profile.channel.id);
  if (!inbound) problems.push(`no inbound adapter for channel ${profile.channel.id}`);
  if (!outbound) problems.push(`no outbound adapter (delivery owner binding) for channel ${profile.channel.id}`);
  else if (outbound.bindingKind !== (profile.channel.status === 'REAL' ? 'real' : 'sandbox')) problems.push(`outbound adapter of ${outbound.channel} is ${outbound.bindingKind} but the profile declares ${profile.channel.status}`);
  if (problems.length > 0) throw new PlatformError('precondition', 'production_composition_refused', `refusing to start the channel gateway:\n- ${problems.join('\n- ')}`);

  const logger = overrides.logger ?? createLogger({ service: 'r4-channel-gateway', level: config.logLevel });
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? uuidV7Generator(clock);
  const pool = createPool({ connectionString: config.databaseUrl, logger, applicationName: `r4-gateway:${config.gatewayId}`.slice(0, 63), max: config.dbPoolMax });
  try {
    const status = await migrationStatus(pool);
    if (status.pending.length > 0 || status.modified.length > 0) {
      throw new PlatformError('unavailable', 'schema_not_current', `database schema is not current (pending: ${status.pending.join(', ') || 'none'}; modified: ${status.modified.join(', ') || 'none'})`);
    }
    const store = new PostgresProductionStore(pool);
    // Kill switch state must be known before anything is accepted.
    await store.readControls();
    const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock, logger });
    const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids, clock, logger });
    const executionStore = new PostgresExecutionStore(pool);
    const execution = new ExecutionRuntime({ store: executionStore, ids, clock, logger, maxRunRecoveries: 0 });
    const temporal = new TemporalRuntime({ store: executionStore, execution, ids, logger });
    const controls = new AutonomyControls({ store, logger });
    const delivery = new OutboundDeliveryRuntime({ store, adapters: bindings.outbound, config: production, owner: config.gatewayId, logger });
    const ingress = new ChannelIngress({
      store, tasks, temporal, controls, adapters: bindings.inbound, delivery, config: production, secrets: bindings.production.secrets, profile, taskFactory: bindings.taskFactory, ids, logger,
    });
    const presence = new PostgresWorkerPresenceStore(pool);
    // A worker counts only if it runs in production and composes this exact execution contract.
    const expectedWorker: ExecutionExpectation = { executionMode: 'production', compatibility: workerCompatibility(await coreSchemaHead(), profileLabel(profile)) };
    const dispatcher = new DeliveryDispatcher({ runtime: delivery, pollIntervalMs: production.outbound.pollIntervalMs, logger });

    // The instance is typed by the pino logger it was built with; expose it as a plain FastifyInstance.
    const app = Fastify({ loggerInstance: logger, bodyLimit: MAX_WEBHOOK_BYTES, logController: new Fastify.LogController({ disableRequestLogging: true }) }) as unknown as FastifyInstance;
    // Signatures are computed over the exact bytes received: keep the raw body as a string.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    app.setErrorHandler((error, request, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      // Infrastructure failure: 5xx so the provider re-delivers (safe: dedupe by provider identity).
      request.log.warn({ err: { name: error instanceof Error ? error.name : 'Error', code: (error as { code?: string }).code } }, 'webhook failed');
      void reply.status(typeof status === 'number' && status >= 400 && status < 500 ? status : 500).send({ error: 'webhook_failed' });
    });
    app.get('/health', (_request, reply) => reply.send({ status: 'ok' }));
    const channelReadiness = async () => {
      const database = await checkDatabaseReadiness(pool);
      const controlsReadable = await store.readControls().then(() => true, () => false);
      return {
        ready: database.ok && controlsReadable,
        checks: {
          database: { ok: database.ok, pendingMigrations: database.pendingMigrations, modifiedMigrations: database.modifiedMigrations },
          autonomyControls: { ok: controlsReadable },
          channel: { id: profile.channel.id, status: profile.channel.status, inbound: Boolean(inbound), outbound: outbound?.bindingKind ?? null },
          profile: profileLabel(profile),
          dispatcher: config.dispatch,
        },
      };
    };
    // Kill switch state is deliberately NOT part of either: readiness is capability, not current authority.
    const executionReadiness = async () => {
      try {
        const workers = await presence.summarizeWorkers(expectedWorker);
        const status = executionReadinessStatus(workers);
        return { ok: status === 'ready', status, expected: expectedWorker, workers };
      } catch {
        return { ok: false, status: 'unavailable' as const, expected: expectedWorker, workers: null };
      }
    };
    app.get('/ready', async (_request, reply) => {
      const channel = await channelReadiness();
      return reply.status(channel.ready ? 200 : 503).send({ status: channel.ready ? 'ready' : 'not_ready', checks: channel.checks });
    });
    app.get('/ready/r4', async (_request, reply) => {
      const [channel, execution] = await Promise.all([channelReadiness(), executionReadiness()]);
      const ready = channel.ready && execution.ok;
      return reply.status(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
        checks: { channel: { ok: channel.ready, ...channel.checks }, execution },
      });
    });
    app.get<{ Params: { channel: string } }>('/v1/channels/:channel/webhook', (request, reply) => {
      const verified = ingress.verify(request.params.channel, request.query as Record<string, string | undefined>);
      if (verified.status === 200) return reply.status(200).header('content-type', 'text/plain; charset=utf-8').send(String(verified.body.challenge));
      return reply.status(verified.status).send(verified.body);
    });
    app.post<{ Params: { channel: string } }>('/v1/channels/:channel/webhook', async (request, reply) => {
      const raw = typeof request.body === 'string' ? request.body : '';
      const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v]));
      const result = await ingress.receive(request.params.channel, raw, headers, `inbound-${randomUUID()}`);
      return reply.status(result.status).send(result.body);
    });
    await app.ready();

    let resumeTimer: NodeJS.Timeout | null = null;
    let started = false;
    return {
      app, pool, ingress, delivery, controls, logger,
      start() {
        if (started) return;
        started = true;
        if (config.dispatch) dispatcher.start();
        resumeTimer = setInterval(() => {
          void ingress.resumeUnsettled(config.resumeAfterMs).catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'inbound resume failed'));
        }, Math.max(1000, Math.floor(config.resumeAfterMs / 2)));
      },
      async close() {
        if (resumeTimer) clearInterval(resumeTimer);
        if (started && config.dispatch) await dispatcher.stop();
        await app.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
