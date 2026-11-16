import { count, stepsOf, type EvaluationFragment, type EvaluationSubject, type Evaluator, type FindingDraft } from '@r4/evaluation';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS } from '../ids.js';

/**
 * How a trajectory uses Catalog evidence (deterministic; reads the recorded observations and decisions, never the
 * catalog). It pins the behaviour sales-web@7 introduced (owner decision 2026-11-13, F1/F2) so a later profile or model
 * cannot silently bring the re-read loop back, and so expired commercial evidence is never presented as current:
 *
 *   catalog_reread_same_run         a product context read of a key already read in the same run (one reply).
 *   discover_repeated_same_need     a Discover call repeating the same need and constraints in the same run.
 *   price_from_expired_evidence     a reply states an amount whose only backing is evidence already expired when the
 *                                   reply was produced (an amount backed by any current observation is fine).
 *   card_without_sellable_evidence  a reply cites a card [[P…]] that no earlier observation of the task showed as a
 *                                   sellable product. A card whose evidence has since expired is NOT a finding: it is
 *                                   a provisional recommendation (the store card shows the live price and stock).
 *
 * Text matching is deliberately narrow: amounts are CLP written with thousands dots ($12.990), cards are the web
 * chat markers. Nothing here infers compatibility or validates a set; that is Catalog's knowledge, not R4's.
 */
const AMOUNT = /\$\s?(\d{1,3}(?:\.\d{3})+)/g;
const CARD = /\[\[(P\d+)(?:-V(\d+))?(?:\s*x(\d+))?\]\]/g;

type Observation = EvaluationSubject['observations'][number];
interface Shown { readonly key: string; readonly sellable: boolean; readonly amounts: readonly number[]; readonly validUntil: number | null; readonly observationId: string }

const at = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const norm = (s: unknown): string => str(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** What one catalog (or shipping) observation shows: product keys, whether sellable, and the amounts it states. */
export function shownBy(o: Observation): Shown[] {
  if (o.outcome !== 'succeeded') return [];
  const p = obj(o.payload); const validUntil = at(o.validUntil); const base = { validUntil, observationId: o.observationId };
  switch (o.source.capabilityId) {
    case CAPABILITY_IDS.productContext: {
      if (p.status !== 'found') return [];
      const derived = obj(p.derived); const price = obj(derived.price);
      const sellable = obj(derived.availability).sellability === 'sellable';
      const amounts = [obj(price.finalGross).amount, obj(price.regularGross).amount].map(amount).filter((n): n is number => n !== null);
      const facts = obj(p.facts);
      const variants = (Array.isArray(facts.variantOptions) ? facts.variantOptions : []).map(obj).filter((v) => typeof v.itemKey === 'string');
      return [
        { key: String(p.productKey), sellable, amounts, ...base },
        ...variants.map((v) => ({ key: String(v.itemKey), sellable: obj(v.availability).sellability === 'sellable' || v.sellable === true, amounts: [obj(obj(v.price).finalGross).amount].map(amount).filter((n): n is number => n !== null), ...base })),
      ];
    }
    case CAPABILITY_IDS.catalogSearch:
      return (Array.isArray(p.results) ? p.results : []).map(obj).map((r) => ({
        key: String(r.productKey), sellable: obj(r.availability).sellability === 'sellable',
        amounts: [obj(obj(r.price).finalGross).amount, obj(obj(r.price).regularGross).amount].map(amount).filter((n): n is number => n !== null), ...base,
      }));
    case LANE_CAPABILITY_IDS.catalogDiscover:
      return [p.exactMatch, ...(Array.isArray(p.verified) ? (p.verified as unknown[]) : []), ...(Array.isArray(p.possible) ? (p.possible as unknown[]) : [])].map(obj).filter((c) => typeof c.productKey === 'string').flatMap((c) => {
        const m = obj(c.commercial);
        const sellable = m.status === 'OBSERVED' && m.sellability === 'sellable';
        const amounts = [amount(m.finalGrossClp)].filter((n): n is number => n !== null);
        // A candidate is evidence until the owner's own validUntil (Discover's observation expires with its earliest candidate).
        const own = { ...base, validUntil: at(typeof m.validUntil === 'string' ? m.validUntil : null) ?? validUntil };
        return [{ key: String(c.productKey), sellable, amounts, ...own }, ...(typeof c.itemKey === 'string' && c.itemKey !== c.productKey ? [{ key: c.itemKey, sellable, amounts, ...own }] : [])];
      });
    default: {
      // Any other owner (shipping, quote preview/receipt, …): every amount it states backs that amount until its own
      // validity ends. Only catalog answers can show a product as sellable.
      const amounts: number[] = [];
      JSON.stringify(o.payload, (k, v: unknown) => { if ((k === 'amount' || k === 'total' || k.endsWith('Clp')) && typeof v === 'number') amounts.push(v); return v; });
      return amounts.length ? [{ key: `owner:${o.source.capabilityId}`, sellable: false, amounts, ...base }] : [];
    }
  }
}

export class SalesCatalogEvidenceEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'sales.catalog_evidence_use', version: 1 },
    kind: 'deterministic' as const,
    description: 'Catalog evidence use: no re-read of a product or repeated Discover within one reply; no expired amount stated as current; cards only for products shown sellable (expired evidence = provisional recommendation).',
    emits: ['catalog_reread_same_run', 'discover_repeated_same_need', 'price_from_expired_evidence', 'card_without_sellable_evidence'],
    authoritativeFor: ['catalog_reread_same_run', 'discover_repeated_same_need', 'price_from_expired_evidence', 'card_without_sellable_evidence'],
  };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    const observations = new Map(subject.observations.map((o) => [o.observationId, o]));
    const shown: (Shown & { readonly position: number })[] = [];
    let productReads = 0, rereads = 0, discovers = 0, discoverRepeats = 0, cards = 0, provisionalCards = 0;
    const steps = stepsOf(subject);
    const perRun = new Map<string, { products: Map<string, string>; needs: Map<string, string> }>();

    steps.forEach((s, index) => {
      const run = s.position.run.toString();
      const seen = perRun.get(run) ?? perRun.set(run, { products: new Map(), needs: new Map() }).get(run)!;
      const decision = obj(s.decision);
      if (decision.type === 'read_capability' && s.outcome === 'observed') {
        const args = obj(decision.arguments);
        if (decision.capabilityId === CAPABILITY_IDS.productContext && typeof args.productKey === 'string') {
          productReads++;
          const first = seen.products.get(args.productKey);
          if (first) {
            rereads++;
            findings.push({ code: 'catalog_reread_same_run', subjectRef: { kind: 'step', id: s.stepId }, description: `${args.productKey} read again in the same run`, evidenceRefs: [{ kind: 'step', id: first }, { kind: 'step', id: s.stepId }], details: { productKey: args.productKey } });
          } else seen.products.set(args.productKey, s.stepId);
        }
        if (decision.capabilityId === LANE_CAPABILITY_IDS.catalogDiscover) {
          discovers++;
          const key = `${norm(args.need)}|${JSON.stringify(args.constraints ?? {})}`;
          const first = seen.needs.get(key);
          if (first) {
            discoverRepeats++;
            findings.push({ code: 'discover_repeated_same_need', subjectRef: { kind: 'step', id: s.stepId }, description: 'Discover called again with the same need and constraints in the same run', evidenceRefs: [{ kind: 'step', id: first }, { kind: 'step', id: s.stepId }], details: { need: str(args.need) } });
          } else seen.needs.set(key, s.stepId);
        }
      }
      if (s.observationId) { const o = observations.get(s.observationId); if (o) for (const x of shownBy(o)) shown.push({ ...x, position: index }); }

      if (decision.type === 'respond') {
        const text = str(decision.content);
        const repliedAt = at(s.createdAt) ?? Number.POSITIVE_INFINITY;
        const before = shown.filter((x) => x.position < index);
        for (const m of text.matchAll(CARD)) {
          cards++;
          const key = m[2] ? `${m[1]}-V${m[2]}` : m[1]!;
          const evidence = before.filter((x) => x.key === key && x.sellable);
          if (!evidence.length) {
            findings.push({ code: 'card_without_sellable_evidence', subjectRef: { kind: 'step', id: s.stepId }, description: `card ${key} cited without an earlier observation showing it sellable`, evidenceRefs: [{ kind: 'step', id: s.stepId }], details: { key } });
          } else if (!evidence.some((x) => x.validUntil === null || x.validUntil > repliedAt)) provisionalCards++;
        }
        for (const m of text.matchAll(AMOUNT)) {
          const value = Number(m[1]!.replaceAll('.', ''));
          const backing = before.filter((x) => x.amounts.includes(value));
          if (backing.length && !backing.some((x) => x.validUntil === null || x.validUntil > repliedAt)) {
            findings.push({ code: 'price_from_expired_evidence', subjectRef: { kind: 'step', id: s.stepId }, description: `states ${m[0]} whose only evidence had expired when the reply was produced`, evidenceRefs: [{ kind: 'step', id: s.stepId }, ...backing.map((x) => ({ kind: 'observation' as const, id: x.observationId }))], details: { amount: value } });
          }
        }
      }
    });

    return {
      findings,
      metrics: {
        productReads: count(productReads),
        productRereadsSameRun: count(rereads),
        discoverCalls: count(discovers),
        discoverRepeatsSameRun: count(discoverRepeats),
        cardsCited: count(cards),
        provisionalCards: count(provisionalCards),
      },
    };
  }
}
