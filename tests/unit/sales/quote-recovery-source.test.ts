import { describe, expect, it } from 'vitest';
import { contextContributionSchema } from '@r4/contracts';
import type { ContextSourceRequest } from '@r4/context-compiler';
import { FixtureQuoteV2Service, type QuoteV2CreateRequest } from '@r4-adapters/domains';
import { SalesQuoteRecoveryContextSource, type ConversationQuoteRecord } from '@r4-sales/agent';
import { loadQuoteRecovery } from '@r4-sales/agent/production';

/** M3 — the conversation's earlier quotes with their CURRENT Quote V2 state (fixture owner, injected clock, fake stores). */

const CURRENT = '01a19ddb-0000-7000-8000-000000000003';
const EARLIER = '01a19ddb-0000-7000-8000-000000000002';
const ISSUED_AT = new Date('2026-11-10T15:00:00.000Z');

const REQUEST: QuoteV2CreateRequest = {
  externalCorrelation: { sourceSystem: 'r4' },
  customer: { kind: 'guest' },
  lines: [{ kind: 'product', item: { sourceSystem: 'catalog', productRef: 'p1', description: 'Barra Z 120 cm' }, quantity: { value: '2', unit: 'unit' }, unitPrice: { amount: 29_990, taxBasis: 'included', taxRate: '0.19' } }],
  shipping: { carrier: { name: 'Fixture Courier' }, destination: { commune: 'Ñuñoa', country: 'CL' }, amount: { amount: 4_000, taxBasis: 'excluded', taxRate: '0.19' } },
};

async function world(count = 1) {
  let now = ISSUED_AT;
  const quotes = new FixtureQuoteV2Service({ now: () => now });
  const records: ConversationQuoteRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const { quote } = await quotes.createAndIssue(REQUEST, `key-${i}`);
    records.unshift({
      taskId: i === 0 ? EARLIER : CURRENT, quoteId: quote.quoteId, quoteNumber: quote.quoteNumber!, issuedAt: quote.issuance!.issuedAt,
      validThroughLocalDate: quote.validity!.validThroughLocalDate, validUntilExclusive: quote.validity!.validUntilExclusive, request: REQUEST,
      snapshotLines: i === 0 ? null : [{ itemKey: 'BAR-EZ', description: 'Barra Z 120 cm', quantity: 2 }],
    });
  }
  let reads = 0;
  const getQuote = quotes.getQuote.bind(quotes);
  const asked: { taskIds: readonly string[]; since: string; limit: number }[] = [];
  const source = new SalesQuoteRecoveryContextSource({
    conversation: { earlierConversationTasks: (taskId, max) => (expect(taskId).toBe(CURRENT), expect(max).toBe(10), Promise.resolve([EARLIER])) },
    sales: { conversationQuotes: (taskIds, o) => (asked.push({ taskIds, ...o }), Promise.resolve(records.filter((r) => r.issuedAt >= o.since).slice(0, o.limit))) },
    quotes: { getQuote: (...a) => ((reads += 1), getQuote(...a)) },
    ownerTimeoutMs: 50,
  });
  const load = async (run = 'run-1', taskType = 'sales.conversation') => {
    const items = await source.load({ now, execution: { task: { taskId: CURRENT, taskType }, run: { runId: run } } } as unknown as ContextSourceRequest);
    for (const item of items) contextContributionSchema.parse(item);
    return items;
  };
  const view = async (run?: string) => ((await load(run))[0]!.content as { quotes: Record<string, unknown>[]; olderQuotesOmitted: boolean });
  return { quotes, records, asked, view, load, reads: () => reads, at: (iso: string) => (now = new Date(iso)) };
}

describe('SalesQuoteRecoveryContextSource (M3)', () => {
  it('contributes nothing without an issued quote in the conversation, and nothing for another task type', async () => {
    const w = await world(0);
    expect(await w.load()).toEqual([]);
    expect(w.reads()).toBe(0);
    const v = await world(1);
    expect(await v.load('run-1', 'other.type')).toEqual([]);
  });

  it('shows an issued quote as the owner reports it now: valid, its total, items and delivery, one AUTHORITATIVE live state item', async () => {
    const w = await world(1);
    const [item] = await w.load();
    expect(item).toMatchObject({ itemId: `sales_quotes:${CURRENT}`, kind: 'state', authority: 'AUTHORITATIVE', temporality: 'live', required: true, taskId: CURRENT });
    const [q] = (item!.content as { quotes: Record<string, unknown>[] }).quotes;
    expect(q).toMatchObject({ quoteNumber: 'PC-000001', earlierTask: true, state: 'issued', stateFrom: 'quote_owner', stillValid: true, validThroughLocalDate: '2026-11-14', totalGrossClp: w.quotes.quotes[0]!.totals.gross });
    expect(q!.items).toEqual([{ itemKey: null, description: 'Barra Z 120 cm', quantity: 2 }]);
    expect(q!.delivery).toEqual({ commune: 'Ñuñoa', carrierName: 'Fixture Courier' });
    // Only this conversation's lineage is asked for, within the window, one more than shown.
    expect(w.asked).toEqual([{ taskIds: [CURRENT, EARLIER], since: '2026-10-11T15:00:00.000Z', limit: 4 }]);
  });

  it('an owner answer cached as issued reads as expired once the validity ends within the same run', async () => {
    const w = await world(1);
    expect((await w.view('run-1')).quotes[0]).toMatchObject({ state: 'issued', stillValid: true });
    w.at('2026-11-15T03:00:00.000Z');
    expect((await w.view('run-1')).quotes[0]).toMatchObject({ state: 'expired', stillValid: false, stateFrom: 'quote_owner' });
    expect(w.reads()).toBe(1);
  });

  it('after the validity ends the owner reports it expired: no longer valid (a new run reads the owner again)', async () => {
    const w = await world(1);
    expect((await w.view('run-1')).quotes[0]).toMatchObject({ state: 'issued', stillValid: true });
    w.at('2026-11-15T04:00:00.000Z');
    expect((await w.view('run-2')).quotes[0]).toMatchObject({ state: 'expired', stillValid: false, stateFrom: 'quote_owner' });
  });

  it('reads the owner once per quote per run (the context is compiled every iteration)', async () => {
    const w = await world(2);
    await w.load('run-1');
    await w.load('run-1');
    expect(w.reads()).toBe(2);
    await w.load('run-2');
    expect(w.reads()).toBe(4);
  });

  it('an unreachable owner degrades to R4\'s record: unknown before the recorded validity ends, not valid after it — never a guess', async () => {
    const w = await world(1);
    w.quotes.availability.set({ mode: 'down' });
    expect((await w.view('run-1')).quotes[0]).toMatchObject({ state: 'unknown', stateFrom: 'r4_record', stillValid: null });
    expect((await w.view('run-1')).quotes[0]).not.toHaveProperty('totalGrossClp');
    w.at('2026-11-15T04:00:00.000Z');
    expect((await w.view('run-2')).quotes[0]).toMatchObject({ state: 'unknown', stateFrom: 'r4_record', stillValid: false });
    // A slow owner past the deadline is the same.
    w.quotes.availability.set({ mode: 'slow', delayMs: 500 });
    w.at('2026-11-10T16:00:00.000Z');
    expect((await w.view('run-3')).quotes[0]).toMatchObject({ stateFrom: 'r4_record', stillValid: null });
  });

  it('is bounded to the 3 newest quotes, newest first, and says older ones were left out; an autonomous quote carries the workspace item key', async () => {
    const w = await world(5);
    const v = await w.view();
    expect(v.quotes.map((q) => q.quoteNumber)).toEqual(['PC-000005', 'PC-000004', 'PC-000003']);
    expect(v.olderQuotesOmitted).toBe(true);
    expect(v.quotes[0]).toMatchObject({ earlierTask: false, items: [{ itemKey: 'BAR-EZ', description: 'Barra Z 120 cm', quantity: 2 }] });
    expect(w.reads()).toBe(3);
  });

  it('R4_SALES_QUOTE_RECOVERY is off by default and fails closed on anything but enabled/disabled', () => {
    expect(loadQuoteRecovery({})).toBe(false);
    expect(loadQuoteRecovery({ R4_SALES_QUOTE_RECOVERY: 'enabled' })).toBe(true);
    expect(loadQuoteRecovery({ R4_SALES_QUOTE_RECOVERY: 'disabled' })).toBe(false);
    expect(() => loadQuoteRecovery({ R4_SALES_QUOTE_RECOVERY: 'yes' })).toThrow(/enabled or disabled/);
  });
});
