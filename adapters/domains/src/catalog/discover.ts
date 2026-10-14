import { DomainError, type CallOptions, type DomainErrorCategory } from '../shared/errors.js';
import type { CatalogSellability } from './port.js';

/**
 * Catalog Discover port (R4-DISCOVER-I1). `catalog.discover` is a READ
 * capability OWNED by catalog-service (CAT-DISCOVER V1-A/B2/B1): it interprets
 * a conceptual product need, retrieves, verifies constraints and hydrates the
 * owner's commercial truth. R4 never re-implements any of it: no parsing of
 * the need, no ranking, no constraint verification, no price or stock
 * computation. This port TRANSPORTS the owner's answer.
 *
 * Shape = the owner's agent contract (catalog-service
 * `src/application/catalog/discover-v1a/agentContract.ts`, tolerant reading,
 * schemaVersion 1) minus `schemaVersion`. Owner field names are verbatim.
 * There is no generated client for this contract (the owner publishes Zod +
 * JSON Schema, R4 pins fixtures): these types are a hand-written mirror whose
 * wire schema (`@r4-adapters/catalog-http` discover-schemas) is checked
 * against them at compile time and against the owner's fixtures in tests.
 *
 * Contract revisions. schemaVersion 1 is necessary but NOT sufficient: R4
 * consumes only the revisions whose compatibility it verified, and refuses any
 * other label (a later revision is not used automatically; it is verified and
 * added here first):
 *   catalog-discover-v1b2  base agent contract (owner aac3f8a)
 *   catalog-discover-v1b1  additive over v1b2 (owner 6dd4b5d): candidate.requirements,
 *                          completeness.counts.rejectedByCommercialConstraints,
 *                          commercialFreshness.observations (+ open-vocabulary values).
 *                          Verified by the executable-contract diff, the owner's
 *                          fixtures re-exported at 6dd4b5d, and the v1b2 reduction of
 *                          all 24 scenarios (never more permissive than v1b1).
 * The three v1b1 fields are OPTIONAL here, and a missing `requirements` is never
 * read as "satisfied" (see the Sales capability). catalog-discover-v1a is history:
 * R4 never verified it and refuses it.
 */

export const CATALOG_DISCOVER_CAPABILITY = 'catalog.discover';
export const CATALOG_DISCOVER_SCHEMA_VERSION = 1;
/** The ONLY revisions R4 consumes. An answer labelled otherwise is a CONTRACT_VIOLATION (unverified_contract_revision). */
export const CATALOG_DISCOVER_VERIFIED_REVISIONS = ['catalog-discover-v1b2', 'catalog-discover-v1b1'] as const;
export type CatalogDiscoverRevision = (typeof CATALOG_DISCOVER_VERIFIED_REVISIONS)[number];

export function isVerifiedDiscoverRevision(label: unknown): label is CatalogDiscoverRevision {
  return typeof label === 'string' && (CATALOG_DISCOVER_VERIFIED_REVISIONS as readonly string[]).includes(label);
}
export const CATALOG_DISCOVER_MAX_LIMIT = 8;
export const CATALOG_DISCOVER_MAX_KEYS = 8;
export const CATALOG_DISCOVER_MAX_NEED_CHARS = 300;

// ---- request (strict on the owner side: an unknown field is an error) -----

/** Structured constraints the owner supports; the unit is in the field name. Anything else is rejected by the owner. */
export interface CatalogDiscoverConstraints {
  /** Unit price <= X CLP, tax included. The owner never lets a reference (not orderable) price satisfy it. */
  readonly maxUnitPriceClp?: number;
  readonly sellableOnly?: boolean;
  readonly minUserCapacityKg?: number;
  readonly minLoadKg?: number;
  readonly maxLengthCm?: number;
  readonly maxWidthCm?: number;
  readonly maxHeightCm?: number;
}

export interface CatalogDiscoverRequest {
  /** The consolidated product need (never the conversation, never customer data); 1..300 chars after trimming. */
  readonly need: string;
  /** Verified candidates to return, 1..8. */
  readonly limit?: number;
  readonly constraints?: CatalogDiscoverConstraints;
  /** productKeys the caller already holds (exact lookups). */
  readonly productKeys?: readonly string[];
  /** Sellable units the customer already selected (owner itemKeys). */
  readonly selectedItemKeys?: readonly string[];
}

// ---- answer -----------------------------------------------------------------

export type CatalogDiscoverStatus = 'COMPLETE' | 'PARTIAL' | 'DEGRADED';
export type CatalogDiscoverDisposition = 'VERIFIED_MATCH' | 'POSSIBLE_MATCH' | 'REJECTED';
export type CatalogDiscoverRequirementState = 'SATISFIED' | 'UNKNOWN' | 'UNSUPPORTED' | 'VIOLATED' | 'NOT_EVALUATED';

export interface CatalogDiscoverUnit {
  readonly itemKey: string;
  readonly finalGrossClp: number | null;
  readonly sellability: CatalogSellability;
  readonly reason: string;
  readonly availableQuantity: number | null;
  readonly orderable: boolean;
  readonly validUntil: string | null;
}

export type CatalogDiscoverCommercial =
  | {
      readonly status: 'OBSERVED';
      readonly authority: string;
      readonly asOf: string;
      readonly validUntil: string | null;
      /** PRODUCT level: `from` = minimum over orderable variants; `not_offerable` = a reference price, never an offer. */
      readonly price: { readonly finalGrossClp: number | null; readonly kind: 'exact' | 'from' | null; readonly basis: 'offerable' | 'not_offerable' | null };
      readonly sellability: CatalogSellability;
      readonly orderable: boolean;
      /** The determined unit (candidate.itemKey): its own price, stock and sellability. Not a quote. */
      readonly unit?: CatalogDiscoverUnit | undefined;
    }
  | { readonly status: 'EXPIRED'; readonly authority: string; readonly asOf: string; readonly validUntil: string }
  /** `reason` is an OPEN vocabulary: unknown codes are kept opaque. */
  | { readonly status: 'UNKNOWN'; readonly reason: string };

export interface CatalogDiscoverRequirement {
  readonly code: string;
  readonly state: CatalogDiscoverRequirementState;
  readonly authority: string | null;
  readonly derived: boolean;
}

export interface CatalogDiscoverCandidate {
  readonly productKey: string;
  /** Present only when the owner determined the unit (selected, only unit, or the unit that certified a purchase constraint). */
  readonly itemKey?: string | undefined;
  readonly name: string;
  readonly disposition: CatalogDiscoverDisposition;
  readonly matchedBy: readonly string[];
  readonly satisfied: readonly string[];
  readonly unresolved: readonly string[];
  readonly readings: readonly string[];
  /** v1b1+. Absent from a v1b2 producer. */
  readonly requirements?: readonly CatalogDiscoverRequirement[] | undefined;
  readonly commercial: CatalogDiscoverCommercial;
}

export interface CatalogDiscoverAmbiguity {
  readonly text: string;
  readonly readings: readonly string[];
  readonly groupId: string;
  readonly readingRequirements: readonly { readonly readingId: string; readonly required: readonly string[] }[];
}

export interface CatalogDiscoverInterpretation {
  readonly need: string;
  readonly required: readonly string[];
  readonly preferred: readonly string[];
  readonly notVerifiable: readonly string[];
  readonly ambiguities: readonly CatalogDiscoverAmbiguity[];
  readonly unrecognized: readonly string[];
  readonly structured: { readonly applied: readonly string[]; readonly duplicatesOfText: readonly string[] };
  readonly hints: { readonly productKeys: readonly string[]; readonly notFound: readonly string[] };
  readonly selection: { readonly itemKeys: readonly string[]; readonly notFound: readonly string[]; readonly unverified: readonly string[] };
}

export interface CatalogDiscoverCompleteness {
  readonly retrieval: 'COMPLETE' | 'TRUNCATED';
  readonly commercial: 'NOT_REQUIRED' | 'COMPLETE' | 'SUFFICIENT' | 'INCOMPLETE' | 'UNAVAILABLE';
  readonly exhaustive: boolean;
  readonly moreVerifiedAvailable: boolean;
  readonly counts: {
    readonly retrieved: number;
    readonly technicallyExamined: number;
    readonly commerciallyHydrated: number;
    readonly pendingHydration: number;
    readonly rejectedByKnownConstraints: number;
    /** v1b1+. */
    readonly rejectedByCommercialConstraints?: number | undefined;
    readonly withUnresolvedConstraints: number;
    readonly verified: number;
    readonly presented: number;
  };
}

export type CatalogDiscoverAbsenceReason =
  | 'NO_RELEVANT_CANDIDATES'
  | 'NO_VERIFIED_CANDIDATES'
  | 'AMBIGUOUS_NEED'
  | 'CONSTRAINTS_UNSUPPORTED'
  | 'COMMERCIAL_TRUTH_UNAVAILABLE'
  | 'COMMERCIAL_EVALUATION_INCOMPLETE'
  | 'RETRIEVAL_TRUNCATED'
  | 'SOURCE_UNAVAILABLE';

export interface CatalogDiscoverAnswer {
  /** The owner's revision; always one of CATALOG_DISCOVER_VERIFIED_REVISIONS (the adapter refuses the rest). */
  readonly contractVersion: CatalogDiscoverRevision;
  readonly requestId: string;
  readonly status: CatalogDiscoverStatus;
  readonly interpretation: CatalogDiscoverInterpretation;
  readonly exactMatch: CatalogDiscoverCandidate | null;
  readonly verified: readonly CatalogDiscoverCandidate[];
  readonly possible: readonly CatalogDiscoverCandidate[];
  readonly completeness: CatalogDiscoverCompleteness;
  readonly absence: { readonly reason: CatalogDiscoverAbsenceReason; readonly contributing: readonly string[]; readonly engineReason: string | null } | null;
  /** component / cause are OPEN vocabularies. */
  readonly degradation: readonly { readonly component: string; readonly cause: string; readonly retryable: boolean }[];
  readonly commercialFreshness: {
    readonly status: 'OBSERVED' | 'PARTIAL' | 'UNAVAILABLE' | 'NOT_CONFIGURED' | 'NOT_REQUESTED';
    readonly authority: string | null;
    readonly integrationVersion: string | null;
    readonly oldestAsOf: string | null;
    readonly newestAsOf: string | null;
    readonly earliestValidUntil: string | null;
    readonly maxCacheAgeMs: number | null;
    readonly reads: number;
    /** v1b1+. */
    readonly observations?: { readonly observed: number; readonly notFound: number; readonly unavailable: number } | undefined;
    readonly coherence: 'PER_PRODUCT_READ';
  } | null;
  readonly lineage: { readonly contractVersion: string; readonly bundleId: string; readonly indexFingerprint: string; readonly retrievalVersion: string } | null;
  readonly warnings: readonly string[];
}

/** Read-only by construction: the port has no operation that changes anything. */
export interface CatalogDiscoverPort {
  /** What the binding is (fixture replay, http), for composition checks. */
  readonly bindingKind: 'fixture' | 'http';
  discover(request: CatalogDiscoverRequest, options?: CallOptions): Promise<CatalogDiscoverAnswer>;
}

// ---- typed failures ------------------------------------------------------------

/**
 * Why a Discover call produced no answer. A 200 answer is never a failure, even
 * DEGRADED or PARTIAL: those are answers with reservations (see the capability).
 *
 *   INVALID_REQUEST     the owner refused the request (400/413/415; issues name what to fix). Never "no products".
 *   AUTH_FAILED         401 (unknown key) / 403 (key not in the owner's Discover allowlist). Fail closed.
 *   DISABLED            the owner has the capability switched off (503 capability_disabled). Do not retry.
 *   NOT_READY           not configured / index not built / incompatible / shutting down (503). Owner states retryability.
 *   SATURATED           the owner's admission is full (503 capability_saturated, Retry-After). Never retried automatically.
 *   RATE_LIMITED        429.
 *   TIMEOUT             R4's deadline passed before an answer.
 *   UNREACHABLE         the owner could not be reached.
 *   SERVICE_ERROR       a terminal owner failure (500, other 5xx).
 *   CONTRACT_VIOLATION  the owner answered outside its contract (also: a FAILED body sent as 200, or a
 *                       contract revision R4 has not verified).
 */
export const CATALOG_DISCOVER_FAILURES = ['INVALID_REQUEST', 'AUTH_FAILED', 'DISABLED', 'NOT_READY', 'SATURATED', 'RATE_LIMITED', 'TIMEOUT', 'UNREACHABLE', 'SERVICE_ERROR', 'CONTRACT_VIOLATION'] as const;
export type CatalogDiscoverFailure = (typeof CATALOG_DISCOVER_FAILURES)[number];

const CATEGORY_OF: Record<CatalogDiscoverFailure, DomainErrorCategory> = {
  INVALID_REQUEST: 'validation',
  AUTH_FAILED: 'unauthorized',
  DISABLED: 'temporarily_unavailable',
  NOT_READY: 'temporarily_unavailable',
  SATURATED: 'temporarily_unavailable',
  RATE_LIMITED: 'temporarily_unavailable',
  TIMEOUT: 'timeout',
  UNREACHABLE: 'temporarily_unavailable',
  SERVICE_ERROR: 'temporarily_unavailable',
  CONTRACT_VIOLATION: 'contract_violation',
};

export class CatalogDiscoverError extends DomainError {
  readonly failure: CatalogDiscoverFailure;

  constructor(failure: CatalogDiscoverFailure, code: string, message: string, options: { readonly retryable: boolean; readonly httpStatus?: number | null; readonly retryAfterSeconds?: number | null; readonly issues?: string | null }) {
    super(CATEGORY_OF[failure], code, message, {
      discoverFailure: failure,
      httpStatus: options.httpStatus ?? null,
      ...(options.retryAfterSeconds !== undefined && options.retryAfterSeconds !== null ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
      ...(options.issues ? { issues: options.issues } : {}),
    }, { retryable: options.retryable });
    this.name = 'CatalogDiscoverError';
    this.failure = failure;
  }
}
