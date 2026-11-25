import type { JsonObject, Principal } from '@r4/contracts';
import type { NewArtifactProposal, PostgresArtifacts } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND } from '../graph.js';
import { readSignedGraph } from '../signed.js';
import type { ProductSheetView } from './capabilities.js';
import { checkClassification, classificationTargets, kindVocabulary } from './classify.js';
import { GRAPH_CURATOR_AGENT_ID, GRAPH_CURATOR_AGENT_VERSION, TASK_CLASSIFY_PRODUCT } from './definition.js';

/** The parts of TaskRuntime the batch uses (created and read like any other task: governed runs). */
export interface CuratorTasks {
  createTask(command: { request: { taskType: string; agentId: string; agentVersion: number; goal: { description: string }; input: JsonObject; budget: { maxTokens: number } }; requestedBy: Principal; correlationId: string; idempotencyKey?: string }): Promise<{ view: { task: { taskId: string } } }>;
  getTask(taskId: string): Promise<{ task: { status: string; result: JsonObject | null } }>;
}

export interface ClassificationBatchResult {
  readonly batchId: string;
  readonly targets: number;
  readonly completed: number;
  readonly proposals: { readonly created: number; readonly refreshed: number; readonly reopened: number; readonly skipped: number };
  /** Results the deterministic check refused (never proposed), with why. */
  readonly refused: readonly { readonly productKey: string; readonly reason: string }[];
  /** Tasks not finished within the wait (picked up by the next batch: same idempotency key). */
  readonly pending: readonly string[];
}

// A blocked task (e.g. its token budget ran out) will not finish by itself: the batch counts it as done, refused.
const FINISHED = new Set(['completed', 'failed', 'cancelled', 'blocked']);

/**
 * ADR-058 G4a: one batch of the graph-curator agent. The products no rule classifies, in the owner's order (most asked
 * to Pesín first), each become a governed task; its validated result becomes proposals a person approves. The token
 * budget per task is the run's US$ cap converted with the model price, divided among the tasks.
 */
export async function runClassificationBatch(
  deps: {
    readonly artifacts: Pick<PostgresArtifacts, 'current' | 'propose'>;
    readonly tasks: CuratorTasks;
    readonly sheet: (productKey: string) => Promise<ProductSheetView>;
    readonly asked: ReadonlyMap<string, number>;
    /** The signed criteria (ADR-058 Decision 11) every task receives and may cite. */
    readonly criteria?: readonly { readonly id: string; readonly statement: string }[];
    readonly sleep?: (ms: number) => Promise<void>;
  },
  input: { readonly batchId: string; readonly limit: number; readonly maxTokensPerTask: number; readonly waitMs: number; readonly pollMs?: number },
): Promise<ClassificationBatchResult> {
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph');
  const vocabulary = new Set(kindVocabulary(signed.graph).kinds.map((k) => k.kind));
  const targets = classificationTargets(signed.graph, deps.asked, () => false, input.limit);
  const requestedBy: Principal = { kind: 'service', ref: 'graph-curator' };
  const taskOf = new Map<string, string>();
  for (const key of targets) {
    const { view } = await deps.tasks.createTask({
      request: {
        taskType: TASK_CLASSIFY_PRODUCT, agentId: GRAPH_CURATOR_AGENT_ID, agentVersion: GRAPH_CURATOR_AGENT_VERSION,
        goal: { description: `Clasificar el producto ${key}: su tipo (de la lista cerrada) y sus grupos musculares, con evidencia literal de su ficha.` },
        input: { productKey: key, criteria: (deps.criteria ?? []).map((c) => ({ id: c.id, statement: c.statement })) },
        budget: { maxTokens: input.maxTokensPerTask },
      },
      requestedBy, correlationId: `graph-classify-${input.batchId}-${key}`,
      // The same product on the same signed version is one task: an unfinished one is resumed, never duplicated.
      idempotencyKey: `graph-classify-v${signed.version}-${key}`,
    });
    taskOf.set(key, view.task.taskId);
  }

  const done = new Map<string, { status: string; result: JsonObject | null }>();
  await waitForTasks(deps.tasks, taskOf, done, Date.now() + input.waitMs, deps.sleep, input.pollMs);

  const refused: { productKey: string; reason: string }[] = [];
  const proposals: NewArtifactProposal[] = [];
  let completed = 0;
  for (const [key, task] of done) {
    if (task.status !== 'completed') { refused.push({ productKey: key, reason: `task ${task.status}` }); continue; }
    completed++;
    const check = checkClassification((task.result as { data?: unknown } | null)?.data, await deps.sheet(key), vocabulary, new Set((deps.criteria ?? []).map((c) => c.id)));
    if (!check.ok) { refused.push({ productKey: key, reason: check.violations.join('; ').slice(0, 300) }); continue; }
    const c = check.classification;
    const name = signed.graph.products[key]?.n ?? key;
    const evidence = { taskId: taskOf.get(key), confidence: c.confidence, cited: c.evidence, source: 'graph-curator agent v1' };
    if (c.kind) proposals.push({ fingerprint: `missing_data|AGENT_KIND|${key}|`, summary: `${name}: el curador lo clasifica como ${c.kind} (confianza ${c.confidence})`, evidence: { task: 'missing_data', rule: 'AGENT_KIND', productKey: key, relatedKey: null, effect: 'Al aprobar: el grafo usa ese tipo para este producto.', ...evidence }, change: { op: 'set_kind', key, kind: c.kind } });
    if (c.muscles.length) proposals.push({ fingerprint: `missing_data|AGENT_MUSCLES|${key}|`, summary: `${name}: trabaja ${c.muscles.join(', ').replaceAll('_', ' ')} (curador, confianza ${c.confidence})`, evidence: { task: 'missing_data', rule: 'AGENT_MUSCLES', productKey: key, relatedKey: null, effect: 'Al aprobar: el grafo registra qué grupos trabaja.', muscles: c.muscles, ...evidence }, change: { op: 'set_muscles', key, muscles: c.muscles } });
  }
  const stored = await deps.artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: signed.version, source: `graph-curator-agent:${input.batchId}`, correlationId: `graph-classify-${input.batchId}`, proposals });
  return { batchId: input.batchId, targets: targets.length, completed, proposals: stored, refused, pending: [...taskOf.keys()].filter((k) => !done.has(k)) };
}

/** Waits until every task of `taskOf` (label → task id) is finished or the deadline passes; finished ones land in `done`. */
export async function waitForTasks(
  tasks: CuratorTasks, taskOf: ReadonlyMap<string, string>, done: Map<string, { status: string; result: JsonObject | null }>, deadline: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)), pollMs = 5_000,
): Promise<void> {
  const open = () => [...taskOf.keys()].filter((k) => !done.has(k));
  while (open().length && Date.now() < deadline) {
    for (const key of open()) {
      const { task } = await tasks.getTask(taskOf.get(key)!);
      if (FINISHED.has(task.status)) done.set(key, task);
    }
    if (open().length) await sleep(pollMs);
  }
}

/**
 * How many tasks fit in a US$ cap per run (owner decision 3: US$1), each with its full token budget, from the model's
 * price per million tokens (the higher of input/output: a conservative bound, since the platform records tokens, never
 * cost). A task never gets less than its budget: one that would run out is not started.
 */
export function tasksWithinBudget(capUsd: number, pricePerMillionUsd: number, tokensPerTask: number): number {
  if (!(capUsd > 0) || !(pricePerMillionUsd > 0) || !(tokensPerTask > 0)) return 0;
  return Math.floor(((capUsd / pricePerMillionUsd) * 1_000_000) / tokensPerTask);
}

/**
 * How often Pesín read each product's sheet in the last 90 days (owner 2026-11-24: classify what customers ask about
 * first). Read from R4's own run steps (catalog.get_product_context calls), counts only.
 */
export async function askedToPesin(pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { key: string | null; n: number }[] }> }): Promise<Map<string, number>> {
  const r = await pool.query(
    `select decision->'arguments'->>'productKey' as key, count(*)::int as n from agent_run_steps
      where decision->>'type' = 'read_capability' and decision->>'capabilityId' = 'catalog.get_product_context' and created_at > now() - interval '90 days'
      group by 1`,
  );
  return new Map(r.rows.filter((row) => row.key).map((row) => [row.key!, row.n]));
}
