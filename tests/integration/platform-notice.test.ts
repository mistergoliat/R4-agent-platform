import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import { LiveOpsTestbed, say } from '../support/live-ops.js';

/**
 * Contract R-4 (R4 Checkout integration): a platform notice is a pack-rendered owner answer (the payment link) that the
 * single delivery owner sends through the existing WhatsApp path, under the agent-output gates, once per
 * (task, noticeKey). The real production composition over PostgreSQL with the local WhatsApp provider; no Checkout.
 */
const CUSTOMER = '56955556666';
const TEXT = 'Este es tu link de pago de Mercado Pago (ambiente de prueba) por $2.500:\nhttps://www.mercadopago.cl/checkout/v1/redirect?pref_id=1\nVence a las 16:41 (hora de Chile).';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

async function conversation(options: { allowlisted?: boolean } = {}) {
  const b = await LiveOpsTestbed.start({ allowlist: options.allowlisted === false ? [] : [CUSTOMER], autonomy: true });
  bed = b;
  b.next(say('Hola'));
  await b.customer(CUSTOMER, 'wamid.1', 'Hola');
  await b.runAgent();
  await b.deliver();
  return { b, taskId: await b.taskOf(CUSTOMER), store: new PostgresProductionStore(b.pool) };
}
const sent = (b: LiveOpsTestbed) => b.provider.sends.filter((s) => s.to === CUSTOMER).map((s) => s.text);

describe('platform notices (R-4)', { timeout: 90_000 }, () => {
  it('is delivered once through the existing path; the same key and text replays; another text is refused', async () => {
    const { b, taskId, store } = await conversation();
    const first = await store.createPlatformNotice({ taskId, noticeKey: 'checkout.link:cpa_1', text: TEXT, correlationId: randomUUID() });
    expect(first).toMatchObject({ replayed: false, record: { origin: 'platform', noticeKey: 'checkout.link:cpa_1', humanRequestId: null, status: 'pending' } });
    expect((await store.createPlatformNotice({ taskId, noticeKey: 'checkout.link:cpa_1', text: TEXT, correlationId: randomUUID() })).replayed).toBe(true);
    await expect(store.createPlatformNotice({ taskId, noticeKey: 'checkout.link:cpa_1', text: `${TEXT} otro`, correlationId: randomUUID() })).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    await b.deliver();
    await b.deliver();
    expect(sent(b)).toEqual(['Hola', TEXT]);
    // The model's context and the operator thread show the notice by key and state, never its body (the link).
    const thread = await store.thread(taskId);
    const event = thread.find((e) => e.refs.type === 'platform.notice');
    expect(event).toMatchObject({ kind: 'event', text: null, refs: { noticeKey: 'checkout.link:cpa_1' } });
  });

  it('is held by the kill switch like agent output, and sent once autonomy returns', async () => {
    const { b, taskId, store } = await conversation();
    await b.setAutonomy(false);
    await store.createPlatformNotice({ taskId, noticeKey: 'checkout.link:cpa_2', text: TEXT, correlationId: randomUUID() });
    await b.deliver();
    expect(sent(b)).toEqual(['Hola']);
    expect((await b.rows<{ hold_reason: string }>(`select hold_reason from outbound_messages where notice_key = 'checkout.link:cpa_2'`))[0]!.hold_reason).toBeTruthy();
    await b.setAutonomy(true);
    await b.rows(`update outbound_messages set next_attempt_at = null where notice_key = 'checkout.link:cpa_2'`);
    await b.deliver();
    expect(sent(b)).toEqual(['Hola', TEXT]);
  });

  it('the schema keeps a platform row either a fallback or a notice, never both or neither', async () => {
    const { b, taskId } = await conversation();
    const binding = (await b.rows<{ binding_id: string; channel: string; profile: string }>('select binding_id, channel, profile from channel_conversation_bindings where task_id = $1', [taskId]))[0]!;
    await expect(b.rows(
      `insert into outbound_messages (outbound_id, origin, task_id, binding_id, channel, idempotency_key, content_sha256, body, status, profile, correlation_id)
       values ($1, 'platform', $2, $3, $4, $5, $6, 'x', 'pending', $7, 'c')`,
      [randomUUID(), taskId, binding.binding_id, binding.channel, `k-${randomUUID()}`, '0'.repeat(64), binding.profile],
    )).rejects.toThrow(/outbound_messages_platform_origin/);
  });
});
