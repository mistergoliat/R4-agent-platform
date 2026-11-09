import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_ACCREDITED_STATUSES,
  checkoutErrorAction,
  checkoutIdempotencyKey,
  checkoutLinkIsDeliverable,
  checkoutPurchaseStatus,
  type CheckoutAttemptView,
  type CheckoutSessionView,
} from '@r4-adapters/domains';
import { isExplicitPurchaseRequest } from '@r4-sales/agent';

/** R4_CHECKOUT_INTEGRATION_CONTRACT §5.1, §6, §7, §8 and the purchase grammar: pure functions, every rule. */
const session = (over: Partial<CheckoutSessionView> = {}): CheckoutSessionView => ({
  sessionId: 'cks_1', status: 'READY', statusReason: null, quote: { quoteId: 'q', quoteVersion: 1, expiresAt: '2026-11-06T20:00:00Z' }, purchaseAuthorizationId: 'pza_1',
  amount: { amountMinor: '2500', currency: 'CLP' }, orderSyncStatus: null, anomaly: null, createdAt: '2026-11-06T19:00:00Z', updatedAt: '2026-11-06T19:00:00Z', ...over,
});
const attempt = (over: Partial<CheckoutAttemptView> = {}): CheckoutAttemptView => ({
  paymentAttemptId: 'cpa_1', sessionId: 'cks_1', ordinal: 1, status: 'LINK_AVAILABLE', amount: { amountMinor: '2500', currency: 'CLP' }, quoteVersion: 1, expiresAt: '2026-11-06T19:15:00Z',
  linkExpired: false, checkoutUrl: 'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=x', lateCapture: false, createdAt: '2026-11-06T19:00:00Z', updatedAt: '2026-11-06T19:00:00Z', ...over,
});

describe('§6 status mapping (in order, first match wins, fail closed)', () => {
  const cases: [string, CheckoutSessionView, CheckoutAttemptView[], string][] = [
    ['1 ACTION_REQUIRED', session({ status: 'ACTION_REQUIRED' }), [attempt({ status: 'CAPTURED' })], 'HUMAN_INTERVENTION_REQUIRED'],
    ['1 INTERVENTION_REQUIRED order sync', session({ status: 'COMPLETED', orderSyncStatus: 'INTERVENTION_REQUIRED' }), [], 'HUMAN_INTERVENTION_REQUIRED'],
    ['1 late capture', session({ status: 'PAYMENT_PENDING' }), [attempt({ status: 'EXPIRED', lateCapture: true })], 'HUMAN_INTERVENTION_REQUIRED'],
    ['1 anomaly', session({ anomaly: 'X' }), [], 'HUMAN_INTERVENTION_REQUIRED'],
    ['2 COMPLETED', session({ status: 'COMPLETED', orderSyncStatus: 'SYNCED' }), [attempt({ status: 'CAPTURED' })], 'ORDER_COMPLETED'],
    ['3 confirmed, order pending', session({ status: 'PAYMENT_CONFIRMED_ORDER_PENDING', orderSyncStatus: 'SYNCING' }), [attempt({ status: 'CAPTURED' })], 'PAYMENT_ACCREDITED_ORDER_PROCESSING'],
    ['3 SETTLED attempt', session({ status: 'PAYMENT_PENDING' }), [attempt({ status: 'SETTLED' })], 'PAYMENT_ACCREDITED_ORDER_PROCESSING'],
    ['4 PROCESSING', session({ status: 'PAYMENT_PENDING' }), [attempt({ status: 'PROCESSING' })], 'PAYMENT_PENDING'],
    ['5 link available', session({ status: 'PAYMENT_PENDING' }), [attempt()], 'PAYMENT_LINK_AVAILABLE'],
    ['5 needs the URL', session({ status: 'PAYMENT_PENDING' }), [attempt({ checkoutUrl: null })], 'HUMAN_INTERVENTION_REQUIRED'],
    ['6 expired by Checkout, still open', session({ status: 'PAYMENT_PENDING' }), [attempt({ linkExpired: true })], 'LINK_EXPIRED_PROVISIONAL'],
    ['6 CREATED expired', session({ status: 'PAYMENT_PENDING' }), [attempt({ status: 'CREATED', linkExpired: true, checkoutUrl: null })], 'LINK_EXPIRED_PROVISIONAL'],
    ['7 being issued', session({ status: 'PAYMENT_PENDING' }), [attempt({ status: 'CREATED', checkoutUrl: null })], 'LINK_BEING_ISSUED'],
    ['8 EXPIRED', session(), [attempt({ status: 'EXPIRED', checkoutUrl: null })], 'LINK_EXPIRED'],
    ['8 CANCELED', session(), [attempt({ status: 'CANCELED', checkoutUrl: null })], 'LINK_EXPIRED'],
    ['9 FAILED', session(), [attempt({ status: 'FAILED', checkoutUrl: null })], 'PAYMENT_REJECTED'],
    ['10 PREPARING', session({ status: 'PREPARING' }), [], 'PREPARING'],
    ['10 CREATED', session({ status: 'CREATED' }), [], 'PREPARING'],
    ['11 READY, no attempt', session(), [], 'READY_FOR_LINK'],
    ['12 REJECTED', session({ status: 'REJECTED' }), [], 'NOT_PURCHASABLE'],
    ['12 EXPIRED_NO_PAYMENT', session({ status: 'EXPIRED_NO_PAYMENT' }), [], 'NOT_PURCHASABLE'],
    ['unknown session status', session({ status: 'NEW_STATE' }), [], 'HUMAN_INTERVENTION_REQUIRED'],
    ['unknown attempt status', session(), [attempt({ status: 'REFUNDED' })], 'HUMAN_INTERVENTION_REQUIRED'],
    ['unknown order sync status', session({ orderSyncStatus: 'LOST' }), [], 'HUMAN_INTERVENTION_REQUIRED'],
  ];
  it.each(cases)('%s', (_name, s, a, expected) => expect(checkoutPurchaseStatus(s, a)).toBe(expected));

  it('uses the attempt with the highest ordinal', () => {
    expect(checkoutPurchaseStatus(session({ status: 'PAYMENT_PENDING' }), [attempt({ ordinal: 2 }), attempt({ ordinal: 1, status: 'EXPIRED', checkoutUrl: null })])).toBe('PAYMENT_LINK_AVAILABLE');
  });

  it('only ORDER_COMPLETED and PAYMENT_ACCREDITED_ORDER_PROCESSING mean paid', () => {
    expect([...CHECKOUT_ACCREDITED_STATUSES].sort()).toEqual(['ORDER_COMPLETED', 'PAYMENT_ACCREDITED_ORDER_PROCESSING']);
  });
});

describe('§5.1 keys', () => {
  it('is deterministic per execution key and step, distinct across steps, and fits Checkout\'s key grammar', () => {
    const k = checkoutIdempotencyKey('r4x_abc', 'session');
    expect(k).toBe(checkoutIdempotencyKey('r4x_abc', 'session'));
    expect(k).toMatch(/^r4\.ck\.session\.[0-9a-f]{40}$/);
    expect(new Set(['session', 'prepare', 'link'].map((s) => checkoutIdempotencyKey('r4x_abc', s as never))).size).toBe(3);
    expect(checkoutIdempotencyKey('r4x_abd', 'session')).not.toBe(k);
  });
});

describe('§7 error actions', () => {
  it('maps the contract codes, and any other code to a handoff', () => {
    expect(checkoutErrorAction('IDEMPOTENCY_KEY_REUSED')).toBe('stop_handoff');
    expect(checkoutErrorAction('BUYER_NOT_AUTHORIZED')).toBe('identity_or_consent');
    expect(checkoutErrorAction('REQUEST_IN_PROGRESS')).toBe('retry_same_key');
    expect(checkoutErrorAction('ATTEMPT_UNRESOLVED')).toBe('read_status');
    expect(checkoutErrorAction('QUOTE_EXPIRED')).toBe('not_purchasable');
    expect(checkoutErrorAction('CART_PARITY_UNPROVEN')).toBe('preparation_failed');
    expect(checkoutErrorAction('OPERATIONAL_GATE_BLOCKED')).toBe('environment_closed');
    expect(checkoutErrorAction('ORDER_SYNC_PENDING')).toBe('still_reconciling');
    expect(checkoutErrorAction('SOMETHING_NEW')).toBe('stop_handoff');
    expect(checkoutErrorAction('toString')).toBe('stop_handoff');
  });
});

describe('§8 link checks', () => {
  it('accepts only https Mercado Pago URLs without userinfo or port', () => {
    for (const ok of ['https://www.mercadopago.cl/checkout/v1/redirect?pref_id=1', 'https://mercadopago.com/x', 'https://sandbox.mercadopago.cl/x']) expect(checkoutLinkIsDeliverable(ok), ok).toBe(true);
    for (const bad of ['http://www.mercadopago.cl/x', 'https://mercadopago.cl.evil.com/x', 'https://evilmercadopago.cl/x', 'https://user@www.mercadopago.cl/x', 'https://www.mercadopago.cl:8443/x', 'javascript:alert(1)', 'not a url']) {
      expect(checkoutLinkIsDeliverable(bad), bad).toBe(false);
    }
  });
});

describe('purchase grammar (explicit, unconditional requests only)', () => {
  it('accepts the closed phrase list with an optional affirmation and courtesy', () => {
    for (const ok of ['quiero pagar', 'Sí, quiero pagar', 'envíame el link de pago por favor', 'Lo compro!', 'dale, quiero comprarlo', 'quiero un link nuevo']) expect(isExplicitPurchaseRequest(ok), ok).toBe(true);
  });
  it('refuses questions, conditions, claims of payment and anything else', () => {
    for (const bad of ['¿cómo pago?', 'quiero pagar pero después', 'ya pagué', 'pagué', 'no quiero pagar', 'confirmo', 'ok', '', null, 'quiero pagar '.repeat(20)]) expect(isExplicitPurchaseRequest(bad), String(bad)).toBe(false);
  });
});
