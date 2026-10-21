import type { CallOptions } from '../shared/errors.js';

/**
 * R4-J4-R2: Customer Profile port (ADR-039; specification R4-J4-R1 §4, §5, §7).
 *
 * Customer Profile is the authority for purchase facts of an identified
 * PrestaShop customer. This port reads them for ONE purpose per operation:
 * `getSalesContext` sends `sales_context` and `getPurchaseHistory` sends
 * `purchase_history`. There is no operation that takes a purpose, so the
 * purpose always comes from the capability that calls, never from the model.
 *
 * States are never folded into each other:
 * - `available`  the customer is on file and its facts may be shown
 * - `not_found`  Customer Profile has no such customer
 * - `withheld`   the account exists but its information is not disclosed
 *                (CP `not_applicable`; deleted, operational or unknown state;
 *                provisionally guest and inactive, AP-09). The reason is not exposed.
 * Failures are DomainError, never a state: 401/403 `unauthorized`; 429, 503
 * (`degraded`), 504 and other 5xx `temporarily_unavailable`; an incomplete
 * history `temporarily_unavailable` (`history_unavailable`); the local deadline
 * `timeout`; anything outside the contract `contract_violation`.
 *
 * Every operation needs a grant (D2). Until D2 exists the grant is not sent
 * and every answer is `service_scope_only`, which only a synthetic mode accepts.
 */

export const CUSTOMER_PURPOSES = ['sales_context', 'purchase_history'] as const;
export type CustomerPurpose = (typeof CUSTOMER_PURPOSES)[number];

/** `prestashop_customer:<id>`; any other namespace or a bare integer is foreign. */
export const CUSTOMER_REF_PATTERN = /^prestashop_customer:[1-9][0-9]{0,9}$/;

/** Opaque per-customer authorization issued by the identity authority. R4 never decodes it. */
export interface CustomerAccessGrant {
  readonly token: string;
  /** From the authority's answer (not a parsed claim); required. */
  readonly expiresAt: string;
  readonly purposes: readonly CustomerPurpose[];
}

/** What the identity authority answers for the channel subject. */
export type IdentityResolution =
  | { readonly status: 'verified'; readonly customerRef: string; readonly grant: CustomerAccessGrant; readonly resolvedAt: string }
  | { readonly status: 'not_linked' | 'not_verified' | 'ambiguous' | 'conflicted' | 'not_authorized'; readonly resolvedAt: string };

/**
 * R4-J4-R3: the channel subject, taken only from the trusted conversation binding
 * (`ProductionStore.bindingByTask`), never from the model, the transcript or the workspace.
 * `sessionRef` is the binding id: CIA contract v1-d2 §3 ("Sesión": consumer session reference,
 * R4 `bindingId`). It is the one field added to the R1 draft subject, because the accepted contract
 * requires it.
 */
export interface ChannelSubject {
  readonly channel: string;
  readonly accountRef: string;
  readonly subjectRef: string;
  readonly sessionRef: string;
}

/** R4-J4-R3 (specification R4-J4-R1 §4): resolves the subject for the purposes asked, per invocation. */
export interface CustomerIdentityResolver {
  resolve(subject: ChannelSubject, purposes: readonly CustomerPurpose[], options?: CallOptions): Promise<IdentityResolution>;
}

/** Synthetic Customer Profile ids (CP dataset and CIA fixtures): the only customers a synthetic binding may reach (AG-1). */
export const SYNTHETIC_CUSTOMER_ID_MIN = 900000201;
export const SYNTHETIC_CUSTOMER_ID_MAX = 900000313;

export function isSyntheticCustomerRef(customerRef: string): boolean {
  if (!CUSTOMER_REF_PATTERN.test(customerRef)) return false;
  const id = Number(customerRef.slice('prestashop_customer:'.length));
  return id >= SYNTHETIC_CUSTOMER_ID_MIN && id <= SYNTHETIC_CUSTOMER_ID_MAX;
}

export type CustomerProfileStatus = 'available' | 'not_found' | 'withheld';

export type CustomerSalesContext =
  | {
      readonly status: 'available';
      /** `unknown` when no available component backs the indicator. */
      readonly purchaseHistory: 'present' | 'none' | 'unknown';
      /** CP freshness.validUntil; null when it declares none. */
      readonly validUntil: string | null;
    }
  | { readonly status: 'not_found' | 'withheld'; readonly validUntil: string | null };

export type CustomerLineKind = 'standard' | 'zero_price_line' | 'administrative_service';

export interface CustomerPurchaseItem {
  /** Historical name; null when none is on record. Never replaced by a SKU or a current Catalog name. */
  readonly productName: string | null;
  /** D6 is deferred: always null in J4. */
  readonly catalogKey: string | null;
  /** Calendar day of the stored source value (CP lastPurchasedSourceDate); zone per datePrecision. */
  readonly lastPurchasedOn: string;
  /** GROSS units (CP quantityPurchasedGross): returns and refunds are not subtracted. 0 is a fact. */
  readonly totalQuantity: number;
  /** Valid orders containing the variant (≥ 1). */
  readonly orderCount: number;
  /** For the AP-10 output filter only; never shown to the model. */
  readonly lineKind: CustomerLineKind;
}

export type CustomerDatePrecision = 'day' | 'day_timezone_unverified';

export type CustomerPurchasePage =
  | {
      readonly status: 'available';
      /** Empty means no purchase in this window: absence of history, not an unknown. */
      readonly items: readonly CustomerPurchaseItem[];
      readonly offset: number;
      readonly hasMore: boolean;
      /** offset + returned when hasMore; null otherwise. */
      readonly nextOffset: number | null;
      readonly datePrecision: CustomerDatePrecision;
      readonly validUntil: string | null;
    }
  | { readonly status: 'not_found' | 'withheld'; readonly validUntil: string | null };

export interface CustomerPurchasePageRequest {
  /** 0–40 (a 50-item window). */
  readonly offset: number;
  /** 1–10. */
  readonly limit: number;
}

export interface CustomerProfilePort {
  getSalesContext(customerRef: string, grant: CustomerAccessGrant, options?: CallOptions): Promise<CustomerSalesContext>;
  getPurchaseHistory(customerRef: string, grant: CustomerAccessGrant, page: CustomerPurchasePageRequest, options?: CallOptions): Promise<CustomerPurchasePage>;
}
