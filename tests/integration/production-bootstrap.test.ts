import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definitionContentHash } from '@r4/agent-registry';
import type { Pool } from '@r4/persistence-postgres';
import { SALES_AGENT_DIR, loadSalesAgentDefinition, migrateSales } from '@r4-sales/agent';
import { runProductionBootstrap } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { IDENTITY_KEY, LiveOpsTestbed } from '../support/live-ops.js';

/**
 * R4-I production bootstrap (`production:sales:bootstrap`): a deployment of
 * gateway + worker (no API) registers the Sales AgentDefinition explicitly,
 * through the Agent Registry, before any traffic. The environment carries
 * no channel or model credentials: the command needs neither.
 */
const CUSTOMER = '56944445555';
let db: TestDatabase | null = null;
let pool: Pool | null = null;
let bed: LiveOpsTestbed | null = null;
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await pool?.end().catch(() => undefined);
  await db?.drop().catch(() => undefined);
  await bed?.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  pool = null;
  db = null;
  bed = null;
});

const productionEnv = (databaseUrl: string): Record<string, string> => ({
  R4_EXECUTION_MODE: 'production',
  R4_PROD_POLICY_PROFILE: 'sales-production@1',
  R4_PROD_ROLLOUT_PERCENT: '0',
  R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
  R4_PROD_ALLOW_NETWORK: 'false',
  R4_DATABASE_URL: databaseUrl,
});

async function migratedDatabase(): Promise<{ env: Record<string, string>; pool: Pool }> {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  await migrateSales(pool);
  return { env: productionEnv(db.url), pool };
}

async function bootstrap(env: Readonly<Record<string, string | undefined>>, definitionsDir?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProductionBootstrap(env, { out: (l) => out.push(l), err: (l) => err.push(l) }, definitionsDir ? { definitionsDir } : {});
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const definitions = async (p: Pool) => (await p.query<{ agent_id: string; version: number; content_hash: string }>('select agent_id, version, content_hash from agent_definitions order by agent_id, version')).rows;

async function definitionsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'r4-bootstrap-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}
const salesJson = () => readFile(join(SALES_AGENT_DIR, 'sales.agent.json'), 'utf8');

describe('production:sales:bootstrap', () => {
  it('empty registry → registers sales@3 and sales@4 (the real files, through the registry); repeat → unchanged', async () => {
    const { env, pool: p } = await migratedDatabase();
    expect(await definitions(p)).toEqual([]);
    expect(await bootstrap(env)).toEqual({ code: 0, out: 'production Sales bootstrap:\nregistered: sales@3, sales@4, sales@5, sales@6, sales@7', err: '' });
    expect(await definitions(p)).toEqual([
      { agent_id: 'sales', version: 3, content_hash: definitionContentHash(loadSalesAgentDefinition(3)) },
      { agent_id: 'sales', version: 4, content_hash: definitionContentHash(loadSalesAgentDefinition(4)) },
      { agent_id: 'sales', version: 5, content_hash: definitionContentHash(loadSalesAgentDefinition(5)) },
      { agent_id: 'sales', version: 6, content_hash: definitionContentHash(loadSalesAgentDefinition(6)) },
      { agent_id: 'sales', version: 7, content_hash: definitionContentHash(loadSalesAgentDefinition(7)) },
    ]);
    expect(await bootstrap(env)).toEqual({ code: 0, out: 'production Sales bootstrap:\nunchanged: sales@3, sales@4, sales@5, sales@6, sales@7', err: '' });
    expect(await definitions(p)).toHaveLength(5);
  });

  it('R4-J2D upgrade path: a registry holding only sales@3 (production today) gains sales@4; sales@3 stays byte-identical', async () => {
    const { env, pool: p } = await migratedDatabase();
    expect(await bootstrap(env, await definitionsDir({ 'sales.agent.json': await salesJson() }))).toMatchObject({ code: 0, out: 'production Sales bootstrap:\nregistered: sales@3' });
    const [v3] = await definitions(p);
    expect(await bootstrap(env)).toEqual({ code: 0, out: 'production Sales bootstrap:\nregistered: sales@4, sales@5, sales@6, sales@7\nunchanged: sales@3', err: '' });
    expect(await definitions(p)).toEqual([v3, { agent_id: 'sales', version: 4, content_hash: definitionContentHash(loadSalesAgentDefinition(4)) }, { agent_id: 'sales', version: 5, content_hash: definitionContentHash(loadSalesAgentDefinition(5)) }, { agent_id: 'sales', version: 6, content_hash: definitionContentHash(loadSalesAgentDefinition(6)) }, { agent_id: 'sales', version: 7, content_hash: definitionContentHash(loadSalesAgentDefinition(7)) }]);
  });

  it('the same version with different content fails with agent_definition_version_immutable and changes nothing', async () => {
    const { env, pool: p } = await migratedDatabase();
    expect((await bootstrap(env)).code).toBe(0);
    const before = await definitions(p);
    const edited = JSON.parse(await salesJson()) as Record<string, unknown>;
    const dir = await definitionsDir({ 'sales.agent.json': JSON.stringify({ ...edited, description: `${String(edited.description)} (edited without a version bump)` }) });
    const result = await bootstrap(env, dir);
    expect(result).toMatchObject({ code: 1, out: '' });
    expect(result.err).toMatch(/^error: agent_definition_version_immutable: agent definition sales@3 is already registered with different content/);
    expect(await definitions(p)).toEqual(before);
  });

  it('only the Sales definition is registered, even when the directory holds others', async () => {
    const { env, pool: p } = await migratedDatabase();
    const other = { ...(JSON.parse(await salesJson()) as Record<string, unknown>), agentId: 'other-agent', displayName: 'Other' };
    const dir = await definitionsDir({ 'sales.agent.json': await salesJson(), 'other.agent.json': JSON.stringify(other) });
    expect(await bootstrap(env, dir)).toMatchObject({ code: 0, out: 'production Sales bootstrap:\nregistered: sales@3' });
    expect((await definitions(p)).map((d) => d.agent_id)).toEqual(['sales']);
  });

  it.each([
    ['missing Sales definition', { 'readme.txt': 'no definitions here' }, /^error: agent_definition_missing: /],
    ['unreadable definition (invalid JSON)', { 'sales.agent.json': '{ not json' }, /^error: invalid_agent_definitions: /],
    ['invalid definition (schema)', { 'sales.agent.json': JSON.stringify({ agentId: 'sales', version: 1 }) }, /^error: invalid_agent_definitions: /],
  ])('fails closed on a %s and registers nothing', async (_name, files, message) => {
    const { env, pool: p } = await migratedDatabase();
    const result = await bootstrap(env, await definitionsDir(files));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(message);
    expect(await definitions(p)).toEqual([]);
  });

  it('an unreadable definitions directory fails closed', async () => {
    const { env, pool: p } = await migratedDatabase();
    const result = await bootstrap(env, join(tmpdir(), 'r4-bootstrap-does-not-exist'));
    expect(result).toMatchObject({ code: 1 });
    expect(result.err).toMatch(/^error: agent_definitions_dir_unreadable: /);
    expect(await definitions(p)).toEqual([]);
  });

  it.each([
    ['no execution mode declared', { R4_EXECUTION_MODE: undefined }, /production_mode_not_declared/],
    ['shadow mode', { R4_EXECUTION_MODE: 'shadow' }, /production_mode_not_declared/],
    ['an unknown mode', { R4_EXECUTION_MODE: 'prod' }, /unsupported_execution_mode/],
    ['incomplete production configuration', { R4_PROD_IDENTITY_HASH_KEY: undefined }, /production_config_incomplete|invalid_production_config/],
    ['another production profile', { R4_PROD_POLICY_PROFILE: 'other-production@1' }, /invalid_production_config/],
    ['no database url', { R4_DATABASE_URL: undefined }, /production_config_incomplete: R4_DATABASE_URL/],
    ['an invalid database url', { R4_DATABASE_URL: 'mysql://u:p@h/db' }, /production_config_incomplete: R4_DATABASE_URL/],
  ])('is refused with %s (nothing registered)', async (_name, patch, message) => {
    const { env, pool: p } = await migratedDatabase();
    const result = await bootstrap({ ...env, ...patch });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(message);
    expect(await definitions(p)).toEqual([]);
  });

  it('fails closed when the database is unavailable, without echoing the connection string', async () => {
    const env = productionEnv('postgres://r4:secret-password@127.0.0.1:1/r4');
    const result = await bootstrap(env);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^error: database_unavailable: /);
    expect(result.err).not.toContain('secret-password');
  });

  it('refuses a database whose schema is not current (Sales migrations pending)', async () => {
    db = await createMigratedTestDatabase();
    pool = openPool(db.url);
    const result = await bootstrap(productionEnv(db.url));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^error: schema_not_current: .*0006_sales_reference_application/);
    expect(await definitions(pool)).toEqual([]);
  });

  it('has no model, Meta or network effect and changes no autonomy, rollout or runtime state', async () => {
    const { env, pool: p } = await migratedDatabase();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const state = () => p.query(`select
      (select string_agg(scope || ':' || autonomy_enabled || ':' || version, ',') from autonomy_controls) as controls,
      (select count(*) from autonomy_control_events)::int as control_events, (select count(*) from agent_tasks)::int as tasks,
      (select count(*) from agent_runs)::int as runs, (select count(*) from inbound_events)::int as inbound,
      (select count(*) from outbound_messages)::int as outbound, (select count(*) from worker_presence)::int as workers,
      (select count(*) from channel_conversation_bindings)::int as bindings`).then((r) => r.rows as Record<string, unknown>[]);
    const before = await state();
    expect(Object.keys(env).filter((k) => k.startsWith('R4_MODEL_') || k.startsWith('R4_WHATSAPP_'))).toEqual([]);
    expect(await bootstrap(env)).toMatchObject({ code: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
});

describe('the production gap it closes (gateway + worker, no API)', () => {
  it('without the bootstrap inbound cannot open a Sales task (agent_not_found); after it the same durable inbound is ingested', async () => {
    const empty = await definitionsDir({});
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], agentDefinitionsDir: empty });
    expect(await bed.rows('select count(*)::int as n from agent_definitions')).toEqual([{ n: 0 }]);
    const first = await bed.customer(CUSTOMER, 'wamid.boot.1', 'Hola');
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(await bed.rows('select count(*)::int as n from agent_tasks')).toEqual([{ n: 0 }]);
    expect(await bed.rows('select count(*)::int as n from inbound_events')).toEqual([{ n: 1 }]);

    expect(await bootstrap(bed.env)).toMatchObject({ code: 0, out: 'production Sales bootstrap:\nregistered: sales@3, sales@4, sales@5, sales@6, sales@7' });
    await bed.gateway.ingress.resumeUnsettled(0);
    const taskId = await bed.taskOf(CUSTOMER);
    // R4-J2D: sales@4 is registered too, yet a sales-production@1 conversation is pinned to v3 (never "latest").
    expect(await bed.rows('select agent_id, agent_version from agent_tasks where task_id = $1', [taskId])).toEqual([{ agent_id: 'sales', agent_version: 3 }]);
    expect(await bed.rows('select count(*)::int as n from inbound_events')).toEqual([{ n: 1 }]);
  });
});
