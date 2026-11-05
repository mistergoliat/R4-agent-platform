import { z } from 'zod';

/**
 * (R4 integrated E2E, ADR-045) Consumer side of Catalog V2's `catalog.discover` (POST /v2/catalog/discover).
 *
 * Contract: `catalog-discover-v1b1`, schemaVersion 1, as it exists on Catalog main 5f2c086 — status
 * DRAFT_NOT_PUBLISHED (publication requested in Catalog #56). It is pinned below by the hashes of Catalog's own
 * contract manifest; R4's fixture copy is checked against them. A published revision is a new pin, never an edit.
 *
 * This is a port of Catalog's TOLERANT response schema (agentContract.ts, mode 'tolerant'): unknown object fields
 * pass, open vocabularies accept any well-formed code, closed enums fail. R4 adds no rule of its own: it never
 * ranks, filters, reorders or completes candidates, and never turns Discover into a price or stock authority
 * (a purchase still reads the item context).
 */
export const DISCOVER_CONTRACT_PIN = Object.freeze({
  contractVersion: 'catalog-discover-v1b1',
  schemaVersion: 1,
  status: 'DRAFT_NOT_PUBLISHED',
  ownerCommit: '5f2c08693f08ebe014082398c077213e4ad3b38d',
  manifest: 'docs/catalog-v2/discover-contract/catalog-discover.contract-manifest.json',
  sha256Lf: {
    agentContract: 'c58a0426b65af824afdac5921fde6247b4a32a2f99c26339c694084710510279',
    discoverContracts: '835cd1e09358372a51934574f32b2bd383b9eaa38be1e6ec93fa10cec447db21',
    jsonSchemaDraft: '4b00002f9a881857fea518a9b2a92370ff58a69224908f59391646bc7a1cbdca',
    goldenFixtures: '76eb211fa2330014b2b44420f8c091debcc9759f9f05e9ad97ad6c957f23255f',
  },
});

export const DISCOVER_MAX_LIMIT = 8;
export const DISCOVER_MAX_KEYS = 8;
const DISCOVER_MAX_POSSIBLE = 3;

const productKey = z.string().regex(/^P\d+$/u);
const itemKey = z.string().regex(/^P\d+(?:-V\d+)?$/u);
const sellability = z.enum(['sellable', 'backorder', 'not_sellable', 'check_with_staff']);

/** The request, strict like the owner's (an unknown field is an error there too). `need` ≤ 300 is the owner's runtime limit. */
export const catalogDiscoverRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  need: z.string().trim().min(1).max(300),
  limit: z.int().min(1).max(DISCOVER_MAX_LIMIT).optional(),
  constraints: z
    .strictObject({
      maxUnitPriceClp: z.int().min(1).max(100_000_000).optional(),
      sellableOnly: z.boolean().optional(),
      minUserCapacityKg: z.number().min(1).max(2000).optional(),
      minLoadKg: z.number().min(1).max(5000).optional(),
      maxLengthCm: z.number().min(1).max(2000).optional(),
      maxWidthCm: z.number().min(1).max(2000).optional(),
      maxHeightCm: z.number().min(1).max(2000).optional(),
    })
    .optional(),
  hints: z.strictObject({ productKeys: z.array(z.string().regex(/^P[1-9]\d{0,9}$/u)).max(DISCOVER_MAX_KEYS).optional() }).optional(),
  selectedItemKeys: z.array(itemKey).max(DISCOVER_MAX_KEYS).optional(),
  context: z.strictObject({ correlationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u).optional() }).optional(),
});
export type CatalogDiscoverRequest = z.infer<typeof catalogDiscoverRequestSchema>;

const obj = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const openCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);
const isoDate = z.iso.datetime();
const code = z.string().min(1).max(160);
const codes = z.array(code).max(64);
const count = z.int().nonnegative();

const commercial = z.discriminatedUnion('status', [
  obj({
    status: z.literal('OBSERVED'),
    authority: z.string().min(1),
    asOf: isoDate,
    validUntil: isoDate.nullable(),
    price: obj({ finalGrossClp: z.int().nonnegative().nullable(), kind: z.enum(['exact', 'from']).nullable(), basis: z.enum(['offerable', 'not_offerable']).nullable() }),
    sellability,
    orderable: z.boolean(),
    unit: obj({ itemKey, finalGrossClp: z.int().nonnegative().nullable(), sellability, reason: z.string().min(1).max(64), availableQuantity: z.int().nullable(), orderable: z.boolean(), validUntil: isoDate.nullable() }).optional(),
  }),
  obj({ status: z.literal('EXPIRED'), authority: z.string().min(1), asOf: isoDate, validUntil: isoDate }),
  obj({ status: z.literal('UNKNOWN'), reason: openCode }),
]);

const candidate = obj({
  productKey,
  itemKey: itemKey.optional(),
  name: z.string().min(1).max(128),
  disposition: z.enum(['VERIFIED_MATCH', 'POSSIBLE_MATCH', 'REJECTED']),
  matchedBy: codes,
  satisfied: codes,
  unresolved: codes,
  readings: codes,
  requirements: z.array(obj({ code, state: z.enum(['SATISFIED', 'UNKNOWN', 'UNSUPPORTED', 'VIOLATED', 'NOT_EVALUATED']), authority: z.string().min(1).max(32).nullable(), derived: z.boolean() })).max(64),
  commercial,
});

const absenceReason = z.enum(['NO_RELEVANT_CANDIDATES', 'NO_VERIFIED_CANDIDATES', 'AMBIGUOUS_NEED', 'CONSTRAINTS_UNSUPPORTED', 'COMMERCIAL_TRUTH_UNAVAILABLE', 'COMMERCIAL_EVALUATION_INCOMPLETE', 'RETRIEVAL_TRUNCATED', 'SOURCE_UNAVAILABLE']);

/** Catalog's tolerant consumer schema of a 200 answer (FAILED is never sent as 200, but the shape admits it). */
export const catalogDiscoverResponseSchema = obj({
  schemaVersion: z.literal(1),
  contractVersion: z.string().min(1),
  requestId: z.string().min(1).max(128),
  status: z.enum(['COMPLETE', 'PARTIAL', 'DEGRADED', 'FAILED']),
  interpretation: obj({
    need: z.string().max(121),
    required: codes,
    preferred: codes,
    notVerifiable: codes,
    ambiguities: z.array(obj({ text: z.string().max(160), readings: codes, groupId: z.string().min(1).max(32), readingRequirements: z.array(obj({ readingId: z.string().min(1).max(16), required: codes })).max(16) })).max(8),
    unrecognized: z.array(z.string().max(64)).max(64),
    structured: obj({ applied: codes, duplicatesOfText: codes }),
    hints: obj({ productKeys: z.array(productKey).max(DISCOVER_MAX_KEYS), notFound: z.array(productKey).max(DISCOVER_MAX_KEYS) }),
    selection: obj({ itemKeys: z.array(itemKey).max(DISCOVER_MAX_KEYS), notFound: z.array(itemKey).max(DISCOVER_MAX_KEYS), unverified: z.array(itemKey).max(DISCOVER_MAX_KEYS) }),
  }).nullable(),
  exactMatch: candidate.nullable(),
  verified: z.array(candidate).max(DISCOVER_MAX_LIMIT),
  possible: z.array(candidate).max(DISCOVER_MAX_POSSIBLE),
  completeness: obj({
    retrieval: z.enum(['COMPLETE', 'TRUNCATED']),
    commercial: z.enum(['NOT_REQUIRED', 'COMPLETE', 'SUFFICIENT', 'INCOMPLETE', 'UNAVAILABLE']),
    exhaustive: z.boolean(),
    moreVerifiedAvailable: z.boolean(),
    counts: obj({
      retrieved: count, technicallyExamined: count, commerciallyHydrated: count, pendingHydration: count,
      rejectedByKnownConstraints: count, rejectedByCommercialConstraints: count, withUnresolvedConstraints: count, verified: count, presented: count,
    }),
  }).nullable(),
  absence: obj({ reason: absenceReason, contributing: z.array(openCode).max(8), engineReason: z.string().max(64).nullable() }).nullable(),
  degradation: z.array(obj({ component: openCode, cause: openCode, retryable: z.boolean() })).max(8),
  commercialFreshness: obj({
    status: z.enum(['OBSERVED', 'PARTIAL', 'UNAVAILABLE', 'NOT_CONFIGURED', 'NOT_REQUESTED']),
    authority: z.string().min(1).nullable(),
    integrationVersion: z.string().min(1).nullable(),
    oldestAsOf: isoDate.nullable(),
    newestAsOf: isoDate.nullable(),
    earliestValidUntil: isoDate.nullable(),
    maxCacheAgeMs: count.nullable(),
    reads: count,
    observations: obj({ observed: count, notFound: count, unavailable: count }),
    coherence: z.literal('PER_PRODUCT_READ'),
  }).nullable(),
  lineage: z.looseObject({ contractVersion: z.string().min(1) }).nullable(),
  warnings: z.array(openCode).max(32),
});
export type CatalogDiscoverAnswer = z.infer<typeof catalogDiscoverResponseSchema>;

/** What reads Discover (only the Catalog V2 HTTP adapter implements it; Catalog V1 has no Discover). */
export interface CatalogDiscoverPort {
  discover(request: CatalogDiscoverRequest, options?: { readonly signal?: AbortSignal; readonly correlationId?: string }): Promise<CatalogDiscoverAnswer>;
}
