import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRegistry } from '@r4/agent-registry';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifacts, PostgresKnowledge, PostgresTaskRuntimeStore, type Pool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import {
  GRAPH_CRITERIA_TOPIC, GRAPH_CURATOR_AGENT_ID, GRAPH_CURATOR_AGENT_VERSION, PRODUCT_GRAPH_KIND, PRODUCT_SHEETS_CAPABILITY_ID,
  composeNextVersion, confirmPlan, importSignedGraph, loadGraphCuratorDefinition, migrateGraph, productSheetsCapability, readPlan,
  readSignedGraph, signedGraphCriteria, startExplanation, waitForTasks, type ProductSheetPort,
} from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { complete, contextOf, read } from '../support/decisions.js';
import { startTestWorker, type TestWorker } from '../support/worker.js';

/**
 * ADR-058 Decision 11 (G7b), the Deadlift Jack Bar case (owner 2026-11-25): the graph lists bars under the jack's
 * «Discos para cargarla»; the curator proposed removing them. The owner explains that it is a stand used with those
 * bars. The curator (scripted model) plans: reject the removals, retype the relations to «Se usa junto con», keep a
 * criterion. The plan is checked, confirmed in the person's name, and the next version carries the retype.
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;
let knowledge: PostgresKnowledge;
let tasks: TaskRuntime;
let worker: TestWorker;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'ld:a': 'Discos para cargarla', 'ld:b': 'Máquinas e implementos que carga', 'ec:a': 'Se usa junto con', 'ec:b': 'Se usa junto con' },
  products: {
    P1: { n: 'Deadlift Jack Bar', act: true, price: 1, kind: 'JACK' },
    P2: { n: 'Barra Olímpica 20kg Elite', act: true, price: 1, kind: 'OLY_BAR' },
    P3: { n: 'Barra Olímpica 20kg Training', act: true, price: 1, kind: 'OLY_BAR' },
  },
  view: { P1: { 'ld:a': ['P2', 'P3'] }, P2: { 'ld:b': ['P1'] }, P3: { 'ld:b': ['P1'] } },
};
const catalog: ProductSheetPort = {
  getProductContext: (key) => Promise.resolve({ status: 'found' as const, facts: { name: GRAPH.products[key as 'P1']?.n ?? key, status: { active: true }, category: null, specifications: [] }, derived: { availability: { sellability: 'sellable' }, priceSummary: null } }),
};

// What the scripted curator plans, per explanation: a sound plan, or one that tries to retype a relation that is not there.
let plan: (ctx: ReturnType<typeof contextOf>) => Record<string, unknown>;
const script = (request: ModelRequest) => {
  const ctx = contextOf(request);
  if (!ctx.observations.some((o) => o.capabilityId === PRODUCT_SHEETS_CAPABILITY_ID)) return read(PRODUCT_SHEETS_CAPABILITY_ID, { productKeys: ['P1', 'P2', 'P3'] });
  return complete('plan', ctx.observations.map((o) => o.observationId), plan(ctx));
};

const OWNER = 'oidc:owner';
let removeP2: string;
let removeP3: string;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  artifacts = new PostgresArtifacts(pool);
  knowledge = new PostgresKnowledge(pool);
  await migrateGraph(pool);
  await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [['ld', 'P1', 'P2'], ['ld', 'P1', 'P3']], signedBy: OWNER, note: null, correlationId: 'c' });
  await artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: 1, source: 'graph-curator-agent:b1', correlationId: 'c', proposals: ['P2', 'P3'].map((b) => ({
    fingerprint: `inconsistency|AGENT_REMOVE_RELATION|P1|${b}|ld`, summary: `quitar ${b}`, evidence: { rule: 'AGENT_REMOVE_RELATION', reason: 'es una barra, no un disco' }, change: { op: 'remove_relation', area: 'ld', a: 'P1', b },
  })) });
  const open = await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed');
  removeP2 = open.find((p) => (p.change as { b: string }).b === 'P2')!.proposalId;
  removeP3 = open.find((p) => (p.change as { b: string }).b === 'P3')!.proposalId;
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger: createSilentLogger() });
  await agents.sync([loadGraphCuratorDefinition()]);
  tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger: createSilentLogger() });
  const capabilities = new CapabilityRegistry();
  capabilities.register(productSheetsCapability(catalog, () => []));
  worker = await startTestWorker(db.url, { workerId: 'graph-explain-test', script, capabilities, servedAgents: [{ agentId: GRAPH_CURATOR_AGENT_ID, version: GRAPH_CURATOR_AGENT_VERSION }], pollIntervalMs: 50 });
}, 120_000);

afterAll(async () => {
  await worker?.platform.close();
  await pool?.end();
  await db?.drop();
});

const drive = async () => { for (let i = 0; i < 5; i++) await worker.platform.worker.runOnce(); };
const explain = async (text: string) => {
  const started = await startExplanation({ artifacts, tasks, criteria: await signedGraphCriteria(knowledge) }, { proposalId: removeP2, explanation: text, by: OWNER, maxTokens: 30_000 });
  await waitForTasks(tasks, new Map([['p', started.taskId]]), new Map(), Date.now() + 60_000, drive, 100);
  return started;
};

describe('explaining a proposal to the curator (ADR-058 Decision 11)', () => {
  it('a plan that touches a relation the graph does not have is refused whole, and cannot be confirmed', async () => {
    plan = () => ({ summary: 'x', proposal: 'reject', similar: [], changes: [{ op: 'retype_relations', from: 'ld', to: 'ec', relations: [['P2', 'P3']] }], criterion: null });
    const started = await explain('esto no es así');
    const read1 = await readPlan({ artifacts, tasks }, started.taskId);
    expect(read1.plan).toBeNull();
    expect(read1.violations).toEqual(['retype: ld P2–P3 is not a relation of these products']);
    await expect(confirmPlan({ artifacts, tasks, knowledge }, { taskId: started.taskId, by: OWNER, scopes: [], correlationId: 'c' })).rejects.toThrow(/cannot be confirmed/u);
  }, 90_000);

  it('the jack bar: the input shows its relations and the similar proposal; confirming decides, retypes and signs the criterion', async () => {
    plan = (ctx) => {
      const input = ctx.task.input as { relations: { area: string; a: string; b: string }[]; similar: { id: string }[]; areas: { area: string }[] };
      expect(input.relations.map((r) => `${r.area}|${r.a}|${r.b}`).sort()).toEqual(['ld|P1|P2', 'ld|P1|P3']);
      expect(input.areas.map((a) => a.area).sort()).toEqual(['ec', 'ld']);
      return {
        summary: 'No quito las barras: el Jack Bar es un soporte que se usa con ellas; cambio las 2 relaciones a «Se usa junto con».',
        proposal: 'reject', similar: input.similar.map((s) => ({ id: s.id, decision: 'reject', reason: 'también es una barra que se usa con el soporte' })),
        changes: [{ op: 'retype_relations', from: 'ld', to: 'ec', relations: [['P1', 'P2'], ['P1', 'P3']] }],
        criterion: 'Los soportes tipo jack se usan junto con las barras olímpicas («Se usa junto con»), no como discos.',
      };
    };
    const started = await explain('Es un soporte para apoyar la barra y cambiar los discos; va con todas estas barras');
    expect(started.similar).toBe(1);
    const result = await confirmPlan({ artifacts, tasks, knowledge }, { taskId: started.taskId, by: OWNER, scopes: ['knowledge.curate', 'knowledge.sign'], correlationId: 'c' });
    expect(result).toMatchObject({ proposal: 'reject', similar: 1, changes: 1, criterion: { state: 'signed' } });

    const rejected = await artifacts.proposals(PRODUCT_GRAPH_KIND, 'rejected');
    expect(rejected.map((p) => p.proposalId).sort()).toEqual([removeP2, removeP3].sort());
    expect(rejected.every((p) => p.decidedBy === OWNER && (p.decisionNote ?? '').length > 0)).toBe(true);
    expect((await signedGraphCriteria(knowledge)).map((c) => c.statement)).toEqual(['Los soportes tipo jack se usan junto con las barras olímpicas («Se usa junto con»), no como discos.']);
    expect((await knowledge.list()).every((e) => e.topic === GRAPH_CRITERIA_TOPIC)).toBe(true);

    const composed = await composeNextVersion(artifacts, { createdBy: OWNER });
    expect(composed).toMatchObject({ created: true, includes: 1 });
    await artifacts.sign({ kind: PRODUCT_GRAPH_KIND, version: composed!.version, signedBy: OWNER, note: null, correlationId: 'c' });
    const g = (await readSignedGraph(artifacts))!.graph;
    expect([g.view.P1, g.view.P2, g.unreviewed]).toEqual([{ 'ec:a': ['P2', 'P3'] }, { 'ec:b': ['P1'] }, []]);
  }, 90_000);
});
