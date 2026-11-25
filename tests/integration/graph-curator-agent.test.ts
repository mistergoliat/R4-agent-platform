import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRegistry } from '@r4/agent-registry';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifacts, PostgresTaskRuntimeStore, type Pool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import {
  GRAPH_CURATOR_AGENT_ID, KINDS_CAPABILITY_ID, PRODUCT_GRAPH_KIND, PRODUCT_SHEET_CAPABILITY_ID, importSignedGraph, kindVocabulary, kindsCapability,
  loadGraphCuratorDefinition, migrateGraph, productSheetCapability, productSheetView, readSignedGraph, runClassificationBatch, type ProductSheetPort,
} from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { complete, contextOf, read } from '../support/decisions.js';
import { startTestWorker, type TestWorker } from '../support/worker.js';

/**
 * ADR-058 G4a: the graph-curator agent classifies the products no rule classifies, as governed runs on its own worker;
 * the curator checks every result against the sheet and proposes only what passes. Scripted model (no network).
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;
let tasks: TaskRuntime;
let worker: TestWorker;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'nu:a': 'Se usa con', 'nu:b': 'Complementos' },
  products: {
    P1: { n: 'Banco Scott Pro', act: true, price: 1, kind: null }, P2: { n: 'Cosa rara', act: true, price: 1, kind: null },
    P3: { n: 'Mancuerna 10kg', act: true, price: 1, kind: 'DB' }, P4: { n: 'Banco Scott', act: true, price: 1, kind: 'SCOTT' },
  },
  view: { P1: { 'nu:a': ['P3'] }, P3: { 'nu:b': ['P1'] } },
};
const SHEETS: Record<string, { name: string; specs: { name: string; value: string }[] }> = {
  P1: { name: 'Banco Scott Pro | HWM', specs: [{ name: 'Uso', value: 'Curl de bíceps con barra' }] },
  P2: { name: 'Cosa rara', specs: [] },
};
const catalog: ProductSheetPort = {
  getProductContext(key) {
    const s = SHEETS[key];
    if (!s) return Promise.resolve({ status: 'not_found' as const });
    return Promise.resolve({ status: 'found' as const, facts: { name: s.name, status: { active: true }, category: { name: 'Bancos' }, specifications: s.specs }, derived: { availability: { sellability: 'sellable' }, priceSummary: null } });
  },
};

// The model: read the kinds, read the sheet, then complete. For P1 a cited, valid classification; for P2 an invented
// piece of evidence (the check must refuse it).
const script = (request: ModelRequest) => {
  const ctx = contextOf(request);
  const key = String(ctx.task.input.productKey);
  if (!ctx.observations.some((o) => o.capabilityId === KINDS_CAPABILITY_ID)) return read(KINDS_CAPABILITY_ID, {});
  if (!ctx.observations.some((o) => o.capabilityId === PRODUCT_SHEET_CAPABILITY_ID)) return read(PRODUCT_SHEET_CAPABILITY_ID, { productKey: key });
  const ids = ctx.observations.map((o) => o.observationId);
  return key === 'P1'
    ? complete('clasificado', ids, { kind: 'SCOTT', muscles: ['brazos'], evidence: [{ field: 'Nombre', value: 'Banco Scott Pro' }, { field: 'Uso', value: 'Curl de bíceps' }], confidence: 'high' })
    : complete('clasificado', ids, { kind: 'DB', muscles: ['cuerpo_completo'], evidence: [{ field: 'Material', value: 'acero' }], confidence: 'medium' });
};

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  artifacts = new PostgresArtifacts(pool);
  await migrateGraph(pool);
  await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [], signedBy: 'oidc:owner', note: null, correlationId: 'c' });
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger: createSilentLogger() });
  await agents.sync([loadGraphCuratorDefinition()]);
  tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger: createSilentLogger() });
  const capabilities = new CapabilityRegistry();
  capabilities.register(productSheetCapability(catalog, () => []));
  capabilities.register(kindsCapability(async () => kindVocabulary((await readSignedGraph(artifacts))!.graph)));
  worker = await startTestWorker(db.url, { workerId: 'graph-curator-test', script, capabilities, servedAgents: [{ agentId: GRAPH_CURATOR_AGENT_ID, version: 1 }], pollIntervalMs: 50 });
}, 120_000);

afterAll(async () => {
  await worker?.platform.close();
  await pool?.end();
  await db?.drop();
});

/** While the batch waits, the worker runs: one claim-and-step per tick, deterministic. */
const drive = async () => { for (let i = 0; i < 5; i++) await worker.platform.worker.runOnce(); };

describe('graph-curator agent (ADR-058 G4a)', () => {
  it('classifies the products no rule classifies; proposes only what the sheet backs', async () => {
    const result = await runClassificationBatch(
      { artifacts, tasks, sheet: (key) => productSheetView(catalog, () => [], key), asked: new Map([['P2', 3]]), sleep: drive },
      { batchId: 'b1', limit: 10, maxTokensPerTask: 30_000, waitMs: 60_000, pollMs: 100 },
    );
    expect(result).toMatchObject({ targets: 2, completed: 2, pending: [] });
    expect(result.refused).toEqual([{ productKey: 'P2', reason: 'evidence field «Material» is not in the sheet' }]);
    const proposed = await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed');
    expect(proposed.map((p) => [(p.evidence as { rule: string }).rule, p.change]).sort()).toEqual([
      ['AGENT_KIND', { op: 'set_kind', key: 'P1', kind: 'SCOTT' }],
      ['AGENT_MUSCLES', { op: 'set_muscles', key: 'P1', muscles: ['brazos'] }],
    ]);
    expect(proposed[0]!.evidence).toMatchObject({ confidence: 'high', cited: [{ field: 'Nombre', value: 'Banco Scott Pro' }, { field: 'Uso', value: 'Curl de bíceps' }] });
  }, 90_000);

  it('a second batch on the same signed version does not duplicate tasks (idempotency) and proposes nothing new', async () => {
    const before = (await pool.query(`select count(*)::int as n from agent_tasks where agent_id = 'graph-curator'`)).rows[0].n;
    const again = await runClassificationBatch({ artifacts, tasks, sheet: (key) => productSheetView(catalog, () => [], key), asked: new Map(), sleep: drive }, { batchId: 'b2', limit: 10, maxTokensPerTask: 30_000, waitMs: 5_000, pollMs: 100 });
    expect((await pool.query(`select count(*)::int as n from agent_tasks where agent_id = 'graph-curator'`)).rows[0].n).toBe(before);
    expect(again.proposals).toMatchObject({ created: 0 });
  }, 60_000);
});
