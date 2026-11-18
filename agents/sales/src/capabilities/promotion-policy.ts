import type { CatalogPromotion } from '@r4-adapters/domains';

/**
 * (F1-COMMERCIAL-POLICY-v3, owner decision 2026-11-13; active only once the Quote owner accepts it) When a promotional
 * price Catalog V2 reports may be quoted autonomously. One rule, used where the agent reads a product (so it never
 * offers a quote the platform will refuse) and where a quote is previewed and issued (where it is enforced).
 * Catalog's own fields only (`pricing.promotion.validUntil`): never a heuristic, no new Catalog contract.
 */
export const F1_COMMERCIAL_POLICY_V3_VERSION = 'F1-COMMERCIAL-POLICY-v3';
/** The validity of every F1 quote, fixed by the Quote owner's principal r4-sales-retail-session (cl-retail-session-60m-v1). */
export const F1_QUOTE_VALIDITY_MS = 60 * 60_000;
/** (owner decision 2026-11-13) The initial margin a promotion must still run after the quote's validity ends. */
export const F1_PROMOTION_MARGIN_MS = 15 * 60_000;

export type PromotionQuotability =
  | { readonly quotable: true; readonly endsAt: string }
  | { readonly quotable: false; readonly code: 'price_promotional_excluded' | 'price_promotional_unbounded' | 'price_promotional_ending'; readonly endsAt: string | null; readonly reason: string };

/** `promotionsAllowed`: the eligibility's v3 switch (absent/false: every promotional price is refused, as in v1/v2). */
export function promotionQuotability(promotion: CatalogPromotion, eligibility: { readonly promotionsAllowed?: boolean }, now: Date): PromotionQuotability {
  const endsAt = promotion.validUntil;
  if (eligibility.promotionsAllowed !== true) {
    return { quotable: false, code: 'price_promotional_excluded', endsAt, reason: 'promotional prices are not quoted autonomously until their owners authorize it' };
  }
  const end = endsAt === null ? Number.NaN : Date.parse(endsAt);
  if (endsAt === null || !Number.isFinite(end)) {
    return { quotable: false, code: 'price_promotional_unbounded', endsAt: null, reason: 'the promotion declares no end date, so a 60-minute quote cannot be guaranteed at that price' };
  }
  if (end - now.getTime() < F1_QUOTE_VALIDITY_MS + F1_PROMOTION_MARGIN_MS) {
    return { quotable: false, code: 'price_promotional_ending', endsAt, reason: 'the promotion ends before a 60-minute quote (plus a 15-minute margin) would expire' };
  }
  return { quotable: true, endsAt };
}
