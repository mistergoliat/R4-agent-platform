import { z } from 'zod';
import {
  CHECKOUT_ACCREDITED_STATUSES,
  CHECKOUT_LINK_SAFETY_MARGIN_MS,
  CHECKOUT_PURCHASE_STATUSES,
  DomainError,
  checkoutErrorAction,
  checkoutIdempotencyKey,
  checkoutLinkIsDeliverable,
  checkoutPurchaseStatus,
  latestCheckoutAttempt,
  type CheckoutAttemptView,
  type CheckoutConsentSource,
  type CheckoutPurchaseStatus,
  type CheckoutService,
  type CheckoutSessionView,
  type QuoteV2Service,
} from '@r4-adapters/domains';
import { CapabilityFailure, type CapabilityRegistration, type WriteCapabilityRegistration, type WriteExecutionResult, type WriteHandlerContext, type WriteReconciliationResult } from '@r4/capability-runtime';
import { CHECKOUT_CAPABILITY_IDS, CHECKOUT_SCOPES } from '../ids.js';
import type { PostgresSalesStore } from '../workspace/store.js';
import { normalizeMessage } from './confirmation-grammar.js';
import type { ConversationThreadEntry, ConversationThreadReader } from './quote-v4.js';

/**
 * Checkout capabilities (R4_CHECKOUT_INTEGRATION_CONTRACT R-2). R4 is a client: Checkout decides sessions, attempts,
 * link expiry, financial status and orders; Quote prepares the cart. These capabilities only
 *   - check what R4 itself must know first (the quote was issued in this conversation and is valid, the customer
 *     explicitly asked to pay, the consent artifact exists),
 *   - send Checkout's own commands under keys derived from the execution key (§5.1), reading before posting (§5.3),
 *   - map Checkout's views to the deterministic status of §6, and
 *   - hand a usable payment link to the platform as a NOTICE (R-4): the model never sees or writes the URL (§8).
 * No payment outcome is ever taken from the conversation: only Checkout's reads produce a status.
 */

/** The platform notice key of a payment link: one notice per Checkout attempt. */
export const checkoutLinkNoticeKey = (paymentAttemptId: string) => `checkout.link:${paymentAttemptId}`;

/** What the capability queues for delivery (the single delivery owner sends it; `createPlatformNotice` of the production store). */
export interface PlatformNoticeSink {
  createPlatformNotice(command: { readonly taskId: string; readonly noticeKey: string; readonly text: string; readonly correlationId: string }): Promise<{ readonly replayed: boolean }>;
}

export interface CheckoutCapabilityDeps {
  readonly store: PostgresSalesStore;
  /** Checkout, its commands behind the kill switch. */
  readonly checkout: CheckoutService;
  /** Quote V2 (reads only here): the quote must be issued and valid before a purchase starts. */
  readonly quotes: QuoteV2Service;
  readonly consent: CheckoutConsentSource;
  readonly conversation: ConversationThreadReader;
  readonly notices: PlatformNoticeSink;
  readonly now?: () => Date;
  /** Tests: polling bounds and the wait between reads. */
  readonly poll?: { readonly intervalMs: number; readonly prepareMaxMs: number; readonly linkMaxMs: number; readonly sleep?: (ms: number) => Promise<void> };
}

const DEFAULT_POLL = { intervalMs: 1_500, prepareMaxMs: 20_000, linkMaxMs: 30_000 };

/**
 * (D7-6, sandbox) At most this many autonomous Checkout financial operations per task: one session (start) and one
 * payment attempt (link). Replays of the same execution never count again (store.checkoutFinancialOperations); a new
 * link after an expired one would be a third operation and is refused (a person continues).
 */
export const CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK = 2;

async function financialLimitReached(deps: CheckoutCapabilityDeps, taskId: string, executionKey: string): Promise<Rejected | null> {
  const used = await deps.store.checkoutFinancialOperations(taskId, executionKey);
  if (used < CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK) return null;
  return rejected('financial_write_limit', `this conversation already used its ${CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK} autonomous payment operations; a person continues`, { used, limit: CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK });
}
export const CHECKOUT_WRITE_TIMEOUT_MS = 75_000;

// ---------------------------------------------------------------------------------------------- purchase grammar

export const PURCHASE_GRAMMAR_VERSION = 'r4-sales-purchase-es-v1';
const PURCHASE_REQUESTS: ReadonlySet<string> = new Set([
  'quiero pagar', 'quiero comprar', 'quiero comprarlo', 'quiero comprarla', 'lo compro', 'la compro', 'compro', 'pagar', 'quiero pagarlo', 'quiero pagarla',
  'envíame el link de pago', 'enviame el link de pago', 'mandame el link de pago', 'mándame el link de pago', 'quiero el link de pago', 'el link de pago', 'link de pago',
  'quiero un link nuevo', 'quiero un nuevo link', 'mandame otro link', 'enviame otro link', 'otro link de pago', 'nuevo link de pago',
].map(normalizeMessage));
const AFFIRMATIONS = ['si', 'ok', 'dale', 'perfecto', 'listo', 'claro', 'si claro'];
const COURTESY = ['', 'por favor', 'porfa', 'gracias'];
const PURCHASE_DISQUALIFIERS = /\b(no|nunca|todavia|aun|pero|aunque|cambia|cambiar|despues|luego|espera|esperar|quizas|tal vez|creo|cuanto|cuando|que pasa)\b/;

/**
 * Whether one customer message is an explicit, unconditional request to pay (`[AFFIRMATION] REQUEST [COURTESY]`
 * over a closed phrase list). Questions, conditions and anything outside the list are not. Pure and deterministic.
 */
export function isExplicitPurchaseRequest(text: string | null): boolean {
  if (text === null || text.length > 120 || /[?¿]/.test(text)) return false;
  const n = normalizeMessage(text);
  if (n === '' || PURCHASE_DISQUALIFIERS.test(n)) return false;
  for (const a of ['', ...AFFIRMATIONS]) {
    for (const c of COURTESY) {
      const core = n.slice(a ? a.length + 1 : 0, c ? n.length - c.length - 1 : n.length).trim();
      if ((a === '' || n.startsWith(`${a} `)) && (c === '' || n.endsWith(` ${c}`)) && PURCHASE_REQUESTS.has(core)) return true;
    }
  }
  return false;
}

/** The latest contact message after `since` (exclusive), when it is an explicit purchase request. */
function explicitRequestSince(thread: readonly ConversationThreadEntry[], since: string): ConversationThreadEntry | null {
  const after = thread.filter((e) => e.kind === 'contact' && Date.parse(e.at) > Date.parse(since));
  const last = after[after.length - 1];
  return last && isExplicitPurchaseRequest(last.text) ? last : null;
}

// ---------------------------------------------------------------------------------------------- outputs

const purchaseStatus = z.enum(CHECKOUT_PURCHASE_STATUSES);
/** What the model may know of a purchase: never the URL, the consent, a PrestaShop id or Checkout's internal reasons. */
export const checkoutStatusOutput = z.strictObject({
  sessionFound: z.boolean(),
  status: purchaseStatus.nullable(),
  /** True only for ORDER_COMPLETED / PAYMENT_ACCREDITED_ORDER_PROCESSING (§6): the only basis to say "paid". */
  paymentAccredited: z.boolean(),
  orderReference: z.string().nullable(),
  amountClp: z.int().nonnegative().nullable(),
  linkExpiresAt: z.string().nullable(),
  /** The platform queued (or already had queued) the link message for the current attempt; not_checked by a status read. */
  linkNotice: z.enum(['queued', 'already_queued', 'not_available', 'not_checked']),
  quoteId: z.string().nullable(),
});
export type CheckoutStatusOutput = z.infer<typeof checkoutStatusOutput>;

const NOT_FOUND_STATUS: CheckoutStatusOutput = { sessionFound: false, status: null, paymentAccredited: false, orderReference: null, amountClp: null, linkExpiresAt: null, linkNotice: 'not_available', quoteId: null };

function statusOutput(session: CheckoutSessionView, attempts: readonly CheckoutAttemptView[], reference: string | null, linkNotice: CheckoutStatusOutput['linkNotice']): CheckoutStatusOutput {
  const status = checkoutPurchaseStatus(session, attempts);
  const latest = latestCheckoutAttempt(attempts);
  return {
    sessionFound: true,
    status,
    paymentAccredited: CHECKOUT_ACCREDITED_STATUSES.has(status),
    orderReference: status === 'ORDER_COMPLETED' ? reference : null,
    amountClp: Number(session.amount.amountMinor),
    linkExpiresAt: status === 'PAYMENT_LINK_AVAILABLE' && latest ? latest.expiresAt : null,
    linkNotice,
    quoteId: session.quote.quoteId,
  };
}

// ---------------------------------------------------------------------------------------------- shared

const writeDefinition = (capabilityId: string, description: string) => ({
  capabilityId,
  version: 1,
  description,
  owner: 'checkout',
  riskClass: 'FINANCIAL' as const,
  requiredScopes: [CHECKOUT_SCOPES.purchase],
  identityRequirement: 'provisional' as const,
  confirmationPolicy: 'none' as const,
  approvalPolicy: 'none' as const,
  idempotency: 'key_required' as const,
  retryPolicy: { maxAttempts: 3, initialBackoffMs: 1_000 },
  timeoutMs: CHECKOUT_WRITE_TIMEOUT_MS,
  freshnessTtlMs: null,
  auditLevel: 'full' as const,
});

type Rejected = Extract<WriteExecutionResult<never>, { status: 'rejected' }>;
const rejected = (code: string, message: string, details: Record<string, string | number | boolean | null> = {}): Rejected => ({ status: 'rejected', code, message, details });

/**
 * A Checkout failure as a write result (§7). Definitive refusals → rejected (no effect, never retried); a transient
 * failure before anything was sent → failed; a lost answer or a command still running → unknown (the platform
 * replays the SAME key: Checkout returns the original operation, never a second one).
 */
function checkoutFailure(error: unknown): WriteExecutionResult<never> {
  if (!(error instanceof DomainError)) throw error;
  if (error.outcomeUnknown) return { status: 'unknown', message: `Checkout outcome unknown (${error.code}); the same key is replayed` };
  if (error.category === 'temporarily_unavailable') return { status: 'failed', code: 'checkout_unavailable', message: error.message, details: { checkoutCode: error.code, retryable: true } };
  return rejected(`checkout_${checkoutErrorAction(error.code)}`, `Checkout refused (${error.code})`, { checkoutCode: error.code, action: checkoutErrorAction(error.code) });
}

const callOptions = (context: WriteHandlerContext) => ({ signal: context.signal, correlationId: context.execution.correlationId });

function sleeper(deps: CheckoutCapabilityDeps): (ms: number) => Promise<void> {
  return deps.poll?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
const SANTIAGO_TIME = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hour12: false });

/** The platform-rendered link message (§8): Checkout's URL, amount and expiry, never model text. Sandbox only. */
export function checkoutLinkNoticeText(attempt: CheckoutAttemptView): string {
  return [
    `Este es tu link de pago de Mercado Pago (ambiente de prueba) por ${CLP.format(Number(attempt.amount.amountMinor))}:`,
    attempt.checkoutUrl!,
    `Vence a las ${SANTIAGO_TIME.format(new Date(attempt.expiresAt))} (hora de Chile). Si vence, puedes pedir uno nuevo.`,
  ].join('\n');
}

/**
 * Queues the link notice when the attempt's link is usable under §8 (Checkout's flag says unexpired, R4's clock leaves
 * at least the safety margin, the URL is an https Mercado Pago URL without userinfo or port). Idempotent per attempt.
 */
async function deliverLink(deps: CheckoutCapabilityDeps, context: WriteHandlerContext, attempt: CheckoutAttemptView | null, now: Date): Promise<CheckoutStatusOutput['linkNotice']> {
  if (!attempt || attempt.status !== 'LINK_AVAILABLE' || attempt.linkExpired || attempt.checkoutUrl === null) return 'not_available';
  if (!checkoutLinkIsDeliverable(attempt.checkoutUrl) || Date.parse(attempt.expiresAt) - CHECKOUT_LINK_SAFETY_MARGIN_MS <= now.getTime()) return 'not_available';
  const { replayed } = await deps.notices.createPlatformNotice({ taskId: context.execution.taskId, noticeKey: checkoutLinkNoticeKey(attempt.paymentAttemptId), text: checkoutLinkNoticeText(attempt), correlationId: context.execution.correlationId });
  return replayed ? 'already_queued' : 'queued';
}

// ---------------------------------------------------------------------------------------------- checkout.start_purchase@1

export const checkoutStartPurchaseInput = z.strictObject({ quoteId: z.uuid() });
export type CheckoutStartPurchaseInput = z.infer<typeof checkoutStartPurchaseInput>;

/**
 * checkout.start_purchase@1 (O1/O2) — FINANCIAL. First attempt: the quote must have been issued in THIS conversation
 * (sales.quote_v2_issued) and Quote must still report it issued and valid; the customer's latest message after the
 * issuance must be an explicit purchase request (platform-recorded); a consent artifact must be obtainable for that
 * quote. Then the create-session body is frozen (0010). Every attempt: create the session (key `session`), prepare it
 * when CREATED (key `prepare`; Quote builds the cart), then read it until it leaves CREATED/PREPARING (a replay
 * returns the stored answer, so the state always comes from a read).
 */
export function checkoutStartPurchaseCapability(deps: CheckoutCapabilityDeps): WriteCapabilityRegistration<CheckoutStartPurchaseInput, CheckoutStatusOutput> {
  const now = deps.now ?? (() => new Date());
  return {
    definition: writeDefinition(
      CHECKOUT_CAPABILITY_IDS.startPurchase,
      'Starts the purchase of a quote issued in this conversation (quote.create observation), only after the customer explicitly asked to pay it in their latest message ("quiero pagar", "envíame el link de pago"). Checkout verifies the quote, the buyer and the cart; it answers a status, never a payment. Rejected with nothing sent when the quote is not this conversation\'s, is no longer valid, the customer did not ask, or no purchase consent can be issued. Then call checkout.request_payment_link.',
    ),
    recovery: 'idempotent_replay',
    input: checkoutStartPurchaseInput,
    output: checkoutStatusOutput,
    async execute(input, context) {
      const taskId = context.execution.taskId;
      let record = await deps.store.checkoutPurchaseRequest(context.executionKey);
      if (!record) {
        const limited = await financialLimitReached(deps, taskId, context.executionKey);
        if (limited) return limited;
        const issued = (await deps.store.quoteV2Issued(taskId)).find((q) => q.quoteId === input.quoteId);
        if (!issued) return rejected('quote_not_in_conversation', 'only a quote issued in this conversation can be bought');
        let quoteVersion: number;
        try {
          const quote = await deps.quotes.getQuote(input.quoteId, callOptions(context));
          if (quote.status !== 'issued') return rejected('checkout_not_purchasable', `the quote is ${quote.status}`, { quoteStatus: quote.status });
          if (!quote.validity || Date.parse(quote.validity.validUntilExclusive) <= now().getTime()) return rejected('checkout_not_purchasable', 'the quote is no longer valid; a new quote is needed');
          quoteVersion = quote.version;
        } catch (error) {
          if (error instanceof DomainError) return { status: 'failed', code: 'quote_unavailable', message: error.message, details: { category: error.category, retryable: error.retryable } };
          throw error;
        }
        const request = explicitRequestSince(await deps.conversation.thread(taskId), issued.issuedAt);
        if (!request) return rejected('purchase_not_requested', 'the customer\'s latest message after the quote is not an explicit request to pay', { grammar: PURCHASE_GRAMMAR_VERSION });
        const consent = await deps.consent.obtain({ taskId, quoteId: input.quoteId, quoteVersion }, callOptions(context));
        if (!consent) return rejected('purchase_consent_unavailable', 'no purchase consent artifact can be issued for this buyer (contract R-3)');
        record = await deps.store.recordCheckoutPurchaseRequest({ executionKey: context.executionKey, taskId, quoteId: input.quoteId, quoteVersion, consent });
      }
      try {
        const created = await deps.checkout.createSession({ quoteId: record.quoteId, quoteVersion: record.quoteVersion, consent: record.consent }, checkoutIdempotencyKey(context.executionKey, 'session'), callOptions(context));
        const sessionId = created.view.sessionId;
        await deps.store.recordCheckoutSession({ executionKey: context.executionKey, taskId, sessionId });
        let session = await deps.checkout.getSession(sessionId, callOptions(context));
        if (session.status === 'CREATED') {
          await deps.checkout.prepareSession(sessionId, checkoutIdempotencyKey(context.executionKey, 'prepare'), callOptions(context));
          session = await deps.checkout.getSession(sessionId, callOptions(context));
        }
        const poll = { ...DEFAULT_POLL, ...deps.poll };
        const sleep = sleeper(deps);
        for (let waited = 0; (session.status === 'CREATED' || session.status === 'PREPARING') && waited < poll.prepareMaxMs; waited += poll.intervalMs) {
          await sleep(poll.intervalMs);
          session = await deps.checkout.getSession(sessionId, callOptions(context));
        }
        const attempts = await deps.checkout.listPaymentAttempts(sessionId, callOptions(context));
        return { status: 'applied', result: statusOutput(session, attempts, null, 'not_available'), resourceRef: `checkout-session:${sessionId}`, replayed: created.replayed };
      } catch (error) {
        return checkoutFailure(error);
      }
    },
    // Read-only: the session, when Checkout already answered one for this key; otherwise the platform replays the same key.
    reconcile: async (context) => reconcileByRead(deps, context, async () => (await deps.store.checkoutPurchaseRequest(context.executionKey)) !== null),
  };
}

// ---------------------------------------------------------------------------------------------- checkout.request_payment_link@1

export const checkoutRequestLinkInput = z.strictObject({});
export type CheckoutRequestLinkInput = z.infer<typeof checkoutRequestLinkInput>;

/** Attempt states during which a new attempt is never requested (§5.3): R4 reports or uses the open one. */
const OPEN_ATTEMPT = new Set(['CREATED', 'LINK_AVAILABLE', 'PROCESSING']);
const RESOLVED_WITHOUT_PAYMENT = new Set(['FAILED', 'CANCELED', 'EXPIRED']);

/**
 * checkout.request_payment_link@1 (O3) — FINANCIAL, read first (§5.3). For the conversation's purchase in course:
 *   - an open attempt (CREATED, PROCESSING, or LINK_AVAILABLE and unexpired) is reported or its link re-delivered; nothing is posted;
 *   - a new attempt (key `link`) only when the session is READY and there is no attempt, or the latest one is FAILED,
 *     CANCELED or EXPIRED and the customer explicitly asked again after it;
 *   - then the attempts are read until the link appears (at most 30 s) and the platform queues the link notice.
 * ACTION_REQUIRED, an accredited payment or any state outside these rules posts nothing.
 */
export function checkoutRequestLinkCapability(deps: CheckoutCapabilityDeps): WriteCapabilityRegistration<CheckoutRequestLinkInput, CheckoutStatusOutput> {
  const now = deps.now ?? (() => new Date());
  return {
    definition: writeDefinition(
      CHECKOUT_CAPABILITY_IDS.requestPaymentLink,
      'Gets the Mercado Pago payment link of the purchase in course (checkout.start_purchase first). Reads Checkout first: an open link is re-sent, never duplicated; a new link only after the previous one expired, was cancelled or failed AND the customer asked again in their latest message. The platform sends the link message itself: you never see, write or repeat the URL, the amount or the expiry yourself; say only that the link was sent (linkNotice) and that payment is confirmed only when checkout.purchase_status says so. Refused with financial_write_limit when this conversation already used its payment operations: then say a person of the team will continue.',
    ),
    recovery: 'idempotent_replay',
    input: checkoutRequestLinkInput,
    output: checkoutStatusOutput,
    async execute(_input, context) {
      const taskId = context.execution.taskId;
      const options = callOptions(context);
      let request = await deps.store.checkoutLinkRequest(context.executionKey);
      if (!request) {
        const purchase = await deps.store.latestCheckoutSession(taskId);
        if (!purchase) return rejected('no_purchase_in_course', 'start the purchase first (checkout.start_purchase)');
        request = await deps.store.recordCheckoutLinkRequest({ executionKey: context.executionKey, taskId, sessionId: purchase.sessionId });
      }
      const { sessionId } = request;
      try {
        let session = await deps.checkout.getSession(sessionId, options);
        let attempts = await deps.checkout.listPaymentAttempts(sessionId, options);
        let latest = latestCheckoutAttempt(attempts);
        const status = checkoutPurchaseStatus(session, attempts);
        // Never a payment operation on a purchase that needs a person, is paid, or is no longer purchasable.
        if (status === 'HUMAN_INTERVENTION_REQUIRED' || CHECKOUT_ACCREDITED_STATUSES.has(status) || status === 'NOT_PURCHASABLE') {
          return { status: 'applied', result: statusOutput(session, attempts, null, 'not_available'), resourceRef: `checkout-session:${sessionId}` };
        }
        const openAttempt = latest !== null && OPEN_ATTEMPT.has(latest.status) && !(latest.status === 'LINK_AVAILABLE' && latest.linkExpired);
        if (!openAttempt) {
          if (session.status !== 'READY' && session.status !== 'PAYMENT_PENDING') return rejected('checkout_not_ready', `the purchase is ${status}; no link can be requested now`, { status });
          if (latest !== null && !RESOLVED_WITHOUT_PAYMENT.has(latest.status)) return rejected('checkout_attempt_unresolved', `the latest payment attempt is ${status}; Checkout is still reconciling it`, { status });
          if (latest !== null && !explicitRequestSince(await deps.conversation.thread(taskId), latest.createdAt)) {
            return rejected('new_link_not_requested', 'a new link needs the customer to ask again after the previous one ended', { status, grammar: PURCHASE_GRAMMAR_VERSION });
          }
          const limited = await financialLimitReached(deps, taskId, context.executionKey);
          if (limited) return limited;
          const created = await deps.checkout.createPaymentAttempt(sessionId, checkoutIdempotencyKey(context.executionKey, 'link'), options);
          await deps.store.recordCheckoutLinkAttempt({ executionKey: context.executionKey, taskId, paymentAttemptId: created.view.paymentAttemptId });
          attempts = await deps.checkout.listPaymentAttempts(sessionId, options);
          latest = latestCheckoutAttempt(attempts);
        }
        // The link appears asynchronously (§3 O3): wait for an attempt still being issued — this execution's, or one an
        // earlier answer-lost attempt of the same key already created — at most linkMaxMs.
        if (latest?.status === 'CREATED' && !latest.linkExpired) {
          const poll = { ...DEFAULT_POLL, ...deps.poll };
          const sleep = sleeper(deps);
          for (let waited = 0; latest?.status === 'CREATED' && !latest.linkExpired && waited < poll.linkMaxMs; waited += poll.intervalMs) {
            await sleep(poll.intervalMs);
            attempts = await deps.checkout.listPaymentAttempts(sessionId, options);
            latest = latestCheckoutAttempt(attempts);
          }
          session = await deps.checkout.getSession(sessionId, options);
        }
        const notice = await deliverLink(deps, context, latest, now());
        return { status: 'applied', result: statusOutput(session, attempts, null, notice), resourceRef: `checkout-session:${sessionId}` };
      } catch (error) {
        return checkoutFailure(error);
      }
    },
    reconcile: async (context) => reconcileByRead(deps, context, async () => (await deps.store.checkoutLinkRequest(context.executionKey)) !== null),
  };
}

/** Reconciliation never sends a command: without a frozen request nothing was sent; otherwise the platform replays the same key. */
async function reconcileByRead(_deps: CheckoutCapabilityDeps, _context: WriteHandlerContext, frozen: () => Promise<boolean>): Promise<WriteReconciliationResult<CheckoutStatusOutput>> {
  if (!(await frozen())) return { status: 'not_applied' };
  return { status: 'unknown', message: 'a Checkout command was frozen for this key; replaying the same key returns its original outcome' };
}

// ---------------------------------------------------------------------------------------------- checkout.purchase_status@1

/**
 * checkout.purchase_status@1 (O4) — READ. Checkout's session, attempts and orders mapped by §6. The only basis for
 * telling the customer that a payment was accredited or an order confirmed; a customer's "ya pagué" changes nothing.
 */
export function checkoutPurchaseStatusCapability(deps: Pick<CheckoutCapabilityDeps, 'store' | 'checkout'>): CapabilityRegistration<Record<string, never>, CheckoutStatusOutput> {
  return {
    definition: {
      capabilityId: CHECKOUT_CAPABILITY_IDS.purchaseStatus,
      version: 1,
      description:
        'Reads the payment and order status of the purchase in course from Checkout. Say that a payment was accredited only when paymentAccredited is true, and that the order is confirmed (with orderReference) only when status is ORDER_COMPLETED. PAYMENT_PENDING: the payment is in process. LINK_EXPIRED: the link expired and a new one can be requested; LINK_EXPIRED_PROVISIONAL: never say the customer did not pay. HUMAN_INTERVENTION_REQUIRED: a person will review the purchase; claim nothing about the payment. A customer saying they paid is never evidence: read this.',
      owner: 'checkout',
      riskClass: 'READ',
      requiredScopes: [CHECKOUT_SCOPES.read],
      identityRequirement: 'none',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'inherent',
      retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
      timeoutMs: 20_000,
      freshnessTtlMs: 30_000,
      auditLevel: 'standard',
    },
    input: z.strictObject({}),
    output: checkoutStatusOutput,
    handler: async (_input, context) => {
      const purchase = await deps.store.latestCheckoutSession(context.execution.taskId);
      if (!purchase) return NOT_FOUND_STATUS;
      try {
        const options = { signal: context.signal, correlationId: context.execution.correlationId };
        const session = await deps.checkout.getSession(purchase.sessionId, options);
        const attempts = await deps.checkout.listPaymentAttempts(purchase.sessionId, options);
        const reference = session.status === 'COMPLETED' ? ((await deps.checkout.getOrders(purchase.sessionId, options)).orders[0]?.reference ?? null) : null;
        return statusOutput(session, attempts, reference, 'not_checked');
      } catch (error) {
        if (error instanceof DomainError) throw new CapabilityFailure(error.message, { category: error.category, code: error.code, retryable: error.retryable });
        throw error;
      }
    },
  };
}

export type { CheckoutPurchaseStatus };
