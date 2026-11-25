import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRequest } from '@r4/model-gateway';
import { LiveOpsTestbed, say } from '../support/live-ops.js';
import { freezeTemporalClock } from '../support/temporal.js';

/**
 * ADR-055 C2b over PostgreSQL and the real gateway composition: S2 goes out as the approved template to a case the idle
 * close already ended, and a tap on its «No me escriban» button is an opt-out.
 */
const CUSTOMER = '56944447777';
const LAST = new Date('2026-11-24T18:05:00.000Z');
const H = 3_600_000;
const QUOTE = '0199aaaa-0000-7000-8000-000000000002';

/** The idle close (ADR-047) on the temporal clock, 25 h after the newest input was received. */
async function idle(b: LiveOpsTestbed): Promise<void> {
  const [row] = await b.rows<{ at: Date }>('select max(received_at) as at from task_inputs');
  await freezeTemporalClock(b.pool, new Date(row!.at.getTime() + 25 * H));
  await b.gateway.idleClose!.sweep();
}

let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

describe('quote follow-up S2 as a template (active, templates on)', () => {
  it('the template goes to the closed case 4 days after the quote; the contact taps «No me escriban» and is opted out', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, env: { R4_PROD_CONTACT_MODE: 'active', R4_PROD_CONTACT_TEMPLATES: 'on', R4_PROD_CASE_IDLE_CLOSE_HOURS: '24' } }));
    b.next(say('Te envío la cotización.'));
    await b.customer(CUSTOMER, 'w1', 'cotízame la barra', { timestamp: LAST.getTime() / 1000 });
    await b.runAgent();
    await b.deliver();
    const taskId = await b.taskOf(CUSTOMER);
    await b.pool.query(`insert into sales.quote_v2_requests (execution_key, task_id, workspace_version, request, request_sha256) values ('k2', $1, 1, '{}', $2)`, [taskId, 'a'.repeat(64)]);
    await b.pool.query(
      `insert into sales.quote_v2_issued (execution_key, task_id, quote_id, quote_number, issued_at, valid_through_local_date, valid_until_exclusive, pdf_sha256, byte_length, document_verification)
       values ('k2', $1, $2, 'PC-000901', $3, '2026-12-03', '2026-12-04T03:00:00Z', $4, 10, 'verified')`,
      [taskId, QUOTE, new Date(LAST.getTime() + 60_000), 'b'.repeat(64)],
    );
    // No S1 here (its delivery depends on the real clock's window): the case closes idle after 24 h.
    await idle(b);
    expect((await b.rows<{ status: string }>('select status from channel_conversation_bindings where task_id = $1', [taskId]))[0]!.status).toBe('closed');

    // Saturday 15:06 in Chile, 4 days after the quote.
    await freezeTemporalClock(b.pool, new Date(LAST.getTime() + 96 * H + 60_000));
    expect(await b.gateway.contact!.sweep()).toMatchObject({ sent: 1, failed: 0 });
    await b.deliver();
    expect(b.provider.sends.at(-1)).toMatchObject({ to: CUSTOMER, text: '', template: { name: 'seguimiento_cotizacion', language: 'es', parameters: ['PC-000901', '03-12-2026'] } });
    expect((await b.rows<{ status: string }>('select status from outbound_messages where notice_key = $1', [`sales.followup-2:${QUOTE}`]))[0]).toMatchObject({ status: 'accepted' });
    expect(await b.gateway.contact!.sweep()).toMatchObject({ sent: 0 });

    // The contact taps the opt-out button: a new case, the agent confirms from the frame, the opt-out holds.
    let seen = '';
    b.next((request: ModelRequest) => ((seen = JSON.stringify(request)), say('Listo, no te escribiremos.')));
    await b.customer(CUSTOMER, 'w2', 'No me escriban', { type: 'button' });
    await b.runAgent();
    expect(seen).toContain('[r4:baja]');
    expect(await b.rows('select source from contact_opt_outs')).toEqual([{ source: 'contact_keyword' }]);
  });

  it('without R4_PROD_CONTACT_TEMPLATES the template is only observed: nothing is sent', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, env: { R4_PROD_CONTACT_MODE: 'active', R4_PROD_CASE_IDLE_CLOSE_HOURS: '24' } }));
    b.next(say('Te envío la cotización.'));
    await b.customer(CUSTOMER, 'w1', 'cotízame la barra', { timestamp: LAST.getTime() / 1000 });
    await b.runAgent();
    await b.deliver();
    const taskId = await b.taskOf(CUSTOMER);
    await b.pool.query(`insert into sales.quote_v2_requests (execution_key, task_id, workspace_version, request, request_sha256) values ('k3', $1, 1, '{}', $2)`, [taskId, 'a'.repeat(64)]);
    await b.pool.query(
      `insert into sales.quote_v2_issued (execution_key, task_id, quote_id, quote_number, issued_at, valid_through_local_date, valid_until_exclusive, pdf_sha256, byte_length, document_verification)
       values ('k3', $1, $2, 'PC-000902', $3, '2026-12-03', '2026-12-04T03:00:00Z', $4, 10, 'verified')`,
      [taskId, QUOTE, new Date(LAST.getTime() + 60_000), 'b'.repeat(64)],
    );
    await idle(b);
    await freezeTemporalClock(b.pool, new Date(LAST.getTime() + 96 * H + 60_000));
    const sends = b.provider.sends.length;
    expect(await b.gateway.contact!.sweep()).toMatchObject({ sent: 0, observed: 1 });
    await b.deliver();
    expect(b.provider.sends.length).toBe(sends);
  });
});
