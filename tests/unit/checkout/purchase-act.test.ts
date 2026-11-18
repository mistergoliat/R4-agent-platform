import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PURCHASE_GRAMMAR_VERSION, purchaseActEvidence, type ConversationThreadEntry, type PurchaseActIssuedQuote, type PurchaseActQuote } from '@r4-sales/agent';

/** F2-R01/R02: the deterministic purchase-act evidence. Every rule, plus no text and no identifiers in the evidence. */
const quote: PurchaseActQuote = { quoteId: '0199a1b2-0000-7000-8000-000000000001', quoteVersion: 1, recordedAt: '2026-11-18T12:00:00.000Z', validUntilExclusive: '2026-11-18T13:00:00.000Z' };
const only: readonly PurchaseActIssuedQuote[] = [quote];
let n = 0;
const contact = (at: string, text: string | null, inputId: string | null = `in-${++n}`): ConversationThreadEntry => ({ cursor: `${at}|${n}`, at, kind: 'contact', text, refs: { inputId }, delivery: null });
const agent = (at: string, text: string): ConversationThreadEntry => ({ cursor: `${at}|a`, at, kind: 'agent', text, refs: { stepId: 's-1' }, delivery: { outboundId: 'o-1', status: 'accepted' } });

describe('purchaseActEvidence (F2-R01)', () => {
  it('records the latest explicit request after R4 recorded the quote, while the quote is valid', () => {
    const thread = [contact('2026-11-18T11:59:00.000Z', 'quiero pagar'), agent('2026-11-18T12:00:01.000Z', 'Tu cotización está lista'), contact('2026-11-18T12:05:00.000Z', 'sí, quiero pagar por favor', 'in-ok')];
    expect(purchaseActEvidence(thread, quote, only)).toEqual({
      status: 'recorded',
      evidence: {
        quoteId: quote.quoteId,
        quoteVersion: 1,
        quoteRecordedAt: quote.recordedAt,
        requestInputId: 'in-ok',
        requestAt: '2026-11-18T12:05:00.000Z',
        requestTextSha256: createHash('sha256').update('sí, quiero pagar por favor').digest('hex'),
        grammarVersion: PURCHASE_GRAMMAR_VERSION,
      },
    });
  });

  it('a request received before R4 recorded the quote (e.g. while quote.create ran) is not about it', () => {
    expect(purchaseActEvidence([contact('2026-11-18T11:59:59.999Z', 'quiero pagar')], quote, only)).toEqual({ status: 'refused', code: 'no_request_after_issuance' });
  });

  it('a later quote recorded before the request supersedes this one: the request is about the latest quote shown', () => {
    const q2: PurchaseActIssuedQuote = { quoteId: '0199a1b2-0000-7000-8000-000000000002', recordedAt: '2026-11-18T12:03:00.000Z' };
    const thread = [contact('2026-11-18T12:05:00.000Z', 'quiero pagar')];
    expect(purchaseActEvidence(thread, quote, [quote, q2])).toEqual({ status: 'refused', code: 'superseded_by_later_quote' });
    // A quote recorded AFTER the request does not change what the request was about.
    expect(purchaseActEvidence(thread, quote, [quote, { ...q2, recordedAt: '2026-11-18T12:06:00.000Z' }]).status).toBe('recorded');
    // An EARLIER quote never supersedes the later one.
    expect(purchaseActEvidence(thread, quote, [{ ...q2, recordedAt: '2026-11-18T11:00:00.000Z' }, quote]).status).toBe('recorded');
  });

  it('only the LATEST customer message counts: a later question or condition voids an earlier request', () => {
    const thread = [contact('2026-11-18T12:01:00.000Z', 'quiero pagar'), contact('2026-11-18T12:02:00.000Z', '¿y el despacho?')];
    expect(purchaseActEvidence(thread, quote, only)).toEqual({ status: 'refused', code: 'not_explicit' });
    for (const text of ['quiero pagar pero mañana', 'no quiero pagar', 'ok', null]) {
      expect(purchaseActEvidence([contact('2026-11-18T12:03:00.000Z', text)], quote, only)).toEqual({ status: 'refused', code: 'not_explicit' });
    }
  });

  it('refuses a request at or after the quote validity end', () => {
    expect(purchaseActEvidence([contact(quote.validUntilExclusive, 'quiero pagar')], quote, only)).toEqual({ status: 'refused', code: 'outside_validity' });
  });

  it('refuses an entry without a platform input id', () => {
    expect(purchaseActEvidence([contact('2026-11-18T12:05:00.000Z', 'quiero pagar', null)], quote, only)).toEqual({ status: 'refused', code: 'input_id_missing' });
  });

  it('agent and operator messages are never an act', () => {
    const op: ConversationThreadEntry = { cursor: 'x', at: '2026-11-18T12:06:00.000Z', kind: 'operator', text: 'quiero pagar', refs: {}, delivery: null };
    expect(purchaseActEvidence([agent('2026-11-18T12:05:00.000Z', 'quiero pagar'), op], quote, only)).toEqual({ status: 'refused', code: 'no_request_after_issuance' });
  });

  it('is deterministic and the evidence carries no customer text', () => {
    const text = 'Dale, mándame el link de pago gracias';
    const thread = [contact('2026-11-18T12:05:00.000Z', text, 'in-x')];
    const first = purchaseActEvidence(thread, quote, only);
    expect(purchaseActEvidence(thread, quote, only)).toEqual(first);
    expect(first.status).toBe('recorded');
    const serialized = JSON.stringify(first).toLowerCase();
    expect(serialized).not.toContain('link de pago');
    expect(serialized).not.toMatch(/prestashop_customer|customerref|grant/);
  });
});
