import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type pg from 'pg';
import type { Logger } from 'pino';
import { createPlatform } from '@r4/api';
import { PlatformError } from '@r4/contracts';
import { ProductionConfigError, profileLabel, type ProductionProfile } from '@r4/live-ops';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import { SALES_AGENT_DIR } from '../../definition.js';
import { salesGatewayInspection } from '../../production/gateway-identity.js';
import { isCustomerIdentityProfile } from '../../production/profile-v8.js';
import { SYNTHETIC_ACCOUNT } from './channel.js';
import { SYNTHETIC_CHANNEL, assertIsolatedCanaryDatabase, foreignTraffic, readCanaryDatabase } from './isolation.js';

/**
 * R4-J4-R5 preparation (R4-J4-R4-OWNER-ACCEPTANCE-AND-R5-PREPARATION-10): what the isolated canary needs to run
 * sales-production@8. NOTHING here deploys or runs the canary. It provides:
 *
 *   test hosts   a CLOSED allowlist of synthetic test hosts (R4_CANARY_TEST_HOSTS), exact DNS names, https only,
 *                at most four; empty by default (loopback only). Only the canary passes it to the adapters.
 *   one gateway  the canary's single gateway (`sales:canary gateway`): the inbound inspector in full and the CIA
 *                confirm dispatcher. Before it starts, no other canary gateway and no platform gateway may be
 *                connected to the canary database (pg_stat_activity); the worker and the synthetic ingest of @8
 *                refuse to run without it (mixed replicas are refused, not detected afterwards).
 *   rollback     @8 → @7 readiness: protect_only first, every protection window expired, no open
 *                identity.start_verification execution, no live canary gateway.
 *   purge        a verifiable purge of the synthetic data (D7 of the canary): counts before, every data table
 *                emptied in one transaction, counts after (all zero), proof of zero real customers, sha256.
 */

/** The application name prefix of a canary gateway's connections; each gateway adds its own suffix (what the replica checks count). */
export const CANARY_GATEWAY_APPLICATION = 'r4-sales-canary:gateway:';
/** Connections of a platform channel gateway (apps/channel-gateway: `r4-gateway:<id>`). */
const PLATFORM_GATEWAY_APPLICATION = 'r4-gateway:%';
const MAX_TEST_HOSTS = 4;
const DNS_NAME = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Parses R4_CANARY_TEST_HOSTS: comma-separated exact DNS names; no IP literal, wildcard, port, scheme or loopback name. */
export function parseCanaryTestHosts(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return Object.freeze([]);
  const hosts = raw.split(',').map((h) => h.trim());
  for (const host of hosts) {
    if (!DNS_NAME.test(host) || /^[0-9.]+$/.test(host) || host === 'localhost' || host.endsWith('.localhost')) {
      throw new ProductionConfigError('invalid_production_config', `R4_CANARY_TEST_HOSTS: "${host.slice(0, 80)}" is not an exact lower-case DNS name (no IP, wildcard, port, scheme or loopback name)`);
    }
  }
  if (new Set(hosts).size !== hosts.length) throw new ProductionConfigError('invalid_production_config', 'R4_CANARY_TEST_HOSTS lists a host twice');
  if (hosts.length > MAX_TEST_HOSTS) throw new ProductionConfigError('invalid_production_config', `R4_CANARY_TEST_HOSTS lists more than ${MAX_TEST_HOSTS} hosts`);
  return Object.freeze(hosts);
}

/** Gateways connected to the canary database right now (distinct application names: one per gateway, whatever its pool size). */
export async function connectedGateways(pool: pg.Pool): Promise<{ readonly canary: number; readonly platform: number }> {
  const { rows } = await pool.query<{ canary: string; platform: string }>(
    `select count(distinct application_name) filter (where starts_with(application_name, $1))::text as canary,
            count(distinct application_name) filter (where application_name like $2)::text as platform
       from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`,
    [CANARY_GATEWAY_APPLICATION, PLATFORM_GATEWAY_APPLICATION],
  );
  return { canary: Number(rows[0]!.canary), platform: Number(rows[0]!.platform) };
}

/** Before the canary gateway starts: it must be the only gateway on this database. */
export async function assertNoOtherGateway(pool: pg.Pool): Promise<void> {
  const g = await connectedGateways(pool);
  if (g.canary > 0 || g.platform > 0) {
    throw new PlatformError('precondition', 'canary_gateway_replica', `another gateway is connected to the canary database (canary ${g.canary}, platform ${g.platform}); the canary runs exactly one gateway (mixed replicas are refused)`);
  }
}

/** The worker and the synthetic ingest of an inspected profile run only while the single canary gateway is up, and no platform gateway is. */
export async function assertCanaryGatewayLive(pool: pg.Pool): Promise<void> {
  const g = await connectedGateways(pool);
  if (g.platform > 0) throw new PlatformError('precondition', 'canary_gateway_replica', `a platform gateway is connected to the canary database (${g.platform}); refused`);
  if (g.canary === 0) throw new PlatformError('precondition', 'canary_gateway_not_running', 'the canary gateway (inbound inspector and confirm dispatcher) is not running: start "sales:canary gateway" first');
}

export interface CanaryGateway {
  readonly gatewayId: string;
  readonly mode: string;
  readonly degradedReason: string | null;
  close(): Promise<void>;
}

/**
 * The canary's single gateway for an inspected profile (@8): composes the inbound inspection exactly as the
 * production gateway does (salesGatewayInspection: keyring and CIA confirm client, `full`; or `protect_only`, the
 * first step of a rollback) over the canary database, and runs the confirm dispatcher. Refused when another
 * gateway is connected.
 */
export async function startCanaryGateway(
  canary: { readonly databaseUrl: string; readonly profile: ProductionProfile; readonly testHosts: readonly string[] },
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly logger: Logger;
    readonly openPool: (name: string) => pg.Pool;
    readonly requested?: 'full' | 'protect_only';
    /** Tests: the CIA confirm transport and the dispatcher tuning. */
    readonly transport?: (url: string, init: RequestInit) => Promise<Response>;
  },
): Promise<CanaryGateway> {
  if (!isCustomerIdentityProfile(canary.profile)) throw new PlatformError('precondition', 'canary_gateway_not_needed', `${profileLabel(canary.profile)} composes no inbound inspector; the canary gateway is for sales-production@8`);
  const preflight = options.openPool('gateway-preflight');
  let canaryId: string;
  try {
    canaryId = await assertIsolatedCanaryDatabase(preflight);
    await assertNoOtherGateway(preflight);
  } finally {
    await preflight.end().catch(() => undefined);
  }
  const pool = options.openPool(`gateway:${randomBytes(4).toString('hex')}`);
  let platform: Awaited<ReturnType<typeof createPlatform>> | null = null;
  try {
    platform = await createPlatform({ databaseUrl: canary.databaseUrl, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 2 }, { logger: options.logger });
    const gatewayId = `sales-canary-gateway:${canaryId}:${hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 24) || 'host'}:${process.pid}`;
    const factory = salesGatewayInspection(canary.profile, options.env, { transport: options.transport, allowedHosts: canary.testHosts, requested: options.requested ?? 'full' });
    const inspection = await factory({
      pool, store: new PostgresProductionStore(pool), temporal: platform.temporal, gatewayId,
      log: (event, fields) => options.logger.info({ event, ...fields }, 'canary gateway'),
    });
    inspection.start();
    const p = platform;
    return {
      gatewayId, mode: inspection.mode, degradedReason: inspection.degradedReason,
      async close() {
        await inspection.stop().catch(() => undefined);
        await p.close().catch(() => undefined);
        await pool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await platform?.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/** Whether an identity-verification schema exists in the canary database (it does once @8 was initialized). */
async function identitySchemaPresent(pool: pg.Pool): Promise<boolean> {
  return (await pool.query<{ present: boolean }>(`select to_regclass('identity_verification.component_mode') is not null as present`)).rows[0]?.present === true;
}

export interface CanaryRollbackStatus {
  readonly mode: 'full' | 'protect_only' | null;
  readonly openProtections: number;
  readonly openStarts: number;
  readonly liveGateways: number;
  readonly ready: boolean;
}

/**
 * @8 → @7 rollback readiness (plan §5; ADR-040 addendum): the component left `full` (protect_only), every
 * protection window expired, no identity.start_verification execution still open, and no gateway connected.
 * Only then may the canary run a profile without the inspector. There is no override.
 */
export async function canaryRollbackStatus(pool: pg.Pool): Promise<CanaryRollbackStatus> {
  const liveGateways = (await connectedGateways(pool)).canary;
  if (!(await identitySchemaPresent(pool))) return { mode: null, openProtections: 0, openStarts: 0, liveGateways, ready: liveGateways === 0 };
  const { rows } = await pool.query<{ mode: 'full' | 'protect_only' | null; open: string; starts: string }>(
    `select (select mode from identity_verification.component_mode) as mode,
            (select count(*) from identity_verification.expectations where protect_until > clock_timestamp())::text as open,
            (select count(*) from action_executions where capability_id = 'identity.start_verification' and status in ('prepared', 'executing', 'needs_reconciliation'))::text as starts`,
  );
  const r = rows[0]!;
  const status = { mode: r.mode, openProtections: Number(r.open), openStarts: Number(r.starts), liveGateways };
  return { ...status, ready: status.mode !== 'full' && status.openProtections === 0 && status.openStarts === 0 && status.liveGateways === 0 };
}

/** A profile without the inspector (@4–@7) may run on a canary database only when the rollback is complete. */
export async function assertUninspectedCanaryAllowed(pool: pg.Pool): Promise<void> {
  const status = await canaryRollbackStatus(pool);
  if (!status.ready) {
    throw new PlatformError('precondition', 'canary_rollback_not_ready', `a profile without the inbound inspector cannot run on this canary database yet: mode ${status.mode ?? 'none'}, open protection windows ${status.openProtections}, open verification starts ${status.openStarts}, live gateways ${status.liveGateways} (rollback: recompose the gateway in protect_only, wait for every window to expire, stop it)`);
  }
}

/** Tables a purge keeps: the migration ledger and the registered definitions (needed to run again; no conversation data). */
export const PURGE_PRESERVED_TABLES = Object.freeze(['public.r4_schema_migrations', 'public.agent_definitions']);

export interface CanaryPurgeEvidence {
  readonly canaryId: string;
  readonly database: string;
  readonly purgedAt: string;
  readonly preserved: readonly string[];
  readonly realCustomers: { readonly foreignTraffic: { readonly bindings: number; readonly inbound: number; readonly outbound: number }; readonly nonCanaryAccounts: number };
  readonly before: Readonly<Record<string, number>>;
  readonly after: Readonly<Record<string, number>>;
  readonly rowsRemaining: number;
  readonly sha256: string;
}

async function dataTables(client: pg.Pool | pg.PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ t: string }>(
    `select schemaname || '.' || tablename as t from pg_tables
      where schemaname in ('public', 'sales', 'identity_verification') order by 1`,
  );
  return rows.map((r) => r.t).filter((t) => !PURGE_PRESERVED_TABLES.includes(t));
}

async function counts(client: pg.Pool | pg.PoolClient, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const [schema, table] = t.split('.');
    out[t] = Number((await client.query<{ n: string }>(`select count(*)::text as n from ${quoteIdent(schema!)}.${quoteIdent(table!)}`)).rows[0]!.n);
  }
  return out;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The verifiable purge of the canary's synthetic data (D7 of the canary, owner decision 2026-10-22). Refused
 * unless the database is the isolated canary named by `confirmCanaryId`, no canary component or gateway is
 * connected, and it never held real traffic. Every data table is emptied in ONE transaction and recounted: the
 * evidence lists the counts before and after (all zero) and is hashed. The canary marker and the migration
 * ledger stay, so isolation remains provable and `init` is not needed again.
 */
export async function purgeCanary(pool: pg.Pool, confirmCanaryId: string): Promise<CanaryPurgeEvidence> {
  const state = await readCanaryDatabase(pool);
  const canaryId = await assertIsolatedCanaryDatabase(pool);
  if (confirmCanaryId !== canaryId) throw new PlatformError('precondition', 'canary_purge_not_confirmed', 'the purge needs --confirm <canaryId> naming THIS canary database');
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and (application_name like 'r4-sales-canary:%' or application_name like $1)`, [PLATFORM_GATEWAY_APPLICATION]);
  if (Number(rows[0]!.n) > 0) throw new PlatformError('precondition', 'canary_purge_busy', 'a canary component or a gateway is still connected to the canary database; stop it before purging');
  const foreign = await foreignTraffic(pool);
  const nonCanaryAccounts = Number((await pool.query<{ n: string }>(`select count(*)::text as n from channel_conversation_bindings where channel <> $1 or account_ref <> $2`, [SYNTHETIC_CHANNEL, SYNTHETIC_ACCOUNT])).rows[0]!.n);
  // Anything that is not canary traffic is investigated, never silently purged.
  if (nonCanaryAccounts > 0) throw new PlatformError('precondition', 'canary_purge_foreign_data', `the canary database holds ${nonCanaryAccounts} bindings outside the synthetic canary account; refused`);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tables = await dataTables(client);
    const before = await counts(client, tables);
    if (tables.length > 0) await client.query(`truncate ${tables.map((t) => t.split('.').map(quoteIdent).join('.')).join(', ')} cascade`);
    const after = await counts(client, tables);
    const rowsRemaining = Object.values(after).reduce((a, b) => a + b, 0);
    if (rowsRemaining !== 0) throw new PlatformError('internal', 'canary_purge_incomplete', `the purge left ${rowsRemaining} rows`);
    await client.query('commit');
    const body = { canaryId, database: state.database, purgedAt: new Date().toISOString(), preserved: [...PURGE_PRESERVED_TABLES], realCustomers: { foreignTraffic: foreign, nonCanaryAccounts }, before, after, rowsRemaining };
    return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
