import type { Observation } from '@r4/contracts';
import type { ClaimVerification, ClaimVerifier, ExtractedClaim } from '@r4/evaluation';
import { catalogEvidenceValidUntil } from '../capabilities/catalog.js';
import { CAPABILITY_IDS } from '../ids.js';

/**
 * Deterministic verification of Sales claims against the observations a
 * response could see. A judge may say WHAT a response claimed; whether it
 * was grounded is decided here, from catalog / shipping / quote evidence
 * only — never from what a model (or the fixture catalog) knows otherwise.
 * Catalog evidence has the R4-J1B shape.
 *
 *   entity   product → its catalog key (productKey or a variant itemKey —
 *            never a SKU), or name matched against observed product names;
 *            category → observed categories; anything else → its name
 *            appears in an available observation.
 *   price    the stated amount equals an observed EXACT price, a "from"
 *            price stated as such ("desde" / attributes.priceKind = from),
 *            or a shipping / quote amount. A catalog answer the owner had
 *            already declared expired when R4 observed it is not evidence.
 *   stock    the stated status equals the owner's sellability or its
 *            reason; stated units are never grounded (J1 shows no quantity).
 *   absence  (availability with exists=false) only a complete, untruncated,
 *            empty search for those words, or a product context answering
 *            not_found for that key, grounds "we do not have it".
 *   spec     every stated attribute value appears in the product's observed
 *            facts (verbatim specifications, name, category, brand, lifecycle).
 *   relation compatibility is NEVER grounded by catalog evidence: the owner
 *            publishes no curated compatibility. "Bought together" is
 *            grounded only as a relationship, from frequentlyBoughtTogether.
 */
interface ObservedProduct {
  productKey: string;
  name: string;
  category: string | null;
  exactPrices: Set<number>;
  fromPrices: Set<number>;
  availability: { sellability: string; reason: string } | null;
  detailValues: Set<string>;
  boughtTogether: Set<string>;
  observationIds: Set<string>;
}

interface EvidenceIndex {
  products: Map<string, ObservedProduct>;
  /** Other catalog keys (variant itemKeys, sellable item keys) → the product key they belong to. */
  aliases: Map<string, string>;
  categories: Map<string, Set<string>>;
  amounts: Map<number, Set<string>>;
  /** Complete, untruncated, empty searches: normalized query tokens → observation. */
  emptySearches: { tokens: string[]; id: string }[];
  notFound: Map<string, string>;
  text: { id: string; normalized: string }[];
}

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9.,\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Function words that do not identify a product ("barra olímpica de 20 kg" = "Barra olímpica 20 kg"). */
const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'con', 'para', 'set', 'of', 'the']);

function tokens(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

type Money = { amount?: unknown } | undefined;
type Price = { kind?: unknown; finalGross?: Money } | null | undefined;

/** False when the owner had already declared the answer expired at the instant R4 observed it. */
function ownerCurrentAtObservation(o: Observation): boolean {
  const validUntil = catalogEvidenceValidUntil({ validUntil: null, payload: o.payload });
  return validUntil === null || Date.parse(validUntil) >= Date.parse(o.observedAt);
}

function index(evidence: readonly Observation[]): EvidenceIndex {
  const idx: EvidenceIndex = { products: new Map(), aliases: new Map(), categories: new Map(), amounts: new Map(), emptySearches: [], notFound: new Map(), text: [] };
  const addAmount = (amount: unknown, id: string) => {
    if (typeof amount === 'number') idx.amounts.set(amount, (idx.amounts.get(amount) ?? new Set()).add(id));
  };
  const addCategory = (name: unknown, id: string) => {
    if (typeof name === 'string') idx.categories.set(normalize(name), (idx.categories.get(normalize(name)) ?? new Set()).add(id));
  };
  const product = (key: string, name: unknown, id: string): ObservedProduct => {
    const entry = idx.products.get(key) ?? { productKey: key, name: typeof name === 'string' ? name : key, category: null, exactPrices: new Set(), fromPrices: new Set(), availability: null, detailValues: new Set(), boughtTogether: new Set(), observationIds: new Set() };
    entry.observationIds.add(id);
    idx.products.set(key, entry);
    return entry;
  };
  const price = (entry: ObservedProduct, p: Price, id: string, current: boolean) => {
    const amount = p?.finalGross?.amount;
    if (!current || typeof amount !== 'number') return;
    (p?.kind === 'from' ? entry.fromPrices : entry.exactPrices).add(amount);
    addAmount(amount, id);
  };
  for (const o of evidence) {
    if (o.outcome !== 'succeeded' || o.payload === null) continue;
    const payload = o.payload as Record<string, unknown>;
    idx.text.push({ id: o.observationId, normalized: normalize(JSON.stringify(o.payload)) });
    const capability = o.source.capabilityId;
    if (capability === CAPABILITY_IDS.catalogSearch) {
      const current = ownerCurrentAtObservation(o);
      const results = (payload.results as Record<string, unknown>[] | undefined) ?? [];
      const completeness = payload.completeness as { totalMatches?: unknown; truncated?: unknown } | undefined;
      if (results.length === 0 && completeness?.totalMatches === 0 && completeness.truncated === false && typeof payload.query === 'string') idx.emptySearches.push({ tokens: tokens(payload.query), id: o.observationId });
      for (const r of results) {
        if (typeof r.productKey !== 'string') continue;
        const entry = product(r.productKey, r.name, o.observationId);
        const category = (r.category as { name?: unknown } | null)?.name;
        if (typeof category === 'string') entry.category = category;
        addCategory(category, o.observationId);
        price(entry, r.price as Price, o.observationId, current);
        const a = r.availability as { sellability?: unknown; reason?: unknown } | undefined;
        if (typeof a?.sellability === 'string' && typeof a.reason === 'string') entry.availability = { sellability: a.sellability, reason: a.reason };
        for (const v of leafValues({ name: r.name, category })) entry.detailValues.add(v);
      }
    } else if (capability === CAPABILITY_IDS.productContext) {
      if (payload.status === 'not_found' && typeof payload.productKey === 'string') idx.notFound.set(payload.productKey, o.observationId);
      if (payload.status !== 'found' || typeof payload.productKey !== 'string') continue;
      const facts = payload.facts as { name?: unknown; category?: { name?: unknown } | null; brand?: unknown; lifecycle?: unknown; specifications?: unknown; sellableItemKey?: unknown; variantOptions?: { itemKey?: unknown; attributes?: unknown }[] };
      const derived = payload.derived as { price?: Price; availability?: { sellability?: unknown; reason?: unknown } };
      const entry = product(payload.productKey, facts.name, o.observationId);
      if (typeof facts.category?.name === 'string') entry.category = facts.category.name;
      addCategory(facts.category?.name, o.observationId);
      price(entry, derived.price, o.observationId, ownerCurrentAtObservation(o));
      if (typeof derived.availability?.sellability === 'string' && typeof derived.availability.reason === 'string') entry.availability = { sellability: derived.availability.sellability, reason: derived.availability.reason };
      // Only authoritative facts ground a specification: never catalog-edited free text or inferred blocks.
      for (const v of leafValues({ name: facts.name, category: facts.category, brand: facts.brand, lifecycle: facts.lifecycle, specifications: facts.specifications, variants: (facts.variantOptions ?? []).map((v) => v.attributes) })) entry.detailValues.add(v);
      if (typeof facts.sellableItemKey === 'string') idx.aliases.set(facts.sellableItemKey, payload.productKey);
      for (const v of facts.variantOptions ?? []) if (typeof v.itemKey === 'string') idx.aliases.set(v.itemKey, payload.productKey);
      const fbt = (payload.inferred as { frequentlyBoughtTogether?: { status?: unknown; items?: { productKey?: unknown }[] } } | undefined)?.frequentlyBoughtTogether;
      if (fbt?.status === 'available') for (const item of fbt.items ?? []) if (typeof item.productKey === 'string') entry.boughtTogether.add(item.productKey);
    } else if (capability === CAPABILITY_IDS.shippingQuote) {
      for (const option of (payload.options as { amount?: { amount?: unknown } }[] | undefined) ?? []) addAmount(option.amount?.amount, o.observationId);
    } else if (capability === CAPABILITY_IDS.quoteCreate) {
      // A durable action observation carries the receipt envelope ({receiptId, status, …, result}); the owner's quote is `result`.
      // (R4-H fix: the fixture builder wrote the bare result, so only fixtures were ever indexed.)
      const q = (typeof payload.result === 'object' && payload.result !== null ? payload.result : payload) as { total?: { amount?: unknown }; subtotal?: { amount?: unknown }; shipping?: { amount?: { amount?: unknown } }; lines?: { unitPrice?: { amount?: unknown }; lineTotal?: { amount?: unknown } }[] };
      addAmount(q.total?.amount, o.observationId);
      addAmount(q.subtotal?.amount, o.observationId);
      addAmount(q.shipping?.amount?.amount, o.observationId);
      for (const l of q.lines ?? []) {
        addAmount(l.unitPrice?.amount, o.observationId);
        addAmount(l.lineTotal?.amount, o.observationId);
      }
    }
  }
  return idx;
}

/**
 * Every leaf value, plus the tokens of each string: owner specifications are
 * verbatim text ("120 × 140 × 215 cm"), so a stated 140 is grounded when it
 * appears in one. (Evaluation matching only; runtime never parses them.)
 */
function leafValues(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) leafValues(v, into);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) leafValues(v, into);
  else if (typeof value === 'number' || typeof value === 'boolean') into.push(String(value));
  else if (typeof value === 'string') {
    const text = normalize(value);
    into.push(text, ...text.split(' ').map((t) => t.replace(/[.,]$/, '').replace(/^(\d+),(\d+)$/, '$1.$2')).filter((t) => t.length > 0));
  }
  return into;
}

function matchProduct(idx: EvidenceIndex, entity: { name: string; ref: string | null }): ObservedProduct | null {
  if (entity.ref) {
    const key = idx.aliases.get(entity.ref) ?? entity.ref;
    if (idx.products.has(key)) return idx.products.get(key)!;
  }
  const wanted = normalize(entity.name);
  const wantedTokens = tokens(entity.name);
  let best: { p: ObservedProduct; score: number } | null = null;
  for (const p of idx.products.values()) {
    const name = normalize(p.name);
    const nameTokens = new Set(tokens(p.name));
    const score = name === wanted ? 3 : name.includes(wanted) || wanted.includes(name) ? 2 : wantedTokens.length > 1 && wantedTokens.every((t) => nameTokens.has(t)) ? 1 : 0;
    if (score > 0 && (!best || score > best.score)) best = { p, score };
  }
  return best?.p ?? null;
}

const statedAsFrom = (claim: ExtractedClaim) => claim.attributes.priceKind === 'from' || /\b(desde|from)\b/.test(normalize(claim.text));

export class SalesClaimVerifier implements ClaimVerifier {
  verify(claim: ExtractedClaim, evidence: readonly Observation[]): ClaimVerification {
    const idx = index(evidence);
    const refs = new Set<string>();
    if ((claim.type === 'availability' || claim.type === 'stock') && claim.attributes.exists === false) return this.#absence(claim, idx);
    const resolved = claim.entities.map((e) => {
      const kind = normalize(e.kind);
      if (kind === 'category') {
        const hit = idx.categories.get(normalize(e.name));
        hit?.forEach((id) => refs.add(id));
        return { name: e.name, grounded: hit !== undefined, ref: null, product: null };
      }
      const product = matchProduct(idx, e);
      if (product) {
        product.observationIds.forEach((id) => refs.add(id));
        return { name: e.name, grounded: true, ref: product.productKey, product };
      }
      if (kind === 'product' || kind === 'item') return { name: e.name, grounded: false, ref: e.ref, product: null };
      const needle = normalize(e.name);
      const text = idx.text.find((t) => needle.length >= 3 && t.normalized.includes(needle));
      if (text) refs.add(text.id);
      return { name: e.name, grounded: text !== undefined, ref: e.ref, product: null };
    });
    const products = resolved.flatMap((r) => (r.product ? [r.product] : []));
    const attrs = Object.entries(claim.attributes).filter(([key]) => key !== 'priceKind').map(([, v]) => v);
    const supported = (() => {
      switch (claim.type) {
        case 'compatibility':
          // No curated compatibility exists in the Catalog contract; co-purchase is not compatibility.
          return false;
        case 'relationship': {
          if (products.length < 2) return false;
          const [a, b] = [products[0]!, products[1]!];
          return a.boughtTogether.has(b.productKey) || b.boughtTogether.has(a.productKey);
        }
        case 'price': {
          const amount = claim.attributes.amount;
          if (typeof amount !== 'number') return true;
          idx.amounts.get(amount)?.forEach((id) => refs.add(id));
          if (products.length === 0) return idx.amounts.has(amount);
          return products.some((p) => p.exactPrices.has(amount) || (statedAsFrom(claim) && p.fromPrices.has(amount)));
        }
        case 'stock':
        case 'availability': {
          const status = claim.attributes.status;
          // "We carry discs": availability of an observed category (no specific product, no stated stock).
          if (products.length === 0) return resolved.length > 0 && resolved.every((r) => r.grounded) && status === undefined && claim.attributes.units === undefined;
          if (claim.attributes.units !== undefined) return false;
          return products.every((p) => p.availability !== null && (status === undefined || [p.availability.sellability, p.availability.reason].some((s) => normalize(s) === normalize(String(status)))));
        }
        case 'recommendation':
          return true;
        default: {
          if (attrs.length === 0) return true;
          const pool = products.length > 0 ? new Set(products.flatMap((p) => [...p.detailValues])) : new Set(idx.text.flatMap((t) => [t.normalized]));
          return attrs.every((v) => (products.length > 0 ? pool.has(typeof v === 'string' ? normalize(v) : String(v)) : [...pool].some((t) => t.includes(typeof v === 'string' ? normalize(v) : String(v)))));
        }
      }
    })();
    return { entities: resolved.map((r) => ({ name: r.name, grounded: r.grounded, ref: r.ref })), supported, evidenceRefs: [...refs].sort() };
  }

  /** "We do not have X": only an exhaustive empty search for those words, or not_found for that key. */
  #absence(claim: ExtractedClaim, idx: EvidenceIndex): ClaimVerification {
    const refs = new Set<string>();
    const entities = claim.entities.map((e) => {
      const byKey = e.ref ? idx.notFound.get(e.ref) : undefined;
      const wanted = tokens(e.name);
      const bySearch = idx.emptySearches.find((s) => s.tokens.length > 0 && s.tokens.every((t) => wanted.includes(t)));
      const hit = byKey ?? bySearch?.id;
      if (hit) refs.add(hit);
      return { name: e.name, grounded: hit !== undefined, ref: e.ref };
    });
    return { entities, supported: entities.length > 0 && entities.every((e) => e.grounded), evidenceRefs: [...refs].sort() };
  }
}
