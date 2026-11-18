import { createHash } from 'node:crypto';
import { normalizeMessage } from './confirmation-grammar.js';
import type { ConversationThreadEntry } from './quote-v4.js';

/**
 * F2 increment R01 (docs/architecture/R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md §5): the customer's purchase act,
 * derived deterministically from the conversation the platform recorded — the same provenance as quote acceptance
 * (ADR-035): `contact` entries come only from the authenticated channel ingress, never from the model.
 *
 * O-5 (approved 2026-11-18): Checkout issues the purchase-consent evidence from this act, which R4 records and
 * transmits. R4 signs nothing and issues nothing (R-3). checkout.start_purchase@1 records it (Sales 0012, F2-R02) only
 * when its `purchaseActRecording` dependency is exactly `true`; no production profile or app sets it (contract test
 * f2-purchase-boundaries).
 */

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

/** One quote issued in this conversation, as R4 recorded it (sales.quote_v2_issued; never model arguments). */
export interface PurchaseActIssuedQuote {
  readonly quoteId: string;
  /**
   * When R4 recorded the issuance (`recorded_at`, the database clock that also stamps the customer's inputs): the
   * customer cannot have reacted to a quote before R4 had it. Never Quote's own `issuedAt` (another clock).
   */
  readonly recordedAt: string;
}

/** The quote the act is about: the issued quote, its current version and validity as Quote reports them. */
export interface PurchaseActQuote extends PurchaseActIssuedQuote {
  readonly quoteVersion: number;
  readonly validUntilExclusive: string;
}

/** Identities, platform times and a hash only: never the customer's text, customerRef, grant or any PrestaShop id. */
export interface PurchaseActEvidence {
  readonly quoteId: string;
  readonly quoteVersion: number;
  readonly quoteRecordedAt: string;
  readonly requestInputId: string;
  readonly requestAt: string;
  readonly requestTextSha256: string;
  readonly grammarVersion: string;
}

export type PurchaseActRefusal = 'no_request_after_issuance' | 'not_explicit' | 'superseded_by_later_quote' | 'outside_validity' | 'input_id_missing';
export type PurchaseActVerdict = { readonly status: 'recorded'; readonly evidence: PurchaseActEvidence } | { readonly status: 'refused'; readonly code: PurchaseActRefusal };

/**
 * The customer's LATEST message after R4 recorded the quote must be an explicit, unconditional request to pay
 * (`r4-sales-purchase-es-v1`), with no OTHER quote of the conversation recorded between that quote and the message (the
 * request is about the latest quote the customer saw, not one the model picks), received while the quote is valid,
 * with a platform input id. Pure: same thread and quotes, same verdict.
 *
 * Limit: "recorded by R4" is not "seen by the customer"; F2-R10 (a deterministic purchase notice immediately before
 * the act) closes that gap and is a prerequisite for transmitting the act (F2-R11) or enabling the recording.
 */
export function purchaseActEvidence(thread: readonly ConversationThreadEntry[], quote: PurchaseActQuote, issued: readonly PurchaseActIssuedQuote[]): PurchaseActVerdict {
  const anchor = Date.parse(quote.recordedAt);
  const contacts = thread.filter((e) => e.kind === 'contact' && Date.parse(e.at) > anchor);
  const last = contacts[contacts.length - 1];
  if (!last) return { status: 'refused', code: 'no_request_after_issuance' };
  if (!isExplicitPurchaseRequest(last.text)) return { status: 'refused', code: 'not_explicit' };
  const at = Date.parse(last.at);
  if (issued.some((q) => q.quoteId !== quote.quoteId && Date.parse(q.recordedAt) > anchor && Date.parse(q.recordedAt) <= at)) return { status: 'refused', code: 'superseded_by_later_quote' };
  if (at >= Date.parse(quote.validUntilExclusive)) return { status: 'refused', code: 'outside_validity' };
  const inputId = last.refs.inputId;
  if (!inputId) return { status: 'refused', code: 'input_id_missing' };
  return {
    status: 'recorded',
    evidence: {
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      quoteRecordedAt: quote.recordedAt,
      requestInputId: inputId,
      requestAt: last.at,
      requestTextSha256: createHash('sha256').update(last.text ?? '', 'utf8').digest('hex'),
      grammarVersion: PURCHASE_GRAMMAR_VERSION,
    },
  };
}
