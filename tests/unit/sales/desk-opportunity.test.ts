import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@r4/capability-runtime';
import {
  DESK_OPPORTUNITY_CAPABILITY_ID,
  DESK_OPPORTUNITY_MAX_PER_TASK,
  deskOpportunityCapability,
  deskOpportunityKey,
  deskSignature,
  loadDeskIngestConfig,
  type DeskOpportunityInput,
} from '@r4-sales/agent';

/** (ADR-062 O1) desk.opportunity.record@1: the model classifies; the platform fills, signs and sends. */
const TASK = '0190a0a0-0000-7000-8000-00000000d001';
const KEY = 'k'.repeat(40);
const URL_ = 'http://127.0.0.1:3201/api/r4/opportunities';
const INPUT: DeskOpportunityInput = { trigger: 'cotizacion', intent: 'cotizacion', segment: 'empresa', complexity: 'estandar', productRefs: ['P823', 'P1675-V463'], summary: 'Quiere un banco y discos para la oficina, con factura.' };
const NOW = new Date('2026-11-25T12:00:00Z');

function setup(options: { status?: number; body?: unknown; throws?: Error; quotes?: boolean; channel?: string | null; gross?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const capability = deskOpportunityCapability({
    desk: { url: URL_, key: KEY },
    store: { conversationQuotes: (taskIds) => Promise.resolve(taskIds[0] === TASK ? [{ quoteId: 'q-1', quoteNumber: 'PC-000210' }] : []) },
    quotes: options.quotes === false ? null : ({ getQuote: () => Promise.resolve({ totals: { net: 0, tax: 0, gross: options.gross ?? 459_900, exemptNet: 0 } }) } as never),
    bindings: { bindingByTask: () => Promise.resolve(options.channel === null ? null : { channel: options.channel ?? 'web', recipientRef: 'web-visitor-1' }) },
    profileChannel: 'web',
    channels: ['whatsapp', 'web', 'instagram', 'facebook'],
    now: () => NOW,
    fetch: (url, init) => {
      calls.push({ url, init });
      if (options.throws) return Promise.reject(options.throws);
      return Promise.resolve(new Response(JSON.stringify(options.body ?? { opportunityId: 'opp_1', created: true }), { status: options.status ?? 200 }));
    },
  });
  const run = (input: unknown, taskId = TASK) =>
    capability.execute(capability.input.parse(input), { executionKey: 'x1', attempt: 1, signal: new AbortController().signal, execution: { taskId, correlationId: 'c1', agentId: 'sales-web', agentVersion: 21 } as never });
  const sent = (i = 0) => JSON.parse(calls[i]!.init.body as string) as Record<string, unknown>;
  return { capability, run, calls, sent };
}

describe('desk.opportunity.record@1 (ADR-062 O1)', () => {
  it('is a governed, keyed, reversible internal write with its own scope; registers as a write', () => {
    const { capability } = setup();
    expect(capability.definition).toMatchObject({ capabilityId: DESK_OPPORTUNITY_CAPABILITY_ID, version: 1, riskClass: 'REVERSIBLE_WRITE', requiredScopes: ['desk.opportunity.write'], identityRequirement: 'none', idempotency: 'key_required', timeoutMs: 5_000, retryPolicy: { maxAttempts: 2 } });
    expect(capability.recovery).toBe('idempotent_replay');
    expect(new CapabilityRegistry().registerWrite(capability).writeRecovery).toBe('idempotent_replay');
  });

  it('refuses anything outside the closed lists, extra fields and malformed refs', () => {
    const { capability } = setup();
    const bad = [
      { ...INPUT, intent: 'compra_grande' },
      { ...INPUT, segment: 'pyme' },
      { ...INPUT, complexity: 'enorme' },
      { ...INPUT, trigger: 'cierre' },
      { ...INPUT, productRefs: Array.from({ length: 11 }, (_, i) => `P${i}`) },
      { ...INPUT, productRefs: ['P1 x2'] },
      { ...INPUT, summary: 'x'.repeat(501) },
      { ...INPUT, summary: '   ' },
    ];
    for (const input of bad) expect(capability.input.safeParse(input).success, JSON.stringify(input).slice(0, 80)).toBe(false);
    expect(capability.input.safeParse(INPUT).success).toBe(true);
  });

  it('the model cannot set a platform-filled field', () => {
    const { capability } = setup();
    for (const extra of [{ taskId: TASK }, { channel: 'whatsapp' }, { quote: { quoteNumber: 'PC-1', grossClp: 1 } }, { grossClp: 1 }, { agent: { agentId: 'x', agentVersion: 1 } }, { idempotencyKey: 'r4-opp_x' }, { classification: {} }]) {
      expect(capability.input.safeParse({ ...INPUT, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });

  it('sends exactly the desk body, platform-filled: conversation, channel, agent and the quote from Quote', async () => {
    const { run, calls, sent } = setup();
    expect(await run(INPUT)).toMatchObject({ status: 'applied', result: { recorded: true }, resourceRef: 'desk-opportunity:opp_1' });
    expect(calls[0]!.url).toBe(URL_);
    expect(sent()).toEqual({
      idempotencyKey: deskOpportunityKey(TASK, INPUT, 'PC-000210'),
      taskId: TASK,
      channel: 'web',
      trigger: 'cotizacion',
      classification: { intent: 'cotizacion', segment: 'empresa', complexity: 'estandar', productRefs: ['P823', 'P1675-V463'], summary: INPUT.summary },
      quote: { quoteNumber: 'PC-000210', grossClp: 459_900 },
      agent: { agentId: 'sales-web', agentVersion: 21 },
    });
    expect(sent().idempotencyKey).toMatch(/^[A-Za-z0-9_:.-]{8,80}$/);
  });

  it('no quote in the conversation (or no Quote) means quote: null; the binding channel wins over the profile channel', async () => {
    const other = '0190a0a0-0000-7000-8000-00000000d002';
    const a = setup({ channel: 'instagram' });
    await a.run(INPUT, other);
    expect(a.sent()).toMatchObject({ quote: null, channel: 'instagram', taskId: other });
    const b = setup({ quotes: false, channel: null });
    await b.run(INPUT);
    expect(b.sent()).toMatchObject({ quote: null, channel: 'web' });
    expect(await setup({ channel: 'sms' }).run(INPUT)).toMatchObject({ status: 'failed', code: 'channel_unsupported' });
  });

  it('signs base64url(HMAC-SHA256(key, "<timestamp>.<raw body>")) with unix seconds', async () => {
    const { run, calls } = setup();
    await run(INPUT);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-r4-timestamp']).toBe(String(NOW.getTime() / 1000));
    const expected = createHmac('sha256', KEY).update(`${headers['x-r4-timestamp']}.${calls[0]!.init.body as string}`).digest('base64url');
    expect(headers['x-r4-signature']).toBe(expected);
    expect(deskSignature(KEY, '1', '{}')).toBe(createHmac('sha256', KEY).update('1.{}').digest('base64url'));
  });

  it('the idempotency key is deterministic: same conversation, moment, quote and classification; anything else changes it', () => {
    const k = deskOpportunityKey(TASK, INPUT, 'PC-000210');
    expect(deskOpportunityKey(TASK, { ...INPUT }, 'PC-000210')).toBe(k);
    expect(deskOpportunityKey(TASK, { ...INPUT, productRefs: [] }, 'PC-000210')).toBe(k);
    for (const changed of [deskOpportunityKey(TASK, INPUT, null), deskOpportunityKey(TASK, { ...INPUT, trigger: 'consulta' }, 'PC-000210'), deskOpportunityKey(TASK, { ...INPUT, segment: 'persona' }, 'PC-000210'), deskOpportunityKey('0190a0a0-0000-7000-8000-00000000d009', INPUT, 'PC-000210')]) expect(changed).not.toBe(k);
  });

  it('refuses a summary with contact data before sending anything', async () => {
    const { run, calls } = setup();
    for (const summary of ['Escribir a cliente@correo.cl', 'Su celular es +56 9 1234 5678', 'Llamar al 912345678', 'RUT 12.345.678-5']) {
      expect(await run({ ...INPUT, summary })).toMatchObject({ status: 'rejected', code: 'summary_has_contact_data' });
    }
    expect(await run({ ...INPUT, summary: 'Presupuesto de $1.500.000 para un home gym' })).toMatchObject({ status: 'applied' });
    expect(calls).toHaveLength(1);
  });

  it('maps the desk answers: 400/401/500 not_applied = failed (nothing recorded), timeout = unknown (same key), never an id to the model', async () => {
    const r400 = await setup({ status: 400, body: { error: { code: 'unknown_field' } } }).run(INPUT);
    expect(r400).toMatchObject({ status: 'failed', code: 'desk_refused_unknown_field' });
    expect(await setup({ status: 401, body: {} }).run(INPUT)).toMatchObject({ status: 'failed', code: 'desk_unauthorized' });
    expect(await setup({ status: 500, body: { error: { code: 'not_applied' } } }).run(INPUT)).toMatchObject({ status: 'failed', code: 'desk_failed' });
    expect(await setup({ status: 502, body: {} }).run(INPUT)).toMatchObject({ status: 'unknown' });
    expect(await setup({ throws: new DOMException('timed out', 'TimeoutError') }).run(INPUT)).toMatchObject({ status: 'unknown' });
    for (const r of [r400]) expect((r as { message: string }).message).toMatch(/never mention this record to the customer/);
  });

  it('caps the records of one conversation; a replay of the same record is not counted', async () => {
    const { run, calls } = setup();
    for (let i = 0; i < DESK_OPPORTUNITY_MAX_PER_TASK; i++) expect(await run({ ...INPUT, summary: `Registro ${i}` })).toMatchObject({ status: 'applied' });
    expect(await run({ ...INPUT, summary: 'Registro 0' })).toMatchObject({ status: 'applied' });
    expect(await run({ ...INPUT, summary: 'Uno más' })).toMatchObject({ status: 'rejected', code: 'record_limit' });
    expect(calls).toHaveLength(DESK_OPPORTUNITY_MAX_PER_TASK + 1);
  });
});

describe('desk ingest configuration (fails closed)', () => {
  const env = (over: Record<string, string | undefined> = {}) => ({ R4_DESK_INGEST_URL: URL_, R4_DESK_INGEST_KEY: KEY, ...over });
  it('accepts loopback http and https with the network allowed', () => {
    expect(loadDeskIngestConfig(env(), { allowNetwork: false })).toEqual({ url: URL_, key: KEY });
    expect(loadDeskIngestConfig(env({ R4_DESK_INGEST_URL: 'https://desk.example.test/api/r4/opportunities' }), { allowNetwork: true }).url).toBe('https://desk.example.test/api/r4/opportunities');
  });
  it('refuses a missing variable, a short key, non-loopback http, the network not allowed, credentials or a query', () => {
    expect(() => loadDeskIngestConfig(env({ R4_DESK_INGEST_URL: undefined }), { allowNetwork: true })).toThrow(/missing R4_DESK_INGEST_URL/);
    expect(() => loadDeskIngestConfig(env({ R4_DESK_INGEST_KEY: '' }), { allowNetwork: true })).toThrow(/R4_DESK_INGEST_KEY/);
    expect(() => loadDeskIngestConfig(env({ R4_DESK_INGEST_KEY: 'short' }), { allowNetwork: true })).toThrow(/at least 32/);
    expect(() => loadDeskIngestConfig(env({ R4_DESK_INGEST_URL: 'http://desk.example.test/x' }), { allowNetwork: true })).toThrow(/https/);
    expect(() => loadDeskIngestConfig(env({ R4_DESK_INGEST_URL: 'https://desk.example.test/x' }), { allowNetwork: false })).toThrow(/R4_PROD_ALLOW_NETWORK/);
    expect(() => loadDeskIngestConfig(env({ R4_DESK_INGEST_URL: 'http://u:p@127.0.0.1/x' }), { allowNetwork: false })).toThrow(/credentials/);
    expect(() => loadDeskIngestConfig(env({ R4_DESK_INGEST_URL: 'http://127.0.0.1/x?a=1' }), { allowNetwork: false })).toThrow(/query/);
  });
});
