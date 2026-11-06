import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  checkoutIdempotencyKey,
  type CheckoutAttemptView,
  type CheckoutCommandResult,
  type CheckoutConsentSource,
  type CheckoutCreateSessionRequest,
  type CheckoutOrdersView,
  type CheckoutService,
  type CheckoutSessionView,
  type QuoteV2Quote,
  type QuoteV2Service,
} from '@r4-adapters/domains';
import type { CapabilityHandlerContext, WriteHandlerContext } from '@r4/capability-runtime';
import { AutonomyControls } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { PostgresProductionStore, type Pool } from '@r4/persistence-postgres';
import {
  PostgresSalesStore,
  checkoutLinkNoticeKey,
  checkoutPurchaseStatusCapability,
  checkoutRequestLinkCapability,
  checkoutStartPurchaseCapability,
  migrateSales,
  type CheckoutCapabilityDeps,
  type ConversationThreadEntry,
} from '@r4-sales/agent';
import { killSwitchGuardedCheckout } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4 Checkout integration, mandate Phase 6 (scenarios 1–10) and contract R4-CK-01..12 where R4 owns the behaviour:
 * the three Checkout capabilities on real PostgreSQL (`sales` 0006–0010, the real durable kill switch) against a
 * DETERMINISTIC STUB of Checkout that applies the contract's idempotency rules (§5.2). These are stub results, never
 * real-provider evidence: no Checkout runtime, Mercado Pago or PrestaShop is involved.
 */
let db: TestDatabase;
let pool: Pool;
let store: PostgresSalesStore;
let controls: AutonomyControls;
const logger = createSilentLogger();
const NOW = new Date('2026-11-06T19:00:00Z');

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  expect((await migrateSales(pool)).applied).toContain('0010_sales_checkout_requests');
  store = new PostgresSalesStore(pool);
  controls = new AutonomyControls({ store: new PostgresProductionStore(pool), logger });
  await controls.set({ scope: 'global', autonomyEnabled: true, reason: 'test: autonomy on', changedBy: 'it-checkout', correlationId: randomUUID() });
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

// ------------------------------------------------------------------------------------------------ stub Checkout

const URL_OF = (id: string) => `https://www.mercadopago.cl/checkout/v1/redirect?pref_id=${id}`;

/** Checkout as the contract describes it: one operation per key, one live session per quote, at most one unresolved attempt. */
class StubCheckout implements CheckoutService {
  readonly counters = { sessionCreates: 0, prepares: 0, attemptCreates: 0 };
  readonly keysSeen: string[] = [];
  readonly sessions = new Map<string, CheckoutSessionView>();
  readonly attempts = new Map<string, CheckoutAttemptView[]>();
  readonly orders = new Map<string, CheckoutOrdersView>();
  readonly #byKey = new Map<string, { body: string; answer: CheckoutCommandResult<unknown> }>();
  /** The next command applies, then its answer is lost (a timeout). */
  loseNextAnswer = false;
  /** How many attempt reads return CREATED before the link appears. */
  linkAfterReads = 1;
  linkTtlMs = 15 * 60_000;

  async createSession(request: CheckoutCreateSessionRequest, key: string): Promise<CheckoutCommandResult<CheckoutSessionView>> {
    return this.#command(key, JSON.stringify(request), () => {
      const live = [...this.sessions.values()].find((s) => s.quote.quoteId === request.quoteId && !['REJECTED', 'CANCELED', 'EXPIRED_NO_PAYMENT'].includes(s.status));
      if (live) return { httpStatus: 200, replayed: false, view: live };
      this.counters.sessionCreates += 1;
      const view: CheckoutSessionView = { sessionId: `cks_${randomUUID()}`, status: 'CREATED', statusReason: null, quote: { quoteId: request.quoteId, quoteVersion: request.quoteVersion, expiresAt: new Date(NOW.getTime() + 3600_000).toISOString() }, purchaseAuthorizationId: 'pza_1', amount: { amountMinor: '2500', currency: 'CLP' }, orderSyncStatus: null, anomaly: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
      this.sessions.set(view.sessionId, view);
      this.attempts.set(view.sessionId, []);
      return { httpStatus: 201, replayed: false, view };
    });
  }

  getSession(sessionId: string): Promise<CheckoutSessionView> {
    const s = this.sessions.get(sessionId);
    return s ? Promise.resolve(s) : Promise.reject(new DomainError('not_found', 'NOT_FOUND', 'session not found'));
  }

  async prepareSession(sessionId: string, key: string): Promise<CheckoutCommandResult<CheckoutSessionView>> {
    return this.#command(key, sessionId, () => {
      this.counters.prepares += 1;
      const s = this.set(sessionId, { status: 'READY' });
      return { httpStatus: 202, replayed: false, view: { ...s, status: 'PREPARING' } };
    });
  }

  async createPaymentAttempt(sessionId: string, key: string): Promise<CheckoutCommandResult<CheckoutAttemptView>> {
    return this.#command(key, sessionId, () => {
      const list = this.attempts.get(sessionId)!;
      const latest = list[list.length - 1];
      if (latest && ['CREATED', 'LINK_AVAILABLE', 'PROCESSING'].includes(latest.status)) throw new DomainError('conflict', 'ATTEMPT_UNRESOLVED', 'an attempt may still be charged');
      this.counters.attemptCreates += 1;
      const id = `cpa_${randomUUID()}`;
      const view: CheckoutAttemptView = { paymentAttemptId: id, sessionId, ordinal: list.length + 1, status: 'CREATED', amount: { amountMinor: '2500', currency: 'CLP' }, quoteVersion: 1, expiresAt: new Date(NOW.getTime() + this.linkTtlMs).toISOString(), linkExpired: false, checkoutUrl: null, lateCapture: false, createdAt: new Date(NOW.getTime() + list.length * 1000).toISOString(), updatedAt: NOW.toISOString() };
      list.push(view);
      this.set(sessionId, { status: 'PAYMENT_PENDING' });
      this.#readsUntilLink.set(id, this.linkAfterReads);
      return { httpStatus: 202, replayed: false, view };
    });
  }

  readonly #readsUntilLink = new Map<string, number>();

  listPaymentAttempts(sessionId: string): Promise<readonly CheckoutAttemptView[]> {
    const list = this.attempts.get(sessionId) ?? [];
    for (const [i, a] of list.entries()) {
      const left = this.#readsUntilLink.get(a.paymentAttemptId);
      if (a.status === 'CREATED' && left !== undefined) {
        if (left <= 0) list[i] = { ...a, status: 'LINK_AVAILABLE', checkoutUrl: URL_OF(a.paymentAttemptId) };
        else this.#readsUntilLink.set(a.paymentAttemptId, left - 1);
      }
    }
    return Promise.resolve(list.map((a) => ({ ...a })));
  }

  getOrders(sessionId: string): Promise<CheckoutOrdersView> {
    return Promise.resolve(this.orders.get(sessionId) ?? { sessionId, orderSyncStatus: 'NOT_STARTED', orders: [] });
  }

  /** Test hooks: Checkout's own state changes (webhook, reconciliation, expiry). */
  set(sessionId: string, patch: Partial<CheckoutSessionView>): CheckoutSessionView {
    const next = { ...this.sessions.get(sessionId)!, ...patch };
    this.sessions.set(sessionId, next);
    return next;
  }

  setLatestAttempt(sessionId: string, patch: Partial<CheckoutAttemptView>): void {
    const list = this.attempts.get(sessionId)!;
    list[list.length - 1] = { ...list[list.length - 1]!, ...patch };
    this.#readsUntilLink.delete(list[list.length - 1]!.paymentAttemptId);
  }

  #command<T>(key: string, body: string, apply: () => CheckoutCommandResult<T>): Promise<CheckoutCommandResult<T>> {
    try {
      return Promise.resolve(this.#apply(key, body, apply));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #apply<T>(key: string, body: string, apply: () => CheckoutCommandResult<T>): CheckoutCommandResult<T> {
    this.keysSeen.push(key);
    const seen = this.#byKey.get(key);
    if (seen) {
      if (seen.body !== body) throw new DomainError('conflict', 'IDEMPOTENCY_KEY_REUSED', 'same key, another body');
      return { ...(seen.answer as CheckoutCommandResult<T>), replayed: true };
    }
    const answer = apply();
    this.#byKey.set(key, { body, answer });
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new DomainError('timeout', 'checkout_timeout', 'the answer was lost');
    }
    return answer;
  }
}

// ------------------------------------------------------------------------------------------------ the conversation

class Conversation {
  readonly taskId = randomUUID();
  readonly quoteId = randomUUID();
  readonly entries: ConversationThreadEntry[] = [];
  #clock = NOW.getTime() - 30 * 60_000;
  tick(seconds = 10): string {
    this.#clock += seconds * 1000;
    return new Date(this.#clock).toISOString();
  }
  customer(text: string, at = this.tick()): void {
    this.entries.push({ cursor: `${at}|${randomUUID()}`, at, kind: 'contact', text, refs: { inputId: randomUUID() }, delivery: null });
  }
  readonly reader = { thread: () => Promise.resolve([...this.entries]) };
}

async function issueQuote(c: Conversation, issuedAt: string): Promise<void> {
  const executionKey = `r4x_${randomBytes(16).toString('hex')}`;
  await store.recordQuoteV2Request({ executionKey, taskId: c.taskId, workspaceVersion: 1, request: {} as never, requestSha256: '0'.repeat(64) });
  await store.recordQuoteV2Issued({ executionKey, taskId: c.taskId, quoteId: c.quoteId, quoteNumber: 'PC-000001', issuedAt, validThroughLocalDate: '2026-11-06', validUntilExclusive: new Date(NOW.getTime() + 3600_000).toISOString(), pdfSha256: 'a'.repeat(64), byteLength: 1, documentVerification: 'verified' });
}

const quotes = (status: QuoteV2Quote['status'] = 'issued', validUntil = new Date(NOW.getTime() + 3600_000)): QuoteV2Service => ({
  getQuote: (quoteId: string) => Promise.resolve({ quoteId, status, version: 1, validity: { source: 'policy', policyId: 'cl-retail-session-60m-v1', issueLocalDate: '2026-11-06', validThroughLocalDate: '2026-11-06', validUntilExclusive: validUntil.toISOString() } } as unknown as QuoteV2Quote),
  createAndIssue: () => Promise.reject(new Error('unused')),
  getOperation: () => Promise.reject(new Error('unused')),
  lookupIdempotency: () => Promise.reject(new Error('unused')),
  getDocument: () => Promise.reject(new Error('unused')),
});

const consent: CheckoutConsentSource & { calls: number } = { calls: 0, obtain() { this.calls += 1; return Promise.resolve({ format: 'checkout-sbx-test-consent.v1', token: `stub-consent-${'x'.repeat(24)}` }); } };

class Notices {
  readonly queued = new Map<string, string>();
  createPlatformNotice(n: { taskId: string; noticeKey: string; text: string }): Promise<{ replayed: boolean }> {
    const key = `${n.taskId}|${n.noticeKey}`;
    const replayed = this.queued.has(key);
    if (!replayed) this.queued.set(key, n.text);
    return Promise.resolve({ replayed });
  }
}

function setup(options: { quote?: QuoteV2Service; consent?: CheckoutConsentSource } = {}) {
  const c = new Conversation();
  const checkout = new StubCheckout();
  const notices = new Notices();
  const deps: CheckoutCapabilityDeps = { store, checkout: killSwitchGuardedCheckout(checkout, controls, logger), quotes: options.quote ?? quotes(), consent: options.consent ?? consent, conversation: c.reader, notices, now: () => NOW, poll: { intervalMs: 1, prepareMaxMs: 10, linkMaxMs: 10, sleep: () => Promise.resolve() } };
  return { c, checkout, notices, start: checkoutStartPurchaseCapability(deps), link: checkoutRequestLinkCapability(deps), status: checkoutPurchaseStatusCapability(deps) };
}

const wctx = (taskId: string, executionKey = `r4x_${randomBytes(16).toString('hex')}`, attempt = 1): WriteHandlerContext => ({ executionKey, attempt, signal: new AbortController().signal, execution: { taskId, correlationId: `corr-${taskId}` } } as unknown as WriteHandlerContext);
const rctx = (taskId: string): CapabilityHandlerContext => ({ invocationId: randomUUID(), signal: new AbortController().signal, execution: { task: { taskId }, taskId, correlationId: 'corr' } } as unknown as CapabilityHandlerContext);

async function readyToPay() {
  const s = setup();
  await issueQuote(s.c, s.c.tick());
  s.c.customer('quiero pagar');
  const started = await s.start.execute({ quoteId: s.c.quoteId }, wctx(s.c.taskId));
  return { ...s, started };
}

// ------------------------------------------------------------------------------------------------ scenarios

describe('1. quote acceptance creates one Checkout session', () => {
  it('explicit request after issuance → one session, prepared by Quote (stub), READY_FOR_LINK', async () => {
    const { checkout, started } = await readyToPay();
    expect(started).toMatchObject({ status: 'applied', result: { sessionFound: true, status: 'READY_FOR_LINK', paymentAccredited: false, linkNotice: 'not_available' } });
    expect(checkout.counters).toEqual({ sessionCreates: 1, prepares: 1, attemptCreates: 0 });
  });

  it('refuses, with nothing sent: a quote of another conversation, no explicit request, an expired or cancelled quote, no consent', async () => {
    const other = setup();
    await issueQuote(other.c, other.c.tick());
    other.c.customer('quiero pagar');
    expect(await other.start.execute({ quoteId: randomUUID() }, wctx(other.c.taskId))).toMatchObject({ status: 'rejected', code: 'quote_not_in_conversation' });

    const silent = setup();
    await issueQuote(silent.c, silent.c.tick());
    silent.c.customer('¿y cómo pago?');
    expect(await silent.start.execute({ quoteId: silent.c.quoteId }, wctx(silent.c.taskId))).toMatchObject({ status: 'rejected', code: 'purchase_not_requested' });

    const before = setup();
    before.c.customer('quiero pagar');
    await issueQuote(before.c, before.c.tick());
    expect(await before.start.execute({ quoteId: before.c.quoteId }, wctx(before.c.taskId))).toMatchObject({ status: 'rejected', code: 'purchase_not_requested' });

    for (const q of [quotes('cancelled'), quotes('issued', new Date(NOW.getTime() - 1))]) {
      const s = setup({ quote: q });
      await issueQuote(s.c, s.c.tick());
      s.c.customer('quiero pagar');
      expect(await s.start.execute({ quoteId: s.c.quoteId }, wctx(s.c.taskId))).toMatchObject({ status: 'rejected', code: 'checkout_not_purchasable' });
      expect(s.checkout.keysSeen).toEqual([]);
    }

    const noConsent = setup({ consent: { obtain: () => Promise.resolve(null) } });
    await issueQuote(noConsent.c, noConsent.c.tick());
    noConsent.c.customer('quiero pagar');
    expect(await noConsent.start.execute({ quoteId: noConsent.c.quoteId }, wctx(noConsent.c.taskId))).toMatchObject({ status: 'rejected', code: 'purchase_consent_unavailable' });
    for (const s of [other, silent, before, noConsent]) expect(s.checkout.keysSeen).toEqual([]);
  });
});

describe('2. repeated acceptance does not create duplicate financial operations', () => {
  it('a second execution (new key) gets the live session; two link requests create one attempt', async () => {
    const s = await readyToPay();
    s.c.customer('sí, quiero pagar');
    const again = await s.start.execute({ quoteId: s.c.quoteId }, wctx(s.c.taskId));
    expect(again).toMatchObject({ status: 'applied', result: { status: 'READY_FOR_LINK' } });
    expect(await s.link.execute({}, wctx(s.c.taskId))).toMatchObject({ status: 'applied', result: { status: 'PAYMENT_LINK_AVAILABLE', linkNotice: 'queued' } });
    expect(await s.link.execute({}, wctx(s.c.taskId))).toMatchObject({ status: 'applied', result: { status: 'PAYMENT_LINK_AVAILABLE', linkNotice: 'already_queued' } });
    expect(s.checkout.counters).toEqual({ sessionCreates: 1, prepares: 1, attemptCreates: 1 });
    expect(s.notices.queued.size).toBe(1);
  });
});

describe('3. a transport timeout preserves the original operation identity', () => {
  it('lost answer → unknown; the platform retries the SAME execution key → same Checkout keys, replayed, still one session and one attempt', async () => {
    const s = setup();
    await issueQuote(s.c, s.c.tick());
    s.c.customer('quiero pagar');
    const key = `r4x_${randomBytes(16).toString('hex')}`;
    s.checkout.loseNextAnswer = true;
    expect(await s.start.execute({ quoteId: s.c.quoteId }, wctx(s.c.taskId, key, 1))).toMatchObject({ status: 'unknown' });
    expect(await s.start.reconcile!(wctx(s.c.taskId, key, 1))).toMatchObject({ status: 'unknown' });
    const retried = await s.start.execute({ quoteId: s.c.quoteId }, wctx(s.c.taskId, key, 2));
    expect(retried).toMatchObject({ status: 'applied', replayed: true, result: { status: 'READY_FOR_LINK' } });
    expect(s.checkout.keysSeen.filter((k) => k.startsWith('r4.ck.session.'))).toEqual([checkoutIdempotencyKey(key, 'session'), checkoutIdempotencyKey(key, 'session')]);
    expect(consent.calls).toBeGreaterThan(0);

    const linkKey = `r4x_${randomBytes(16).toString('hex')}`;
    s.checkout.loseNextAnswer = true;
    expect(await s.link.execute({}, wctx(s.c.taskId, linkKey, 1))).toMatchObject({ status: 'unknown' });
    expect(await s.link.execute({}, wctx(s.c.taskId, linkKey, 2))).toMatchObject({ status: 'applied', result: { status: 'PAYMENT_LINK_AVAILABLE' } });
    expect(s.checkout.counters).toEqual({ sessionCreates: 1, prepares: 1, attemptCreates: 1 });
  });

  it('reconciliation without a frozen command says not_applied (nothing can have been sent)', async () => {
    const s = setup();
    expect(await s.start.reconcile!(wctx(s.c.taskId))).toEqual({ status: 'not_applied' });
    expect(await s.link.reconcile!(wctx(s.c.taskId))).toEqual({ status: 'not_applied' });
  });
});

describe('4. repeated link requests reuse a valid attempt', () => {
  it('read first: an open attempt (CREATED, LINK_AVAILABLE, PROCESSING) is never duplicated', async () => {
    const s = await readyToPay();
    await s.link.execute({}, wctx(s.c.taskId));
    const sessionId = [...s.checkout.sessions.keys()][0]!;
    for (const status of ['LINK_AVAILABLE', 'PROCESSING'] as const) {
      s.checkout.setLatestAttempt(sessionId, { status, ...(status === 'PROCESSING' ? { checkoutUrl: null } : {}) });
      s.c.customer('mándame el link de pago');
      await s.link.execute({}, wctx(s.c.taskId));
    }
    expect(s.checkout.counters.attemptCreates).toBe(1);
  });

  it('the notice text carries Checkout\'s URL, amount and expiry; the model-facing output never does', async () => {
    const s = await readyToPay();
    const r = await s.link.execute({}, wctx(s.c.taskId));
    const attemptId = s.checkout.attempts.get([...s.checkout.sessions.keys()][0]!)![0]!.paymentAttemptId;
    const text = s.notices.queued.get(`${s.c.taskId}|${checkoutLinkNoticeKey(attemptId)}`)!;
    expect(text).toContain(URL_OF(attemptId));
    expect(text).toMatch(/\$\s?2\.500/);
    expect(text).toMatch(/Vence a las \d{2}:\d{2}/);
    expect(JSON.stringify(r)).not.toMatch(/mercadopago|https?:/);
  });
});

describe('5. expired links are not presented as payable', () => {
  it('Checkout says expired → LINK_EXPIRED_PROVISIONAL, no notice; inside R4\'s 60 s margin → no notice either', async () => {
    const s = await readyToPay();
    s.checkout.linkTtlMs = 30_000;
    const r = await s.link.execute({}, wctx(s.c.taskId));
    expect(r).toMatchObject({ status: 'applied', result: { status: 'PAYMENT_LINK_AVAILABLE', linkNotice: 'not_available', linkExpiresAt: expect.any(String) } });
    const sessionId = [...s.checkout.sessions.keys()][0]!;
    s.checkout.setLatestAttempt(sessionId, { linkExpired: true });
    expect(await s.status.handler({}, rctx(s.c.taskId))).toMatchObject({ status: 'LINK_EXPIRED_PROVISIONAL', paymentAccredited: false, linkExpiresAt: null });
    expect(s.notices.queued.size).toBe(0);
  });

  it('after Checkout resolves the attempt EXPIRED, a new link needs the customer to ask again (R4-CK-04): then ordinal 2', async () => {
    const s = await readyToPay();
    await s.link.execute({}, wctx(s.c.taskId));
    const sessionId = [...s.checkout.sessions.keys()][0]!;
    s.checkout.setLatestAttempt(sessionId, { status: 'EXPIRED', checkoutUrl: null, linkExpired: true });
    s.checkout.set(sessionId, { status: 'READY' });
    expect(await s.link.execute({}, wctx(s.c.taskId))).toMatchObject({ status: 'rejected', code: 'new_link_not_requested' });
    s.c.customer('quiero un link nuevo', new Date(NOW.getTime() + 60_000).toISOString());
    expect(await s.link.execute({}, wctx(s.c.taskId))).toMatchObject({ status: 'applied', result: { status: 'PAYMENT_LINK_AVAILABLE', linkNotice: 'queued' } });
    expect(s.checkout.attempts.get(sessionId)!.map((a) => a.ordinal)).toEqual([1, 2]);
  });
});

describe('6. a buyer\'s payment claim does not change financial status', () => {
  it('"ya pagué" → status still from Checkout (link available, not accredited); it is not a purchase request either', async () => {
    const s = await readyToPay();
    await s.link.execute({}, wctx(s.c.taskId));
    s.c.customer('ya pagué');
    expect(await s.status.handler({}, rctx(s.c.taskId))).toMatchObject({ status: 'PAYMENT_LINK_AVAILABLE', paymentAccredited: false, orderReference: null });
    expect(await s.link.execute({}, wctx(s.c.taskId))).toMatchObject({ status: 'applied', result: { linkNotice: 'already_queued' } });
    expect(s.checkout.counters.attemptCreates).toBe(1);
  });
});

describe('7. verified accreditation is reported accurately', () => {
  it('PROCESSING → PAYMENT_PENDING (not paid); CAPTURED + PAYMENT_CONFIRMED_ORDER_PENDING → accredited, order processing, no reference', async () => {
    const s = await readyToPay();
    await s.link.execute({}, wctx(s.c.taskId));
    const sessionId = [...s.checkout.sessions.keys()][0]!;
    s.checkout.setLatestAttempt(sessionId, { status: 'PROCESSING', checkoutUrl: null });
    expect(await s.status.handler({}, rctx(s.c.taskId))).toMatchObject({ status: 'PAYMENT_PENDING', paymentAccredited: false });
    s.checkout.setLatestAttempt(sessionId, { status: 'CAPTURED' });
    s.checkout.set(sessionId, { status: 'PAYMENT_CONFIRMED_ORDER_PENDING', orderSyncStatus: 'SYNCING' });
    expect(await s.status.handler({}, rctx(s.c.taskId))).toMatchObject({ status: 'PAYMENT_ACCREDITED_ORDER_PROCESSING', paymentAccredited: true, orderReference: null });
  });
});

describe('8. order completion is confirmed only after Checkout reports COMPLETED', () => {
  it('orders listed while SYNCING are not shown; COMPLETED → ORDER_COMPLETED with the reference, never the PrestaShop id', async () => {
    const s = await readyToPay();
    await s.link.execute({}, wctx(s.c.taskId));
    const sessionId = [...s.checkout.sessions.keys()][0]!;
    s.checkout.setLatestAttempt(sessionId, { status: 'CAPTURED', checkoutUrl: null });
    s.checkout.orders.set(sessionId, { sessionId, orderSyncStatus: 'SYNCING', orders: [{ psOrderId: 106, reference: 'DICHJYQED', totalPaid: { amountMinor: '2500', currency: 'CLP' } }] });
    s.checkout.set(sessionId, { status: 'PAYMENT_CONFIRMED_ORDER_PENDING', orderSyncStatus: 'SYNCING' });
    expect(await s.status.handler({}, rctx(s.c.taskId))).toMatchObject({ status: 'PAYMENT_ACCREDITED_ORDER_PROCESSING', orderReference: null });
    s.checkout.set(sessionId, { status: 'COMPLETED', orderSyncStatus: 'SYNCED' });
    const done = await s.status.handler({}, rctx(s.c.taskId));
    expect(done).toMatchObject({ status: 'ORDER_COMPLETED', paymentAccredited: true, orderReference: 'DICHJYQED' });
    expect(JSON.stringify(done)).not.toContain('106');
  });
});

describe('9. ACTION_REQUIRED does not trigger another payment', () => {
  it('ACTION_REQUIRED (or a late capture, an anomaly) → HUMAN_INTERVENTION_REQUIRED and no attempt, even when the customer asks again', async () => {
    for (const patch of [{ session: { status: 'ACTION_REQUIRED' } }, { session: { anomaly: 'LATE_CAPTURE' } }, { attempt: { lateCapture: true } }]) {
      const s = await readyToPay();
      await s.link.execute({}, wctx(s.c.taskId));
      const sessionId = [...s.checkout.sessions.keys()][0]!;
      s.checkout.setLatestAttempt(sessionId, { status: 'FAILED', checkoutUrl: null, ...(patch.attempt ?? {}) });
      s.checkout.set(sessionId, { status: 'READY', ...(patch.session ?? {}) });
      s.c.customer('quiero un link nuevo', new Date(NOW.getTime() + 60_000).toISOString());
      expect(await s.link.execute({}, wctx(s.c.taskId))).toMatchObject({ status: 'applied', result: { status: 'HUMAN_INTERVENTION_REQUIRED', paymentAccredited: false, linkNotice: 'not_available' } });
      expect(s.checkout.counters.attemptCreates).toBe(1);
    }
  });
});

describe('10. an unauthorized initiation cannot reach Checkout', () => {
  it('the kill switch stops every Checkout command before any call (OPERATIONAL_GATE_BLOCKED, nothing sent); reads stay open', async () => {
    const s = setup();
    await issueQuote(s.c, s.c.tick());
    s.c.customer('quiero pagar');
    await controls.set({ scope: 'global', autonomyEnabled: false, reason: 'test: kill switch', changedBy: 'it-checkout', correlationId: randomUUID() });
    try {
      expect(await s.start.execute({ quoteId: s.c.quoteId }, wctx(s.c.taskId))).toMatchObject({ status: 'rejected', code: 'checkout_environment_closed' });
      expect(s.checkout.keysSeen).toEqual([]);
      expect(await s.status.handler({}, rctx(s.c.taskId))).toMatchObject({ sessionFound: false });
    } finally {
      await controls.set({ scope: 'global', autonomyEnabled: true, reason: 'test: autonomy on', changedBy: 'it-checkout', correlationId: randomUUID() });
    }
  });

  it('a link request without a purchase in course, or for another conversation\'s session, sends nothing', async () => {
    const s = setup();
    expect(await s.link.execute({}, wctx(s.c.taskId))).toMatchObject({ status: 'rejected', code: 'no_purchase_in_course' });
    expect(s.checkout.keysSeen).toEqual([]);
  });
});

