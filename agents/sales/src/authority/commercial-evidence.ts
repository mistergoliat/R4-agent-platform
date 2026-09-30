import { systemClock, type Clock, type JsonObject, type Observation, type ResponseAuthorityInput, type ResponseAuthorityValidator, type ResponseAuthorityVerdict } from '@r4/contracts';
import { CAPABILITY_IDS } from '../ids.js';

/**
 * ADR-031 — Sales commercial evidence enforcement (pre-respond, deterministic).
 *
 * Catalog owns product truth (identity, price, promotion, sellability,
 * availability, validity). Before a draft reply becomes durable/outbound this
 * validator reconstructs the commercial claims it can anchor deterministically
 * and binds each to the latest Catalog observation of the task:
 *
 *   amount-anchored   every "$N" is a claim: a Catalog unit/regular price of an
 *                     observed product (matched by amount, disambiguated by
 *                     the product's name words around it), a derived estimated
 *                     total (sum of stated Catalog prices, labelled referencial /
 *                     aproximado / ~), or the customer's own budget; anything else
 *                     is a commercial number without authority
 *   availability      the clause around a price of a product Catalog reports as
 *                     not sellable must say so; a clause must not call a sellable
 *                     product out of stock; a product Catalog reports as not
 *                     sellable must not be named as available
 *   variant           a "from" price (variants differ, one must be chosen) is only
 *                     stated as "desde / a partir de", never as a variant's price
 *   freshness         evidence must stay valid until send time (+ margin); expired
 *                     evidence is revalidated with a targeted product-context READ
 *
 * It never recomputes Catalog facts, applies no business rule (no tax,
 * discount, shipping or rounding) and does not parse language beyond these
 * anchors: unanchored wording is left to the agent (ADR-031 limits).
 */

export type CommercialClaimKind = 'product_identity' | 'unit_price' | 'regular_price' | 'promotion' | 'sellability' | 'availability' | 'variant' | 'estimated_total' | 'customer_amount';

export interface CommercialClaim {
  readonly kind: CommercialClaimKind;
  readonly subjectRef: string | null;
  readonly value: string | number;
  readonly authority: 'catalog' | 'derived' | 'customer';
  readonly evidenceRef: string | null;
  readonly derivation?: { readonly operation: 'sum'; readonly operands: readonly number[] };
}

interface ProductEvidence {
  readonly productKey: string;
  readonly name: string;
  readonly nameTokens: readonly string[];
  readonly priceKind: 'exact' | 'from' | null;
  readonly finalGross: number | null;
  readonly regularGross: number | null;
  readonly sellability: string;
  readonly reason: string;
  readonly observationId: string;
  readonly validUntilMs: number;
}

/** Evidence must remain valid this long after the check (dispatch happens within it). */
export const SEND_MARGIN_MS = 3_000;

const NEGATIVE = /\b(sin stock|sin existencias|agotad[oa]s?|fuera de stock|no (?:esta|estan|se encuentra|se encuentran)? ?disponibles?|no disponibles?|no (?:es|son) pedibles?|no se puede[n]? (?:comprar|pedir)|no (?:hay|tenemos) stock|no (?:lo|la|los|las) tenemos|inactiv[oa]s?|no se vende)\b/u;
const POSITIVE = /\b(disponibles?|con stock|en stock|(?:lo|la|los|las) tenemos|tenemos stock|hay stock)\b/u;
const FROM = /\b(desde|a partir de)\b/u;
const REFERENTIAL = /(referencial|aproximad[oa]|estimad[oa]|aprox\b|en total aprox|[~≈])/u;
const BUDGET_BEFORE = /(presupuesto|budget|tus?|dispones de|te alcanza)\s*(de\s*)?[~≈]?\s*$/u;
const AMOUNT = /([~≈]\s*)?\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?![\d.,]*\d)/gu;
const STOPWORDS = new Set(['par', 'set', 'para', 'con', 'the', 'serie', 'series', 'unidad', 'color']);

export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/(\d)\s*(kg|cm|mm|lb|g)\b/gu, '$1$2');
}

function nameTokens(name: string): string[] {
  const base = normalizeText(name.split('|')[0] ?? name).replace(/[®™()"'/,.-]/gu, ' ');
  return [...new Set(base.split(/\s+/u).filter((t) => (t.length >= 3 || /\d/u.test(t)) && !STOPWORDS.has(t)))];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The latest Catalog evidence per product (search results and product contexts), from succeeded
 * observations only. Observations arrive in recording order (the task log orders them by observed_at):
 * a later one supersedes an earlier one for the same product.
 */
export function indexCatalogEvidence(observations: readonly Observation[]): Map<string, ProductEvidence> {
  const index = new Map<string, ProductEvidence>();
  const put = (o: Observation, entry: Record<string, unknown>, name: string, price: Record<string, unknown> | null, availability: Record<string, unknown> | null) => {
    const productKey = typeof entry.productKey === 'string' ? entry.productKey : null;
    if (!productKey || !availability) return;
    const money = (m: unknown) => (typeof obj(m)?.amount === 'number' ? (obj(m)!.amount as number) : null);
    index.set(productKey, {
      productKey,
      name,
      nameTokens: nameTokens(name),
      priceKind: price ? (price.kind === 'from' ? 'from' : 'exact') : null,
      finalGross: price ? money(price.finalGross) : null,
      regularGross: price ? money(price.regularGross) : null,
      sellability: str(availability.sellability),
      reason: str(availability.reason),
      observationId: o.observationId,
      validUntilMs: o.validUntil ? Date.parse(o.validUntil) : Number.POSITIVE_INFINITY,
    });
  };
  for (const o of observations) {
    if (o.outcome !== 'succeeded' || o.source.kind !== 'capability') continue;
    const payload = obj(o.payload);
    if (!payload) continue;
    if (o.source.capabilityId === CAPABILITY_IDS.catalogSearch && Array.isArray(payload.results)) {
      for (const raw of payload.results) {
        const r = obj(raw);
        if (r) put(o, r, str(r.name), obj(r.price), obj(r.availability));
      }
    } else if (o.source.capabilityId === CAPABILITY_IDS.productContext && payload.status === 'found') {
      const derived = obj(payload.derived);
      put(o, payload, str(obj(payload.facts)?.name), obj(derived?.price), obj(derived?.availability));
    }
  }
  return index;
}

interface Clause {
  readonly text: string;
  readonly start: number;
}

function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    const boundary = c === '!' || c === '?' || c === ';' || c === '\n' || c === '•' || (c === '.' && (i + 1 >= text.length || /\s/u.test(text[i + 1]!)));
    if (boundary) {
      out.push({ text: text.slice(start, i + 1), start });
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ text: text.slice(start), start });
  return out;
}

interface Amount {
  readonly value: number;
  readonly approximate: boolean;
  readonly index: number;
  readonly end: number;
}

function amountsIn(text: string): Amount[] {
  const out: Amount[] = [];
  for (const m of text.matchAll(AMOUNT)) out.push({ value: Number(m[2]!.replace(/\./gu, '')), approximate: Boolean(m[1]), index: m.index, end: m.index + m[0].length });
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hasWord(text: string, token: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(token)}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function overlap(tokens: readonly string[], window: string): number {
  return tokens.filter((t) => hasWord(window, t)).length;
}

/** A product is named in a clause when every measure/number of its name and ~80 % of its words appear. */
function names(p: ProductEvidence, text: string): boolean {
  const numeric = p.nameTokens.filter((t) => /\d/u.test(t));
  if (!numeric.every((t) => hasWord(text, t))) return false;
  return overlap(p.nameTokens, text) >= Math.max(2, Math.ceil(p.nameTokens.length * 0.8));
}

function subsetSums(values: readonly number[], target: number): number[] | null {
  const n = Math.min(values.length, 12);
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const picked = values.filter((_, i) => mask & (1 << i));
    if (picked.length >= 2 && picked.reduce((a, b) => a + b, 0) === target) return picked;
  }
  return null;
}

const money = (n: number) => `$${n.toLocaleString('es-CL')}`;

export class SalesCommercialEvidenceValidator implements ResponseAuthorityValidator {
  readonly #clock: Clock;
  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  validate(input: ResponseAuthorityInput): ResponseAuthorityVerdict {
    const now = this.#clock.now().getTime();
    const evidence = indexCatalogEvidence(input.observations);
    const claims: CommercialClaim[] = [];
    const problems: string[] = [];
    const stale = new Set<string>();
    const fresh = (p: ProductEvidence) => {
      if (p.validUntilMs - now < SEND_MARGIN_MS) stale.add(p.productKey);
    };
    const products = [...evidence.values()];
    const catalogAmounts: number[] = [];
    const pendingTotals: { amount: Amount; window: string }[] = [];

    for (const clause of clauses(input.content)) {
      const norm = normalizeText(clause.text);
      const amounts = amountsIn(clause.text);
      amounts.forEach((amount, i) => {
        const window = normalizeText(clause.text.slice(i === 0 ? 0 : amounts[i - 1]!.end, i + 1 < amounts.length ? amounts[i + 1]!.index : clause.text.length));
        const before = normalizeText(clause.text.slice(Math.max(0, amount.index - 40), amount.index));
        const candidates = products.filter((p) => p.finalGross === amount.value || p.regularGross === amount.value);
        if (candidates.length === 0) {
          if (BUDGET_BEFORE.test(before)) {
            claims.push({ kind: 'customer_amount', subjectRef: null, value: amount.value, authority: 'customer', evidenceRef: null });
            return;
          }
          pendingTotals.push({ amount, window });
          return;
        }
        const best = Math.max(...candidates.map((p) => overlap(p.nameTokens, window)));
        const matched = candidates.filter((p) => overlap(p.nameTokens, window) === best);
        // Lenient on ambiguity: the amount is supported when one matching product is consistent with the clause.
        const failures: string[] = [];
        let supported: ProductEvidence | null = null;
        for (const p of matched) {
          const issues: string[] = [];
          const notSellable = p.sellability !== 'sellable' && p.sellability !== 'backorder';
          if (notSellable && !NEGATIVE.test(window)) issues.push(`${money(amount.value)} refers to ${p.productKey} "${p.name}", which Catalog reports ${p.sellability}/${p.reason}: say it is currently not available (or omit it); never present it as available.`);
          if (!notSellable && NEGATIVE.test(window)) issues.push(`${money(amount.value)} refers to ${p.productKey} "${p.name}", which Catalog reports ${p.sellability}/${p.reason}: do not call it out of stock or unavailable.`);
          if (p.priceKind === 'from' && amount.value === p.finalGross && !FROM.test(window)) issues.push(`${money(amount.value)} is the "from" price of ${p.productKey} "${p.name}" (variants must be chosen): state it as "desde ${money(amount.value)}" and ask which variant; do not assume one.`);
          if (issues.length === 0) {
            supported = p;
            break;
          }
          failures.push(...issues);
        }
        const p = supported ?? matched[0]!;
        fresh(p);
        const kind: CommercialClaimKind = p.finalGross === amount.value ? 'unit_price' : 'regular_price';
        claims.push({ kind, subjectRef: p.productKey, value: amount.value, authority: 'catalog', evidenceRef: p.observationId });
        claims.push({ kind: 'availability', subjectRef: p.productKey, value: `${p.sellability}/${p.reason}`, authority: 'catalog', evidenceRef: p.observationId });
        if (supported) catalogAmounts.push(amount.value);
        else problems.push(...new Set(failures));
      });
      // Name-anchored availability: a product Catalog reports as not sellable must not be named as available.
      if (POSITIVE.test(norm) && !NEGATIVE.test(norm)) {
        for (const p of products) {
          if (p.sellability === 'sellable' || p.sellability === 'backorder' || p.nameTokens.length === 0) continue;
          if (names(p, norm)) {
            fresh(p);
            claims.push({ kind: 'availability', subjectRef: p.productKey, value: `${p.sellability}/${p.reason}`, authority: 'catalog', evidenceRef: p.observationId });
            problems.push(`${p.productKey} "${p.name}" is ${p.sellability}/${p.reason} in Catalog: do not say it is available.`);
          }
        }
      }
    }

    // Derived totals: sums of the Catalog prices stated anywhere in the reply, labelled as referential.
    for (const { amount, window } of pendingTotals) {
      const operands = subsetSums(catalogAmounts, amount.value);
      if (operands && (amount.approximate || REFERENTIAL.test(window))) {
        claims.push({ kind: 'estimated_total', subjectRef: null, value: amount.value, authority: 'derived', evidenceRef: null, derivation: { operation: 'sum', operands } });
      } else if (operands) {
        problems.push(`${money(amount.value)} is a sum of Catalog prices: label it as a referential/approximate total ("total referencial"), never as a final amount or quote.`);
      } else {
        problems.push(`${money(amount.value)} is not a current Catalog price, nor a sum of Catalog prices stated in the reply: remove it (discounts, shipping, taxes and totals are not Catalog facts).`);
      }
    }

    const claimObjects = claims.map((c) => ({ ...c }) as unknown as JsonObject);
    if (stale.size > 0) {
      return { kind: 'revalidation_required', reads: [...stale].map((productKey) => ({ capabilityId: CAPABILITY_IDS.productContext, arguments: { productKey } })), claims: claimObjects };
    }
    if (problems.length > 0) {
      const feedback = ['Your reply was NOT sent: it is not consistent with current Catalog evidence.', ...[...new Set(problems)].map((p) => `- ${p}`), 'Rewrite it stating prices and availability exactly as the current Catalog evidence says.'].join('\n');
      return { kind: 'reject', code: 'response_authority_contradiction', feedback: feedback.slice(0, 1900), claims: claimObjects };
    }
    return { kind: 'allow', claims: claimObjects };
  }

  degraded(): string {
    return 'Perdón, no pude confirmar el precio ni la disponibilidad actual en este momento. ¿Quieres que lo revise de nuevo?';
  }
}
