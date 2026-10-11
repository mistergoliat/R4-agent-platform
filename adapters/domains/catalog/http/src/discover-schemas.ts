import { z } from 'zod';
import { CATALOG_DISCOVER_MAX_KEYS, CATALOG_DISCOVER_MAX_LIMIT, CATALOG_DISCOVER_SCHEMA_VERSION, CATALOG_SELLABILITY, type CatalogDiscoverAnswer } from '@r4-adapters/domains';
import { catalogKeySchema } from './schemas.js';

/**
 * Wire schema of catalog.discover answers (POST /v2/catalog/discover, HTTP 200),
 * the CONSUMER reading of the owner's agent contract (catalog-service
 * `discover-v1a/agentContract.ts`, `discoverAgentResponseTolerantSchema`):
 *
 * - `schemaVersion` must be 1 (checked before parsing, like the v2 reads).
 * - Objects are NOT strict: unknown fields are dropped (additive evolution).
 * - OPEN vocabularies (warnings, degradation component/cause, UNKNOWN reasons,
 *   absence.contributing) accept any well-formed code; R4 treats an unknown
 *   code as opaque and conservative.
 * - CLOSED enums (status, disposition, commercial status, price kind/basis,
 *   sellability, completeness, absence.reason, freshness status) fail on an
 *   unknown value: that would be a breaking change (new schemaVersion).
 * - The v1b1 additions (candidate.requirements, counts.rejectedByCommercialConstraints,
 *   commercialFreshness.observations) are optional so a v1b2 producer parses.
 * - A 200 answer is never FAILED: the owner sends terminal failures as 4xx/5xx.
 * - Invariants R4 relies on are checked, never repaired (see `checkAnswer`).
 *
 * Nothing here computes a price, a stock figure or a verdict.
 */

const openCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const isoDate = z.iso.datetime({ offset: true });
const code = z.string().min(1).max(160);
const codes = z.array(code).max(64);
const count = z.int().nonnegative();
const sellability = z.enum(CATALOG_SELLABILITY);

const unit = z.object({
  itemKey: catalogKeySchema,
  finalGrossClp: z.int().nonnegative().nullable(),
  sellability,
  reason: z.string().min(1).max(64),
  availableQuantity: z.int().nullable(),
  orderable: z.boolean(),
  validUntil: isoDate.nullable(),
});

const commercial = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('OBSERVED'),
    authority: z.string().min(1),
    asOf: isoDate,
    validUntil: isoDate.nullable(),
    price: z.object({ finalGrossClp: z.int().nonnegative().nullable(), kind: z.enum(['exact', 'from']).nullable(), basis: z.enum(['offerable', 'not_offerable']).nullable() }),
    sellability,
    orderable: z.boolean(),
    unit: unit.optional(),
  }),
  z.object({ status: z.literal('EXPIRED'), authority: z.string().min(1), asOf: isoDate, validUntil: isoDate }),
  z.object({ status: z.literal('UNKNOWN'), reason: openCode }),
]);

const candidate = z.object({
  productKey: catalogKeySchema,
  itemKey: catalogKeySchema.optional(),
  name: z.string().min(1).max(128),
  disposition: z.enum(['VERIFIED_MATCH', 'POSSIBLE_MATCH', 'REJECTED']),
  matchedBy: codes,
  satisfied: codes,
  unresolved: codes,
  readings: codes,
  requirements: z.array(z.object({ code, state: z.enum(['SATISFIED', 'UNKNOWN', 'UNSUPPORTED', 'VIOLATED', 'NOT_EVALUATED']), authority: z.string().min(1).max(32).nullable(), derived: z.boolean() })).max(64).optional(),
  commercial,
});

const keys = z.array(catalogKeySchema).max(CATALOG_DISCOVER_MAX_KEYS);

export const catalogDiscoverAnswerSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_DISCOVER_SCHEMA_VERSION),
    contractVersion: z.string().min(1).max(64),
    requestId: z.string().min(1).max(128),
    status: z.enum(['COMPLETE', 'PARTIAL', 'DEGRADED']),
    interpretation: z.object({
      need: z.string().max(121),
      required: codes,
      preferred: codes,
      notVerifiable: codes,
      ambiguities: z.array(z.object({ text: z.string().max(160), readings: codes, groupId: z.string().min(1).max(32), readingRequirements: z.array(z.object({ readingId: z.string().min(1).max(16), required: codes })).max(16) })).max(8),
      unrecognized: z.array(z.string().max(64)).max(64),
      structured: z.object({ applied: codes, duplicatesOfText: codes }),
      hints: z.object({ productKeys: keys, notFound: keys }),
      selection: z.object({ itemKeys: keys, notFound: keys, unverified: keys }),
    }),
    exactMatch: candidate.nullable(),
    verified: z.array(candidate).max(CATALOG_DISCOVER_MAX_LIMIT),
    possible: z.array(candidate).max(3),
    completeness: z.object({
      retrieval: z.enum(['COMPLETE', 'TRUNCATED']),
      commercial: z.enum(['NOT_REQUIRED', 'COMPLETE', 'SUFFICIENT', 'INCOMPLETE', 'UNAVAILABLE']),
      exhaustive: z.boolean(),
      moreVerifiedAvailable: z.boolean(),
      counts: z.object({
        retrieved: count, technicallyExamined: count, commerciallyHydrated: count, pendingHydration: count, rejectedByKnownConstraints: count,
        rejectedByCommercialConstraints: count.optional(), withUnresolvedConstraints: count, verified: count, presented: count,
      }),
    }),
    absence: z
      .object({
        reason: z.enum(['NO_RELEVANT_CANDIDATES', 'NO_VERIFIED_CANDIDATES', 'AMBIGUOUS_NEED', 'CONSTRAINTS_UNSUPPORTED', 'COMMERCIAL_TRUTH_UNAVAILABLE', 'COMMERCIAL_EVALUATION_INCOMPLETE', 'RETRIEVAL_TRUNCATED', 'SOURCE_UNAVAILABLE']),
        contributing: z.array(openCode).max(8),
        engineReason: z.string().max(64).nullable(),
      })
      .nullable(),
    degradation: z.array(z.object({ component: openCode, cause: openCode, retryable: z.boolean() })).max(8),
    commercialFreshness: z
      .object({
        status: z.enum(['OBSERVED', 'PARTIAL', 'UNAVAILABLE', 'NOT_CONFIGURED', 'NOT_REQUESTED']),
        authority: z.string().min(1).nullable(),
        integrationVersion: z.string().min(1).nullable(),
        oldestAsOf: isoDate.nullable(),
        newestAsOf: isoDate.nullable(),
        earliestValidUntil: isoDate.nullable(),
        maxCacheAgeMs: count.nullable(),
        reads: count,
        observations: z.object({ observed: count, notFound: count, unavailable: count }).optional(),
        coherence: z.literal('PER_PRODUCT_READ'),
      })
      .nullable(),
    lineage: z.object({ contractVersion: z.string().min(1), bundleId: z.string().min(1), indexFingerprint: z.string().min(1), retrievalVersion: z.string().min(1) }).nullable(),
    warnings: z.array(openCode).max(32),
  })
  .superRefine(checkAnswer);

type Wire = z.output<typeof catalogDiscoverAnswerSchema>;

/**
 * Contract invariants R4's reading depends on. A violation is a contract
 * violation (the answer is refused), never repaired:
 *   - `verified` holds only VERIFIED_MATCH, `possible` only POSSIBLE_MATCH; REJECTED never reaches the agent.
 *   - a determined unit's commercial facts belong to that same unit (price and stock of ONE itemKey).
 *   - a selected itemKey the owner proved absent is never echoed as a candidate unit.
 *   - `requirements`, when present, has one entry per `interpretation.required`, same order.
 *   - `exhaustive` is true only when nothing was cut or degraded.
 */
function checkAnswer(a: Pick<Wire, 'interpretation' | 'exactMatch' | 'verified' | 'possible' | 'completeness' | 'degradation'>, ctx: z.RefinementCtx): void {
  a.verified.forEach((c, i) => {
    if (c.disposition !== 'VERIFIED_MATCH') ctx.addIssue({ code: 'custom', path: ['verified', i, 'disposition'], message: 'verified holds only VERIFIED_MATCH' });
  });
  a.possible.forEach((c, i) => {
    if (c.disposition !== 'POSSIBLE_MATCH') ctx.addIssue({ code: 'custom', path: ['possible', i, 'disposition'], message: 'possible holds only POSSIBLE_MATCH' });
  });
  if (a.exactMatch?.disposition === 'REJECTED') ctx.addIssue({ code: 'custom', path: ['exactMatch', 'disposition'], message: 'a REJECTED candidate never reaches the agent' });
  const all: [string, number | null, Wire['verified'][number]][] = [
    ...(a.exactMatch ? [['exactMatch', null, a.exactMatch] as [string, null, Wire['verified'][number]]] : []),
    ...a.verified.map((c, i) => ['verified', i, c] as [string, number, Wire['verified'][number]]),
    ...a.possible.map((c, i) => ['possible', i, c] as [string, number, Wire['verified'][number]]),
  ];
  for (const [list, i, c] of all) {
    const path = i === null ? [list] : [list, i];
    if (c.commercial.status === 'OBSERVED' && c.commercial.unit && c.commercial.unit.itemKey !== c.itemKey) ctx.addIssue({ code: 'custom', path: [...path, 'commercial', 'unit', 'itemKey'], message: 'the unit facts belong to a different itemKey than the candidate' });
    if (c.itemKey && a.interpretation.selection.notFound.includes(c.itemKey)) ctx.addIssue({ code: 'custom', path: [...path, 'itemKey'], message: 'an itemKey the owner proved absent is echoed as a candidate unit' });
    if (c.requirements && c.requirements.map((r) => r.code).join('\n') !== a.interpretation.required.join('\n')) ctx.addIssue({ code: 'custom', path: [...path, 'requirements'], message: 'requirements must follow interpretation.required, one entry each' });
  }
  const cut = a.completeness.retrieval !== 'COMPLETE' || ['SUFFICIENT', 'INCOMPLETE', 'UNAVAILABLE'].includes(a.completeness.commercial) || a.degradation.length > 0;
  if (a.completeness.exhaustive && cut) ctx.addIssue({ code: 'custom', path: ['completeness', 'exhaustive'], message: 'exhaustive although retrieval or commercial evaluation was cut, or a component degraded' });
}

/** The owner's request body (strict on the owner side). R4 never sends a field the owner does not define. */
export interface CatalogDiscoverWireRequest {
  readonly schemaVersion: typeof CATALOG_DISCOVER_SCHEMA_VERSION;
  readonly need: string;
  readonly limit?: number;
  readonly constraints?: Record<string, number | boolean>;
  readonly hints?: { readonly productKeys: readonly string[] };
  readonly selectedItemKeys?: readonly string[];
  readonly context?: { readonly correlationId: string };
}

// Compile-time agreement: every parsed answer (minus schemaVersion) is a port answer.
const _agrees = (wire: Wire): CatalogDiscoverAnswer => {
  const { schemaVersion: _, ...answer } = wire;
  return answer;
};
void _agrees;
