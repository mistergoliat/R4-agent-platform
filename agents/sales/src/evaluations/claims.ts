import type { Observation } from '@r4/contracts';
import type { ClaimVerification, ClaimVerifier, ExtractedClaim } from '@r4/evaluation';
import { CAPABILITY_IDS } from '../ids.js';

/**
 * Deterministic verification of Sales claims against the observations a
 * response could see. A judge may say WHAT a response claimed; whether it
 * was grounded is decided here, from catalog / shipping / quote evidence
 * only — never from what a model (or the fixture catalog) knows otherwise.
 *
 *   entity   product → id, or name matched against observed product names;
 *            category → observed categories; anything else → its name
 *            appears in an available observation.
 *   price    the stated amount equals an observed unit price / shipping / quote amount.
 *   stock    the stated status or units equal the observed stock.
 *   spec     every stated attribute value appears in the product's observed detail.
 *   relation compatibility is observed only from a product-context
 *            `compatibleWith` of one side listing the other.
 */
interface ObservedProduct {
  productId: string;
  name: string;
  category: string | null;
  brand: string | null;
  prices: Set<number>;
  stock: { status: string; units: number } | null;
  detailValues: Set<string>;
  compatibleWith: Set<string>;
  observationIds: Set<string>;
}

interface EvidenceIndex {
  products: Map<string, ObservedProduct>;
  categories: Map<string, Set<string>>;
  amounts: Map<number, Set<string>>;
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

function index(evidence: readonly Observation[]): EvidenceIndex {
  const products = new Map<string, ObservedProduct>();
  const categories = new Map<string, Set<string>>();
  const amounts = new Map<number, Set<string>>();
  const text: EvidenceIndex['text'] = [];
  const addAmount = (amount: unknown, id: string) => {
    if (typeof amount === 'number') amounts.set(amount, (amounts.get(amount) ?? new Set()).add(id));
  };
  const product = (p: Record<string, unknown>, id: string): ObservedProduct => {
    const productId = String(p.productId);
    const entry = products.get(productId) ?? { productId, name: typeof p.name === 'string' ? p.name : productId, category: null, brand: null, prices: new Set(), stock: null, detailValues: new Set(), compatibleWith: new Set(), observationIds: new Set() };
    entry.observationIds.add(id);
    if (typeof p.category === 'string') {
      entry.category = p.category;
      categories.set(normalize(p.category), (categories.get(normalize(p.category)) ?? new Set()).add(id));
    }
    if (typeof p.brand === 'string') entry.brand = p.brand;
    const price = (p.unitPrice as { amount?: unknown } | undefined)?.amount;
    if (typeof price === 'number') {
      entry.prices.add(price);
      addAmount(price, id);
    }
    const stock = p.stock as { status?: unknown; units?: unknown } | undefined;
    if (stock && typeof stock.status === 'string' && typeof stock.units === 'number') entry.stock = { status: stock.status, units: stock.units };
    for (const v of leafValues(p)) entry.detailValues.add(v);
    if (Array.isArray(p.compatibleWith)) for (const c of p.compatibleWith) entry.compatibleWith.add(String(c));
    products.set(productId, entry);
    return entry;
  };
  for (const o of evidence) {
    if (o.outcome !== 'succeeded' || o.payload === null) continue;
    const payload = o.payload as Record<string, unknown>;
    text.push({ id: o.observationId, normalized: normalize(JSON.stringify(o.payload)) });
    const capability = o.source.capabilityId;
    if (capability === CAPABILITY_IDS.catalogSearch) {
      for (const c of (payload.categories as unknown[] | undefined) ?? []) categories.set(normalize(String(c)), (categories.get(normalize(String(c))) ?? new Set()).add(o.observationId));
      for (const r of (payload.results as Record<string, unknown>[] | undefined) ?? []) product(r, o.observationId);
    } else if (capability === CAPABILITY_IDS.productContext && payload.found === true) {
      product(payload.product as Record<string, unknown>, o.observationId);
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
  return { products, categories, amounts, text };
}

function leafValues(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) leafValues(v, into);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) leafValues(v, into);
  else if (typeof value === 'number' || typeof value === 'boolean') into.push(String(value));
  else if (typeof value === 'string') into.push(normalize(value));
  return into;
}

function matchProduct(idx: EvidenceIndex, entity: { name: string; ref: string | null }): ObservedProduct | null {
  if (entity.ref && idx.products.has(entity.ref)) return idx.products.get(entity.ref)!;
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

export class SalesClaimVerifier implements ClaimVerifier {
  verify(claim: ExtractedClaim, evidence: readonly Observation[]): ClaimVerification {
    const idx = index(evidence);
    const refs = new Set<string>();
    const resolved = claim.entities.map((e) => {
      const kind = normalize(e.kind);
      if (kind === 'category') {
        const hit = idx.categories.get(normalize(e.name));
        hit?.forEach((id) => refs.add(id));
        return { name: e.name, grounded: hit !== undefined, ref: null, product: null };
      }
      const product = kind === 'product' || kind === 'item' ? matchProduct(idx, e) : (matchProduct(idx, e) ?? null);
      if (product) {
        product.observationIds.forEach((id) => refs.add(id));
        return { name: e.name, grounded: true, ref: product.productId, product };
      }
      if (kind === 'product' || kind === 'item') return { name: e.name, grounded: false, ref: e.ref, product: null };
      const needle = normalize(e.name);
      const text = idx.text.find((t) => needle.length >= 3 && t.normalized.includes(needle));
      if (text) refs.add(text.id);
      return { name: e.name, grounded: text !== undefined, ref: e.ref, product: null };
    });
    const products = resolved.flatMap((r) => (r.product ? [r.product] : []));
    const attrs = Object.values(claim.attributes);
    const supported = (() => {
      switch (claim.type) {
        case 'compatibility':
        case 'relationship': {
          if (products.length < 2) return false;
          const [a, b] = [products[0]!, products[1]!];
          return a.compatibleWith.has(b.productId) || b.compatibleWith.has(a.productId);
        }
        case 'price': {
          const amount = claim.attributes.amount;
          if (typeof amount !== 'number') return true;
          const hit = products.length > 0 ? products.some((p) => p.prices.has(amount)) : idx.amounts.has(amount);
          idx.amounts.get(amount)?.forEach((id) => refs.add(id));
          return hit || (products.length === 0 && idx.amounts.has(amount));
        }
        case 'stock':
        case 'availability': {
          const status = claim.attributes.status;
          const units = claim.attributes.units;
          // "We carry discs": availability of an observed category (no specific product, no stated stock).
          if (products.length === 0) return resolved.length > 0 && resolved.every((r) => r.grounded) && status === undefined && units === undefined;
          return products.every((p) => p.stock !== null && (status === undefined || normalize(String(status)) === normalize(p.stock.status)) && (units === undefined || units === p.stock.units));
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
}
