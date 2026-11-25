import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRegistry } from '@r4/agent-registry';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifacts, PostgresKnowledge, PostgresTaskRuntimeStore, type Pool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import {
  GRAPH_CURATOR_AGENT_ID, GRAPH_CURATOR_AGENT_VERSION, PRODUCT_GRAPH_KIND, PRODUCT_SHEETS_CAPABILITY_ID, R4_COMMENT_PREFIX,
  importSignedGraph, loadGraphCuratorDefinition, migrateGraph, productSheetsCapability, signedGraphCriteria, startExplanation, syncClickUp,
  waitForTasks, type ProductSheetPort, type QuestionBoard,
} from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { complete, contextOf, read } from '../support/decisions.js';
import { startTestWorker, type TestWorker } from '../support/worker.js';

/**
 * ADR-058 Decision 13 (G6): the PM curates the curator in ClickUp. A fake board stands in for the ClickUp connector
 * (`@r4-adapters/clickup`); the curator agent runs on a scripted model. The sync creates the most asked questions up to
 * the cap, records the Respuesta field as the PM's decision, turns a PM comment into a plan in the thread, confirms it
 * on «sí», ignores everyone else, and closes what is no longer open.
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;
let knowledge: PostgresKnowledge;
let tasks: TaskRuntime;
let worker: TestWorker;

const PM = 4242;
const PM_REF = 'oidc:pm';
const OTHER = 7;
const GRAPH = {
  schemaVersion: 1,
  labels: { 'ld:a': 'Discos para cargarla', 'ld:b': 'Máquinas e implementos que carga', 'rb:a': 'Barras que apoyan en este rack', 'rb:b': 'Racks y atriles donde apoya', 'sub:a': 'Lo reemplaza', 'sub:b': 'Lo reemplaza' },
  products: {
    P1: { n: 'Deadlift Jack Bar', act: true, price: 36792, kind: 'JACK' },
    P2: { n: 'Barra Olímpica 20kg Elite', act: true, price: 179990, kind: 'OLY_BAR' },
    P3: { n: 'Barra Olímpica 20kg Training', act: true, price: 149990, kind: 'OLY_BAR' },
    P4: { n: 'Prensa Inclinada 45°', act: true, price: 1399990, kind: 'PRESS' },
    P5: { n: 'Dual Prensa Hack', act: true, price: 1899990, kind: 'PRESS' },
  },
  view: { P1: { 'ld:a': ['P2', 'P3'] }, P2: { 'ld:b': ['P1'] }, P3: { 'ld:b': ['P1'] }, P4: { 'sub:a': ['P5'] }, P5: { 'sub:b': ['P4'] } },
};
const catalog: ProductSheetPort = {
  getProductContext: (key) => Promise.resolve({ status: 'found' as const, facts: { name: GRAPH.products[key as 'P1']?.n ?? key, status: { active: true }, category: null, specifications: [] }, derived: { availability: { sellability: 'sellable' }, priceSummary: null } }),
};
const script = (request: ModelRequest) => {
  const ctx = contextOf(request);
  if (!ctx.observations.some((o) => o.capabilityId === PRODUCT_SHEETS_CAPABILITY_ID)) return read(PRODUCT_SHEETS_CAPABILITY_ID, { productKeys: ['P1', 'P2', 'P3'] });
  const input = ctx.task.input as { similar: { id: string }[] };
  return complete('plan', ctx.observations.map((o) => o.observationId), {
    summary: 'No quito las barras: el Jack Bar es un soporte; las paso a «Barras que apoyan en este rack».', proposal: 'reject',
    similar: input.similar.map((s) => ({ id: s.id, decision: 'reject', reason: 'también es una barra del soporte' })),
    changes: [{ op: 'retype_relations', from: 'ld', to: 'rb', relations: [['P1', 'P2'], ['P1', 'P3']] }],
    criterion: 'Los soportes tipo jack sirven con barras olímpicas para apoyarlas.',
  });
};

/** A fake ClickUp list: tasks with a hidden question tag, an answer dropdown and comments. */
class FakeBoard implements QuestionBoard {
  tasks: { taskId: string; questionId: string; closed: boolean; answer: string | null; priority: string; note?: string; comments: { commentId: string; userId: number | null; text: string; dateMs: number }[] }[] = [];
  #clock = 1_000;
  createQuestionTask(input: { questionId: string; priority: string }) {
    const found = this.tasks.find((t) => t.questionId === input.questionId);
    if (found) return Promise.resolve({ taskId: found.taskId, url: 'u', created: false });
    const t = { taskId: `t${this.tasks.length + 1}`, questionId: input.questionId, closed: false, answer: null, priority: input.priority, comments: [] };
    this.tasks.push(t);
    return Promise.resolve({ taskId: t.taskId, url: 'u', created: true });
  }
  commentTask(taskId: string, text: string) { this.comment(taskId, null, text); return Promise.resolve(); }
  closeTask(taskId: string, note?: string) { const t = this.task(taskId); t.closed = true; t.note = note ?? ''; return Promise.resolve(); }
  readList() { return Promise.resolve(this.tasks.map(({ taskId, questionId, closed, answer }) => ({ taskId, questionId, closed, answer }))); }
  readComments(taskId: string) { return Promise.resolve([...this.task(taskId).comments]); }
  readAnswerOptions() { return Promise.resolve([{ id: 'opt-si', name: 'Sí', orderindex: 0 }, { id: 'opt-no', name: 'No', orderindex: 1 }]); }
  task(id: string) { return this.tasks.find((t) => t.taskId === id)!; }
  comment(taskId: string, userId: number | null, text: string) { this.task(taskId).comments.push({ commentId: `c${++this.#clock}`, userId, text, dateMs: this.#clock }); }
}

let removeP2: string;
let removeP3: string;
let removeSub: string;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  artifacts = new PostgresArtifacts(pool);
  knowledge = new PostgresKnowledge(pool);
  await migrateGraph(pool);
  await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [], signedBy: 'oidc:owner', note: null, correlationId: 'c' });
  await artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: 1, source: 'graph-curator-agent:b1', correlationId: 'c', proposals: [
    ...['P2', 'P3'].map((b) => ({ fingerprint: `r|P1|${b}`, summary: `quitar ${b}`, evidence: { rule: 'AGENT_REMOVE_RELATION', reason: 'es una barra, no un disco' }, change: { op: 'remove_relation', area: 'ld', a: 'P1', b } })),
    { fingerprint: 'r|P4|P5', summary: 'quitar reemplazo', evidence: { rule: 'SUBSTITUTE_KIND_MISMATCH', reason: 'otra máquina' }, change: { op: 'remove_relation', area: 'sub', a: 'P4', b: 'P5' } },
  ] });
  const open = await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed');
  removeP2 = open.find((p) => (p.change as { b: string }).b === 'P2')!.proposalId;
  removeP3 = open.find((p) => (p.change as { b: string }).b === 'P3')!.proposalId;
  removeSub = open.find((p) => (p.change as { b: string }).b === 'P5')!.proposalId;
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger: createSilentLogger() });
  await agents.sync([loadGraphCuratorDefinition()]);
  tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger: createSilentLogger() });
  const capabilities = new CapabilityRegistry();
  capabilities.register(productSheetsCapability(catalog, () => []));
  worker = await startTestWorker(db.url, { workerId: 'graph-clickup-test', script, capabilities, servedAgents: [{ agentId: GRAPH_CURATOR_AGENT_ID, version: GRAPH_CURATOR_AGENT_VERSION }], pollIntervalMs: 50 });
}, 120_000);

afterAll(async () => {
  await worker?.platform.close();
  await pool?.end();
  await db?.drop();
});

const drive = async () => { for (let i = 0; i < 5; i++) await worker.platform.worker.runOnce(); };
const board = new FakeBoard();
const deps = () => ({
  artifacts, tasks, knowledge, board,
  asked: new Map([['P1', 9], ['P4', 3]]),
  explain: async (proposalId: string, text: string) => {
    const s = await startExplanation({ artifacts, tasks, criteria: await signedGraphCriteria(knowledge) }, { proposalId, explanation: text, by: PM_REF, maxTokens: 30_000 });
    await waitForTasks(tasks, new Map([['p', s.taskId]]), new Map(), Date.now() + 60_000, drive, 100);
    return s.taskId;
  },
});
const cfg = { pmClickUpId: PM, pmRef: PM_REF, pmScopes: ['knowledge.curate', 'knowledge.sign'], maxOpen: 2, dueDays: 7, consoleUrl: 'https://consola.example/grafo' };
const state = async (id: string) => (await artifacts.proposals(PRODUCT_GRAPH_KIND)).find((p) => p.proposalId === id)!;

describe('the PM curates the curator in ClickUp (ADR-058 Decision 13)', () => {
  it('creates the most asked questions up to the cap, never twice', async () => {
    expect(await syncClickUp(deps(), cfg)).toMatchObject({ created: 2, open: 2, errors: [] });
    expect(board.tasks.map((t) => t.questionId).sort()).toEqual([removeP2, removeP3].sort());
    expect(await syncClickUp(deps(), cfg)).toMatchObject({ created: 0, open: 2 });
  });

  it('a PM comment becomes a plan in the thread; a comment from someone else does nothing; «sí» confirms it in the PM’s name', async () => {
    const t = board.tasks.find((x) => x.questionId === removeP2)!;
    board.comment(t.taskId, OTHER, 'quítala no más');
    expect(await syncClickUp(deps(), cfg)).toMatchObject({ explained: 0 });
    board.comment(t.taskId, PM, 'Es un soporte donde se apoya la barra para cambiar los discos; vale para todas las barras');
    expect(await syncClickUp(deps(), cfg)).toMatchObject({ explained: 1, errors: [] });
    const plan = t.comments.at(-1)!.text;
    expect(plan.startsWith(R4_COMMENT_PREFIX)).toBe(true);
    expect(plan).toMatch(/\[r4-plan:[0-9a-f-]{36}\]/u);
    expect(plan).toContain('Resuelvo igual 1 preguntas parecidas');
    expect(await syncClickUp(deps(), cfg)).toMatchObject({ explained: 0, confirmed: 0 }); // nothing new: no second plan

    board.comment(t.taskId, PM, 'Sí');
    // The same pass frees a place, and the next most asked question (P4–P5) takes it.
    expect(await syncClickUp(deps(), cfg)).toMatchObject({ confirmed: 1, created: 1, errors: [] });
    expect([(await state(removeP2)).state, (await state(removeP2)).decidedBy, (await state(removeP3)).state]).toEqual(['rejected', PM_REF, 'rejected']);
    expect(t.closed).toBe(true);
    expect((await signedGraphCriteria(knowledge)).map((c) => c.statement)).toEqual(['Los soportes tipo jack sirven con barras olímpicas para apoyarlas.']);
  }, 90_000);

  it('closes the task of a question decided elsewhere (P3, rejected by the plan as a similar one)', async () => {
    const r = await syncClickUp(deps(), cfg);
    expect(r).toMatchObject({ closed: 1, created: 0, errors: [] });
    expect(board.tasks.find((x) => x.questionId === removeP3)!.closed).toBe(true);
    expect(board.tasks.find((x) => x.questionId === removeSub)!.closed).toBe(false);
  }, 60_000);

  it('the Respuesta field is the PM’s decision, by what «Sí» means for that question', async () => {
    const t = board.tasks.find((x) => x.questionId === removeSub)!;
    t.answer = 'opt-si'; // «¿le ofrecerías la Dual Prensa Hack?» Sí → keep the replacement → reject the removal
    expect(await syncClickUp(deps(), cfg)).toMatchObject({ answered: 1, errors: [] });
    expect([(await state(removeSub)).state, (await state(removeSub)).decidedBy, t.closed]).toEqual(['rejected', PM_REF, true]);
    expect(t.note).toContain('Pesín sigue ofreciendo «Dual Prensa Hack»');
  }, 60_000);

  it('a list without the Respuesta field: a bare «No» comment answers; a task that is not R4’s is never touched', async () => {
    await artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: 1, source: 'graph-curator-agent:b2', correlationId: 'c', proposals: [
      { fingerprint: 'r|P5|P4', summary: 'quitar reemplazo', evidence: { rule: 'SUBSTITUTE_KIND_MISMATCH', reason: 'otra máquina' }, change: { op: 'remove_relation', area: 'sub', a: 'P5', b: 'P4' } },
    ] });
    const id = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).find((p) => (p.change as { a: string }).a === 'P5')!.proposalId;
    const plain = new FakeBoard();
    plain.readAnswerOptions = () => Promise.reject(Object.assign(new Error('R4_CLICKUP_ANSWER_FIELD_ID is not set'), { code: 'not_configured' }));
    plain.tasks.push({ taskId: 'foreign', questionId: 'prueba-curador', closed: false, answer: null, priority: 'normal', comments: [] });
    const run = () => syncClickUp({ ...deps(), board: plain }, { ...cfg, maxOpen: 1 });
    expect(await run()).toMatchObject({ created: 1, errors: [] });
    const t = plain.tasks.find((x) => x.questionId === id)!;
    plain.comment(t.taskId, PM, 'No');
    expect(await run()).toMatchObject({ answered: 1, explained: 0, errors: [] });
    expect([(await state(id)).state, (await state(id)).decidedBy, t.closed]).toEqual(['approved', PM_REF, true]); // «¿le ofrecerías…?» No → remove it
    expect(plain.tasks.find((x) => x.taskId === 'foreign')).toMatchObject({ closed: false, comments: [] });
  }, 60_000);
});
