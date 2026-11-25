import type { ArtifactProposal, PostgresArtifacts, PostgresKnowledge } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, type ProductGraph } from '../graph.js';
import { presentProposal, type Presentation } from '../present.js';
import { readSignedGraph } from '../signed.js';
import type { CuratorTasks } from './batch.js';
import { confirmPlan, readPlan, type ExplanationPlan } from './explain.js';

/**
 * ADR-058 Decision 13 (G6): the product manager curates the curator in ClickUp. Every few minutes this sync:
 * 1. records what the PM answered (the Respuesta field) as their decision, and closes the task;
 * 2. turns a new PM comment into an explanation (Decision 11): the curator's plan is posted in the thread; an exact
 *    «sí» confirms the latest plan in the PM's name;
 * 3. closes the tasks whose question is no longer open (decided in the console, resolved);
 * 4. fills the list up to the cap with the most important open questions.
 * Stateless: the thread itself is the state (R4's comments carry markers), so a restart loses nothing. Only the PM's
 * answers and comments count; ClickUp text is untrusted data and never changes the graph by itself.
 */

/** What the curator needs from the ClickUp connector (ADR-061; `@r4-adapters/clickup` implements it). */
export interface QuestionBoard {
  createQuestionTask(input: { questionId: string; title: string; markdown: string; priority: 'urgent' | 'high' | 'normal'; dueDate?: Date }): Promise<{ taskId: string; url: string; created: boolean }>;
  commentTask(taskId: string, text: string): Promise<void>;
  closeTask(taskId: string, note?: string): Promise<void>;
  readList(options?: { includeClosed?: boolean }): Promise<readonly { taskId: string; questionId: string; closed: boolean; answer: string | null }[]>;
  readComments(taskId: string, options?: { sinceMs?: number }): Promise<readonly { commentId: string; userId: number | null; text: string; dateMs: number }[]>;
  readAnswerOptions(): Promise<readonly { id: string; name: string; orderindex: number | null }[]>;
}

/** Marks in R4's own comments: the thread is the state. */
export const R4_COMMENT_PREFIX = 'Curador R4:';
const planMark = (id: string) => `[r4-plan:${id}]`;
const PLAN_MARK = /\[r4-plan:([0-9a-f-]{36})\]/u;
const DONE_MARK = '[r4-done]';

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase().replace(/[.!¡]+$/u, '');
/** An exact «sí» confirms; anything else is a new explanation. */
export const isConfirmation = (text: string) => ['si', 'si, confirmo', 'confirmo', 'yes'].includes(norm(text));

const money = (n: number | null) => (n === null ? 'sin precio' : `$${Math.round(n).toLocaleString('es-CL')}`);

/** The task text (Decision 12 template): the question, both products, what each answer does, why the curator asks. */
export function questionMarkdown(p: ArtifactProposal, shown: Presentation, consoleUrl: string): string {
  const reason = (p.evidence as { reason?: unknown } | null)?.reason;
  return [
    `**${shown.question ?? shown.text}**`,
    '',
    ...shown.products.map((x) => `- ${x.name} · ${money(x.price)}${x.active === false ? ' · inactivo' : ''}`),
    '',
    `**Si respondes Sí:** ${shown.ifYes ?? '—'}`,
    `**Si respondes No:** ${shown.ifNo ?? '—'}`,
    '',
    `Por qué pregunta el curador: ${typeof reason === 'string' ? reason : p.summary}`,
    '',
    'Responde con el campo **Respuesta** (Sí / No), o comenta con tus palabras para conversar con el curador: te responde aquí con lo que hará, y lo confirmas respondiendo «sí».',
    `Ver en la consola: ${consoleUrl}`,
  ].join('\n');
}

/** The plan as a comment: what the curator will do, and how to confirm it. */
export function planComment(planId: string, plan: ExplanationPlan | null, violations: readonly string[], questions: readonly (string | null)[]): string {
  if (!plan) return `${R4_COMMENT_PREFIX} no pude armar un plan válido con eso (${violations.slice(0, 3).join('; ') || 'la tarea no terminó'}). ¿Me lo explicas de otra forma?`;
  const decision = plan.proposal === 'approve' ? 'la apruebo' : plan.proposal === 'reject' ? 'la rechazo' : 'la dejo abierta';
  return [
    `${R4_COMMENT_PREFIX} ${plan.summary}`,
    `- Esta pregunta: ${decision}.`,
    ...(plan.similar.length ? [`- Resuelvo igual ${plan.similar.length} preguntas parecidas.`] : []),
    ...questions.filter((x): x is string => !!x).map((x) => `- Cambio: ${x}`),
    ...(plan.criterion ? [`- Guardo este criterio: «${plan.criterion}»`] : []),
    'Si está bien, responde «sí». Si no, explícamelo de nuevo.',
    planMark(planId),
  ].join('\n');
}

export interface ClickUpSyncDeps {
  readonly artifacts: Pick<PostgresArtifacts, 'current' | 'proposals' | 'propose' | 'decide'>;
  readonly tasks: CuratorTasks;
  readonly knowledge: Pick<PostgresKnowledge, 'list' | 'propose' | 'transition'>;
  readonly board: QuestionBoard;
  readonly asked: ReadonlyMap<string, number>;
  /** Opens the interpretation of an explanation (graph:explain, within its daily cap) and waits for it. */
  readonly explain: (proposalId: string, text: string) => Promise<string>;
}
export interface ClickUpSyncConfig {
  /** The PM's ClickUp user id: only their answers and comments count. */
  readonly pmClickUpId: number;
  /** The PM as an R4 operator: their decisions are recorded in this name, with these scopes. */
  readonly pmRef: string;
  readonly pmScopes: readonly string[];
  readonly maxOpen: number;
  readonly dueDays: number;
  readonly consoleUrl: string;
  readonly now?: () => Date;
}

export interface ClickUpSyncReport {
  answered: number; explained: number; confirmed: number; closed: number; created: number; open: number; errors: string[];
}

export async function syncClickUp(deps: ClickUpSyncDeps, cfg: ClickUpSyncConfig): Promise<ClickUpSyncReport> {
  const report: ClickUpSyncReport = { answered: 0, explained: 0, confirmed: 0, closed: 0, created: 0, open: 0, errors: [] };
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph');
  const g: ProductGraph = signed.graph;
  const options = await deps.board.readAnswerOptions();
  const answerOf = (raw: string | null): 'si' | 'no' | null => {
    if (raw === null) return null;
    const o = options.find((x) => x.id === raw || String(x.orderindex) === raw);
    const n = o ? norm(o.name) : null;
    return n === 'si' ? 'si' : n === 'no' ? 'no' : null;
  };
  let open = new Map((await deps.artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).map((p) => [p.proposalId, p]));
  const tasks = await deps.board.readList({ includeClosed: true });
  const step = async (what: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { report.errors.push(`${what}: ${e instanceof Error ? e.message.slice(0, 160) : 'unexpected'}`); } };

  for (const t of tasks.filter((x) => !x.closed)) {
    const proposal = open.get(t.questionId);
    if (!proposal) {
      await step(`close ${t.taskId}`, async () => { await deps.board.closeTask(t.taskId, `${R4_COMMENT_PREFIX} esta pregunta ya no está abierta en R4 (se decidió en la consola o dejó de hacer falta). ${DONE_MARK}`); report.closed++; });
      continue;
    }
    // 1. The Respuesta field, set by the PM: a decision without the model.
    const answer = answerOf(t.answer);
    if (answer) {
      await step(`answer ${t.taskId}`, async () => {
        const shown = presentProposal(g, proposal, deps.asked);
        if (!shown.yes) throw new Error('this question has no yes/no meaning');
        const approve = (answer === 'si') === (shown.yes === 'approve');
        await deps.artifacts.decide({ kind: PRODUCT_GRAPH_KIND, proposalIds: [proposal.proposalId], decision: approve ? 'approved' : 'rejected', decidedBy: cfg.pmRef, note: `Respondido en ClickUp: ${answer === 'si' ? 'Sí' : 'No'}`, correlationId: `clickup-${t.taskId}` });
        await deps.board.closeTask(t.taskId, `${R4_COMMENT_PREFIX} listo, ${(answer === 'si' ? shown.ifYes : shown.ifNo) ?? ''} Entra en la próxima versión del grafo. ${DONE_MARK}`);
        report.answered++;
      });
      continue;
    }
    // 2. The conversation: the latest PM comment after R4's latest comment.
    await step(`thread ${t.taskId}`, async () => {
      const comments = await deps.board.readComments(t.taskId);
      const lastR4 = [...comments].reverse().find((c) => c.text.startsWith(R4_COMMENT_PREFIX));
      const pending = comments.filter((c) => c.userId === cfg.pmClickUpId && !c.text.startsWith(R4_COMMENT_PREFIX) && (!lastR4 || c.dateMs > lastR4.dateMs));
      const latest = pending.at(-1);
      if (!latest) return;
      const planId = lastR4 ? PLAN_MARK.exec(lastR4.text)?.[1] : undefined;
      if (isConfirmation(latest.text) && planId) {
        const done = await confirmPlan(deps, { taskId: planId, by: cfg.pmRef, scopes: cfg.pmScopes, correlationId: `clickup-${t.taskId}` });
        const left = (await deps.artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).some((p) => p.proposalId === proposal.proposalId);
        const text = `${R4_COMMENT_PREFIX} confirmado: ${done.similar} parecidas resueltas, ${done.changes} cambios aprobados${done.criterion ? ', criterio guardado' : ''}. Entra en la próxima versión del grafo. ${DONE_MARK}`;
        if (left) await deps.board.commentTask(t.taskId, text); else await deps.board.closeTask(t.taskId, text);
        report.confirmed++;
        return;
      }
      const text = pending.map((c) => c.text.trim()).join('\n').slice(0, 2000);
      const id = await deps.explain(proposal.proposalId, text);
      const read = await readPlan(deps, id);
      const questions = (read.plan?.changes ?? []).map((change) => presentProposal(g, { summary: '', change }, new Map()).question);
      await deps.board.commentTask(t.taskId, planComment(id, read.plan, read.violations, questions));
      report.explained++;
    });
  }

  // 4. Fill the list with the most important open questions that never had a task (urgent and high come in G6-2).
  open = new Map((await deps.artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).map((p) => [p.proposalId, p]));
  const after = await deps.board.readList({ includeClosed: true });
  const had = new Set(after.map((x) => x.questionId));
  report.open = after.filter((x) => !x.closed).length;
  const candidates = [...open.values()]
    .map((p) => ({ p, shown: presentProposal(g, p, deps.asked) }))
    .filter(({ p, shown }) => shown.group === 'changes' && shown.question && !had.has(p.proposalId.toLowerCase()))
    .sort((a, b) => b.shown.asked - a.shown.asked || a.p.createdAt.localeCompare(b.p.createdAt));
  const due = new Date((cfg.now?.() ?? new Date()).getTime() + cfg.dueDays * 86_400_000);
  for (const { p, shown } of candidates.slice(0, Math.max(0, cfg.maxOpen - report.open))) {
    await step(`create ${p.proposalId}`, async () => {
      const r = await deps.board.createQuestionTask({ questionId: p.proposalId, title: shown.question!.slice(0, 250), markdown: questionMarkdown(p, shown, cfg.consoleUrl), priority: 'normal', dueDate: due });
      if (r.created) report.created++;
      report.open++;
    });
  }
  return report;
}
