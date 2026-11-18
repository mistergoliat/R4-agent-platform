import { createHash } from 'node:crypto';
import { PURCHASE_GRAMMAR_VERSION, isExplicitPurchaseRequest } from './checkout.js';
import type { ConversationThreadEntry } from './quote-v4.js';

/**
 * F2 increment R01 (docs/architecture/R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md §5): the customer's purchase act,
 * derived deterministically from the conversation the platform recorded — the same provenance as quote acceptance
 * (ADR-035): `contact` entries come only from the authenticated channel ingress, never from the model.
 *
 * NOT WIRED: no capability, profile or composition uses this module (a contract test enforces it). It signs nothing,
 * issues nothing and is not a consent artifact (R-3): it is the evidence a consent authority (O-5) will need.
 * Persisting it needs a Sales migration and its own authorization (work item F2-R02).
 */

/** The quote the act is about, as R4 recorded its issuance and Quote reports its validity (never model arguments). */
export interface PurchaseActQuote {
  readonly quoteId: string;
  readonly quoteVersion: number;
  /** When R4 recorded the issuance in this conversation (sales.quote_v2_issued). */
  readonly issuedAt: string;
  /** Quote's own validity end. */
  readonly validUntilExclusive: string;
}

/** Identities, platform times and a hash only: never the customer's text, customerRef, grant or any PrestaShop id. */
export interface PurchaseActEvidence {
  readonly quoteId: string;
  readonly quoteVersion: number;
  readonly quoteIssuedAt: string;
  readonly requestInputId: string;
  readonly requestAt: string;
  readonly requestTextSha256: string;
  readonly grammarVersion: string;
}

export type PurchaseActRefusal = 'no_request_after_issuance' | 'not_explicit' | 'outside_validity' | 'input_id_missing';
export type PurchaseActVerdict = { readonly status: 'recorded'; readonly evidence: PurchaseActEvidence } | { readonly status: 'refused'; readonly code: PurchaseActRefusal };

/**
 * The customer's LATEST message after the issuance must be an explicit, unconditional request to pay
 * (`r4-sales-purchase-es-v1`, the rule checkout.start_purchase@1 already applies), received while the quote is valid,
 * with a platform input id. Pure: same thread and quote, same verdict.
 */
export function purchaseActEvidence(thread: readonly ConversationThreadEntry[], quote: PurchaseActQuote): PurchaseActVerdict {
  const contacts = thread.filter((e) => e.kind === 'contact' && Date.parse(e.at) > Date.parse(quote.issuedAt));
  const last = contacts[contacts.length - 1];
  if (!last) return { status: 'refused', code: 'no_request_after_issuance' };
  if (!isExplicitPurchaseRequest(last.text)) return { status: 'refused', code: 'not_explicit' };
  if (Date.parse(last.at) >= Date.parse(quote.validUntilExclusive)) return { status: 'refused', code: 'outside_validity' };
  const inputId = last.refs.inputId;
  if (!inputId) return { status: 'refused', code: 'input_id_missing' };
  return {
    status: 'recorded',
    evidence: {
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      quoteIssuedAt: quote.issuedAt,
      requestInputId: inputId,
      requestAt: last.at,
      requestTextSha256: createHash('sha256').update(last.text ?? '', 'utf8').digest('hex'),
      grammarVersion: PURCHASE_GRAMMAR_VERSION,
    },
  };
}
