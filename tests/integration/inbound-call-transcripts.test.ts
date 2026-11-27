import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_SIGNATURE_HEADER, CALL_TIMESTAMP_HEADER, signCallBody } from '@r4-adapters/whatsapp-cloud';
import { guardIntentReply } from '@r4-sales/agent';
import { LiveOpsTestbed } from '../support/live-ops.js';

/**
 * (ADR-068) A WhatsApp call through the REAL Sales gateway composition: the call gateway posts what the caller said to
 * the second WhatsApp ingress, and it becomes a framed `[r4:llamada]` input of the caller's own WhatsApp conversation.
 */

const CALLER = '56911110001';
const NEW_CALLER = '56911110002';
const SECRET = 'call-secret-for-integration-0123456789';
const PERCEPTION = {
  R4_MEDIA_PERCEPTION: 'enabled',
  R4_MEDIA_PERCEPTION_PROFILES: 'sales-production@1',
  R4_PERCEPTION_VISION_BASE_URL: 'http://127.0.0.1:9',
  R4_PERCEPTION_VISION_API_KEY: 'unused-in-this-suite',
};

let bed: LiveOpsTestbed;

async function callTurn(b: LiveOpsTestbed, callId: string, turn: number, from: string, text: string, secret = SECRET): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = JSON.stringify({ callId, turn, from, text, occurredAt: new Date().toISOString() });
  const ts = String(Date.now());
  const res = await b.gateway.app.inject({
    method: 'POST', url: '/v1/channels/whatsapp-call/webhook', payload: raw,
    headers: { 'content-type': 'application/json', [CALL_TIMESTAMP_HEADER]: ts, [CALL_SIGNATURE_HEADER]: signCallBody(secret, ts, raw) },
  });
  return { status: res.statusCode, body: res.json() };
}

async function inputOf(b: LiveOpsTestbed, inputId: string): Promise<{ text: string; taskId: string }> {
  const [row] = await b.rows<{ text: string; task_id: string }>("select m.content #>> '{text}' as text, i.task_id from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id where i.input_id = $1", [inputId]);
  return { text: row!.text, taskId: row!.task_id };
}

beforeAll(async () => {
  bed = await LiveOpsTestbed.start({ allowlist: [CALLER, NEW_CALLER], autonomy: true, env: { ...PERCEPTION, R4_WHATSAPP_CALL_SECRET: SECRET } });
});
afterAll(async () => {
  await bed.close();
});

describe('WhatsApp calls into the same conversation (ADR-068)', { timeout: 60_000 }, () => {
  it('what the caller said lands, framed, on the conversation the caller already has on WhatsApp; the call gateway learns where', async () => {
    const typed = await bed.customer(CALLER, 'wamid.call.1', 'hola, ¿tienen mancuernas?');
    expect(typed.body).not.toHaveProperty('landed'); // Meta's ingress never returns task identities
    const [first] = await bed.rows<{ input_id: string }>("select input_id from inbound_events where provider_event_id = 'wamid.call.1'");
    const textTask = (await inputOf(bed, first!.input_id)).taskId;

    const res = await callTurn(bed, 'wacid.INTEGRATION_CALL_1', 1, CALLER, 'cotízame dos mancuernas de veinte kilos');
    expect(res).toMatchObject({ status: 200, body: { ingested: 1, duplicates: 0 } });
    const landed = res.body.landed as { taskId: string; inputId: string }[];
    expect(landed).toHaveLength(1);
    expect(landed[0]!.taskId).toBe(textTask);
    const input = await inputOf(bed, landed[0]!.inputId);
    expect(input.taskId).toBe(textTask);
    expect(input.text.startsWith('[r4:llamada] El cliente te está hablando por una llamada de WhatsApp')).toBe(true);
    expect(input.text.endsWith('\n«cotízame dos mancuernas de veinte kilos»')).toBe(true);
    // (D4, owner decision 2026-11-26) read like a typed reply: an order is not a question, negation or hesitation.
    expect(guardIntentReply(input.text)).toMatchObject({ confirmed: true });
    const [row] = await bed.rows("select content_kind, content_type, disposition, channel from inbound_events where input_id = $1", [landed[0]!.inputId]);
    expect(row).toEqual({ content_kind: 'unsupported', content_type: 'transcript', disposition: 'autonomous', channel: 'whatsapp' });
  });

  it('a re-sent turn is one input; another turn is another', async () => {
    const again = await callTurn(bed, 'wacid.INTEGRATION_CALL_1', 1, CALLER, 'cotízame dos mancuernas de veinte kilos');
    expect(again).toMatchObject({ status: 200, body: { ingested: 0, duplicates: 1, landed: [] } });
    const next = await callTurn(bed, 'wacid.INTEGRATION_CALL_1', 2, CALLER, 'con despacho a Ñuñoa');
    expect(next).toMatchObject({ status: 200, body: { ingested: 1 } });
  });

  it('(owner decision 2026-11-26) the end of an answered call reaches the same conversation once, asking only whether it helped', async () => {
    const send = async () => {
      const raw = JSON.stringify({ callId: 'wacid.INTEGRATION_CALL_1', event: 'ended', from: CALLER, occurredAt: new Date().toISOString() });
      const ts = String(Date.now());
      const res = await bed.gateway.app.inject({ method: 'POST', url: '/v1/channels/whatsapp-call/webhook', payload: raw, headers: { 'content-type': 'application/json', [CALL_TIMESTAMP_HEADER]: ts, [CALL_SIGNATURE_HEADER]: signCallBody(SECRET, ts, raw) } });
      return { status: res.statusCode, body: res.json() };
    };
    const res = await send();
    expect(res).toMatchObject({ status: 200, body: { ingested: 1 } });
    const landed = (res.body.landed as { taskId: string; inputId: string }[])[0]!;
    const input = await inputOf(bed, landed.inputId);
    expect(input.text).toContain('¿Te pude ayudar en la llamada, o hubo algún problema?');
    const [row] = await bed.rows('select content_kind, content_type, disposition from inbound_events where input_id = $1', [landed.inputId]);
    expect(row).toEqual({ content_kind: 'unsupported', content_type: 'call-ended', disposition: 'autonomous' });
    expect(await send()).toMatchObject({ status: 200, body: { ingested: 0, duplicates: 1 } });
  });

  it('a caller who never wrote gets a WhatsApp conversation opened by the call', async () => {
    const res = await callTurn(bed, 'wacid.INTEGRATION_CALL_2', 1, NEW_CALLER, 'hola, ¿hacen despacho a regiones?');
    expect(res).toMatchObject({ status: 200, body: { ingested: 1 } });
    const [binding] = await bed.rows<{ recipient_ref: string; channel: string }>('select recipient_ref, channel from channel_conversation_bindings where task_id = $1', [(res.body.landed as { taskId: string }[])[0]!.taskId]);
    expect(binding).toMatchObject({ channel: 'whatsapp', recipient_ref: NEW_CALLER });
  });

  it('fails closed without the call gateway’s signature', async () => {
    expect((await callTurn(bed, 'wacid.INTEGRATION_CALL_3', 1, CALLER, 'hola', 'a-different-secret-of-32-characters!')).status).toBe(401);
    expect(await bed.rows("select 1 from inbound_events where provider_event_id like 'call:%' and content_type not in ('transcript', 'call-ended')")).toEqual([]);
  });
});

describe('WhatsApp calls where the pack does not frame them', { timeout: 60_000 }, () => {
  it('without media perception, a call transcript is unsupported content: the words never reach the agent as text', async () => {
    const plain = await LiveOpsTestbed.start({ allowlist: [CALLER], autonomy: true, env: { R4_WHATSAPP_CALL_SECRET: SECRET } });
    try {
      const res = await callTurn(plain, 'wacid.PLAIN_CALL_1', 1, CALLER, 'sí, emítela');
      expect(res.status).toBe(200);
      const [row] = await plain.rows<{ content_kind: string; content_type: string; disposition: string }>("select content_kind, content_type, disposition from inbound_events where provider_event_id like 'call:%'");
      expect(row).toMatchObject({ content_kind: 'unsupported', content_type: 'transcript', disposition: 'held:unsupported_inbound_content' });
    } finally {
      await plain.close();
    }
  });

  it('without R4_WHATSAPP_CALL_SECRET there is no call ingress', async () => {
    const plain = await LiveOpsTestbed.start({ allowlist: [CALLER], autonomy: true });
    try {
      expect((await callTurn(plain, 'wacid.PLAIN_CALL_2', 1, CALLER, 'hola')).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
