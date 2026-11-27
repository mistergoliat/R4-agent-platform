import type { ContextContributionInput, JsonValue, Observation } from '@r4/contracts';
import { CATALOG_TEXT_NOTICE } from '../capabilities/catalog.js';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS } from '../ids.js';

/**
 * Catalog descriptive freshness (R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS, off by default).
 *
 * Catalog V2 declares ONE `validUntil` (asOf + 15 s, OD-3) for a whole answer, so a product's name, specifications and
 * description expire with its price and stock, and the agent reads them again every few model calls. With the switch
 * on, the Sales pack re-states the DESCRIPTIVE part of an expired catalog read as its own observation item, valid for
 * the configured window from the read. Nothing else changes:
 *
 *   - the observation keeps the owner's validity (the invoker, ADR-030): its price, stock, availability, sellability,
 *     promotion and status flags expire exactly as today and are never copied here;
 *   - quote.preview and quote.create read Catalog themselves and never see context items;
 *   - Catalog's contract is read as is; no field is added or computed.
 *
 * Covered: catalog.get_product_context and catalog.discover. Not catalog.search: its result set may be filtered by
 * price or sellability, which is commercial.
 */
export const CATALOG_DESCRIPTIVE_SOURCE = 'sales_catalog_descriptive';
export const CATALOG_DESCRIPTIVE_MAX_WINDOW_SECONDS = 1800;

/** `R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS`: unset or 0 = off; 1..1800 seconds; anything else refuses (fail closed). */
export function loadCatalogDescriptiveWindowMs(env: Readonly<Record<string, string | undefined>>): number | null {
  const raw = env.R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS?.trim() ?? '';
  if (raw === '' || raw === '0') return null;
  const seconds = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!(seconds >= 1 && seconds <= CATALOG_DESCRIPTIVE_MAX_WINDOW_SECONDS)) throw new Error(`R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS must be 0 (off) or 1..${CATALOG_DESCRIPTIVE_MAX_WINDOW_SECONDS}`);
  return seconds * 1000;
}

const about = (minutes: string) =>
  `Descriptive catalog facts of an earlier Catalog read (observationId), kept by the Sales pack for ${minutes} from that read: names, specifications, description, variants and the candidates Catalog proposed for a need. Use them without reading again. They carry NO price, stock, availability, sellability or promotion: take those only from current catalog observations.`;

/** A Discover requirement code that depends on price or stock (owner codes: `…@COMMERCIAL_TRUTH`, `price<=…`, `sellable…`). */
const COMMERCIAL_CODE = /COMMERCIAL|^price|^sellable/iu;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The descriptive fields of catalog.get_product_context (found), verbatim: no price, availability, status or promotion. */
function productFacts(p: Json): Json {
  const facts = obj(p.facts);
  return {
    productKey: p.productKey,
    name: facts.name,
    sku: facts.sku,
    category: facts.category,
    brand: facts.brand,
    specifications: facts.specifications,
    sellableItemKey: facts.sellableItemKey,
    variantOptions: arr(facts.variantOptions).map((o) => ({ itemKey: obj(o).itemKey, sku: obj(o).sku, attributes: obj(o).attributes })),
    catalogText: { notice: CATALOG_TEXT_NOTICE, shortDescription: obj(p.catalogText).shortDescription ?? null },
    publicUrl: obj(p.derived).publicUrl ?? null,
    frequentlyBoughtTogether: obj(p.inferred).frequentlyBoughtTogether ?? null,
  };
}

/**
 * The descriptive part of catalog.discover: the need, its interpretation and the proposed candidates in the owner's
 * order with their non-commercial requirement codes. The disposition (verified/possible) is left out: under a price or
 * sellability constraint it depends on commercial truth.
 */
function discoverFacts(p: Json): Json {
  const candidates = [...(p.exactMatch ? [p.exactMatch] : []), ...arr(p.verified), ...arr(p.possible)].map(obj);
  const descriptive = (codes: unknown) => arr(codes).filter((c) => typeof c === 'string' && !COMMERCIAL_CODE.test(c));
  return {
    need: p.need,
    interpretation: p.interpretation ?? null,
    candidates: candidates.map((c) => ({ productKey: c.productKey, itemKey: c.itemKey ?? null, name: c.name, satisfied: descriptive(c.satisfied), unresolved: descriptive(c.unresolved) })),
    note: 'Candidates in the order Catalog proposed them for this need at that time. Their price and availability are not here.',
  };
}

interface Subject {
  readonly subject: string;
  readonly observation: Observation;
  /** The product context or the Discover answer its facts come from. */
  readonly payload: Json;
  readonly itemId: string;
}

/**
 * Which catalog subjects an observation speaks about (newest wins): one for a single read or a Discover answer, one per
 * product for a batch read (sales-web@24; a product it could not read speaks about nothing). Empty when not covered.
 */
function subjectsOf(o: Observation): Subject[] {
  if (o.source.kind !== 'capability' || o.outcome !== 'succeeded') return [];
  const p = obj(o.payload);
  const itemId = `${CATALOG_DESCRIPTIVE_SOURCE}:${o.observationId}`;
  if (o.source.capabilityId === CAPABILITY_IDS.productContext && typeof p.productKey === 'string') return [{ subject: `product:${p.productKey}`, observation: o, payload: p, itemId }];
  if (o.source.capabilityId === LANE_CAPABILITY_IDS.catalogProductsContext) {
    return arr(p.products).map(obj).flatMap((i) => (typeof i.productKey === 'string' && i.status !== 'failed' ? [{ subject: `product:${i.productKey}`, observation: o, payload: i, itemId: `${itemId}:${i.productKey}` }] : []));
  }
  if (o.source.capabilityId === LANE_CAPABILITY_IDS.catalogDiscover && typeof p.need === 'string') return [{ subject: `need:${p.need.trim().toLowerCase().replace(/\s+/gu, ' ')}`, observation: o, payload: p, itemId }];
  return [];
}

/**
 * Pure: one OBSERVED item per catalog subject whose NEWEST read has passed its owner validity but is still inside the
 * descriptive window. A subject whose newest read is current needs no copy (the read itself is in the context); one
 * whose newest read is `not_found` gets none.
 */
export function catalogDescriptiveItems(observations: readonly Observation[], now: Date, windowMs: number): ContextContributionInput[] {
  const newest = new Map<string, Subject>();
  for (const o of observations) {
    for (const s of subjectsOf(o)) {
      const previous = newest.get(s.subject)?.observation;
      if (!previous || o.observedAt > previous.observedAt || (o.observedAt === previous.observedAt && o.observationId > previous.observationId)) newest.set(s.subject, s);
    }
  }
  const at = now.getTime();
  const minutes = windowMs % 60_000 === 0 ? `${windowMs / 60_000} minutes` : `${windowMs / 1000} seconds`;
  const items: ContextContributionInput[] = [];
  for (const { observation: o, payload: p, itemId } of newest.values()) {
    const until = Date.parse(o.observedAt) + windowMs;
    // A batch read has one validity for all its products, the earliest of theirs (catalogProductsOwnerValidUntil).
    if (o.validUntil === null || at < Date.parse(o.validUntil) || at >= until) continue;
    const product = o.source.capabilityId !== LANE_CAPABILITY_IDS.catalogDiscover;
    if (product && p.status !== 'found') continue;
    const facts = product ? productFacts(p) : discoverFacts(p);
    items.push({
      itemId,
      kind: 'observation',
      authority: 'OBSERVED',
      temporality: 'point_in_time',
      content: { about: about(minutes), observationId: o.observationId, capabilityId: o.source.capabilityId, descriptive: facts } as unknown as JsonValue,
      provenance: { recordType: 'observation', recordId: o.observationId, producedBy: 'sales' },
      createdAt: o.observedAt,
      observedAt: o.observedAt,
      validUntil: new Date(until).toISOString(),
      taskId: o.taskId,
    });
  }
  return items;
}
