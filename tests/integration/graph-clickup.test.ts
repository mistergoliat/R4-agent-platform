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
  importSignedGraph, isoWeek, loadGraphCuratorDefinition, migrateGraph, parseAnswers, productSheetsCapability, signedGraphCriteria, startExplanation, syncClickUp,
  waitForTasks, type ProductSheetPort, type QuestionBoard,
} from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { complete, contextOf, read } from '../support/decisions.js';
import { startTestWorker, type TestWorker } from '../support/worker.js';

/**
 * ADR-058 Decision 13 (G6): the PM curates the curator in ONE ClickUp task a week (owner, 2026-11-25). A fake board
 * stands in for the connector; the curator agent runs on a scripted model. The week’s task groups questions by product,
 * numbered; «1 no, 2 sí, 3 no sé» answer without the model; «1: words» gets a plan that «1 sí» confirms; only the PM
 * counts; the task closes when everything is answered; «no sé» goes to the console; other tasks are never touched.
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


/** A fake ClickUp list: tasks with a hidden question tag and comments (no custom fields, like the real list). */
class FakeBoard implements QuestionBoard {
  tasks: { taskId: string; questionId: string; closed: boolean; answer: string | null; priority: string; title?: string; markdown?: string; note?: string; comments: { commentId: string; userId: number | null; text: string; dateMs: number }[] }[] = [];
  #clock = 1_000;
  createQuestionTask(input: { questionId: string; title: string; markdown: string; priority: string }) {
    const found = this.tasks.find((t) => t.questionId === input.questionId);
    if (found) return Promise.resolve({ taskId: found.taskId, url: 'u', created: false });
    const t = { taskId: `t${this.tasks.length + 1}`, questionId: input.questionId, closed: false, answer: null, priority: input.priority, title: input.title, markdown: input.markdown, comments: [] };
    this.tasks.push(t);
    return Promise.resolve({ taskId: t.taskId, url: 'u', created: true });
  }
  commentTask(taskId: string, text: string) { this.comment(taskId, null, text); return Promise.resolve(); }
  closeTask(taskId: string, note?: string) { const t = this.task(taskId); t.closed = true; t.note = note ?? ''; return Promise.resolve(); }
  readList() { return Promise.resolve(this.tasks.map(({ taskId, questionId, closed, answer }) => ({ taskId, questionId, closed, answer }))); }
  readComments(taskId: string) { return Promise.resolve([...this.task(taskId).comments]); }
  task(id: string) { return this.tasks.find((t) => t.taskId === id)!; }
  comment(taskId: string, userId: number | null, text: string) { this.task(taskId).comments.push({ commentId: `c${++this.#clock}`, userId, text, dateMs: this.#clock }); }
  last(taskId: string) { return this.task(taskId).comments.at(-1)!.text; }
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
board.tasks.push({ taskId: 'foreign', questionId: 'prueba-curador', closed: false, answer: null, priority: 'normal', comments: [] });
const deps = () => ({
  artifacts, tasks, knowledge, board,
  asked: new Map([['P1', 9], ['P4', 3]]),
  explain: async (proposalId: string, text: string) => {
    const s = await startExplanation({ artifacts, tasks, criteria: await signedGraphCriteria(knowledge) }, { proposalId, explanation: text, by: PM_REF, maxTokens: 30_000 });
    await waitForTasks(tasks, new Map([['p', s.taskId]]), new Map(), Date.now() + 60_000, drive, 100);
    return s.taskId;
  },
});
const WEEK1 = new Date('2026-11-25T15:00:00Z');
const WEEK2 = new Date('2026-12-02T15:00:00Z');
const cfg = (now: Date) => ({ pmClickUpId: PM, pmRef: PM_REF, pmScopes: ['knowledge.curate', 'knowledge.sign'], maxItems: 10, dueDays: 7, consoleUrl: 'https://consola.example/grafo', now: () => now });
const state = async (id: string) => (await artifacts.proposals(PRODUCT_GRAPH_KIND)).find((p) => p.proposalId === id)!;
const digest = (week: string) => board.tasks.find((t) => t.questionId === `digest-${week}`)!;

describe('isoWeek and the answers parser', () => {
  it('weeks and numbered answers', () => {
    expect([isoWeek(WEEK1), isoWeek(WEEK2), isoWeek(new Date('2027-01-01T12:00:00Z'))]).toEqual(['2026-w48', '2026-w49', '2026-w53']);
    expect(parseAnswers('1 no, 2 sí, 3 no sé', 3)).toEqual([{ n: 1, text: 'no' }, { n: 2, text: 'sí' }, { n: 3, text: 'no sé' }]);
    expect(parseAnswers('1: es un soporte, va con todas las barras\n2 sí', 2)).toEqual([{ n: 1, text: 'es un soporte, va con todas las barras' }, { n: 2, text: 'sí' }]);
    expect(parseAnswers('9 sí', 2)).toEqual([]);
  });
});

describe('the PM curates the curator in ONE weekly ClickUp task (ADR-058 Decision 13)', () => {
  it('opens the week’s task: one item per product, most asked first, never twice; other tasks are left alone', async () => {
    expect(await syncClickUp(deps(), cfg(WEEK1))).toMatchObject({ week: '2026-w48', created: true, items: 2, errors: [] });
    const t = digest('2026-w48');
    expect(t.title).toBe('Curador del grafo · preguntas de la semana (2)');
    expect(t.markdown).toContain('**1. En el grafo, «Deadlift Jack Bar» tiene a «Barra Olímpica 20kg Elite» en «Discos para cargarla». ¿Está bien así?** *(y 1 más del mismo producto');
    expect(t.markdown).toContain('**2. Si un cliente busca «Prensa Inclinada 45°»');
    expect(board.last(t.taskId)).toContain(`[r4-items:1=${removeP2},${removeP3};2=${removeSub}]`);
    expect(await syncClickUp(deps(), cfg(WEEK1))).toMatchObject({ created: false, explained: 0, answered: 0 });
    expect(board.tasks.filter((x) => x.questionId.startsWith('digest-'))).toHaveLength(1);
    expect(board.task('foreign')).toMatchObject({ closed: false, comments: [] });
  });

  it('«1: <words>, 2 sí» in one comment: a plan for item 1 and a decision for item 2; someone else’s comment does nothing', async () => {
    const t = digest('2026-w48');
    board.comment(t.taskId, OTHER, '1 no');
    expect(await syncClickUp(deps(), cfg(WEEK1))).toMatchObject({ answered: 0, explained: 0 });
    board.comment(t.taskId, PM, '1: es un soporte donde se apoya la barra para cambiar los discos, vale para todas las barras\n2 sí');
    expect(await syncClickUp(deps(), cfg(WEEK1))).toMatchObject({ explained: 1, answered: 1, errors: [] });
    const reply = board.last(t.taskId);
    expect(reply.startsWith(R4_COMMENT_PREFIX)).toBe(true);
    expect(reply).toMatch(/1 · No quito las barras.*\[r4-plan:[0-9a-f-]{36}:1\]/su);
    expect(reply).toContain('[r4-done:2]');
    expect([(await state(removeSub)).state, (await state(removeSub)).decidedBy]).toEqual(['rejected', PM_REF]); // «¿le ofrecerías…?» Sí → keep it
    expect(t.closed).toBe(false);
  }, 90_000);

  it('«1 sí» confirms item 1’s plan in the PM’s name; with everything answered, the week’s task closes', async () => {
    const t = digest('2026-w48');
    board.comment(t.taskId, PM, '1 sí');
    expect(await syncClickUp(deps(), cfg(WEEK1))).toMatchObject({ confirmed: 1, closed: 1, errors: [] });
    expect([(await state(removeP2)).state, (await state(removeP3)).state, (await state(removeP2)).decidedBy]).toEqual(['rejected', 'rejected', PM_REF]);
    expect((await signedGraphCriteria(knowledge)).map((c) => c.statement)).toEqual(['Los soportes tipo jack sirven con barras olímpicas para apoyarlas.']);
    expect(t.closed).toBe(true);
  }, 90_000);

  it('next week: a new task with what is open; «no sé» sends it to the console and it does not come back', async () => {
    await artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: 1, source: 'graph-curator-agent:b2', correlationId: 'c', proposals: [
      { fingerprint: 'r|P5|P4', summary: 'quitar reemplazo', evidence: { rule: 'SUBSTITUTE_KIND_MISMATCH', reason: 'otra máquina' }, change: { op: 'remove_relation', area: 'sub', a: 'P5', b: 'P4' } },
    ] });
    const id = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).find((p) => (p.change as { a: string }).a === 'P5')!.proposalId;
    expect(await syncClickUp(deps(), cfg(WEEK2))).toMatchObject({ week: '2026-w49', created: true, items: 1 });
    const t = digest('2026-w49');
    board.comment(t.taskId, PM, 'no sé');
    expect(await syncClickUp(deps(), cfg(WEEK2))).toMatchObject({ unsure: 1, closed: 1, errors: [] });
    expect(board.last(t.taskId)).toContain(`[r4-unsure:${id}]`);
    expect((await state(id)).state).toBe('proposed'); // still open: it waits in the console
    expect(await syncClickUp(deps(), cfg(new Date('2026-12-09T15:00:00Z')))).toMatchObject({ created: false, items: 0 });
    expect(board.task('foreign')).toMatchObject({ closed: false, comments: [] });
  }, 90_000);
});
