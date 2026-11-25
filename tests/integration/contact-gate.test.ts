import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRequest } from '@r4/model-gateway';
import { SALES_OPT_OUT } from '@r4-sales/agent/production';
import { LiveOpsTestbed, say } from '../support/live-ops.js';
import { freezeTemporalClock } from '../support/temporal.js';

/**
 * ADR-055 C1 over PostgreSQL and the real gateway composition: opt-out words decided at ingress without the model,
 * and the quote follow-up sweep observed (decides and records, sends nothing).
 */
const CUSTOMER = '56944446666';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});
const start = async (mode: string | null = 'observe') => (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, ...(mode ? { env: { R4_PROD_CONTACT_MODE: mode } } : {}) }));
const outbound = (b: LiveOpsTestbed) => b.rows<{ origin: string; body: string | null; status: string }>('select origin, body, status from outbound_messages order by created_at');

describe('opt-out at ingress', () => {
  it('in a live case: recorded, the agent is not woken, the fixed confirmation goes out; the next message wakes it as usual', async () => {
    const b = await start();
    b.next(say('Hola, ¿en qué te ayudo?'));
    await b.customer(CUSTOMER, 'w1', 'hola');
    await b.runAgent();
    await b.deliver();
    const calls = b.model.requests.length;
    await b.customer(CUSTOMER, 'w2', '¡BAJA!');
    await b.runAgent();
    expect(b.model.requests.length).toBe(calls);
    expect((await outbound(b)).at(-1)).toMatchObject({ origin: 'platform', body: SALES_OPT_OUT.confirmation, status: 'pending' });
    expect(await b.rows('select source from contact_opt_outs')).toEqual([{ source: 'contact_keyword' }]);
    expect(await b.rows<{ disposition: string }>(`select disposition from inbound_events where provider_event_id = 'w2'`)).toEqual([{ disposition: 'opt_out' }]);
    // The same event again is one input and one notice.
    await b.customer(CUSTOMER, 'w2', '¡BAJA!');
    expect((await outbound(b)).filter((o) => o.body === SALES_OPT_OUT.confirmation)).toHaveLength(1);
    b.next(say('Claro, te ayudo.'));
    await b.customer(CUSTOMER, 'w3', '¿tienen discos?');
    await b.runAgent();
    expect(b.model.requests.length).toBe(calls + 1);
  });

  it('opening a new case: the agent receives the frame instead of the words; without the contact mode nothing changes', async () => {
    const b = await start();
    let seen = '';
    b.next((request: ModelRequest) => ((seen = JSON.stringify(request)), say('Listo, no te escribiremos.')));
    await b.customer(CUSTOMER, 'w1', 'No me escriban');
    await b.runAgent();
    expect(seen).toContain('[r4:baja]');
    expect(seen).not.toContain('No me escriban');
    expect(await b.rows('select 1 from contact_opt_outs')).toHaveLength(1);
    await b.close();
    const off = await start(null);
    expect(off.gateway.contact).toBeNull();
    off.next(say('Hola.'));
    await off.customer(CUSTOMER, 'w1', 'BAJA');
    await off.runAgent();
    expect(await off.rows('select 1 from contact_opt_outs')).toHaveLength(0);
  });
});

describe('quote follow-up sweep (observe)', () => {
  // Tuesday 15:05 in Chile: S1 is due Wednesday from 09:05, inside hours.
  const LAST = new Date('2026-11-24T18:05:00.000Z');
  const H = 3_600_000;

  async function quoted(b: LiveOpsTestbed): Promise<string> {
    b.next(say('Te envío la cotización.'));
    await b.customer(CUSTOMER, 'w1', 'cotízame la barra', { timestamp: LAST.getTime() / 1000 });
    await b.runAgent();
    await b.deliver();
    const taskId = await b.taskOf(CUSTOMER);
    expect((await b.rows<{ at: Date }>('select last_inbound_at as at from channel_conversation_bindings where task_id = $1', [taskId]))[0]!.at).toEqual(LAST);
    await b.pool.query(`insert into sales.quote_v2_requests (execution_key, task_id, workspace_version, request, request_sha256) values ('k1', $1, 1, '{}', $2)`, [taskId, 'a'.repeat(64)]);
    await b.pool.query(
      `insert into sales.quote_v2_issued (execution_key, task_id, quote_id, quote_number, issued_at, valid_through_local_date, valid_until_exclusive, pdf_sha256, byte_length, document_verification)
       values ('k1', $1, '0199aaaa-0000-7000-8000-000000000001', 'PC-000900', $2, '2026-12-03', '2026-12-04T03:00:00Z', $3, 10, 'verified')`,
      [taskId, new Date(LAST.getTime() + 60_000), 'b'.repeat(64)],
    );
    return taskId;
  }
  const decisions = (b: LiveOpsTestbed) => b.rows<{ source_ref: string; mode: string; outcome: string; rule: string; text: string; template: unknown; outbound_id: string | null }>('select source_ref, mode, outcome, rule, text, template, outbound_id from contact_decisions order by decided_at');

  it('S1 at 19 h is decided once observed with its text and nothing is enqueued; S2 (the template) 3 days later', async () => {
    const b = await start();
    await quoted(b);
    const before = (await outbound(b)).length;
    await freezeTemporalClock(b.pool, new Date(LAST.getTime() + 17 * H));
    expect(await b.gateway.contact!.sweep()).toMatchObject({ observed: 0 });
    await freezeTemporalClock(b.pool, new Date(LAST.getTime() + 19 * H));
    expect(await b.gateway.contact!.sweep()).toMatchObject({ observed: 1, failed: 0 });
    expect(await b.gateway.contact!.sweep()).toMatchObject({ observed: 0 });
    expect(await decisions(b)).toEqual([expect.objectContaining({ source_ref: 'sales.quote-followup:0199aaaa-0000-7000-8000-000000000001:1', mode: 'observe', outcome: 'send', rule: 'allowed', outbound_id: null })]);
    expect((await decisions(b))[0]!.text).toContain('PC-000900');
    expect((await outbound(b)).length).toBe(before);
    // Saturday 10:05: 3 days after S1.
    await freezeTemporalClock(b.pool, new Date(LAST.getTime() + (19 + 72) * H));
    expect(await b.gateway.contact!.sweep()).toMatchObject({ observed: 1 });
    expect((await decisions(b))[1]).toMatchObject({ source_ref: 'sales.quote-followup:0199aaaa-0000-7000-8000-000000000001:2', outcome: 'send', template: { name: 'seguimiento_cotizacion', language: 'es', parameters: ['PC-000900', '03-12-2026'] } });
    expect((await outbound(b)).length).toBe(before);
  });

  it('an opted-out contact is stopped, once', async () => {
    const b = await start();
    const taskId = await quoted(b);
    await b.pool.query(`insert into contact_opt_outs (channel, conversation_key, source) select channel, conversation_key, 'operator' from channel_conversation_bindings where task_id = $1`, [taskId]);
    await freezeTemporalClock(b.pool, new Date(LAST.getTime() + 19 * H));
    expect(await b.gateway.contact!.sweep()).toMatchObject({ stopped: 1 });
    expect((await decisions(b))[0]).toMatchObject({ outcome: 'stopped', rule: 'opt_out' });
    expect(await b.gateway.contact!.sweep()).toMatchObject({ stopped: 0 });
  });
});
