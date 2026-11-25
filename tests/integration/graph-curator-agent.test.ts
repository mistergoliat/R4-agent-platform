import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRegistry } from '@r4/agent-registry';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifacts, PostgresTaskRuntimeStore, type Pool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import {
  GRAPH_CURATOR_AGENT_ID, GRAPH_CURATOR_AGENT_VERSION, KINDS_CAPABILITY_ID, PRODUCT_GRAPH_KIND, PRODUCT_SHEETS_CAPABILITY_ID, PRODUCT_SHEET_CAPABILITY_ID,
  importSignedGraph, kindVocabulary, kindsCapability, loadGraphCuratorDefinition, migrateGraph, productSheetCapability, productSheetView,
  productSheetsCapability, readSignedGraph, reviewedRelations, runClassificationBatch, runReviewBatch, tokensSpent, type ProductSheetPort,
} from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { complete, contextOf, read } from '../support/decisions.js';
import { startTestWorker, type TestWorker } from '../support/worker.js';

/**
 * ADR-058 G4: the graph-curator agent classifies the products no rule classifies (G4a) and re-judges the relations
 * nobody reviewed (G4b), as governed runs on its own worker; the curator checks every result against the sheets and
 * proposes only what passes. Scripted model (no network).
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;
let tasks: TaskRuntime;
let worker: TestWorker;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'nu:a': 'Se usa con', 'nu:b': 'Complementos', 'ld:a': 'Discos para cargarla', 'ld:b': 'Máquinas que carga' },
  products: {
    P1: { n: 'Banco Scott Pro', act: true, price: 1, kind: null }, P2: { n: 'Cosa rara', act: true, price: 1, kind: null },
    P3: { n: 'Mancuerna 10kg', act: true, price: 1, kind: 'DB' }, P4: { n: 'Banco Scott', act: true, price: 1, kind: 'SCOTT' },
    P5: { n: 'Barra Olímpica 20kg', act: true, price: 1, kind: 'BAR_OLY' }, P6: { n: 'Disco Estándar 10kg', act: true, price: 1, kind: 'PLATE_STD' },
    P7: { n: 'Disco Bumper 10kg', act: true, price: 1, kind: 'PLATE_OLY' },
  },
  view: { P1: { 'nu:a': ['P3'] }, P3: { 'nu:b': ['P1'] }, P5: { 'ld:a': ['P6', 'P7'] }, P6: { 'ld:b': ['P5'] }, P7: { 'ld:b': ['P5'] } },
};
const UNREVIEWED = [['nu', 'P1', 'P3'], ['ld', 'P5', 'P6'], ['ld', 'P5', 'P7']];
const SHEETS: Record<string, { name: string; specs: { name: string; value: string }[] }> = {
  P1: { name: 'Banco Scott Pro | HWM', specs: [{ name: 'Uso', value: 'Curl de bíceps con barra' }] },
  P2: { name: 'Cosa rara', specs: [] },
  P3: { name: 'Mancuerna 10kg', specs: [] },
  P5: { name: 'Barra Olímpica 20kg', specs: [{ name: 'Diámetro manguito', value: '50 mm' }] },
  P6: { name: 'Disco Estándar 10kg', specs: [{ name: 'Diámetro interno', value: '28 mm' }] },
  P7: { name: 'Disco Bumper 10kg', specs: [{ name: 'Diámetro interno', value: '50,4 mm' }] },
};
const catalog: ProductSheetPort = {
  getProductContext(key) {
    const s = SHEETS[key];
    if (!s) return Promise.resolve({ status: 'not_found' as const });
    return Promise.resolve({ status: 'found' as const, facts: { name: s.name, status: { active: true }, category: { name: 'Bancos' }, specifications: s.specs }, derived: { availability: { sellability: 'sellable' }, priceSummary: null } });
  },
};

type Rel = { area: string; a: string; b: string };
// G4b: read every sheet in one call, then judge. P5–P6 (28 mm plate on an olympic bar) is removed and P5–P7 kept, both
// cited; P1–P3 is "kept" on invented evidence (the check must refuse that verdict alone).
const review = (ctx: ReturnType<typeof contextOf>) => {
  const relations = ctx.task.input.relations as Rel[];
  if (!ctx.observations.some((o) => o.capabilityId === PRODUCT_SHEETS_CAPABILITY_ID)) return read(PRODUCT_SHEETS_CAPABILITY_ID, { productKeys: [...new Set(relations.flatMap((r) => [r.a, r.b]))] });
  const verdict = ({ area, a, b }: Rel) =>
    b === 'P6' ? { area, a, b, verdict: 'remove', reason: 'disco de 28 mm para una barra olímpica', evidence: [{ product: 'P6', field: 'Diámetro interno', value: '28 mm' }] }
    : b === 'P7' ? { area, a, b, verdict: 'keep', reason: 'calzan en 50 mm', evidence: [{ product: 'P7', field: 'Diámetro interno', value: '50,4 mm' }] }
    : { area, a, b, verdict: 'keep', reason: 'se usan juntos', evidence: [{ product: 'P3', field: 'Material', value: 'acero' }] };
  return complete('revisado', ctx.observations.map((o) => o.observationId), { verdicts: relations.map(verdict) });
};

// G4a: read the kinds, read the sheet, then complete. For P1 a cited, valid classification; for P2 an invented piece
// of evidence (the check must refuse it).
const script = (request: ModelRequest) => {
  const ctx = contextOf(request);
  if (Array.isArray(ctx.task.input.relations)) return review(ctx);
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
  await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: UNREVIEWED, signedBy: 'oidc:owner', note: null, correlationId: 'c' });
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger: createSilentLogger() });
  await agents.sync([loadGraphCuratorDefinition()]);
  tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger: createSilentLogger() });
  const capabilities = new CapabilityRegistry();
  capabilities.register(productSheetCapability(catalog, () => []));
  capabilities.register(productSheetsCapability(catalog, () => []));
  capabilities.register(kindsCapability(async () => kindVocabulary((await readSignedGraph(artifacts))!.graph)));
  worker = await startTestWorker(db.url, { workerId: 'graph-curator-test', script, capabilities, servedAgents: [{ agentId: GRAPH_CURATOR_AGENT_ID, version: GRAPH_CURATOR_AGENT_VERSION }], pollIntervalMs: 50 });
}, 120_000);

afterAll(async () => {
  await worker?.platform.close();
  await pool?.end();
  await db?.drop();
});

/** While the batch waits, the worker runs: one claim-and-step per tick, deterministic. */
const drive = async () => { for (let i = 0; i < 5; i++) await worker.platform.worker.runOnce(); };
const curatorTasks = async () => (await pool.query(`select count(*)::int as n from agent_tasks where agent_id = 'graph-curator'`)).rows[0].n as number;

describe('graph-curator agent classifies (ADR-058 G4a)', () => {
  it('classifies the products no rule classifies; proposes only what the sheet backs', async () => {
    const result = await runClassificationBatch(
      { artifacts, tasks, sheet: (key) => productSheetView(catalog, () => [], key), asked: new Map([['P2', 3]]), sleep: drive },
      { batchId: 'b1', limit: 10, maxTokensPerTask: 40_000, waitMs: 60_000, pollMs: 100 },
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
    const before = await curatorTasks();
    const again = await runClassificationBatch({ artifacts, tasks, sheet: (key) => productSheetView(catalog, () => [], key), asked: new Map(), sleep: drive }, { batchId: 'b2', limit: 10, maxTokensPerTask: 40_000, waitMs: 5_000, pollMs: 100 });
    expect(await curatorTasks()).toBe(before);
    expect(again.proposals).toMatchObject({ created: 0 });
  }, 60_000);
});

describe('graph-curator agent reviews relations (ADR-058 G4b)', () => {
  const deps = () => ({ artifacts, tasks, sheet: (key: string) => productSheetView(catalog, () => [], key), asked: new Map<string, number>(), spent: (ids: readonly string[]) => tokensSpent(pool, ids), sleep: drive });
  const run = { capUsd: 1, pricePerMillion: { input: 0.1, output: 0.5 }, maxTokensPerTask: 60_000, wave: 4, perTask: 10, waitMs: 60_000, pollMs: 100 };

  it('judges the unreviewed relations from the sheets; proposes only cited verdicts, within the cap', async () => {
    const result = await runReviewBatch({ ...deps(), reviewed: await reviewedRelations(pool) }, { ...run, batchId: 'r1' });
    expect(result).toMatchObject({ tasks: 2, remaining: 0, completed: 2, verdicts: { keep: 1, remove: 1, unsure: 0 }, pending: [] });
    expect(result.refused).toEqual([{ relation: 'nu|P1|P3', reason: 'evidence field «Material» is not in the sheet of P3' }]);
    expect(result.spentUsd).toBeGreaterThan(0);
    expect(result.spentUsd).toBeLessThan(1);
    const proposed = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).filter((p) => p.source === 'graph-curator-agent:r1');
    expect(proposed.map((p) => [(p.evidence as { rule: string }).rule, p.change]).sort()).toEqual([
      ['AGENT_CONFIRM_RELATIONS', { op: 'mark_reviewed', relations: [['ld', 'P5', 'P7']] }],
      ['AGENT_REMOVE_RELATION', { op: 'remove_relation', area: 'ld', a: 'P5', b: 'P6' }],
    ]);
  }, 90_000);

  it('a second run does not send judged relations to the model again', async () => {
    const before = await curatorTasks();
    const again = await runReviewBatch({ ...deps(), reviewed: await reviewedRelations(pool) }, { ...run, batchId: 'r2' });
    expect(again).toMatchObject({ tasks: 0, remaining: 0, proposals: { created: 0 } });
    expect(await curatorTasks()).toBe(before);
  }, 60_000);

  it('a cap that cannot cover one task at its worst starts none', async () => {
    const none = await runReviewBatch({ ...deps(), reviewed: new Set() }, { ...run, batchId: 'r3', capUsd: 0.01 });
    expect(none).toMatchObject({ tasks: 0, remaining: 2, spentUsd: 0 });
  }, 60_000);
});
