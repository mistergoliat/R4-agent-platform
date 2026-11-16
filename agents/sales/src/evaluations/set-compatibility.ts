import { count, stepsOf, type EvaluationFragment, type EvaluationSubject, type Evaluator, type FindingDraft } from '@r4/evaluation';

/**
 * Whether the sets a reply proposes are technically compatible — as the CATALOG OWNER says, never as R4 computes
 * (deterministic; owner decision 2026-11-16, «R4 × Catalog PRG»). R4 holds no compatibility rule: it reads the
 * verdicts of the owner's compatibility assessment (proposed contract `compat-v1`, capability
 * `catalog.assess_compatibility`, not published yet) and classifies each proposed set:
 *
 *   INVALID                       a pair among the cited cards, or between a card and what the visitor already has
 *                                 (cart / Mi gym in the browser note), was assessed INCOMPATIBLE before the reply.
 *   REQUIRES_TECHNICAL_CONFIRMATION  no INCOMPATIBLE pair, but at least one pair is UNKNOWN (missing or ambiguous data,
 *                                 out-of-vocabulary interface, rule not approved).
 *   VALID                         every assessed pair is COMPATIBLE, by an APPROVED rule.
 *   NOT_ASSESSED                  no assessment covers any pair of the set.
 *
 * A COMPATIBLE verdict whose rule is not APPROVED counts as UNKNOWN: a pending adjudication is never treated as
 * verified. Set completeness (a rack without a bar) needs a REQUIRES relation the owner does not publish yet, so it
 * is not evaluated here; nor is the budget (the web channel keeps no structured budget).
 */
export const COMPATIBILITY_CAPABILITY_ID = 'catalog.assess_compatibility';
export type SetClass = 'VALID' | 'REQUIRES_TECHNICAL_CONFIRMATION' | 'INVALID' | 'NOT_ASSESSED';

const CARD = /\[\[(P\d+)(?:-V\d+)?(?:\s*x\d+)?\]\]/g;
const OWNED_NOTE = /Contexto informado por el navegador[^\]]*\]/;
const OWNED_KEY = /\b(P\d+)(?:-V\d+)?\s+x\d+/g;
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const productOf = (key: unknown): string => (typeof key === 'string' ? key.replace(/-V\d+$/, '') : '');
const pairKey = (a: string, b: string): string => [a, b].sort().join('|');

interface Verdict { readonly verdict: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNKNOWN'; readonly reasonCode: string; readonly observationId: string; readonly relation: string }

/** The owner's verdicts in one assessment observation, keyed by unordered product pair (latest wins). */
export function verdictsOf(o: EvaluationSubject['observations'][number]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  if (o.outcome !== 'succeeded' || o.source.capabilityId !== COMPATIBILITY_CAPABILITY_ID) return out;
  for (const a of (Array.isArray(obj(o.payload).assessments) ? (obj(o.payload).assessments as unknown[]) : []).map(obj)) {
    const subject = productOf(a.subject), object = productOf(a.object);
    if (!subject || !object) continue;
    const approved = obj(a.rule).approval === 'APPROVED';
    const raw = a.verdict === 'COMPATIBLE' || a.verdict === 'INCOMPATIBLE' ? a.verdict : 'UNKNOWN';
    // Only an APPROVED rule decides; anything else is not verified.
    const verdict = raw !== 'UNKNOWN' && !approved ? 'UNKNOWN' : raw;
    const reasonCode = verdict !== raw ? 'RULE_NOT_APPROVED' : typeof a.reasonCode === 'string' ? a.reasonCode : 'UNSPECIFIED';
    out.set(pairKey(subject, object), { verdict, reasonCode, observationId: o.observationId, relation: typeof a.relation === 'string' ? a.relation : 'UNSPECIFIED' });
  }
  return out;
}

export class SalesSetCompatibilityEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'sales.set_compatibility', version: 1 },
    kind: 'deterministic' as const,
    description: 'Proposed sets against the Catalog owner\'s compatibility verdicts (no rule in R4): INVALID / REQUIRES_TECHNICAL_CONFIRMATION / VALID / NOT_ASSESSED.',
    emits: ['set_with_demonstrated_incompatibility'],
    authoritativeFor: ['set_with_demonstrated_incompatibility'],
  };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    const observations = new Map(subject.observations.map((o) => [o.observationId, o]));
    const verdicts = new Map<string, Verdict>();
    const sets: { step: string; cards: string[]; owned: string[]; class: SetClass; pairs: { pair: string; verdict: string; reasonCode: string }[] }[] = [];
    const turnText = new Map(subject.turns.map((t) => [t.index, t.text]));

    for (const s of stepsOf(subject)) {
      if (s.observationId) { const o = observations.get(s.observationId); if (o) for (const [k, v] of verdictsOf(o)) verdicts.set(k, v); }
      const decision = obj(s.decision);
      if (decision.type !== 'respond' || typeof decision.content !== 'string') continue;
      const cards = [...new Set([...decision.content.matchAll(CARD)].map((m) => m[1]!))];
      if (cards.length < 2) continue;
      const note = OWNED_NOTE.exec(s.turnIndex !== null ? (turnText.get(s.turnIndex) ?? '') : '')?.[0] ?? '';
      const owned = [...new Set([...note.matchAll(OWNED_KEY)].map((m) => m[1]!))].filter((k) => !cards.includes(k));
      const candidates = [...cards.flatMap((a, i) => cards.slice(i + 1).map((b) => [a, b] as const)), ...cards.flatMap((a) => owned.map((b) => [a, b] as const))];
      const pairs = candidates.map(([a, b]) => ({ a, b, v: verdicts.get(pairKey(a, b)) })).filter((p) => p.v);
      const cls: SetClass = !pairs.length ? 'NOT_ASSESSED'
        : pairs.some((p) => p.v!.verdict === 'INCOMPATIBLE') ? 'INVALID'
        : pairs.some((p) => p.v!.verdict === 'UNKNOWN') ? 'REQUIRES_TECHNICAL_CONFIRMATION' : 'VALID';
      sets.push({ step: s.stepId, cards, owned, class: cls, pairs: pairs.map((p) => ({ pair: `${p.a}+${p.b}`, verdict: p.v!.verdict, reasonCode: p.v!.reasonCode })) });
      for (const p of pairs.filter((x) => x.v!.verdict === 'INCOMPATIBLE')) {
        findings.push({ code: 'set_with_demonstrated_incompatibility', subjectRef: { kind: 'step', id: s.stepId }, description: `proposes ${p.a} with ${p.b}, assessed INCOMPATIBLE by the catalog owner (${p.v!.relation}: ${p.v!.reasonCode})`, evidenceRefs: [{ kind: 'step', id: s.stepId }, { kind: 'observation', id: p.v!.observationId }], details: { subject: p.a, object: p.b, relation: p.v!.relation, reasonCode: p.v!.reasonCode, ownedByVisitor: owned.includes(p.b) } });
      }
    }
    const by = (c: SetClass) => count(sets.filter((x) => x.class === c).length);
    return {
      findings,
      metrics: { setsProposed: count(sets.length), setsValid: by('VALID'), setsRequiringConfirmation: by('REQUIRES_TECHNICAL_CONFIRMATION'), setsInvalid: by('INVALID'), setsNotAssessed: by('NOT_ASSESSED') },
      data: { sets: sets },
    };
  }
}
