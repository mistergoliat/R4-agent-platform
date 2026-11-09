import { createHash } from 'node:crypto';
import type { CallOptions } from '../shared/errors.js';

/**
 * Checkout port (R4_CHECKOUT_INTEGRATION_CONTRACT, Checkout `d11e3c7`, OpenAPI `1.0.3-proposed`, sandbox-purchase
 * profile). Checkout is the authority over sessions, payment attempts, link expiry, financial status and orders; Quote
 * prepares the cart (ADR-0002). R4 is a client: it asks for the purchase of a quote it already issued and relays what
 * Checkout verified. Nothing here sets a payment, an order or an expiry.
 */
export const CHECKOUT_SESSION_STATUSES = ['CREATED', 'PREPARING', 'READY', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED_ORDER_PENDING', 'COMPLETED', 'REJECTED', 'EXPIRED_NO_PAYMENT', 'CANCELED', 'ACTION_REQUIRED'] as const;
export const CHECKOUT_ATTEMPT_STATUSES = ['CREATED', 'LINK_AVAILABLE', 'PROCESSING', 'CAPTURED', 'SETTLED', 'FAILED', 'CANCELED', 'EXPIRED'] as const;
export const CHECKOUT_ORDER_SYNC_STATUSES = ['NOT_STARTED', 'PENDING', 'SYNCING', 'SYNCED', 'RETRYABLE_FAILURE', 'INTERVENTION_REQUIRED'] as const;

/** Integer minor units as a string (CLP exponent 0), never a JSON number. */
export interface CheckoutMoney {
  readonly amountMinor: string;
  readonly currency: 'CLP';
}

export interface CheckoutSessionView {
  readonly sessionId: string;
  /** Unknown future values are kept as strings: the status mapping fails closed on them. */
  readonly status: string;
  readonly statusReason: string | null;
  readonly quote: { readonly quoteId: string; readonly quoteVersion: number; readonly expiresAt: string };
  readonly purchaseAuthorizationId: string | null;
  readonly amount: CheckoutMoney;
  readonly orderSyncStatus: string | null;
  readonly anomaly: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CheckoutAttemptView {
  readonly paymentAttemptId: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly amount: CheckoutMoney;
  readonly quoteVersion: number;
  readonly expiresAt: string;
  /** Checkout's own expiry flag: R4 never computes expiry from its clock (§6). */
  readonly linkExpired: boolean;
  /** Sensitive: never logged, never shown to the model (§4, §8). */
  readonly checkoutUrl: string | null;
  readonly lateCapture: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CheckoutOrdersView {
  readonly sessionId: string;
  readonly orderSyncStatus: string;
  /** `psOrderId` is never shown (§3 O4): only `reference`. */
  readonly orders: readonly { readonly psOrderId: number; readonly reference: string; readonly totalPaid: CheckoutMoney }[];
}

/** An opaque purchase-consent artifact issued by an approved consent authority (never built from a boolean). */
export interface CheckoutConsentEvidence {
  readonly format: string;
  readonly token: string;
}

export interface CheckoutCreateSessionRequest {
  readonly quoteId: string;
  readonly quoteVersion: number;
  readonly consent: CheckoutConsentEvidence;
}

/** A command's answer: the view, and whether Checkout replayed a stored answer for the same key (`Idempotent-Replay`). */
export interface CheckoutCommandResult<T> {
  readonly httpStatus: number;
  readonly replayed: boolean;
  readonly view: T;
}

/**
 * The six routes of contract §11.1, nothing else (no cancel, no query strings). Every command takes the caller's
 * Idempotency-Key (§5.1); failures are DomainErrors whose `code` is Checkout's own error code (§7).
 */
export interface CheckoutService {
  createSession(request: CheckoutCreateSessionRequest, idempotencyKey: string, options?: CallOptions): Promise<CheckoutCommandResult<CheckoutSessionView>>;
  getSession(sessionId: string, options?: CallOptions): Promise<CheckoutSessionView>;
  prepareSession(sessionId: string, idempotencyKey: string, options?: CallOptions): Promise<CheckoutCommandResult<CheckoutSessionView>>;
  createPaymentAttempt(sessionId: string, idempotencyKey: string, options?: CallOptions): Promise<CheckoutCommandResult<CheckoutAttemptView>>;
  listPaymentAttempts(sessionId: string, options?: CallOptions): Promise<readonly CheckoutAttemptView[]>;
  getOrders(sessionId: string, options?: CallOptions): Promise<CheckoutOrdersView>;
}

/**
 * Where the purchase-consent artifact comes from (contract R-3: a CIA `purpose: purchase` grant obtained at call time).
 * No implementation exists in R4: CIA has no purchase purpose (H3 candidate, C-CIA-1..8) and the only issuer is
 * Checkout's explicitly test-only operator tooling. A deployment without a source cannot start a purchase.
 */
export interface CheckoutConsentSource {
  /** The artifact for this buyer and this exact quote, or null when none can be issued (nothing is then sent). */
  obtain(request: { readonly taskId: string; readonly quoteId: string; readonly quoteVersion: number }, options?: CallOptions): Promise<CheckoutConsentEvidence | null>;
}

export type CheckoutStep = 'session' | 'prepare' | 'link';

/** §5.1: one Checkout operation per step per R4 execution, derived from the persisted execution key (no extra state). */
export function checkoutIdempotencyKey(executionKey: string, step: CheckoutStep): string {
  return `r4.ck.${step}.${createHash('sha256').update(`${executionKey}|${step}`).digest('hex').slice(0, 40)}`;
}

export const CHECKOUT_PURCHASE_STATUSES = [
  'HUMAN_INTERVENTION_REQUIRED',
  'ORDER_COMPLETED',
  'PAYMENT_ACCREDITED_ORDER_PROCESSING',
  'PAYMENT_PENDING',
  'PAYMENT_LINK_AVAILABLE',
  'LINK_EXPIRED_PROVISIONAL',
  'LINK_BEING_ISSUED',
  'LINK_EXPIRED',
  'PAYMENT_REJECTED',
  'PREPARING',
  'READY_FOR_LINK',
  'NOT_PURCHASABLE',
] as const;
export type CheckoutPurchaseStatus = (typeof CHECKOUT_PURCHASE_STATUSES)[number];

/** The only statuses under which a payment may be called accredited (§6): they come from Checkout's verified reads only. */
export const CHECKOUT_ACCREDITED_STATUSES: ReadonlySet<CheckoutPurchaseStatus> = new Set(['ORDER_COMPLETED', 'PAYMENT_ACCREDITED_ORDER_PROCESSING']);

/** The attempt with the highest ordinal, or null. */
export function latestCheckoutAttempt(attempts: readonly CheckoutAttemptView[]): CheckoutAttemptView | null {
  return attempts.reduce<CheckoutAttemptView | null>((top, a) => (top === null || a.ordinal > top.ordinal ? a : top), null);
}

const SESSION_KNOWN = new Set<string>(CHECKOUT_SESSION_STATUSES);
const ATTEMPT_KNOWN = new Set<string>(CHECKOUT_ATTEMPT_STATUSES);
const SYNC_KNOWN = new Set<string>(CHECKOUT_ORDER_SYNC_STATUSES);

/**
 * §6, evaluated in order, first match wins; a pure function of Checkout's views. Any value outside the contract's
 * enums, or a combination no rule covers, maps to HUMAN_INTERVENTION_REQUIRED (fail closed). `PAYMENT_PENDING` as a
 * session status (a link is out) is covered through the attempt (§11.1).
 */
export function checkoutPurchaseStatus(session: CheckoutSessionView, attempts: readonly CheckoutAttemptView[]): CheckoutPurchaseStatus {
  const a = latestCheckoutAttempt(attempts);
  const unknown = !SESSION_KNOWN.has(session.status) || (session.orderSyncStatus !== null && !SYNC_KNOWN.has(session.orderSyncStatus)) || attempts.some((x) => !ATTEMPT_KNOWN.has(x.status));
  if (unknown || session.status === 'ACTION_REQUIRED' || session.orderSyncStatus === 'INTERVENTION_REQUIRED' || a?.lateCapture === true || session.anomaly !== null) return 'HUMAN_INTERVENTION_REQUIRED';
  if (session.status === 'COMPLETED') return 'ORDER_COMPLETED';
  if (session.status === 'PAYMENT_CONFIRMED_ORDER_PENDING' || a?.status === 'CAPTURED' || a?.status === 'SETTLED') return 'PAYMENT_ACCREDITED_ORDER_PROCESSING';
  if (a?.status === 'PROCESSING') return 'PAYMENT_PENDING';
  if (a?.status === 'LINK_AVAILABLE' && !a.linkExpired && a.checkoutUrl !== null) return 'PAYMENT_LINK_AVAILABLE';
  if ((a?.status === 'LINK_AVAILABLE' || a?.status === 'CREATED') && a.linkExpired) return 'LINK_EXPIRED_PROVISIONAL';
  if (a?.status === 'CREATED') return 'LINK_BEING_ISSUED';
  if (a?.status === 'EXPIRED' || a?.status === 'CANCELED') return 'LINK_EXPIRED';
  if (a?.status === 'FAILED') return 'PAYMENT_REJECTED';
  if (session.status === 'CREATED' || session.status === 'PREPARING') return 'PREPARING';
  if (session.status === 'READY' && a === null) return 'READY_FOR_LINK';
  if (session.status === 'REJECTED' || session.status === 'CANCELED' || session.status === 'EXPIRED_NO_PAYMENT') return 'NOT_PURCHASABLE';
  return 'HUMAN_INTERVENTION_REQUIRED';
}

/** What R4 does with a Checkout error code (§7). Any code not listed: handoff (fail closed). */
export type CheckoutErrorAction = 'stop_handoff' | 'identity_or_consent' | 'retry_same_key' | 'read_status' | 'not_purchasable' | 'preparation_failed' | 'environment_closed' | 'still_reconciling';

const ERROR_ACTIONS: Readonly<Record<string, CheckoutErrorAction>> = Object.freeze({
  VALIDATION_ERROR: 'stop_handoff', IDEMPOTENCY_KEY_REUSED: 'stop_handoff', NOT_FOUND: 'stop_handoff',
  UNAUTHENTICATED: 'identity_or_consent', BUYER_NOT_AUTHORIZED: 'identity_or_consent', PURCHASE_AUTHORIZATION_REQUIRED: 'identity_or_consent',
  REQUEST_IN_PROGRESS: 'retry_same_key', QUOTE_UNAVAILABLE: 'retry_same_key', AUTHORIZATION_UNAVAILABLE: 'retry_same_key', PAYMENT_PROVIDER_UNAVAILABLE: 'retry_same_key',
  ATTEMPT_UNRESOLVED: 'read_status', CHECKOUT_ALREADY_SETTLED: 'read_status',
  QUOTE_EXPIRED: 'not_purchasable', QUOTE_VALIDITY_INSUFFICIENT: 'not_purchasable', QUOTE_NOT_ISSUED: 'not_purchasable', QUOTE_CANCELLED: 'not_purchasable', QUOTE_VERSION_MISMATCH: 'not_purchasable', QUOTE_IDENTITY_MISMATCH: 'not_purchasable',
  PRICE_MISMATCH: 'preparation_failed', CART_PARITY_UNPROVEN: 'preparation_failed', CART_PREPARATION_UNAVAILABLE: 'preparation_failed', CART_PREPARATION_MISMATCH: 'preparation_failed', STOCK_UNAVAILABLE: 'preparation_failed', SHIPPING_MISMATCH: 'preparation_failed',
  OPERATIONAL_GATE_BLOCKED: 'environment_closed', PRESTASHOP_MODULE_UNSUPPORTED: 'environment_closed',
  PAYMENT_STATUS_UNVERIFIED: 'still_reconciling', ORDER_SYNC_PENDING: 'still_reconciling', OPERATION_OUTCOME_UNKNOWN: 'still_reconciling',
});

export function checkoutErrorAction(code: string): CheckoutErrorAction {
  return Object.hasOwn(ERROR_ACTIONS, code) ? ERROR_ACTIONS[code]! : 'stop_handoff';
}

/** §8: an `https:` Mercado Pago URL (mercadopago.cl / .com or a subdomain), with no userinfo and no port. */
export function checkoutLinkIsDeliverable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const mp = ['mercadopago.cl', 'mercadopago.com'].some((d) => host === d || host.endsWith(`.${d}`));
  return parsed.protocol === 'https:' && mp && parsed.username === '' && parsed.password === '' && parsed.port === '' && url.length <= 2048;
}

/** §8: a link is offered only while `now < expiresAt − 60 s` (Checkout's expiry, R4's clock only shortens it). */
export const CHECKOUT_LINK_SAFETY_MARGIN_MS = 60_000;
