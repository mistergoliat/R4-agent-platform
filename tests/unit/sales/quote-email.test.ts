import { describe, expect, it } from 'vitest';
import { DomainError, type QuoteV2Delivery, type QuoteV2Service } from '@r4-adapters/domains';
import { quoteEmailCapability, QUOTE_EMAIL_CAPABILITY_ID } from '@r4-sales/agent';

/** (ADR-057 C4) quote.email@1: the platform, not the model, decides which quote and which address. */
const TASK = '0190a0a0-0000-7000-8000-00000000e001';
const QUOTE = { quoteId: '0f8e4a52-3c1b-4d6e-9b7a-2e5f1c8d9a10', quoteNumber: 'PC-000210' };
const delivery = (over: Partial<QuoteV2Delivery> = {}): QuoteV2Delivery => ({
  deliveryId: '7d2f9b1e-3a4c-4e8d-9f0a-6b5c2e1d8a90', quoteId: QUOTE.quoteId, channel: 'email', status: 'pending', recipientMasked: 'ca***@gmail.com',
  documentSha256: 'a'.repeat(64), requestedAt: '2026-11-24T12:00:00Z', sentAt: null, attempts: { count: 0, lastAttemptAt: null, lastErrorCode: null }, ...over,
});

function setup(options: { said?: string[]; fail?: DomainError } = {}) {
  const calls: { quoteId: string; email: string; key: string }[] = [];
  const quotes = {
    requestEmailDelivery: (quoteId: string, request: { recipient: { email: string } }, key: string) => {
      calls.push({ quoteId, email: request.recipient.email, key });
      return options.fail ? Promise.reject(options.fail) : Promise.resolve({ replayed: false, delivery: delivery() });
    },
  } as unknown as QuoteV2Service;
  const thread = (options.said ?? ['Hola, quiero la cotización por correo', 'mi correo es Camila.Rojas@Gmail.com']).map((text, i) => ({ cursor: `${i}`, at: '2026-11-24T12:00:00Z', kind: 'contact' as const, text, refs: {}, delivery: null }));
  const capability = quoteEmailCapability({
    store: { conversationQuotes: (taskIds: readonly string[]) => Promise.resolve(taskIds[0] === TASK ? [QUOTE] : []) },
    quotes,
    conversation: { thread: () => Promise.resolve([...thread, { cursor: 'x', at: '2026-11-24T12:00:01Z', kind: 'agent' as const, text: 'te la mando a otro@evil.com', refs: {}, delivery: null }]) },
  });
  const run = (input: { quoteNumber: string; email: string }) =>
    // As the runtime does: the input schema first (trims), then execute.
    capability.execute(capability.input.parse(input), { executionKey: 'k1', attempt: 1, signal: new AbortController().signal, execution: { taskId: TASK, correlationId: 'c1' } as never });
  return { capability, run, calls };
}

describe('quote.email@1 (ADR-057 C4)', () => {
  it('is a governed external communication with its own scope', () => {
    const { capability } = setup();
    expect(capability.definition).toMatchObject({ capabilityId: QUOTE_EMAIL_CAPABILITY_ID, version: 1, riskClass: 'EXTERNAL_COMMUNICATION', requiredScopes: ['quote.email'], idempotency: 'key_required' });
    expect(capability.recovery).toBe('idempotent_replay');
  });

  it('emails a quote issued here to the address the customer wrote; only the masked address comes back', async () => {
    const { run, calls } = setup();
    const result = await run({ quoteNumber: 'pc-000210', email: ' camila.rojas@gmail.com ' });
    expect(result).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000210', status: 'pending', recipientMasked: 'ca***@gmail.com' } });
    expect(JSON.stringify(result)).not.toMatch(/camila\.rojas/);
    expect(calls).toEqual([{ quoteId: QUOTE.quoteId, email: 'camila.rojas@gmail.com', key: expect.stringMatching(/^r4-qe_[0-9a-f]{48}$/) }]);
  });

  it('the same quote and address always use the same owner key (a repeat replays, never a second email)', async () => {
    const { run, calls } = setup();
    await run({ quoteNumber: 'PC-000210', email: 'camila.rojas@gmail.com' });
    await run({ quoteNumber: 'PC-000210', email: 'CAMILA.ROJAS@gmail.com' });
    expect(calls[0]!.key).toBe(calls[1]!.key);
  });

  it.each([
    ['an address only the agent wrote', { quoteNumber: 'PC-000210', email: 'otro@evil.com' }, 'email_not_from_customer'],
    ['a quote not issued in this conversation', { quoteNumber: 'PC-000999', email: 'camila.rojas@gmail.com' }, 'quote_not_in_conversation'],
    ['two addresses at once', { quoteNumber: 'PC-000210', email: 'a@b.cl,camila.rojas@gmail.com' }, 'invalid_email'],
    ['not an address', { quoteNumber: 'PC-000210', email: 'camila' }, 'invalid_email'],
  ])('refuses %s, before anything is sent', async (_name, input, code) => {
    const { run, calls } = setup();
    expect(await run(input)).toMatchObject({ status: 'rejected', code });
    expect(calls).toEqual([]);
  });

  it.each([
    ['email provider off', new DomainError('temporarily_unavailable', 'email_provider_unavailable', 'x'), { status: 'failed', code: 'email_unavailable' }],
    ['kill switch', new DomainError('temporarily_unavailable', 'autonomy_disabled', 'x'), { status: 'failed', code: 'email_unavailable' }],
    ['quote expired', new DomainError('conflict', 'invalid_state_transition', 'x'), { status: 'failed', code: 'quote_not_issued' }],
    ['owner did not answer after sending', new DomainError('unknown_outcome', 'http_500', 'x'), { status: 'unknown' }],
  ])('maps the owner answer: %s', async (_name, fail, expected) => {
    const { run } = setup({ fail });
    expect(await run({ quoteNumber: 'PC-000210', email: 'camila.rojas@gmail.com' })).toMatchObject(expected);
  });
});
