import type { CatalogDiscoverAnswer, CatalogDiscoverCandidate, CatalogDiscoverRequirementState } from '@r4-adapters/domains';

/**
 * R4's CONSUMPTION POLICY for catalog.discover answers (R4-DISCOVER-I1 §4).
 *
 * Catalog owns the facts (disposition, constraint verdicts, commercial truth,
 * completeness); what those facts PERMIT a sales agent to assert is a consumer
 * decision, so it lives here (the owner's B2 report keeps it out of the
 * response on purpose). It reads states only: it never parses the need, never
 * re-verifies a constraint, never computes or compares a price against a
 * budget, and never picks a variant. Every rule is conservative: anything not
 * positively established by the owner is not claimable.
 */

/** What R4 may or may not assert about one candidate, or about the answer. */
export type DiscoverClaim =
  | `MEETS:${string}`
  | 'PRICE_CURRENT'
  | 'PRICE_FROM'
  | 'PRICE_REFERENCE_ONLY'
  | 'ORDERABLE_NOW'
  | 'IN_STOCK'
  | 'BACKORDER'
  | 'WITHIN_BUDGET'
  | 'VARIANT_FIXED'
  | 'PURCHASE_CONFIRMED'
  | 'BEST_FOR_CUSTOMER'
  | 'BEST_IN_CATALOG'
  | 'COMPLETE_LIST'
  | 'NONE_EXIST';

export const ALWAYS_FORBIDDEN: readonly DiscoverClaim[] = ['PURCHASE_CONFIRMED', 'BEST_FOR_CUSTOMER', 'BEST_IN_CATALOG'];
const COMMERCIAL_CLAIMS: readonly DiscoverClaim[] = ['PRICE_CURRENT', 'PRICE_FROM', 'PRICE_REFERENCE_ONLY', 'ORDERABLE_NOW', 'IN_STOCK', 'BACKORDER', 'WITHIN_BUDGET', 'VARIANT_FIXED'];

/** How the candidate's unit was determined (derived from selection and price kind; the contract has no such field). */
export type DiscoverUnitBasis = 'SELECTED' | 'ONLY_UNIT' | 'WITNESS' | 'UNDETERMINED';
export type DiscoverPresentation = 'PURCHASABLE' | 'WITH_COMMERCIAL_CAVEAT' | 'POSSIBILITY_WITH_CAVEATS';
export type DiscoverNextAction = 'SELECT_ITEM' | 'FRESH_COMMERCIAL_LOOKUP' | 'CONFIRM_ITEM' | 'INSPECT_PRODUCT';

export interface DiscoverRequirementView {
  readonly code: string;
  readonly state: CatalogDiscoverRequirementState;
  readonly authority: string | null;
}

export interface DiscoverCandidateReading {
  readonly presentation: DiscoverPresentation;
  readonly unitBasis: DiscoverUnitBasis;
  /** CURRENT only when the owner observed it and its window has not passed at R4's clock. */
  readonly commercial: 'CURRENT' | 'EXPIRED' | 'UNKNOWN';
  /** OWNER: the owner's per-requirement verdicts (v1b1). DERIVED_FROM_DISPOSITION: a v1b2 answer (VERIFIED_MATCH = every required SATISFIED; anything else = not evaluated). */
  readonly requirementsSource: 'OWNER' | 'DERIVED_FROM_DISPOSITION';
  readonly requirements: readonly DiscoverRequirementView[];
  readonly allowedClaims: readonly DiscoverClaim[];
  readonly forbiddenClaims: readonly DiscoverClaim[];
  readonly next: readonly { readonly action: DiscoverNextAction; readonly capability: string; readonly key: string }[];
}

export type DiscoverAskReason = 'AMBIGUOUS_NEED' | 'VARIANT_CHOICE' | 'SELECTED_VARIANT_NOT_FOUND' | 'UNSUPPORTED_REQUIREMENT' | 'UNRECOGNIZED_TERMS';
export type DiscoverAnswerLabel =
  | 'MAY_PRESENT_AS_PURCHASABLE'
  | 'MAY_PRESENT_WITH_COMMERCIAL_CAVEAT'
  | 'MAY_PRESENT_POSSIBILITIES_WITH_CAVEATS'
  | 'CLARIFICATION_RECOMMENDED'
  | 'CANNOT_ASSERT_NO_PRODUCTS_EXIST'
  | 'REQUIRE_FRESH_COMMERCIAL_LOOKUP'
  | 'REQUIRE_ITEM_SELECTION'
  | 'COMMERCIAL_TRUTH_DEGRADED'
  | 'RETRY_LATER';

export interface DiscoverAnswerReading {
  readonly labels: readonly DiscoverAnswerLabel[];
  readonly canAssertCompleteList: boolean;
  readonly canAssertNoneExist: boolean;
  readonly answerAllowed: readonly DiscoverClaim[];
  readonly answerForbidden: readonly DiscoverClaim[];
  readonly askCustomer: { readonly needed: boolean; readonly reasons: readonly DiscoverAskReason[] };
  readonly retryable: boolean;
}

const CAPABILITY = { productContext: 'catalog.get_product_context', itemContext: 'catalog.get_item_context (internal confirmation)' } as const;

/** A requirement code without its authority / state suffix ("price<=300000CLP@COMMERCIAL_TRUTH" → "price<=300000CLP"). */
export function requirementOf(code: string): string {
  return code.split(/:(UNKNOWN|UNSUPPORTED|VIOLATED|OFF_TARGET|DERIVED)(:|$)/u)[0]!.replace(/@[A-Z0-9_]+$/u, '');
}

function requirementsOf(candidate: CatalogDiscoverCandidate, required: readonly string[]): { source: DiscoverCandidateReading['requirementsSource']; list: DiscoverRequirementView[] } {
  if (candidate.requirements) return { source: 'OWNER', list: candidate.requirements.map((r) => ({ code: r.code, state: r.state, authority: r.authority })) };
  // v1b2 producer: the disposition is the only verdict the contract states. VERIFIED_MATCH means every
  // required constraint was SATISFIED by an admitted authority; anything else is never read as satisfied.
  const unresolved = new Set(candidate.unresolved.map(requirementOf));
  return {
    source: 'DERIVED_FROM_DISPOSITION',
    list: required.map((code) => ({ code, state: candidate.disposition === 'VERIFIED_MATCH' ? 'SATISFIED' : unresolved.has(code) ? 'UNKNOWN' : 'NOT_EVALUATED', authority: null })),
  };
}

function unitBasisOf(candidate: CatalogDiscoverCandidate, answer: CatalogDiscoverAnswer): DiscoverUnitBasis {
  if (!candidate.itemKey) return 'UNDETERMINED';
  if (answer.interpretation.selection.itemKeys.includes(candidate.itemKey) && !answer.interpretation.selection.notFound.includes(candidate.itemKey)) return 'SELECTED';
  const kind = candidate.commercial.status === 'OBSERVED' ? candidate.commercial.price.kind : null;
  if (kind === 'exact') return 'ONLY_UNIT';
  // A unit the owner used to certify a purchase constraint (or a "from" witness): SOME unit fits; the customer did not choose it.
  return 'WITNESS';
}

export function readCandidate(candidate: CatalogDiscoverCandidate, answer: CatalogDiscoverAnswer, now: Date): DiscoverCandidateReading {
  const allowed = new Set<DiscoverClaim>();
  const next: { action: DiscoverNextAction; capability: string; key: string }[] = [];
  const verified = candidate.disposition === 'VERIFIED_MATCH';
  const unitBasis = unitBasisOf(candidate, answer);
  const state = candidate.commercial;
  const consumerExpired = state.status === 'OBSERVED' && ((state.validUntil !== null && Date.parse(state.validUntil) <= now.getTime()) || (state.unit?.validUntil != null && Date.parse(state.unit.validUntil) <= now.getTime()));
  const commercial: DiscoverCandidateReading['commercial'] = state.status === 'OBSERVED' && !consumerExpired ? 'CURRENT' : state.status === 'UNKNOWN' ? 'UNKNOWN' : 'EXPIRED';
  const requirements = requirementsOf(candidate, answer.interpretation.required);

  // Only SATISFIED supports "it meets X": UNKNOWN, UNSUPPORTED, VIOLATED and NOT_EVALUATED never do.
  for (const r of requirements.list) if (r.state === 'SATISFIED') allowed.add(`MEETS:${r.code}`);

  let purchasable = false;
  if (state.status === 'OBSERVED' && commercial === 'CURRENT') {
    const { price, unit } = state;
    const unitDetermined = unitBasis === 'SELECTED' || unitBasis === 'ONLY_UNIT';
    const orderable = state.orderable && (unit ? unit.orderable : true);
    const offerable = price.basis === 'offerable';
    if (price.basis === 'not_offerable') allowed.add('PRICE_REFERENCE_ONLY');
    else if (offerable && unitDetermined && (unit?.finalGrossClp ?? (price.kind === 'exact' ? price.finalGrossClp : null)) !== null) allowed.add('PRICE_CURRENT');
    else if (offerable && price.kind === 'from' && price.finalGrossClp !== null) allowed.add('PRICE_FROM');
    if (orderable && offerable) allowed.add('ORDERABLE_NOW');
    const sellability = unit?.sellability ?? state.sellability;
    if (sellability === 'backorder' && orderable) allowed.add('BACKORDER');
    if (unit && unitDetermined && unit.sellability === 'sellable' && (unit.availableQuantity ?? 0) > 0) allowed.add('IN_STOCK');
    // The owner certified the budget (shared unitPriceBudget predicate: reference prices never satisfy it).
    const budgetCertified = requirements.source === 'OWNER'
      ? requirements.list.some((r) => r.code.startsWith('price<=') && r.state === 'SATISFIED' && r.authority === 'COMMERCIAL_TRUTH')
      : candidate.satisfied.some((c) => c.startsWith('price<=') && c.endsWith('@COMMERCIAL_TRUTH'));
    if (budgetCertified && offerable && orderable) allowed.add('WITHIN_BUDGET');
    if (unitBasis === 'SELECTED') allowed.add('VARIANT_FIXED');
    if (price.kind === 'from' && unitBasis !== 'SELECTED') next.push({ action: 'SELECT_ITEM', capability: CAPABILITY.productContext, key: candidate.productKey });
    purchasable = verified && orderable && offerable;
    // Only a determined unit can be confirmed (item context takes an itemKey); otherwise the unit is chosen first.
    if (purchasable && unitDetermined) next.push({ action: 'CONFIRM_ITEM', capability: CAPABILITY.itemContext, key: candidate.itemKey! });
    else if (purchasable && price.kind !== 'from') next.push({ action: 'SELECT_ITEM', capability: CAPABILITY.productContext, key: candidate.productKey });
  } else if (commercial === 'EXPIRED' || (state.status === 'UNKNOWN' && state.reason !== 'COMMERCIAL_TRUTH_NOT_CONFIGURED')) {
    next.push({ action: 'FRESH_COMMERCIAL_LOOKUP', capability: CAPABILITY.productContext, key: candidate.productKey });
  }
  if (!verified) next.push({ action: 'INSPECT_PRODUCT', capability: CAPABILITY.productContext, key: candidate.productKey });

  const forbidden = new Set<DiscoverClaim>([...ALWAYS_FORBIDDEN, ...COMMERCIAL_CLAIMS.filter((c) => !allowed.has(c))]);
  for (const r of requirements.list) if (r.state !== 'SATISFIED') forbidden.add(`MEETS:${r.code}`);
  for (const code of candidate.unresolved) forbidden.add(`MEETS:${requirementOf(code)}`);
  for (const code of [...answer.interpretation.preferred, ...answer.interpretation.notVerifiable]) if (!allowed.has(`MEETS:${requirementOf(code)}`)) forbidden.add(`MEETS:${requirementOf(code)}`);
  return {
    presentation: !verified ? 'POSSIBILITY_WITH_CAVEATS' : purchasable ? 'PURCHASABLE' : 'WITH_COMMERCIAL_CAVEAT',
    unitBasis,
    commercial,
    requirementsSource: requirements.source,
    requirements: requirements.list,
    allowedClaims: [...allowed].sort(),
    forbiddenClaims: [...forbidden].sort(),
    next,
  };
}

const NONE_EXIST_REASONS = new Set(['NO_RELEVANT_CANDIDATES', 'NO_VERIFIED_CANDIDATES']);

export function readAnswer(answer: CatalogDiscoverAnswer, candidates: readonly DiscoverCandidateReading[]): DiscoverAnswerReading {
  const labels = new Set<DiscoverAnswerLabel>();
  const { completeness, interpretation } = answer;
  const presented = (answer.exactMatch ? 1 : 0) + answer.verified.length + answer.possible.length;
  const verifiedCount = candidates.filter((c) => c.presentation !== 'POSSIBILITY_WITH_CAVEATS').length;
  // COMPLETE is about the execution; only `exhaustive` speaks about the catalog, and only for what was presented.
  const canAssertCompleteList = answer.status === 'COMPLETE' && completeness.exhaustive && !completeness.moreVerifiedAvailable
    && completeness.counts.verified + completeness.counts.withUnresolvedConstraints <= completeness.counts.presented;
  const canAssertNoneExist = answer.status === 'COMPLETE' && completeness.exhaustive && presented === 0 && answer.absence !== null && NONE_EXIST_REASONS.has(answer.absence.reason)
    && answer.absence.contributing.length === 0 && interpretation.unrecognized.length === 0 && interpretation.ambiguities.length === 0 && answer.degradation.length === 0;

  if (candidates.some((c) => c.presentation === 'PURCHASABLE')) labels.add('MAY_PRESENT_AS_PURCHASABLE');
  if (candidates.some((c) => c.presentation === 'WITH_COMMERCIAL_CAVEAT')) labels.add('MAY_PRESENT_WITH_COMMERCIAL_CAVEAT');
  if (verifiedCount === 0 && candidates.length > 0) labels.add('MAY_PRESENT_POSSIBILITIES_WITH_CAVEATS');
  if (interpretation.ambiguities.length > 0) labels.add('CLARIFICATION_RECOMMENDED');
  if (!canAssertNoneExist && verifiedCount === 0) labels.add('CANNOT_ASSERT_NO_PRODUCTS_EXIST');
  if (candidates.some((c) => c.commercial === 'EXPIRED')) labels.add('REQUIRE_FRESH_COMMERCIAL_LOOKUP');
  if (candidates.some((c) => c.next.some((n) => n.action === 'SELECT_ITEM'))) labels.add('REQUIRE_ITEM_SELECTION');
  if (answer.degradation.some((d) => d.component === 'COMMERCIAL_TRUTH') || answer.commercialFreshness?.status === 'UNAVAILABLE' || answer.commercialFreshness?.status === 'PARTIAL') labels.add('COMMERCIAL_TRUTH_DEGRADED');
  const retryable = answer.degradation.some((d) => d.retryable);
  if (retryable) labels.add('RETRY_LATER');

  const reasons = new Set<DiscoverAskReason>();
  if (interpretation.ambiguities.length > 0) reasons.add('AMBIGUOUS_NEED');
  if (labels.has('REQUIRE_ITEM_SELECTION')) reasons.add('VARIANT_CHOICE');
  if (interpretation.selection.notFound.length > 0) reasons.add('SELECTED_VARIANT_NOT_FOUND');
  if (verifiedCount === 0 && answer.absence?.reason === 'CONSTRAINTS_UNSUPPORTED') reasons.add('UNSUPPORTED_REQUIREMENT');
  if (verifiedCount === 0 && interpretation.unrecognized.length > 0) reasons.add('UNRECOGNIZED_TERMS');

  return {
    labels: [...labels],
    canAssertCompleteList,
    canAssertNoneExist,
    answerAllowed: [...(canAssertCompleteList ? ['COMPLETE_LIST' as const] : []), ...(canAssertNoneExist ? ['NONE_EXIST' as const] : [])],
    answerForbidden: [...(canAssertCompleteList ? [] : ['COMPLETE_LIST' as const]), ...(canAssertNoneExist ? [] : ['NONE_EXIST' as const]), ...ALWAYS_FORBIDDEN],
    askCustomer: { needed: reasons.size > 0, reasons: [...reasons] },
    retryable,
  };
}
