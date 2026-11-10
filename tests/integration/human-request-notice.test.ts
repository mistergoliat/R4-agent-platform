import { afterEach, describe, expect, it } from 'vitest';
import type { FakeModelStep } from '@r4/model-gateway';
import { SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_HUMAN_REQUEST_NOTICE_TEXT, SALES_RUN_FAILURE_FALLBACK_TEXT } from '@r4-sales/agent/production';
import { LiveOpsTestbed, say } from '../support/live-ops.js';

/**
 * F-ADV-2 (ADR-041 extension): when the agent opens a human request (a consultation or a handoff) without replying,
 * the delivery owner sends the pack's fixed notice exactly once, so the contact never waits in silence. The request
 * itself stays open for the person. Scoped by profile: a profile outside the scope keeps the previous behaviour.
 * The real production composition over PostgreSQL (webhook, Sales worker, scripted model, delivery, local WhatsApp).
 */
const CUSTOMER = '56933335555';
const BED_PROFILE = 'sales-production@1';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const HANDOFF: FakeModelStep = { type: 'structured', data: { type: 'request_handoff', summary: 'El cliente pide emitir con stock por confirmar.', contextRefs: [] } };
const CONSULT: FakeModelStep = { type: 'structured', data: { type: 'request_consultation', question: '¿Se puede despachar a Isla de Pascua?', contextRefs: [] } };
const TWO_DOCUMENTS: FakeModelStep = { type: 'text', content: '{"type":"respond","content":"a"}{"type":"respond","content":"b"}' };

const start = async (profiles: readonly string[] | undefined) => (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, ...(profiles ? { humanRequestNoticeProfiles: profiles } : {}) }));
const settle = async (b: LiveOpsTestbed) => {
  await b.runAgent();
  await b.deliver();
};
const sentTexts = (b: LiveOpsTestbed) => b.provider.sends.filter((s) => s.to === CUSTOMER).map((s) => s.text);
const requests = (b: LiveOpsTestbed) => b.rows<{ kind: string; status: string }>(`select kind, status from human_requests order by created_at`);

describe('an agent-opened human request never leaves the contact in silence (F-ADV-2)', { timeout: 90_000 }, () => {
  it('the composition scopes the notice to the F1 quote lane candidates only (@17 and its successor @18)', () => {
    expect(SALES_HUMAN_REQUEST_NOTICE_PROFILES).toEqual(['sales-production@17', 'sales-production@18']);
    // Fixed text: a pending person, no commercial effect or promise.
    expect(SALES_HUMAN_REQUEST_NOTICE_TEXT).not.toMatch(/cotizaci[oó]n|emit|confirm|pedido|pago|reserv|stock|disponib|precio|descuento/i);
  });

  it.each([
    ['handoff', HANDOFF],
    ['consultation', CONSULT],
  ])('a %s without a reply: exactly one notice, delivered; the request stays open for the person', async (kind, step) => {
    const b = await start([BED_PROFILE]);
    b.next(step);
    await b.customer(CUSTOMER, 'wamid.1', 'Igual emítela, la necesito');
    await settle(b);
    expect(sentTexts(b)).toEqual([SALES_HUMAN_REQUEST_NOTICE_TEXT]);
    expect(await requests(b)).toEqual([{ kind, status: 'requested' }]);
    expect(await b.rows(`select origin, status, body from outbound_messages`)).toEqual([{ origin: 'platform', status: 'accepted', body: SALES_HUMAN_REQUEST_NOTICE_TEXT }]);
    // Idempotent: more delivery passes and another customer message while the person is pending add nothing.
    await b.customer(CUSTOMER, 'wamid.2', '¿hola?');
    await settle(b);
    await b.deliver();
    expect(sentTexts(b)).toEqual([SALES_HUMAN_REQUEST_NOTICE_TEXT]);
  });

  it('a profile outside the scope keeps the previous behaviour: the request, and no notice', async () => {
    const b = await start(undefined);
    b.next(HANDOFF);
    await b.customer(CUSTOMER, 'wamid.1', 'Quiero hablar con alguien');
    await settle(b);
    expect(await requests(b)).toEqual([{ kind: 'handoff', status: 'requested' }]);
    expect(sentTexts(b)).toEqual([]);
  });

  it('an earlier reply does not silence a later request: its own notice, once', async () => {
    const b = await start([BED_PROFILE]);
    b.next(say('Te comunico con una persona del equipo.'));
    await b.customer(CUSTOMER, 'wamid.1', 'Quiero hablar con alguien');
    await settle(b);
    b.next(HANDOFF);
    await b.customer(CUSTOMER, 'wamid.2', 'Gracias');
    await settle(b);
    // A reply ends its turn, so a request never shares a run with one: the second run opened it silently.
    expect(sentTexts(b)).toEqual(['Te comunico con una persona del equipo.', SALES_HUMAN_REQUEST_NOTICE_TEXT]);
  });

  it('a platform hold (autonomy disabled) stays as designed: humans own it, no notice', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: false, humanRequestNoticeProfiles: [BED_PROFILE] });
    await bed.customer(CUSTOMER, 'wamid.1', 'Hola');
    await settle(bed);
    expect(await bed.rows(`select kind, payload->>'initiatedBy' as by from human_requests`)).toEqual([{ kind: 'handoff', by: 'platform' }]);
    expect(sentTexts(bed)).toEqual([]);
    expect(await bed.rows(`select origin from outbound_messages`)).toEqual([]);
  });

  it('a run-failure handoff keeps its own fallback and never gets the notice too', async () => {
    const b = await start([BED_PROFILE]);
    b.next(TWO_DOCUMENTS, TWO_DOCUMENTS);
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    await settle(b);
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
  });
});
