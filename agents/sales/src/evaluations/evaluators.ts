import type { JsonValue } from '@r4/contracts';
import {
  canonicalJson,
  comparePositions,
  count,
  questionsOf,
  rate,
  type DomainOutcome,
  type EffectClaim,
  type EffectClaimDetector,
  type EvaluationFragment,
  type EvaluationSubject,
  type Evaluator,
  type FindingDraft,
  type KeyedStateHistory,
  type KnownStateAt,
  type Position,
  type QuestionClassifier,
  type StateHistoryAccessor,
  type SubjectResponse,
} from '@r4/evaluation';
import { CAPABILITY_IDS } from '../ids.js';
import { salesProjectionOf, transitionPositions, SALES_WORKSPACE_PROJECTION } from './projection.js';

/** Quote numbers as the Quote owner issues them, and explicit claims of an issued quote. */
const QUOTE_NUMBER = /\bCOT-\d{6}\b/g;
const QUOTE_ISSUED = /(cotizaci[oó]n\s+(n[°ºo.]*\s*)?(creada|generada|emitida|lista)|emit[ií]\s+la\s+cotizaci[oó]n|quote\s+(was\s+)?(created|issued))/i;

/** Which responses claim a quote exists. Checking them against receipts is the generic evaluator's job. */
export const quoteClaimDetector: EffectClaimDetector = {
  detect(response: SubjectResponse): EffectClaim[] {
    const numbers = [...new Set(response.text.match(QUOTE_NUMBER) ?? [])];
    if (numbers.length > 0) return numbers.map((n) => ({ responseId: response.responseId, capabilityId: CAPABILITY_IDS.quoteCreate, externalRef: n, text: n }));
    return QUOTE_ISSUED.test(response.text) ? [{ responseId: response.responseId, capabilityId: CAPABILITY_IDS.quoteCreate, externalRef: null, text: 'quote issued' }] : [];
  },
};

/**
 * DS-1 (owner, 2026-11-05): the agent must not claim it recorded, reserved,
 * modified or scheduled an operation unless an authorized capability did it.
 * No Sales capability reserves stock or schedules anything, so those claims
 * name a capability that does not exist and can never be receipt-backed.
 */
export const NO_CAPABILITY = { reserve: 'none:reserve', schedule: 'none:schedule' } as const;

/**
 * Completed-effect claims only: a first-person preterite («registré»), a
 * result state («quedó / queda / está / dejé … anotado»), or a bare
 * confirmation («Anotado.»). Offers and conditionals («te lo dejo anotado si
 * quieres», «¿quieres que quede reservado?») are not claims (cf. the quote
 * detector false positives in shadow/gaps.ts), and neither are negations or
 * questions.
 */
/** `\b` is ASCII-only in JS («registré» has no boundary after «é»); `~` marks a Unicode word boundary instead. */
const words = (source: string): RegExp => new RegExp(source.replaceAll('~', '(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))'), 'iu');
/** The result state of an operation: «quedó / queda / quedaron / dejé / está / están (ya) <participle>». */
const DONE = '~(qued[oó]|queda|quedaron|quedan|dej[eé]|est[aá]n?|tienes)\\s+(ya\\s+)?';
/** (DS-1 round 2) A result stated as a place in the selection, with no participle: «quedó / ya está / dejé (…) en tu selección». */
const IN_SELECTION = '~(ya\\s+)?(qued[oó]|queda|quedan|quedaron|dej[eé]|est[aá]n?)\\s+(\\S+\\s+){0,10}en\\s+tu\\s+selecci[oó]n~';
/** (DS-1 round 2) A modified quantity stated as a result: «tu selección quedó con…», «quedan 2 unidades». */
// «quedan 3 unidades disponibles / en stock» is a stock statement, not a change: excluded for the rest of the sentence.
const QUANTITY_RESULT = '~(tu|la)\\s+selecci[oó]n\\s+(qued[oó]|queda)\\s+con~|~(qued[oó]|queda|quedan|quedaron)\\s+\\d+\\s+unidad(es)?\\s+de~(?![^.]*(disponible|stock|bodega|cat[aá]logo))';
// Preterites need the accent: without it they are subjunctives («que lo anote»), which are offers, not claims.
const OPERATION_CLAIMS: readonly { readonly kind: string; readonly capabilityId: string; readonly pattern: RegExp }[] = [
  { kind: 'record', capabilityId: CAPABILITY_IDS.workspaceUpdate, pattern: words(`~(registré|anoté|guardé|agregué|añadí)~|${DONE}(registrad|anotad|guardad|agregad|añadid)[oa]s?~|(^|[.!¡]\\s*)(registrad|anotad|guardad)[oa]s?~|${IN_SELECTION}`) },
  { kind: 'modify', capabilityId: CAPABILITY_IDS.workspaceUpdate, pattern: words(`~(modifiqué|actualicé|corregí)~|${DONE}(modificad|actualizad|corregid)[oa]s?~|${QUANTITY_RESULT}`) },
  { kind: 'reserve', capabilityId: NO_CAPABILITY.reserve, pattern: words(`~reservé~|${DONE}reservad[oa]s?~|~tu\\s+reserva\\s+(est[aá]|qued[oó])\\s+(lista|confirmada|hecha)~`) },
  { kind: 'schedule', capabilityId: NO_CAPABILITY.schedule, pattern: words(`~(programé|agendé)~|${DONE}(programad|agendad)[oa]s?~`) },
];
const NEGATED = words('~(no|nunca|ni)\\s+(\\S+\\s+){0,2}$');

/** Which responses claim a completed operation (DS-1). Checking them against receipts is the generic evaluator's job. */
export const operationClaimDetector: EffectClaimDetector = {
  detect(response: SubjectResponse): EffectClaim[] {
    const claims = new Map<string, EffectClaim>();
    for (const sentence of response.text.split(/\n|(?<=[.!?])\s+/)) {
      if (/\?\s*$/.test(sentence) || /^\s*¿/.test(sentence)) continue;
      for (const { kind, capabilityId, pattern } of OPERATION_CLAIMS) {
        const match = pattern.exec(sentence);
        if (!match || claims.has(kind) || NEGATED.test(sentence.slice(0, match.index))) continue;
        claims.set(kind, { responseId: response.responseId, capabilityId, externalRef: null, text: match[0].trim() });
      }
    }
    return [...claims.values()];
  },
};

/** CLP amounts as written in Spanish (`$932.350`, `$1.100.000`). */
const AMOUNT = /\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?!\d|[.,]\d)/g;
const amountOf = (s: string) => Number(s.replace(/\./g, ''));

/**
 * Sales quote evaluator (deterministic; reads ActionRuntime's evidence, never
 * re-implements it): the figures a response gives for a quote come from its
 * receipt, every quote command cites catalog evidence, and the business
 * outcome `quote_created` exists exactly when a quote receipt succeeded.
 */
export class SalesQuoteEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'sales.quote', version: 1 },
    kind: 'deterministic' as const,
    description: 'Quote totals come from the receipt; quote commands cite catalog evidence; business outcome from receipts.',
    emits: ['quote_figure_not_from_receipt', 'quote_without_catalog_evidence'],
    authoritativeFor: ['quote_figure_not_from_receipt', 'quote_without_catalog_evidence'],
  };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    const quoteReceipts = subject.actions.receipts.filter((r) => r.capabilityId === CAPABILITY_IDS.quoteCreate);
    for (const response of subject.responses) {
      for (const number of new Set(response.text.match(QUOTE_NUMBER) ?? [])) {
        const receipt = quoteReceipts.find((r) => r.status === 'succeeded' && r.externalOperationRef === number);
        const result = receipt?.result as { total?: { amount?: number }; subtotal?: { amount?: number }; shipping?: { amount?: { amount?: number } }; lines?: { unitPrice?: { amount?: number }; lineTotal?: { amount?: number } }[] } | null | undefined;
        if (!receipt || !result) continue; // unbacked claims are the receipt-backed claim evaluator's finding
        const allowed = new Set([result.total?.amount, result.subtotal?.amount, result.shipping?.amount?.amount, ...(result.lines ?? []).flatMap((l) => [l.unitPrice?.amount, l.lineTotal?.amount])].filter((n): n is number => typeof n === 'number'));
        for (const sentence of response.text.split(/\n|(?<=[.!?])\s/)) {
          if (!/total/i.test(sentence)) continue;
          const stated = [...sentence.matchAll(AMOUNT)].map((m) => amountOf(m[1]!));
          const wrong = stated.filter((a) => !allowed.has(a));
          if (stated.length > 0 && wrong.length === stated.length) {
            findings.push({ code: 'quote_figure_not_from_receipt', subjectRef: { kind: 'response', id: response.responseId }, description: `total stated for ${number} does not match its receipt`, evidenceRefs: [{ kind: 'response', id: response.responseId }, { kind: 'receipt', id: receipt.receiptId }], details: { stated: wrong, receiptTotal: result.total?.amount ?? null } });
          }
        }
      }
    }
    const catalogObservations = new Set(subject.observations.filter((o) => o.source.capabilityId.startsWith('catalog.')).map((o) => o.observationId));
    for (const e of subject.actions.executions.filter((x) => x.capabilityId === CAPABILITY_IDS.quoteCreate)) {
      const proposal = subject.actions.proposals.find((p) => p.proposalId === e.proposalId);
      if (!proposal || !proposal.evidenceRefs.some((id) => catalogObservations.has(id))) {
        findings.push({ code: 'quote_without_catalog_evidence', subjectRef: { kind: 'execution', id: e.executionId }, description: 'quote.create was commanded from a proposal citing no catalog observation', evidenceRefs: [{ kind: 'execution', id: e.executionId }, ...(proposal ? [{ kind: 'proposal' as const, id: proposal.proposalId }] : [])] });
      }
    }
    const created = quoteReceipts.filter((r) => r.status === 'succeeded').length;
    const business: DomainOutcome[] = quoteReceipts.map((r) => ({ owner: 'sales', code: r.status === 'succeeded' ? 'quote_created' : r.status === 'rejected' ? 'quote_rejected_by_owner' : 'quote_failed', evidenceRefs: [{ kind: 'receipt', id: r.receiptId }] }));
    return {
      findings,
      metrics: {
        quotesCreated: count(created),
        quoteProposals: count(subject.actions.proposals.filter((p) => p.capabilityId === CAPABILITY_IDS.quoteCreate).length),
        callsPerQuote: rate(subject.runs.reduce((s, r) => s + r.steps.length, 0), created, 'per_task', 'model calls per created quote'),
        tokensPerQuote: rate(subject.runs.reduce((s, r) => s + r.usage.inputTokens + r.usage.outputTokens, 0), created, 'per_task', 'input+output tokens per created quote'),
      },
      outcome: { business },
    };
  }
}

/** Workspace facts, delivery and selection as keyed histories (from the pack's own transitions). */
export const salesWorkspaceHistories: StateHistoryAccessor = {
  stateId: SALES_WORKSPACE_PROJECTION,
  histories(subject): KeyedStateHistory[] {
    const data = salesProjectionOf(subject);
    const positions = transitionPositions(subject);
    const out = new Map<string, { events: KeyedStateHistory['events'][number][]; current: JsonValue | undefined }>();
    const entry = (key: string) => out.get(key) ?? (out.set(key, { events: [], current: undefined }), out.get(key)!);
    for (const t of data.transitions.filter((x) => x.outcome === 'applied')) {
      const position = positions.get(t.executionKey) ?? null;
      for (const c of t.changes) {
        // R4-J3E kinds (workspace.update@2 only): the delivery choice and the quote request.
        const key = c.kind === 'fact' ? `fact:${c.key}` : c.kind === 'item' ? `item:${c.productId}` : c.kind === 'shipping' ? 'shipping' : c.kind === 'quote_request' ? 'quote_request' : 'delivery';
        const to =
          c.kind === 'fact'
            ? (c.to?.value ?? null)
            : c.kind === 'item'
              ? (c.to?.quantity ?? null)
              : c.kind === 'shipping'
                ? c.to === null
                  ? null
                  : c.to.kind === 'selected'
                    ? `${c.to.carrierName} ${c.to.serviceType}`
                    : 'excluded'
                : c.kind === 'quote_request'
                  ? (c.to?.previewId ?? null)
                  : (c.to?.commune ?? null);
        entry(key).events.push({ position, version: t.toVersion, kind: to === null ? 'removed' : 'set', value: (to ?? null) });
      }
    }
    for (const [k, f] of Object.entries(data.state.facts)) entry(`fact:${k}`).current = f.value;
    for (const i of data.state.items) entry(`item:${i.productId}`).current = i.quantity;
    if (data.state.delivery) entry('delivery').current = data.state.delivery.commune;
    return [...out.entries()].map(([key, v]) => ({ key, events: v.events, current: v.current }));
  },
};

/** The budget fact, whatever key the agent chose (the pack prescribes none). */
export const BUDGET_KEY = /^(budget|presupuesto)(_|$)/;
const BUDGET_WORDS = /\b(presupuesto|budget|tope|techo|l[ií]mite)\b/i;

/**
 * Budget correction (deterministic part): after the budget fact is corrected,
 * later responses do not present the old amount as the budget. Current vs.
 * historical value is the generic state-continuity check; whether decisions
 * "used" the old value in other words is left to the objective rubric.
 */
export class SalesCorrectionEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'sales.budget_correction', version: 1 },
    kind: 'deterministic' as const,
    description: 'After a budget correction, responses do not state the superseded amount as the budget.',
    emits: ['superseded_value_used'],
    authoritativeFor: [],
  };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    let corrections = 0;
    let historyRetained = 0;
    for (const h of salesWorkspaceHistories.histories(subject)) {
      const key = h.key.replace(/^fact:/, '');
      if (!h.key.startsWith('fact:') || !BUDGET_KEY.test(key)) continue;
      const sets = h.events.filter((e) => e.kind === 'set');
      for (let i = 1; i < sets.length; i += 1) {
        const before = sets[i - 1]!;
        const after = sets[i]!;
        if (canonicalJson(before.value) === canonicalJson(after.value) || after.position === null) continue;
        corrections += 1;
        historyRetained += 1; // transitions are append-only: the earlier value stays as history by construction
        const old = amountOfFact(before.value);
        const current = amountOfFact(after.value);
        if (old === null) continue;
        for (const r of subject.responses.filter((x) => comparePositions(x.position, after.position!) > 0)) {
          for (const sentence of r.text.split(/\n|(?<=[.!?])\s/)) {
            const amounts = [...sentence.matchAll(AMOUNT)].map((m) => amountOf(m[1]!));
            if (BUDGET_WORDS.test(sentence) && amounts.includes(old) && (current === null || !amounts.includes(current))) {
              findings.push({ code: 'superseded_value_used', subjectRef: { kind: 'response', id: r.responseId }, description: `states the superseded budget ${old} after it was corrected to ${current ?? '?'}`, evidenceRefs: [{ kind: 'response', id: r.responseId }, { kind: 'domain', id: `${SALES_WORKSPACE_PROJECTION}:fact:${key}` }], details: { superseded: old, current } });
            }
          }
        }
      }
    }
    return { findings, metrics: { budgetCorrections: count(corrections), correctionsWithHistory: count(historyRetained) } };
  }
}

function amountOfFact(value: JsonValue): number | null {
  if (typeof value === 'number') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.amount === 'number') return value.amount;
  return null;
}

/**
 * A deliberately small classifier: only questions whose information key is
 * unambiguous in the pack's own vocabulary. Anything else is unclassified
 * and left to the question-quality rubric.
 */
export const salesQuestionClassifier: QuestionClassifier = {
  classify(question: string): string[] {
    const q = question.toLowerCase();
    const keys: string[] = [];
    if (/presupuesto|cu[aá]nto (quieres|puedes|pretendes) (gastar|invertir)|budget/.test(q)) keys.push('budget');
    if (/\bcomuna\b|a qu[eé] comuna|d[oó]nde (te lo )?(despach|envi|entreg)/.test(q)) keys.push('delivery');
    if (/cu[aá]nto espacio|qu[eé] espacio|\bmetros\b|dimensiones/.test(q)) keys.push('space');
    return keys;
  },
};

/** Which information keys the workspace held before a position of the step log. */
export const salesKnownState: KnownStateAt = {
  knownAt(subject, position: Position) {
    const data = salesProjectionOf(subject);
    const positions = transitionPositions(subject);
    const known = new Map<string, { value: JsonValue; evidenceId: string }>();
    const facts = new Map<string, JsonValue | null>();
    let delivery: string | null = null;
    for (const t of data.transitions.filter((x) => x.outcome === 'applied')) {
      const at = positions.get(t.executionKey);
      if (!at || comparePositions(at, position) >= 0) continue;
      for (const c of t.changes) {
        if (c.kind === 'fact') facts.set(c.key, (c.to?.value ?? null));
        if (c.kind === 'delivery') delivery = c.to?.commune ?? null;
      }
    }
    for (const [key, value] of facts) {
      if (value === null) continue;
      if (BUDGET_KEY.test(key)) known.set('budget', { value, evidenceId: `${SALES_WORKSPACE_PROJECTION}:fact:${key}` });
      if (/^(available_space|space|espacio)/.test(key)) known.set('space', { value, evidenceId: `${SALES_WORKSPACE_PROJECTION}:fact:${key}` });
    }
    if (delivery) known.set('delivery', { value: delivery, evidenceId: `${SALES_WORKSPACE_PROJECTION}:delivery` });
    return known;
  },
};

export { questionsOf };
