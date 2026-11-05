import { z } from 'zod';
import type { CatalogDiscoverAnswer, CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { LANE_CAPABILITY_IDS, SCOPES } from '../ids.js';
import { CATALOG_FRESHNESS_TTL_MS, CATALOG_TEXT_NOTICE } from './catalog.js';
import { domainRead, readDefinition } from './common.js';

/**
 * (ADR-045) `catalog.discover` — Catalog V2 Discover as a READ capability, offered only by the lane profile
 * (sales-production@13). Need → candidates is Catalog's: R4 forwards the consolidated need and the customer's
 * explicit constraints, and projects the owner's answer field by field. It never ranks, filters, reorders or
 * completes candidates, never infers a requirement, and is never a price or stock authority for a purchase.
 */
export const catalogDiscoverInput = z.strictObject({
  need: z.string().trim().min(2).max(300),
  limit: z.int().min(1).max(8).default(5),
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
  selectedItemKeys: z.array(z.string().regex(/^P\d+(?:-V\d+)?$/u)).max(8).optional(),
});

const candidateView = z.strictObject({
  productKey: z.string(),
  itemKey: z.string().nullable(),
  name: z.string(),
  disposition: z.string(),
  satisfied: z.array(z.string()),
  unresolved: z.array(z.string()),
  commercial: z.strictObject({
    status: z.string(),
    finalGrossClp: z.int().nullable(),
    priceKind: z.string().nullable(),
    priceBasis: z.string().nullable(),
    sellability: z.string().nullable(),
    orderable: z.boolean().nullable(),
    validUntil: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});

export const catalogDiscoverOutput = z.strictObject({
  need: z.string(),
  notice: z.literal(CATALOG_TEXT_NOTICE),
  requestId: z.string(),
  status: z.string(),
  interpretation: z
    .strictObject({
      required: z.array(z.string()),
      preferred: z.array(z.string()),
      notVerifiable: z.array(z.string()),
      ambiguities: z.array(z.strictObject({ text: z.string(), groupId: z.string(), readings: z.array(z.string()) })),
      unrecognized: z.array(z.string()),
    })
    .nullable(),
  exactMatch: candidateView.nullable(),
  verified: z.array(candidateView),
  possible: z.array(candidateView),
  completeness: z.strictObject({ retrieval: z.string(), commercial: z.string(), exhaustive: z.boolean(), moreVerifiedAvailable: z.boolean() }).nullable(),
  absence: z.strictObject({ reason: z.string(), contributing: z.array(z.string()) }).nullable(),
  degradation: z.array(z.strictObject({ component: z.string(), cause: z.string(), retryable: z.boolean() })),
  commercialFreshness: z.strictObject({ status: z.string(), oldestAsOf: z.string().nullable(), earliestValidUntil: z.string().nullable() }).nullable(),
  warnings: z.array(z.string()),
});
export type CatalogDiscoverView = z.infer<typeof catalogDiscoverOutput>;

type Candidate = NonNullable<CatalogDiscoverAnswer['exactMatch']>;

function candidateOf(c: Candidate): z.infer<typeof candidateView> {
  const m = c.commercial;
  const observed = m.status === 'OBSERVED' ? m : null;
  return {
    productKey: c.productKey,
    itemKey: c.itemKey ?? null,
    name: c.name,
    disposition: c.disposition,
    satisfied: [...c.satisfied],
    unresolved: [...c.unresolved],
    commercial: {
      status: m.status,
      finalGrossClp: observed ? (observed.unit?.finalGrossClp ?? observed.price.finalGrossClp) : null,
      priceKind: observed?.price.kind ?? null,
      priceBasis: observed?.price.basis ?? null,
      sellability: observed ? (observed.unit?.sellability ?? observed.sellability) : null,
      orderable: observed ? (observed.unit?.orderable ?? observed.orderable) : null,
      validUntil: m.status === 'UNKNOWN' ? null : m.validUntil,
      reason: m.status === 'UNKNOWN' ? m.reason : null,
    },
  };
}

/** Pure projection of the owner's answer: selection of fields, in the owner's order, nothing computed. */
export function catalogDiscoverView(answer: CatalogDiscoverAnswer, need: string): CatalogDiscoverView {
  const i = answer.interpretation;
  return {
    need,
    notice: CATALOG_TEXT_NOTICE,
    requestId: answer.requestId,
    status: answer.status,
    interpretation: i
      ? { required: [...i.required], preferred: [...i.preferred], notVerifiable: [...i.notVerifiable], ambiguities: i.ambiguities.map((a) => ({ text: a.text, groupId: a.groupId, readings: [...a.readings] })), unrecognized: [...i.unrecognized] }
      : null,
    exactMatch: answer.exactMatch ? candidateOf(answer.exactMatch) : null,
    verified: answer.verified.map(candidateOf),
    possible: answer.possible.map(candidateOf),
    completeness: answer.completeness ? { retrieval: answer.completeness.retrieval, commercial: answer.completeness.commercial, exhaustive: answer.completeness.exhaustive, moreVerifiedAvailable: answer.completeness.moreVerifiedAvailable } : null,
    absence: answer.absence ? { reason: answer.absence.reason, contributing: [...answer.absence.contributing] } : null,
    degradation: answer.degradation.map((d) => ({ component: d.component, cause: d.cause, retryable: d.retryable })),
    commercialFreshness: answer.commercialFreshness ? { status: answer.commercialFreshness.status, oldestAsOf: answer.commercialFreshness.oldestAsOf, earliestValidUntil: answer.commercialFreshness.earliestValidUntil } : null,
    warnings: [...answer.warnings],
  };
}

export function catalogDiscoverCapability(discover: CatalogDiscoverPort): CapabilityRegistration<z.infer<typeof catalogDiscoverInput>, CatalogDiscoverView> {
  return {
    definition: readDefinition({
      capabilityId: LANE_CAPABILITY_IDS.catalogDiscover,
      description:
        'Finds catalog products for a NEED (owner: Catalog Discover), e.g. "barra para sentadilla en casa": pass the need consolidated in the customer\'s words (never personal data or the conversation) and only constraints the customer stated (max unit price CLP tax included, sellable only, capacity/load kg, max size cm). Returns, in the owner\'s order: exactMatch, verified (meets every verifiable requirement), possible (some requirement unresolved: say so), ambiguities to ask about, absence and completeness. Not exhaustive unless completeness.exhaustive; an empty answer is not proof nothing exists. Prices here are discovery evidence only: before stating price or availability as an offer, read catalog.get_product_context. Never call a product "the best"; Discover does not know the customer.',
      owner: 'catalog',
      requiredScopes: [SCOPES.catalogRead],
      freshnessTtlMs: CATALOG_FRESHNESS_TTL_MS,
    }),
    input: catalogDiscoverInput,
    output: catalogDiscoverOutput,
    ownerValidUntil: (output) => output.commercialFreshness?.earliestValidUntil ?? null,
    handler: (input, context) =>
      domainRead(async () => {
        const answer = await discover.discover(
          { schemaVersion: 1, need: input.need, limit: input.limit, ...(input.constraints ? { constraints: input.constraints } : {}), ...(input.selectedItemKeys?.length ? { selectedItemKeys: input.selectedItemKeys } : {}) },
          { signal: context.signal, correlationId: context.execution.correlationId },
        );
        return catalogDiscoverView(answer, input.need);
      }),
  };
}
