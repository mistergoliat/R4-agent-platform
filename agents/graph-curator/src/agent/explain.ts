import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject } from '@r4/contracts';
import type { ArtifactProposal, NewArtifactProposal, PostgresArtifacts, PostgresKnowledge } from '@r4/persistence-postgres';
import type { Relation } from '../additions.js';
import { graphChangeSchema, type GraphChange } from '../changes.js';
import { PRODUCT_GRAPH_KIND, type ProductGraph } from '../graph.js';
import { presentProposal } from '../present.js';
import { proposeOnce } from '../once.js';
import { readSignedGraph } from '../signed.js';
import { waitForTasks, type CuratorTasks } from './batch.js';
import { GRAPH_CRITERIA_TOPIC, GRAPH_CURATOR_AGENT_ID, GRAPH_CURATOR_AGENT_VERSION, TASK_INTERPRET_EXPLANATION } from './definition.js';
import { tokensSpent, type GraphCriterion } from './review.js';

/**
 * ADR-058 Decision 11 (G7b): a person explains, in their own words, something about an open proposal. The curator
 * interprets it as a governed task into a PLAN (this proposal, similar open ones resolved the same way, new changes
 * such as retyping relations, and a general criterion). The plan is checked against the graph and the open proposals,
 * and nothing happens until the person confirms it: the explanation and the plan never change the graph by themselves.
 */
const EXPLAIN_SOURCE = 'graph-curator-explain';
const MAX_RELATIONS = 80;
const MAX_SIMILAR = 30;

const name = (g: ProductGraph, k: string) => (g.products[k]?.n ?? k).split('|')[0]!.trim();
const relationId = ([area, a, b]: Relation) => `${area}|${a}|${b}`;

/** The products a change is about. */
function productsOf(change: unknown): string[] {
  const parsed = graphChangeSchema.safeParse(change);
  if (!parsed.success) return [];
  const c = parsed.data;
  switch (c.op) {
    case 'remove_relation': return [c.a, c.b];
    case 'add_relations': case 'mark_reviewed': return c.relations.flatMap(([, a, b]) => [a, b]);
    case 'retype_relations': return c.relations.flat();
    default: return [c.key];
  }
}

/** Every relation of these products in the graph, once each, as [area, a, b] (view[a]['area:a'] ∋ b). */
export function relationsOfProducts(g: ProductGraph, keys: readonly string[]): Relation[] {
  const out = new Map<string, Relation>();
  for (const k of new Set(keys)) {
    for (const [directed, list] of Object.entries(g.view[k] ?? {})) {
      const [area, side] = directed.split(':') as [string, string];
      for (const other of list) {
        const r: Relation = side === 'a' ? [area, k, other] : [area, other, k];
        out.set(relationId(r), r);
      }
    }
  }
  return [...out.values()].slice(0, MAX_RELATIONS);
}

/** Open proposals like this one: the same rule and a product in common, most recent first. */
function similarTo(target: ArtifactProposal, open: readonly ArtifactProposal[]): ArtifactProposal[] {
  const rule = (p: ArtifactProposal) => (p.evidence as { rule?: string } | null)?.rule;
  const mine = new Set(productsOf(target.change));
  return open.filter((p) => p.proposalId !== target.proposalId && rule(p) === rule(target) && productsOf(p.change).some((k) => mine.has(k))).slice(0, MAX_SIMILAR);
}

const reasonOf = (p: ArtifactProposal): string => { const r = (p.evidence as { reason?: unknown } | null)?.reason; return typeof r === 'string' ? r : p.summary; };

/** The signed criteria of the curator (knowledge topic «grafo»). */
export async function signedGraphCriteria(knowledge: Pick<PostgresKnowledge, 'list'>): Promise<GraphCriterion[]> {
  return (await knowledge.list()).filter((e) => e.topic === GRAPH_CRITERIA_TOPIC && e.state === 'signed').map((e) => ({ id: e.entryId, statement: e.statement }));
}

/** Opens the interpretation task. The same explanation of the same proposal is one task (never paid twice). */
export async function startExplanation(
  deps: { readonly artifacts: Pick<PostgresArtifacts, 'current' | 'proposals'>; readonly tasks: CuratorTasks; readonly criteria: readonly GraphCriterion[] },
  input: { readonly proposalId: string; readonly explanation: string; readonly by: string; readonly maxTokens: number },
): Promise<{ taskId: string; similar: number; relations: number }> {
  const explanation = input.explanation.trim();
  if (explanation.length < 3 || explanation.length > 2000) throw new Error('an explanation has 3 to 2000 characters');
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph');
  const g = signed.graph;
  const open = await deps.artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed');
  const target = open.find((p) => p.proposalId === input.proposalId);
  if (!target) throw new Error(`proposal ${input.proposalId} is not open`);
  const shown = (p: ArtifactProposal) => presentProposal(g, p, new Map()).question ?? p.summary;
  const relations = relationsOfProducts(g, productsOf(target.change));
  const similar = similarTo(target, open);
  const areas = [...new Set(Object.keys(g.labels).map((k) => k.split(':')[0]!))].map((area) => ({ area, meaning: `${g.labels[`${area}:a`] ?? area} / ${g.labels[`${area}:b`] ?? area}` }));
  const hash = createHash('sha256').update(`${input.proposalId}\n${explanation}`).digest('hex').slice(0, 24);
  const { view } = await deps.tasks.createTask({
    request: {
      taskType: TASK_INTERPRET_EXPLANATION, agentId: GRAPH_CURATOR_AGENT_ID, agentVersion: GRAPH_CURATOR_AGENT_VERSION,
      goal: { description: `Interpretar lo que explicó una persona sobre una propuesta del grafo y armar un plan que ella confirma.` },
      input: {
        explanation, proposalId: target.proposalId,
        proposal: { question: shown(target), change: target.change as JsonObject, reason: reasonOf(target) },
        relations: relations.map(([area, a, b]) => ({ area, a, b, meaning: `${name(g, a)} → «${g.labels[`${area}:a`] ?? area}» → ${name(g, b)}` })),
        similar: similar.map((p) => ({ id: p.proposalId, question: shown(p), change: p.change as JsonObject })),
        areas, criteria: deps.criteria.map((c) => ({ id: c.id, statement: c.statement })),
      },
      budget: { maxTokens: input.maxTokens },
    },
    requestedBy: { kind: 'user', ref: input.by }, correlationId: `graph-explain-${hash}`, idempotencyKey: `graph-explain-${hash}`,
  });
  return { taskId: view.task.taskId, similar: similar.length, relations: relations.length };
}

const NEW_CHANGE_OPS: ReadonlySet<string> = new Set(['retype_relations', 'remove_relation', 'add_relations']);
const planSchema = z.strictObject({
  summary: z.string().min(1).max(400),
  proposal: z.enum(['approve', 'reject', 'keep_open']),
  similar: z.array(z.strictObject({ id: z.string().min(1).max(64), decision: z.enum(['approve', 'reject']), reason: z.string().min(1).max(300) })).max(MAX_SIMILAR),
  changes: z.array(graphChangeSchema).max(5),
  criterion: z.string().min(5).max(300).nullable(),
});
export type ExplanationPlan = z.infer<typeof planSchema>;

/**
 * The evaluation every plan passes (also its regression set). The whole plan is refused on any violation: a similar
 * proposal that is not in the task, a change of another kind, a relation that is not in the graph with that type, or a
 * type the graph does not have.
 */
export function checkPlan(data: unknown, ctx: { readonly graph: ProductGraph; readonly similarIds: ReadonlySet<string>; readonly relations: readonly Relation[] }): { ok: true; plan: ExplanationPlan } | { ok: false; violations: string[] } {
  const parsed = planSchema.safeParse(data);
  if (!parsed.success) return { ok: false, violations: [`shape: ${parsed.error.issues[0]?.path.join('.') || '(root)'} ${parsed.error.issues[0]?.message ?? ''}`.trim()] };
  const plan = parsed.data;
  const v: string[] = [];
  const areas = new Set(Object.keys(ctx.graph.labels).map((k) => k.split(':')[0]!));
  const known = new Set(ctx.relations.map(relationId));
  const products = new Set(ctx.relations.flatMap(([, a, b]) => [a, b]));
  const seen = new Set<string>();
  for (const s of plan.similar) {
    if (!ctx.similarIds.has(s.id)) v.push(`similar ${s.id} is not one of the open proposals of this task`);
    if (seen.has(s.id)) v.push(`similar ${s.id} twice`);
    seen.add(s.id);
  }
  for (const c of plan.changes) {
    if (!NEW_CHANGE_OPS.has(c.op)) { v.push(`change ${c.op} is not allowed in a plan`); continue; }
    if (c.op === 'retype_relations') {
      if (!areas.has(c.from) || !areas.has(c.to)) v.push(`retype ${c.from} → ${c.to}: a type the graph does not have`);
      if (c.from === c.to) v.push('retype to the same type');
      for (const [a, b] of c.relations) if (!known.has(`${c.from}|${a}|${b}`)) v.push(`retype: ${c.from} ${a}–${b} is not a relation of these products`);
    } else if (c.op === 'remove_relation') {
      if (!known.has(`${c.area}|${c.a}|${c.b}`)) v.push(`remove: ${c.area} ${c.a}–${c.b} is not a relation of these products`);
    } else if (c.op === 'add_relations') {
      for (const [area, a, b] of c.relations) {
        if (!areas.has(area)) v.push(`add: type ${area} does not exist`);
        if (!products.has(a) || !products.has(b)) v.push(`add: ${a}–${b} outside the products of this task`);
      }
    }
  }
  return v.length ? { ok: false, violations: v } : { ok: true, plan };
}

interface ExplainTaskInput { explanation: string; proposalId: string; similar: { id: string }[] }

/** The plan of a finished interpretation task, checked against today's graph (read-only: shows it to the person). */
export async function readPlan(
  deps: { readonly artifacts: Pick<PostgresArtifacts, 'current' | 'proposals'>; readonly tasks: CuratorTasks },
  taskId: string,
): Promise<{ status: string; plan: ExplanationPlan | null; violations: string[]; input: ExplainTaskInput | null }> {
  const { task } = await deps.tasks.getTask(taskId);
  const input = ((task as { input?: JsonObject }).input ?? null) as ExplainTaskInput | null;
  if (task.status !== 'completed' || !input) return { status: task.status, plan: null, violations: [], input };
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph');
  const open = await deps.artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed');
  const target = open.find((p) => p.proposalId === input.proposalId);
  const openIds = new Set(open.map((p) => p.proposalId));
  const check = checkPlan((task.result as { data?: unknown } | null)?.data, {
    graph: signed.graph,
    similarIds: new Set(input.similar.map((s) => s.id).filter((id) => openIds.has(id))),
    relations: relationsOfProducts(signed.graph, target ? productsOf(target.change) : []),
  });
  if (!target) return { status: task.status, plan: null, violations: [`proposal ${input.proposalId} is no longer open`], input };
  return check.ok ? { status: task.status, plan: check.plan, violations: [], input } : { status: task.status, plan: null, violations: check.violations, input };
}

/**
 * The person confirms the plan (all of it, or only what it says about this proposal). Everything is decided in their
 * name: this proposal and the similar ones are approved or rejected with the explanation as the note; the new changes
 * become proposals approved by them (they enter the next version, which is still signed in the console); the criterion
 * becomes a knowledge entry, verified and signed when the person holds those scopes.
 */
export async function confirmPlan(
  deps: { readonly artifacts: Pick<PostgresArtifacts, 'current' | 'proposals' | 'propose' | 'decide'>; readonly tasks: CuratorTasks; readonly knowledge: Pick<PostgresKnowledge, 'list' | 'propose' | 'transition'> },
  input: { readonly taskId: string; readonly by: string; readonly scopes: readonly string[]; readonly onlyThis?: boolean; readonly correlationId: string },
): Promise<{ proposal: string; similar: number; changes: number; criterion: { id: string; state: string } | null }> {
  const { plan, violations, input: task } = await readPlan(deps, input.taskId);
  if (!plan || !task) throw new Error(`the plan cannot be confirmed: ${violations.join('; ') || 'the task has not finished'}`);
  const note = `Explicación: ${task.explanation}`.slice(0, 1000);
  const decide = (ids: string[], decision: 'approved' | 'rejected', why: string) =>
    ids.length ? deps.artifacts.decide({ kind: PRODUCT_GRAPH_KIND, proposalIds: ids, decision, decidedBy: input.by, note: why, correlationId: input.correlationId }) : Promise.resolve({ decided: 0, skipped: 0 });
  if (plan.proposal !== 'keep_open') await decide([task.proposalId], plan.proposal === 'approve' ? 'approved' : 'rejected', note);
  let similar = 0;
  if (!input.onlyThis) {
    for (const s of plan.similar) similar += (await decide([s.id], s.decision === 'approve' ? 'approved' : 'rejected', `${s.reason} (según la explicación de la propuesta ${task.proposalId})`.slice(0, 1000))).decided;
  }
  let changes = 0;
  if (!input.onlyThis && plan.changes.length) {
    const signed = (await readSignedGraph(deps.artifacts))!;
    const fresh: NewArtifactProposal[] = plan.changes.map((change: GraphChange, i) => ({
      fingerprint: `inconsistency|EXPLANATION|${input.taskId}|${i}`,
      summary: `Según tu explicación: ${plan.summary}`.slice(0, 500),
      evidence: { task: 'inconsistency', rule: 'EXPLANATION', productKey: productsOf(change)[0] ?? null, relatedKey: null, explanation: task.explanation, explainedBy: input.by, taskId: input.taskId, proposalId: task.proposalId, effect: 'Lo confirmaste al explicar: entra en la próxima versión que firmas.' },
      change,
    }));
    const source = `${EXPLAIN_SOURCE}:${input.taskId}`;
    // A change another open proposal already asks is not proposed twice: that one is approved instead.
    const { twins } = await proposeOnce(deps.artifacts, { kind: PRODUCT_GRAPH_KIND, baseVersion: signed.version, source, correlationId: input.correlationId, proposals: fresh });
    const mine = [...(await deps.artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).filter((p) => p.source === source).map((p) => p.proposalId), ...twins];
    changes = (await decide(mine, 'approved', note)).decided;
  }
  let criterion: { id: string; state: string } | null = null;
  // A plan confirmed twice (a retried sync) keeps one criterion.
  const already = plan.criterion ? (await deps.knowledge.list()).find((e) => e.topic === GRAPH_CRITERIA_TOPIC && e.statement === plan.criterion && e.sourceRef === task.proposalId && e.state !== 'retired') : undefined;
  if (already) criterion = { id: already.entryId, state: already.state };
  if (!input.onlyThis && plan.criterion && !already) {
    let entry = await deps.knowledge.propose({ topic: GRAPH_CRITERIA_TOPIC, statement: plan.criterion, source: 'graph-curator:explanation', sourceRef: task.proposalId, expiresAt: null }, input.by, input.correlationId);
    const operator = { humanRef: input.by, scopes: input.scopes };
    // Decision 11 / open decision 5: whoever explains and holds the scopes verifies and signs it by confirming.
    if (input.scopes.includes('knowledge.curate')) entry = await deps.knowledge.transition(entry.entryId, 'verified', note, operator, input.correlationId);
    if (input.scopes.includes('knowledge.sign') && entry.state === 'verified') entry = await deps.knowledge.transition(entry.entryId, 'signed', note, operator, input.correlationId);
    criterion = { id: entry.entryId, state: entry.state };
  }
  return { proposal: plan.proposal, similar, changes, criterion };
}

/**
 * Opens and waits for one interpretation within the daily cap (Decision 11; owner: US$0.25 a day). The cap counts what
 * today's interpretations really used (recorded tokens × prices), plus this one at its worst; over it, refused.
 */
export async function explainWithinDailyCap(
  deps: {
    readonly pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { task_id: string; i: number; o: number }[] }> };
    readonly artifacts: Pick<PostgresArtifacts, 'current' | 'proposals'>; readonly tasks: CuratorTasks; readonly knowledge: Pick<PostgresKnowledge, 'list'>;
    readonly sleep?: (ms: number) => Promise<void>;
  },
  input: { readonly proposalId: string; readonly explanation: string; readonly by: string; readonly price: { readonly input: number; readonly output: number }; readonly capUsd: number; readonly maxTokens: number; readonly waitMs: number },
): Promise<{ taskId: string; similar: number; relations: number; spentTodayUsd: number }> {
  const today = (await deps.pool.query(`select task_id from agent_tasks where agent_id = $1 and task_type = $2 and created_at >= current_date`, [GRAPH_CURATOR_AGENT_ID, TASK_INTERPRET_EXPLANATION])).rows.map((r) => r.task_id);
  const used = await tokensSpent(deps.pool, today);
  const spent = (used.inputTokens * input.price.input + used.outputTokens * input.price.output) / 1_000_000;
  const worst = (input.maxTokens * Math.max(input.price.input, input.price.output)) / 1_000_000;
  if (spent + worst > input.capUsd) throw new Error(`daily cap: US$${spent.toFixed(4)} used today of US$${input.capUsd}; this interpretation could take up to US$${worst.toFixed(4)}`);
  const started = await startExplanation({ artifacts: deps.artifacts, tasks: deps.tasks, criteria: await signedGraphCriteria(deps.knowledge) }, { proposalId: input.proposalId, explanation: input.explanation, by: input.by, maxTokens: input.maxTokens });
  await waitForTasks(deps.tasks, new Map([['plan', started.taskId]]), new Map(), Date.now() + input.waitMs, deps.sleep);
  return { ...started, spentTodayUsd: Math.round(spent * 10_000) / 10_000 };
}
