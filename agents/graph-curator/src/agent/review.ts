import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject, Principal } from '@r4/contracts';
import type { NewArtifactProposal, PostgresArtifacts } from '@r4/persistence-postgres';
import type { Relation } from '../additions.js';
import { PRODUCT_GRAPH_KIND, type ProductGraph } from '../graph.js';
import { readSignedGraph } from '../signed.js';
import { waitForTasks, type CuratorTasks } from './batch.js';
import type { ProductSheetView } from './capabilities.js';
import { isCriterionField, norm, sheetValue } from './classify.js';
import { GRAPH_CURATOR_AGENT_ID, GRAPH_CURATOR_AGENT_VERSION, TASK_REVIEW_RELATIONS } from './definition.js';

/**
 * ADR-058 G4b: the graph-curator agent re-judges the relations nobody has reviewed, a few at a time, from the product
 * sheets. Model output is untrusted: each verdict is checked against the sheets before it becomes a proposal, and a
 * person approves every proposal (keep → the mark is cleared; remove → the relation goes).
 */
const relationId = ([area, a, b]: Relation) => `${area}|${a}|${b}`;

const productKey = z.string().regex(/^P[1-9]\d{0,8}$/u);
export const reviewSchema = z.strictObject({
  verdicts: z.array(z.strictObject({
    area: z.string().max(8), a: productKey, b: productKey,
    verdict: z.enum(['keep', 'remove', 'unsure']),
    reason: z.string().min(1).max(300),
    evidence: z.array(z.strictObject({ product: productKey, field: z.string().min(1).max(120), value: z.string().min(1).max(500) })).max(6),
  })).max(50),
});
export type Verdict = z.infer<typeof reviewSchema>['verdicts'][number];

export type ReviewCheck =
  | { readonly ok: true; readonly verdicts: readonly Verdict[]; readonly refused: readonly { readonly relation: string; readonly reason: string }[] }
  | { readonly ok: false; readonly violations: readonly string[] };

/**
 * The evaluation every review result passes (also its regression set). A bad shape refuses the whole result; otherwise
 * each verdict stands alone: it must be about one of the task's relations, once, and keep/remove must cite data that
 * appears verbatim in the sheet of the product it names (a or b). Unsure needs nothing and proposes nothing.
 */
export function checkReview(data: unknown, relations: readonly Relation[], sheets: ReadonlyMap<string, ProductSheetView>, criteria: ReadonlySet<string> = new Set()): ReviewCheck {
  const parsed = reviewSchema.safeParse(data);
  if (!parsed.success) return { ok: false, violations: [`shape: ${parsed.error.issues[0]?.path.join('.') || '(root)'} ${parsed.error.issues[0]?.message ?? ''}`.trim()] };
  const asked = new Set(relations.map(relationId));
  const seen = new Set<string>();
  const verdicts: Verdict[] = [];
  const refused: { relation: string; reason: string }[] = [];
  for (const v of parsed.data.verdicts) {
    const id = relationId([v.area, v.a, v.b]);
    const why: string[] = [];
    if (!asked.has(id)) why.push('not one of the relations of this task');
    else if (seen.has(id)) why.push('a second verdict for the same relation');
    if (v.verdict !== 'unsure' && !v.evidence.length) why.push(`${v.verdict} without evidence`);
    for (const e of v.verdict === 'unsure' ? [] : v.evidence) {
      if (isCriterionField(e.field)) {
        if (e.product !== v.a && e.product !== v.b) why.push(`evidence from ${e.product}, which is not in the relation`);
        else if (!criteria.has(e.value.trim())) why.push(`criterion ${e.value} is not a signed criterion of this task`);
        continue;
      }
      const sheet = e.product === v.a || e.product === v.b ? sheets.get(e.product) : undefined;
      const value = sheet?.found ? sheetValue(sheet, e.field) : null;
      if (!sheet) why.push(`evidence from ${e.product}, which is not in the relation`);
      else if (value === null) why.push(`evidence field «${e.field}» is not in the sheet of ${e.product}`);
      else if (!norm(value).includes(norm(e.value))) why.push(`evidence «${e.field}: ${e.value}» does not appear in the sheet of ${e.product}`);
    }
    seen.add(id);
    if (why.length) refused.push({ relation: id, reason: why.join('; ').slice(0, 300) });
    else verdicts.push(v);
  }
  return { ok: true, verdicts, refused };
}

/**
 * What to review, in the owner's order (2026-11-24): the unreviewed relations, grouped by the product the customers
 * ask Pesín about most (of its two ends), then by how many it has; at most `size` per task. Relations a finished review
 * already judged (`reviewed`) are skipped, so an unsure one is left to a person and not paid for again.
 */
export function reviewTargets(g: ProductGraph, asked: ReadonlyMap<string, number>, reviewed: ReadonlySet<string>, size: number): { anchor: string; relations: Relation[] }[] {
  const score = (k: string) => asked.get(k) ?? 0;
  const byAnchor = new Map<string, Relation[]>();
  for (const r of g.unreviewed) {
    if (reviewed.has(relationId(r))) continue;
    const anchor = score(r[2]) > score(r[1]) ? r[2] : r[1];
    (byAnchor.get(anchor) ?? byAnchor.set(anchor, []).get(anchor)!).push(r);
  }
  return [...byAnchor]
    .sort(([a, ra], [b, rb]) => score(b) - score(a) || rb.length - ra.length || a.localeCompare(b))
    .flatMap(([anchor, rs]) => Array.from({ length: Math.ceil(rs.length / size) }, (_, i) => ({ anchor, relations: rs.slice(i * size, (i + 1) * size) })));
}

/** A finished review task: the relations it was asked about and what the platform recorded as its result. */
export interface FinishedReview { readonly hash: string; readonly taskId: string; readonly anchor: string; readonly relations: readonly Relation[]; readonly status: string; readonly result: JsonObject | null; readonly criteria?: readonly string[] }

/** Checks each finished review against the sheets and turns the verdicts that pass into proposals (by fingerprint). */
export async function proposalsFromReviews(g: ProductGraph, entries: readonly FinishedReview[], sheet: (productKey: string) => Promise<ProductSheetView>) {
  const sheets = new Map<string, ProductSheetView>();
  const sheetOf = async (k: string) => sheets.get(k) ?? sheets.set(k, await sheet(k)).get(k)!;
  const proposals: NewArtifactProposal[] = [];
  const refused: { relation: string; reason: string }[] = [];
  const counts = { keep: 0, remove: 0, unsure: 0 };
  let completed = 0;
  for (const t of entries) {
    if (t.status !== 'completed') { refused.push({ relation: `${t.anchor} (${t.relations.length})`, reason: `task ${t.status}` }); continue; }
    completed++;
    for (const k of new Set(t.relations.flatMap(([, a, b]) => [a, b]))) await sheetOf(k);
    const check = checkReview((t.result as { data?: unknown } | null)?.data, t.relations, sheets, new Set(t.criteria ?? []));
    if (!check.ok) { refused.push({ relation: `${t.anchor} (${t.relations.length})`, reason: check.violations.join('; ').slice(0, 300) }); continue; }
    refused.push(...check.refused);
    const base = { taskId: t.taskId, source: `graph-curator agent v${GRAPH_CURATOR_AGENT_VERSION}` };
    const label = (v: Verdict) => g.labels[`${v.area}:a`] ?? v.area;
    for (const v of check.verdicts) counts[v.verdict]++;
    for (const v of check.verdicts.filter((x) => x.verdict === 'remove')) {
      proposals.push({
        fingerprint: `inconsistency|AGENT_REMOVE_RELATION|${v.a}|${v.b}|${v.area}`,
        summary: cut(`${shortName(g, v.a)} – ${shortName(g, v.b)}: el curador propone quitar «${label(v)}» (${v.reason})`, 500),
        evidence: { task: 'inconsistency', rule: 'AGENT_REMOVE_RELATION', productKey: v.a, relatedKey: v.b, area: v.area, effect: 'Al aprobar: se quita esa relación.', reason: v.reason, cited: v.evidence, ...base },
        change: { op: 'remove_relation', area: v.area, a: v.a, b: v.b },
      });
    }
    const keep = check.verdicts.filter((x) => x.verdict === 'keep');
    if (keep.length) {
      proposals.push({
        fingerprint: `inconsistency|AGENT_CONFIRM_RELATIONS|${t.anchor}|${t.hash}`,
        summary: cut(`${shortName(g, t.anchor)}: el curador confirma ${keep.length} relaciones sin revisar (${[...new Set(keep.map(label))].join(', ')})`, 500),
        evidence: { task: 'inconsistency', rule: 'AGENT_CONFIRM_RELATIONS', productKey: t.anchor, relatedKey: null, effect: `Al aprobar: esas ${keep.length} relaciones quedan revisadas.`, relations: keep.map((v) => ({ area: v.area, a: v.a, b: v.b, reason: v.reason, cited: v.evidence })), ...base },
        change: { op: 'mark_reviewed', relations: keep.map((v) => [v.area, v.a, v.b]) },
      });
    }
  }
  return { proposals, refused, counts, completed };
}

export interface ReviewBatchResult {
  readonly batchId: string;
  /** Tasks this run created or resumed, and how many review chunks were left for later runs. */
  readonly tasks: number;
  readonly remaining: number;
  readonly completed: number;
  readonly verdicts: { readonly keep: number; readonly remove: number; readonly unsure: number };
  readonly proposals: { readonly created: number; readonly refreshed: number; readonly reopened: number; readonly skipped: number };
  readonly refused: readonly { readonly relation: string; readonly reason: string }[];
  readonly pending: readonly string[];
  /** What the run's tasks cost, from the tokens the platform recorded and the model's prices. */
  readonly spentUsd: number;
}

const shortName = (g: ProductGraph, key: string) => (g.products[key]?.n ?? key).split('|')[0]!.trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * One review run. Tasks go out in waves of `wave`; after each wave the run measures what its tasks really cost
 * (`spent`: recorded input/output tokens × prices) and starts the next only while the cap still covers a whole wave
 * at its worst (every task using its full token budget at the higher price). So the US$ cap is never exceeded.
 */
export async function runReviewBatch(
  deps: {
    readonly artifacts: Pick<PostgresArtifacts, 'current' | 'propose'>;
    readonly tasks: CuratorTasks;
    readonly sheet: (productKey: string) => Promise<ProductSheetView>;
    readonly asked: ReadonlyMap<string, number>;
    readonly reviewed: ReadonlySet<string>;
    /** The signed criteria (ADR-058 Decision 11) every task receives and may cite. */
    readonly criteria?: readonly GraphCriterion[];
    readonly spent: (taskIds: readonly string[]) => Promise<{ readonly inputTokens: number; readonly outputTokens: number }>;
    readonly sleep?: (ms: number) => Promise<void>;
  },
  input: {
    readonly batchId: string; readonly capUsd: number; readonly pricePerMillion: { readonly input: number; readonly output: number };
    readonly maxTokensPerTask: number; readonly wave: number; readonly perTask: number; readonly waitMs: number; readonly pollMs?: number;
  },
): Promise<ReviewBatchResult> {
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph');
  const g = signed.graph;
  const chunks = reviewTargets(g, deps.asked, deps.reviewed, input.perTask);
  const cost = (u: { inputTokens: number; outputTokens: number }) => (u.inputTokens * input.pricePerMillion.input + u.outputTokens * input.pricePerMillion.output) / 1_000_000;
  const worst = (input.maxTokensPerTask * Math.max(input.pricePerMillion.input, input.pricePerMillion.output)) / 1_000_000;
  const requestedBy: Principal = { kind: 'service', ref: 'graph-curator' };
  const deadline = Date.now() + input.waitMs;
  const taskOf = new Map<string, { taskId: string; anchor: string; relations: Relation[]; criteria: string[] }>();
  const criteria = deps.criteria ?? [];
  const done = new Map<string, { status: string; result: JsonObject | null }>();
  let next = 0;
  let spentUsd = 0;
  while (next < chunks.length && Date.now() < deadline) {
    const size = Math.min(input.wave, Math.floor((input.capUsd - spentUsd) / worst), chunks.length - next);
    if (size < 1) break;
    const wave: string[] = [];
    for (const chunk of chunks.slice(next, next + size)) {
      const hash = createHash('sha256').update(chunk.relations.map(relationId).join(',')).digest('hex').slice(0, 24);
      const { view } = await deps.tasks.createTask({
        request: {
          taskType: TASK_REVIEW_RELATIONS, agentId: GRAPH_CURATOR_AGENT_ID, agentVersion: GRAPH_CURATOR_AGENT_VERSION,
          goal: { description: `Revisar ${chunk.relations.length} relaciones sin revisar de ${shortName(g, chunk.anchor)} (${chunk.anchor}): keep, remove o unsure para cada una, con evidencia literal de las fichas.` },
          input: { anchor: chunk.anchor, relations: chunk.relations.map(([area, a, b]) => ({ area, a, b, meaning: `${shortName(g, a)} → «${g.labels[`${area}:a`] ?? area}» → ${shortName(g, b)}` })), criteria: criteria.map((c) => ({ id: c.id, statement: c.statement })) },
          budget: { maxTokens: input.maxTokensPerTask },
        },
        requestedBy, correlationId: `graph-review-${input.batchId}-${hash}`,
        // The same relations are one task: a run that stopped waiting resumes it, never pays for it twice.
        idempotencyKey: `graph-review-${hash}`,
      });
      taskOf.set(hash, { taskId: view.task.taskId, anchor: chunk.anchor, relations: chunk.relations, criteria: criteria.map((c) => c.id) });
      wave.push(hash);
    }
    next += size;
    await waitForTasks(deps.tasks, new Map(wave.map((h) => [h, taskOf.get(h)!.taskId])), done, deadline, deps.sleep, input.pollMs);
    spentUsd = cost(await deps.spent([...taskOf.values()].map((t) => t.taskId)));
  }

  const finished: FinishedReview[] = [...done].map(([hash, task]) => ({ hash, ...taskOf.get(hash)!, ...task }));
  const { proposals, refused, counts, completed } = await proposalsFromReviews(g, finished, deps.sheet);
  const stored = await deps.artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: signed.version, source: `graph-curator-agent:${input.batchId}`, correlationId: `graph-review-${input.batchId}`, proposals });
  return {
    batchId: input.batchId, tasks: taskOf.size, remaining: chunks.length - next, completed, verdicts: counts, proposals: stored, refused,
    pending: [...taskOf].filter(([h]) => !done.has(h)).map(([, t]) => t.taskId), spentUsd: Math.round(spentUsd * 10_000) / 10_000,
  };
}

/** The relations a completed review task already judged (any graph version): not sent to the model again. */
export async function reviewedRelations(pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { r: { area: string; a: string; b: string }[] | null }[] }> }): Promise<Set<string>> {
  const res = await pool.query(`select input->'relations' as r from agent_tasks where agent_id = $1 and task_type = $2 and status = 'completed'`, [GRAPH_CURATOR_AGENT_ID, TASK_REVIEW_RELATIONS]);
  return new Set(res.rows.flatMap((row) => (row.r ?? []).map((x) => relationId([x.area, x.a, x.b]))));
}

/** What the given tasks consumed, from the runs the platform recorded. */
export async function tokensSpent(pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { i: number; o: number }[] }> }, taskIds: readonly string[]): Promise<{ inputTokens: number; outputTokens: number }> {
  if (!taskIds.length) return { inputTokens: 0, outputTokens: 0 };
  const res = await pool.query(`select coalesce(sum(input_tokens), 0)::int as i, coalesce(sum(output_tokens), 0)::int as o from agent_runs where task_id = any($1::uuid[])`, [taskIds]);
  return { inputTokens: res.rows[0]?.i ?? 0, outputTokens: res.rows[0]?.o ?? 0 };
}

/**
 * Re-checks the results of review tasks that already completed (no model call, nothing paid again) against today's
 * sheets and evaluation, and stores the proposals by fingerprint: still-open ones are refreshed, decided ones stand.
 * Used after the evaluation was corrected (2026-11-25: a sheet's own «Categoría» specification was refused).
 */
export async function recheckReviews(
  deps: { readonly artifacts: Pick<PostgresArtifacts, 'current' | 'propose'>; readonly tasks: CuratorTasks; readonly sheet: (productKey: string) => Promise<ProductSheetView> },
  input: { readonly batchId: string; readonly reviews: readonly CompletedReview[] },
): Promise<Omit<ReviewBatchResult, 'tasks' | 'remaining' | 'pending' | 'spentUsd'> & { readonly rechecked: number }> {
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph');
  const finished: FinishedReview[] = [];
  for (const r of input.reviews) {
    const { task } = await deps.tasks.getTask(r.taskId);
    // The same hash as the run that created the task, so its proposals keep their fingerprints.
    const hash = createHash('sha256').update(r.relations.map(relationId).join(',')).digest('hex').slice(0, 24);
    if (task.status === 'completed') finished.push({ ...r, hash, status: task.status, result: task.result });
  }
  const { proposals, refused, counts, completed } = await proposalsFromReviews(signed.graph, finished, deps.sheet);
  const stored = await deps.artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: signed.version, source: `graph-curator-agent:recheck:${input.batchId}`, correlationId: `graph-recheck-${input.batchId}`, proposals });
  return { batchId: input.batchId, rechecked: finished.length, completed, verdicts: counts, proposals: stored, refused };
}

export interface CompletedReview { readonly taskId: string; readonly anchor: string; readonly relations: readonly Relation[]; readonly criteria?: readonly string[] }

/** A criterion a person signed (ADR-058 Decision 11): the knowledge entry id and its statement. */
export interface GraphCriterion { readonly id: string; readonly statement: string }

/** The review tasks that completed (any graph version), oldest first, with the relations each was asked about. */
export async function completedReviewTasks(pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { task_id: string; anchor: string | null; r: { area: string; a: string; b: string }[] | null; c?: { id: string }[] | null }[] }> }): Promise<CompletedReview[]> {
  const res = await pool.query(`select task_id, input->>'anchor' as anchor, input->'relations' as r, input->'criteria' as c from agent_tasks where agent_id = $1 and task_type = $2 and status = 'completed' order by created_at`, [GRAPH_CURATOR_AGENT_ID, TASK_REVIEW_RELATIONS]);
  return res.rows.filter((row) => row.anchor && row.r).map((row) => ({ taskId: row.task_id, anchor: row.anchor!, relations: row.r!.map((x): Relation => [x.area, x.a, x.b]), criteria: (row.c ?? []).map((x) => x.id) }));
}
