import { describe, expect, it } from 'vitest';
import { quoteDocumentCaption } from '@r4-sales/agent';
import { followUpText, planQuoteFollowUps, SALES_QUOTE_OPT_OUT_LINE, type QuoteFollowUpRow } from '@r4-sales/agent/production';

/** ADR-055 rev. 1: S1 inside the 24 h window, S2 (the one template) 3 days after S1 or 4 days after the quote. */
const H = 3_600_000;
const D = 24 * H;
const LAST = new Date('2026-11-24T18:05:00.000Z');
const row = (hoursAfterLast: number, over: Partial<QuoteFollowUpRow> = {}): QuoteFollowUpRow => ({
  now: new Date(LAST.getTime() + hoursAfterLast * H), taskId: 't1', quoteId: 'Q-UUID', quoteNumber: 'PC-000123', issuedAt: new Date(LAST.getTime() + 60_000),
  validUntilExclusive: new Date(LAST.getTime() + 10 * D), validThroughLocalDate: '2026-12-03', channel: 'whatsapp', conversationKey: 'a'.repeat(64),
  bindingOpen: true, lastInboundAt: LAST, contactLastInboundAt: LAST, idleWaiting: true, idleClosed: false, s1: null, ...over,
});

describe('quote follow-up plan', () => {
  it('S1 from 18 h after the last message, deadline 23 h 30, free text with the inclusive validity date', () => {
    expect(planQuoteFollowUps([row(17.9)], 'observe')).toEqual([]);
    const [s1] = planQuoteFollowUps([row(18)], 'observe');
    expect(s1).toMatchObject({ sourceRef: 'sales.quote-followup:q-uuid:1', noticeKey: 'sales.followup-1:q-uuid', template: null, purpose: 'seguimiento', deadline: new Date(LAST.getTime() + 23.5 * H) });
    expect(s1!.text).toBe(followUpText(1, 'PC-000123', '2026-12-03'));
    expect(s1!.text).toContain('vale hasta el 03-12-2026');
  });

  it('no S1 while the case is busy or closed; after 24 h without S1, S2 waits for 4 days after the quote', () => {
    expect(planQuoteFollowUps([row(19, { idleWaiting: false })], 'observe')).toEqual([]);
    expect(planQuoteFollowUps([row(30, { bindingOpen: false, idleWaiting: false, idleClosed: true })], 'observe')).toEqual([]);
    const [s2] = planQuoteFollowUps([row(4 * 24 + 0.1, { bindingOpen: false, idleWaiting: false, idleClosed: true })], 'observe');
    expect(s2).toMatchObject({ sourceRef: 'sales.quote-followup:q-uuid:2', template: { name: 'seguimiento_cotizacion', language: 'es', parameters: ['PC-000123', '03-12-2026'] } });
  });

  it('S2 3 days after an S1 sent in the same mode, dropped 2 days later; an S1 of the other mode does not count', () => {
    const s1 = { at: new Date(LAST.getTime() + 18 * H), outcome: 'send', mode: 'observe' };
    const closed = { bindingOpen: false, idleWaiting: false, idleClosed: true, s1 };
    expect(planQuoteFollowUps([row(18 + 71.9, closed)], 'observe')).toEqual([]);
    const [s2] = planQuoteFollowUps([row(18 + 72, closed)], 'observe');
    expect(s2!.deadline).toEqual(new Date(s1.at.getTime() + 5 * D));
    expect(planQuoteFollowUps([row(18 + 72, closed)], 'active')).toEqual([]);
  });

  it('the sequence ends when the contact wrote again, the quote expired, or the case ended any other way', () => {
    expect(planQuoteFollowUps([row(19, { contactLastInboundAt: new Date(LAST.getTime() + H) })], 'observe')).toEqual([]);
    expect(planQuoteFollowUps([row(19, { validUntilExclusive: new Date(LAST.getTime() + 19 * H) })], 'observe')).toEqual([]);
    expect(planQuoteFollowUps([row(5 * 24, { bindingOpen: false, idleWaiting: false, idleClosed: false })], 'observe')).toEqual([]);
  });

  it('the quote caption gains the opt-out line only when asked', () => {
    expect(quoteDocumentCaption('PC-1', '2026-12-04T03:00:00.000Z')).not.toContain('BAJA');
    expect(quoteDocumentCaption('PC-1', '2026-12-04T03:00:00.000Z', SALES_QUOTE_OPT_OUT_LINE)).toMatch(/\(hora de Chile\)\.\nSi no quieres que te escribamos, responde BAJA\.$/);
  });
});
