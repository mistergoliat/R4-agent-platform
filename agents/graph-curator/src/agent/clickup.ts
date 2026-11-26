import type { ArtifactProposal, PostgresArtifacts, PostgresKnowledge } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, type ProductGraph } from '../graph.js';
import { presentProposal, type Presentation } from '../present.js';
import { readSignedGraph } from '../signed.js';
import type { CuratorTasks } from './batch.js';
import { confirmPlan, readPlan, type ExplanationPlan } from './explain.js';

/**
 * ADR-058 Decision 13 (G6): the product manager curates the curator in ClickUp, in ONE task a week (owner,
 * 2026-11-25: one task per question «no tiene tanto sentido»). The week's task lists up to N numbered items; each item
 * groups the open questions about one product. Every few minutes this sync:
 * 1. opens the week's task when there is none (an open one from a past week is closed, its pending items move on);
 * 2. reads the PM's new comments: «1 no, 2 sí, 3 no sé» answer items without the model; «1: <words>» is an
 *    explanation (Decision 11) whose plan is posted in the thread, and «1 sí» then confirms it in the PM's name;
 * 3. replies once per pass with what it did, and closes the task when every item is answered or no longer open.
 * Stateless: the thread is the state. R4's comments start with «Curador R4:» and carry markers: the items
 * ([r4-items:1=<id>,<id>;2=<id>]), a plan per item ([r4-plan:<id>:<n>]), a «no sé» ([r4-unsure:<ids>]). Only the PM's
 * comments count; ClickUp text is untrusted data and never changes the graph by itself.
 */

/** What the curator needs from the ClickUp connector (ADR-061; `@r4-adapters/clickup` implements it). */
export interface QuestionBoard {
  createQuestionTask(input: { questionId: string; title: string; markdown: string; priority: 'urgent' | 'high' | 'normal'; dueDate?: Date }): Promise<{ taskId: string; url: string; created: boolean }>;
  commentTask(taskId: string, text: string): Promise<void>;
  closeTask(taskId: string, note?: string): Promise<void>;
  readList(options?: { includeClosed?: boolean }): Promise<readonly { taskId: string; questionId: string; closed: boolean; answer: string | null }[]>;
  readComments(taskId: string, options?: { sinceMs?: number }): Promise<readonly { commentId: string; userId: number | null; text: string; dateMs: number }[]>;
}

export const R4_COMMENT_PREFIX = 'Curador R4:';
const ITEMS_MARK = /\[r4-items:([^\]]+)\]/u;
const PLAN_MARK = /\[r4-plan:([0-9a-f-]{36}):(\d{1,2})\]/gu;
const DONE_MARK = /\[r4-done:(\d{1,2})\]/gu;
const UNSURE_MARK = /\[r4-unsure:([0-9a-f,-]+)\]/gu;
/** The week's task: its tag carries the ISO week (the connector lowercases it). */
const DIGEST_ID = /^digest-\d{4}-w\d{2}$/u;

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase().replace(/[.!¡]+$/u, '');
/** A short answer: yes, no, or «no sé». Anything else is the PM's own words. */
export function shortAnswer(text: string): 'si' | 'no' | 'unsure' | null {
  const t = norm(text);
  if (['si', 'yes', 'si, confirmo', 'confirmo'].includes(t)) return 'si';
  if (t === 'no') return 'no';
  if (['no se', 'nose', 'no lo se', 'ni idea'].includes(t)) return 'unsure';
  return null;
}

/** «1 no, 2 sí, 3 no sé» or «1: es un soporte…» → [{ n, text }]. A comment without numbers counts for item 1 only when the task has one item. */
export function parseAnswers(text: string, items: number): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  for (const part of text.split(/\n|;|,(?=\s*\d{1,2}\b)/u)) {
    const m = /^\s*(\d{1,2})\s*[:.)\-–]?\s*(.+?)\s*$/su.exec(part);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= items) out.push({ n: Number(m[1]), text: m[2]! });
  }
  if (!out.length && items === 1 && text.trim()) out.push({ n: 1, text: text.trim() });
  return out;
}

/** ISO 8601 week (Monday first), as «2026-w48». */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-w${String(week).padStart(2, '0')}`;
}

const money = (n: number | null) => (n === null ? 'sin precio' : `$${Math.round(n).toLocaleString('es-CL')}`);

interface Item { readonly n: number; readonly ids: readonly string[] }
const itemsMark = (items: readonly Item[]) => `[r4-items:${items.map((i) => `${i.n}=${i.ids.join(',')}`).join(';')}]`;
function itemsOf(text: string): Item[] | null {
  const m = ITEMS_MARK.exec(text);
  if (!m) return null;
  return m[1]!.split(';').map((s) => { const [n, ids] = s.split('='); return { n: Number(n), ids: (ids ?? '').split(',').filter(Boolean) }; }).filter((i) => i.n > 0 && i.ids.length);
}

/** One item of the week's task: the group's question, both products, what each answer does, why the curator asks. */
function itemMarkdown(n: number, group: readonly { p: ArtifactProposal; shown: Presentation }[]): string {
  const [{ p, shown }] = group as [{ p: ArtifactProposal; shown: Presentation }];
  const reason = (p.evidence as { reason?: unknown } | null)?.reason;
  const more = group.length > 1 ? ` *(y ${group.length - 1} más del mismo producto; la respuesta vale para todas)*` : '';
  return [
    `**${n}. ${shown.question ?? shown.text}**${more}`,
    `   ${shown.products.slice(0, 2).map((x) => `${x.name} · ${money(x.price)}`).join(' / ')}`,
    `   Sí: ${shown.ifYes ?? '—'} · No: ${shown.ifNo ?? '—'}`,
    `   Por qué pregunta el curador: ${typeof reason === 'string' ? reason : p.summary}`,
  ].join('\n');
}

/** A plan in the thread, for item n. */
export function planComment(planId: string, n: number, plan: ExplanationPlan | null, violations: readonly string[], questions: readonly (string | null)[]): string {
  if (!plan) return `${n} · no pude armar un plan válido con eso (${violations.slice(0, 2).join('; ') || 'la tarea no terminó'}). ¿Me lo explicas de otra forma?`;
  const decision = plan.proposal === 'approve' ? 'la apruebo' : plan.proposal === 'reject' ? 'la rechazo' : 'la dejo abierta';
  return [
    `${n} · ${plan.summary}`,
    `   Esta pregunta: ${decision}.${plan.similar.length ? ` Resuelvo igual ${plan.similar.length} parecidas.` : ''}`,
    ...questions.filter((x): x is string => !!x).map((x) => `   Cambio: ${x}`),
    ...(plan.criterion ? [`   Guardo este criterio: «${plan.criterion}»`] : []),
    `   Si está bien, responde «${n} sí»; si no, explícamelo de nuevo. [r4-plan:${planId}:${n}]`,
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
  /** The PM's ClickUp user id: only their comments count. */
  readonly pmClickUpId: number;
  /** The PM as an R4 operator: their decisions are recorded in this name, with these scopes. */
  readonly pmRef: string;
  readonly pmScopes: readonly string[];
  /** Items in the week's task (each item = the questions about one product). */
  readonly maxItems: number;
  readonly dueDays: number;
  readonly consoleUrl: string;
  readonly now?: () => Date;
}
export interface ClickUpSyncReport {
  week: string; created: boolean; answered: number; explained: number; confirmed: number; unsure: number; closed: number; items: number; errors: string[];
}

export async function syncClickUp(deps: ClickUpSyncDeps, cfg: ClickUpSyncConfig): Promise<ClickUpSyncReport> {
  const now = cfg.now?.() ?? new Date();
  const week = isoWeek(now);
  const report: ClickUpSyncReport = { week, created: false, answered: 0, explained: 0, confirmed: 0, unsure: 0, closed: 0, items: 0, errors: [] };
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph');
  const g: ProductGraph = signed.graph;
  const openNow = async () => new Map((await deps.artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).map((p) => [p.proposalId, p]));
  let open = await openNow();
  // Only R4's week tasks; any other task in the list (a test, someone's own) is never touched.
  const digests = (await deps.board.readList({ includeClosed: true })).filter((t) => DIGEST_ID.test(t.questionId));
  const r4 = (c: { text: string }) => c.text.startsWith(R4_COMMENT_PREFIX);

  // «No sé» answers of the last digests stay out of ClickUp: they go to the console.
  const unsure = new Set<string>();
  const threads = new Map<string, Awaited<ReturnType<QuestionBoard['readComments']>>>();
  for (const d of digests) {
    const comments = await deps.board.readComments(d.taskId);
    threads.set(d.taskId, comments);
    for (const c of comments.filter(r4)) for (const m of c.text.matchAll(UNSURE_MARK)) for (const id of m[1]!.split(',')) unsure.add(id);
  }

  const current = digests.find((d) => !d.closed && d.questionId === `digest-${week}`);
  // A past week's task still open: closed; what it still had pending comes back in this week's.
  for (const d of digests.filter((x) => !x.closed && x !== current)) {
    try { await deps.board.closeTask(d.taskId, `${R4_COMMENT_PREFIX} cierro la semana; lo que quedó pendiente pasa a la tarea de esta semana.`); report.closed++; } catch (e) { report.errors.push(`close ${d.taskId}: ${e instanceof Error ? e.message.slice(0, 120) : 'unexpected'}`); }
  }

  if (!current) {
    // The week's items: open questions that change what Pesín does, grouped by product, most asked first.
    const groups = new Map<string, { p: ArtifactProposal; shown: Presentation }[]>();
    for (const p of open.values()) {
      if (unsure.has(p.proposalId)) continue;
      const shown = presentProposal(g, p, deps.asked);
      if (shown.group !== 'changes' || !shown.question || !shown.yes) continue;
      const key = shown.products[0]?.key ?? p.proposalId;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push({ p, shown });
    }
    const ranked = [...groups.values()].sort((a, b) => Math.max(...b.map((x) => x.shown.asked)) - Math.max(...a.map((x) => x.shown.asked)) || b.length - a.length).slice(0, cfg.maxItems);
    if (!ranked.length) return report;
    const items: Item[] = ranked.map((grp, i) => ({ n: i + 1, ids: grp.map((x) => x.p.proposalId) }));
    const markdown = [
      `Esta semana el curador tiene ${ranked.length} ${ranked.length === 1 ? 'pregunta' : 'preguntas'} que cambian lo que recomienda Pesín. Las más consultadas van primero.`,
      '',
      ...ranked.map((grp, i) => itemMarkdown(i + 1, grp)),
      '',
      'Responde en un comentario, por número: «1 no, 2 sí, 3 no sé». O explica una con tus palabras: «1: es un soporte, va con todas las barras». El curador te contesta aquí con lo que hará, y lo confirmas con «1 sí».',
      `Ver en la consola: ${cfg.consoleUrl}`,
    ].join('\n');
    const total = ranked.reduce((s, grp) => s + grp.length, 0);
    try {
      const created = await deps.board.createQuestionTask({ questionId: `digest-${week}`, title: `Curador del grafo · preguntas de la semana (${ranked.length})`.slice(0, 250), markdown, priority: 'normal', dueDate: new Date(now.getTime() + cfg.dueDays * 86_400_000) });
      report.created = created.created;
      await deps.board.commentTask(created.taskId, `${R4_COMMENT_PREFIX} referencias internas de esta semana (${total} preguntas en ${ranked.length} ítems; puedes ignorar este comentario). ${itemsMark(items)}`);
      report.items = items.length;
    } catch (e) {
      report.errors.push(`create digest-${week}: ${e instanceof Error ? e.message.slice(0, 160) : 'unexpected'}`);
    }
    return report;
  }

  const comments = threads.get(current.taskId) ?? [];
  const items = comments.filter(r4).map((c) => itemsOf(c.text)).find((x): x is Item[] => x !== null) ?? null;
  if (!items) { report.errors.push(`digest ${current.taskId}: its items comment is missing`); return report; }
  report.items = items.length;
  const byN = new Map(items.map((i) => [i.n, i]));
  // Per item: done, unsure, or a plan pending (the latest plan mark not followed by a done mark for that item).
  const done = new Set<number>(); const pendingPlan = new Map<number, string>();
  for (const c of comments.filter(r4)) {
    for (const m of c.text.matchAll(PLAN_MARK)) pendingPlan.set(Number(m[2]), m[1]!);
    for (const m of c.text.matchAll(DONE_MARK)) { done.add(Number(m[1])); pendingPlan.delete(Number(m[1])); }
  }
  const stillOpen = (i: Item) => i.ids.filter((id) => open.has(id) && !unsure.has(id));
  const lastR4 = [...comments].reverse().find(r4);
  const fresh = comments.filter((c) => c.userId === cfg.pmClickUpId && !r4(c) && (!lastR4 || c.dateMs > lastR4.dateMs));
  const replies: string[] = [];

  for (const { n, text } of fresh.flatMap((c) => parseAnswers(c.text, items.length))) {
    const item = byN.get(n)!;
    const ids = stillOpen(item);
    try {
      if (done.has(n) || !ids.length) { replies.push(`${n} · ya estaba resuelta.`); continue; }
      const short = shortAnswer(text);
      const plan = pendingPlan.get(n);
      if (short === 'si' && plan) {
        const r = await confirmPlan(deps, { taskId: plan, by: cfg.pmRef, scopes: cfg.pmScopes, correlationId: `clickup-${current.taskId}-${n}` });
        replies.push(`${n} · confirmado: ${r.similar} parecidas resueltas, ${r.changes} cambios aprobados${r.criterion ? ', criterio guardado' : ''}. [r4-done:${n}]`);
        report.confirmed++; done.add(n);
        continue;
      }
      if (short === 'no' && plan) { pendingPlan.delete(n); replies.push(`${n} · entendido, no aplico ese plan. Explícame qué está mal, o responde «${n} sí» o «${n} no» a la pregunta.`); continue; }
      if (short === 'unsure') { replies.push(`${n} · la dejo para revisar en la consola. [r4-unsure:${ids.join(',')}] [r4-done:${n}]`); report.unsure++; done.add(n); continue; }
      if (short === 'si' || short === 'no') {
        let effect = '';
        for (const id of ids) {
          const p = open.get(id)!;
          const shown = presentProposal(g, p, deps.asked);
          if (!shown.yes) continue;
          const approve = (short === 'si') === (shown.yes === 'approve');
          await deps.artifacts.decide({ kind: PRODUCT_GRAPH_KIND, proposalIds: [id], decision: approve ? 'approved' : 'rejected', decidedBy: cfg.pmRef, note: `Respondido en ClickUp: ${short === 'si' ? 'Sí' : 'No'}`, correlationId: `clickup-${current.taskId}-${n}` });
          effect ||= (short === 'si' ? shown.ifYes : shown.ifNo) ?? '';
        }
        replies.push(`${n} · listo${ids.length > 1 ? ` (${ids.length} preguntas)` : ''}: ${effect} [r4-done:${n}]`);
        report.answered++; done.add(n);
        continue;
      }
      // The PM's own words: an explanation of the item's first open question (its similar ones come with it).
      const id = await deps.explain(ids[0]!, text.slice(0, 2000));
      const read = await readPlan(deps, id);
      const questions = (read.plan?.changes ?? []).map((change) => presentProposal(g, { summary: '', change }, new Map()).question);
      replies.push(planComment(id, n, read.plan, read.violations, questions));
      report.explained++;
    } catch (e) {
      report.errors.push(`item ${n}: ${e instanceof Error ? e.message.slice(0, 160) : 'unexpected'}`);
    }
  }
  if (fresh.length && !replies.length) replies.push('no encontré respuestas numeradas. Responde por número, por ejemplo «1 no, 2 sí», o «1: …» con tus palabras.');
  if (replies.length) await deps.board.commentTask(current.taskId, `${R4_COMMENT_PREFIX}\n${replies.join('\n')}`);

  // The week's task closes when nothing in it is still waiting for the PM.
  open = await openNow();
  if (items.every((i) => done.has(i.n) || !stillOpen(i).length)) {
    await deps.board.closeTask(current.taskId, `${R4_COMMENT_PREFIX} listo por esta semana: todo quedó respondido. Entra en la próxima versión del grafo.`);
    report.closed++;
  }
  return report;
}
