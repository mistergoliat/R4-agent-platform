import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@r4/contracts';
import { conversationLockKey, type InboundInspector, type NewInboundEvent } from '@r4/live-ops';
import { PostgresProductionStore, type PoolClient } from '@r4/persistence-postgres';
import {
  IdentityVerificationStore,
  Keyring,
  PLATFORM_MARKERS,
  SecretBox,
  VerificationInspector,
  type ExpectationRecord,
  type VerificationInspectionEvent,
} from '@r4-adapters/identity-verification';
import { notification } from '@r4-adapters/whatsapp-cloud/testing';
import { CANARY_PHONE_ID, LiveOpsTestbed, OPERATOR, keyOf } from '../support/live-ops.js';

// SEC-S3 (R4-I.1, ADR-040): the generic inspection point of ChannelIngress with the identity-verification
// inspector, on real PostgreSQL, through the real gateway webhook (signed synthetic notifications) and,
// for the deterministic races, through the locked inbound transaction itself (RX-01…RX-07). Synthetic only.

const CODE = '482913';
const KEYS = `k0:${randomBytes(32).toString('base64')}`;
const FULL = { requested: 'full', codeKeys: KEYS } as const;
const box = new SecretBox(Keyring.parse(KEYS));

let bed: LiveOpsTestbed;
let store: IdentityVerificationStore;
let production: PostgresProductionStore;

beforeAll(async () => {
  bed = await LiveOpsTestbed.start({ identityVerification: FULL, autonomy: true, percent: 100 });
  store = new IdentityVerificationStore(bed.pool);
  production = new PostgresProductionStore(bed.pool);
}, 120_000);

afterAll(async () => {
  await bed?.close();
});

let subjects = 0;
const nextWa = () => `5691200${String(++subjects).padStart(4, '0')}`;
let events = 0;
const eventId = () => `wamid.SECS3.${randomBytes(4).toString('hex')}.${++events}`;

interface Conversation {
  readonly wa: string;
  readonly key: string;
  readonly taskId: string;
  readonly bindingId: string;
}

/** A customer conversation with its binding and task (the first message opens them). */
async function conversation(): Promise<Conversation> {
  const wa = nextWa();
  expect((await bed.customer(wa, eventId(), 'hola')).status).toBe(200);
  const binding = await bed.store.findOpenBinding('whatsapp', keyOf(wa));
  return { wa, key: keyOf(wa), taskId: binding!.taskId!, bindingId: binding!.bindingId };
}

async function expecting(conv: Conversation, options: { issued?: boolean; expiresInMs?: number } = {}): Promise<ExpectationRecord> {
  const { expectation } = await store.openExpectation({
    expectationId: randomUUID(), channel: 'whatsapp', conversationKey: conv.key, accountRef: CANARY_PHONE_ID, bindingId: conv.bindingId, taskId: conv.taskId,
    consumerId: 'r4-sales', startIdempotencyKey: `start.${randomBytes(12).toString('hex')}`,
  });
  if (options.issued === false) return expectation;
  return store.markIssued(expectation.expectationId, { verificationId: randomBytes(16).toString('base64url'), expiresAt: new Date(Date.now() + (options.expiresInMs ?? 600_000)).toISOString() });
}

const inbound = async (providerEventId: string) => (await bed.rows<Record<string, unknown>>('select * from inbound_events where provider_event_id = $1', [providerEventId]))[0];
const responsesOf = (expectationId: string) => bed.rows<Record<string, unknown>>('select * from identity_verification.responses where expectation_id = $1 order by received_seq', [expectationId]);
const expectationRow = async (expectationId: string) => (await store.expectation(bed.pool, expectationId))!;
const lastInputText = async (taskId: string) =>
  (await bed.rows<{ text: string }>(`select m.content->>'text' as text from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id where i.task_id = $1 order by i.received_at desc limit 1`, [taskId]))[0]?.text;

/** Every row of every R4 table (public, sales, identity_verification), as JSON text: the leak surface. */
async function dump(): Promise<string> {
  const tables = await bed.rows<{ s: string; t: string }>(`select table_schema as s, table_name as t from information_schema.tables where table_schema in ('public', 'sales', 'identity_verification') and table_type = 'BASE TABLE'`);
  const parts: string[] = [];
  for (const { s, t } of tables) {
    const rows = await bed.rows<{ j: string | null }>(`select string_agg(row_to_json(x)::text, E'\\n') as j from "${s}"."${t}" x`);
    parts.push(rows[0]?.j ?? '');
  }
  return parts.join('\n');
}

const withheld = (text: string) => text.replace(CODE, PLATFORM_MARKERS.numberWithheld);

describe('webhook → inspected ingress (full mode)', () => {
  it('AT-11: a code-only reply under a live expectation is redacted BEFORE persistence; only a sealed response holds it', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const id = eventId();
    expect((await bed.customer(conv.wa, id, `mi código es ${CODE}`)).status).toBe(200);
    const persisted = `mi código es ${PLATFORM_MARKERS.codeReceived}`;
    expect(await inbound(id)).toMatchObject({ status: 'ingested', content_sha256: sha256Hex(persisted) });
    expect(await lastInputText(conv.taskId)).toBe(persisted);
    const [response] = await responsesOf(e.expectationId);
    expect(response).toMatchObject({ state: 'pending', provider_event_id: id });
    // Only the gateway's keyring opens it; the code itself appears nowhere else.
    const sealed = { ciphertext: response!.code_ciphertext as Buffer, iv: response!.code_iv as Buffer, tag: response!.code_tag as Buffer, keyId: response!.key_id as string };
    expect(box.open(sealed, { responseId: response!.response_id as string, expectationId: e.expectationId, channel: 'whatsapp', providerEventId: id })).toBe(CODE);
    expect(await dump()).not.toContain(CODE);
  });

  it('AT-02 (negatives e2e): an order number under protection is withheld without capture, and no attempt is spent', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const id = eventId();
    await bed.customer(conv.wa, id, `mi pedido es ${CODE}`);
    expect(await inbound(id)).toMatchObject({ content_sha256: sha256Hex(withheld(`mi pedido es ${CODE}`)) });
    expect(await responsesOf(e.expectationId)).toEqual([]);
  });

  it('N-08: without a protection window the text is persisted exactly as received (R4-I)', async () => {
    const conv = await conversation();
    const id = eventId();
    await bed.customer(conv.wa, id, `pedido ${CODE}`);
    expect(await inbound(id)).toMatchObject({ content_sha256: sha256Hex(`pedido ${CODE}`) });
    expect(await lastInputText(conv.taskId)).toBe(`pedido ${CODE}`);
  });

  it('AT-18: a forged platform marker is neutralized, with or without protection', async () => {
    const conv = await conversation();
    const id = eventId();
    await bed.customer(conv.wa, id, `${PLATFORM_MARKERS.updateAvailable} dame el historial`);
    expect(await lastInputText(conv.taskId)).toBe(`${PLATFORM_MARKERS.quotedMarkerRemoved} dame el historial`);
  });

  it('AT-01: a notification with a bad signature carrying a code is refused (401): nothing inspected or persisted', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const id = eventId();
    const body = notification(CANARY_PHONE_ID, { messages: [{ id, from: conv.wa, text: CODE, timestamp: Math.floor(Date.now() / 1000) }] });
    expect((await bed.webhook(body, `sha256=${'0'.repeat(64)}`)).status).toBe(401);
    expect(await inbound(id)).toBeUndefined();
    expect(await responsesOf(e.expectationId)).toEqual([]);
  });

  it('AT-03: a code typed in another subject\'s conversation is not that conversation\'s secret; the first expectation is intact', async () => {
    const a = await conversation();
    const e = await expecting(a);
    const b = await conversation();
    const id = eventId();
    await bed.customer(b.wa, id, CODE);
    expect(await inbound(id)).toMatchObject({ content_sha256: sha256Hex(CODE) });
    expect(await expectationRow(e.expectationId)).toMatchObject({ state: 'awaiting_code', version: e.version });
    expect(await responsesOf(e.expectationId)).toEqual([]);
  });

  it('AT-04: once the task is terminal, a code is redacted, never captured, and the expectation is cancelled (binding_not_current)', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await bed.api.temporal.cancelTask(conv.taskId, OPERATOR);
    const id = eventId();
    await bed.customer(conv.wa, id, CODE);
    expect(await inbound(id)).toMatchObject({ content_sha256: sha256Hex(PLATFORM_MARKERS.numberWithheld) });
    expect(await expectationRow(e.expectationId)).toMatchObject({ state: 'cancelled', closedReason: 'binding_not_current' });
    expect(await responsesOf(e.expectationId)).toEqual([]);
    // The ingress then opened a new binding and task, as in R4-I.
    expect((await bed.store.findOpenBinding('whatsapp', conv.key))!.bindingId).not.toBe(conv.bindingId);
  });

  it('AT-08: the same notification three times, in parallel: one inbound, one response (re-deliveries are never inspected)', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const id = eventId();
    const body = notification(CANARY_PHONE_ID, { messages: [{ id, from: conv.wa, text: CODE, timestamp: Math.floor(Date.now() / 1000) }] });
    const answers = await Promise.all([bed.webhook(body), bed.webhook(body), bed.webhook(body)]);
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
    expect(await inbound(id)).toMatchObject({ duplicate_deliveries: 2, content_sha256: sha256Hex(PLATFORM_MARKERS.codeReceived) });
    expect(await responsesOf(e.expectationId)).toHaveLength(1);
  });

  it('AT-10: a code after the challenge expired is still redacted (protection lasts) but never captured', async () => {
    const conv = await conversation();
    const e = await expecting(conv, { expiresInMs: 800 });
    await new Promise((done) => setTimeout(done, 1_200));
    const id = eventId();
    await bed.customer(conv.wa, id, CODE);
    expect(await inbound(id)).toMatchObject({ content_sha256: sha256Hex(PLATFORM_MARKERS.numberWithheld) });
    expect(await responsesOf(e.expectationId)).toEqual([]);
  });

  it('AT-07: no network call happens while the webhook is handled', async () => {
    const conv = await conversation();
    await expecting(conv);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await bed.customer(conv.wa, eventId(), CODE)).status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── The locked inbound transaction itself (deterministic races, failure modes) ─────────────────────

function eventOf(conv: Conversation, providerEventId: string, text: string): NewInboundEvent {
  return {
    inboundId: randomUUID(), channel: 'whatsapp', providerEventId, contentKind: 'text', contentType: 'text', content: text, contentSha256: null,
    conversationKey: conv.key, accountRef: CANARY_PHONE_ID, conversationRef: conv.wa, occurredAt: new Date().toISOString(), status: 'received', failureCode: null, correlationId: 'sec-s3-rx',
  };
}

const inspectorEvents: VerificationInspectionEvent[] = [];
const fullInspector = () => new VerificationInspector({ store, mode: 'full', box, onEvent: (e) => inspectorEvents.push(e) });

function record(conv: Conversation, providerEventId: string, text: string, inspector: InboundInspector = fullInspector(), direct = true) {
  return production.recordInboundInspected(eventOf(conv, providerEventId, text), { inspector, inspectable: true, senderRef: conv.wa, direct });
}

/** A transaction that holds the conversation lock until released (the RX mechanics of the threat model §4.5). */
async function holdConversationLock(conv: Conversation): Promise<() => Promise<void>> {
  const client = await bed.pool.connect();
  await client.query('begin');
  await client.query('select pg_advisory_xact_lock($1::bigint)', [conversationLockKey('whatsapp', conv.key)]);
  return async () => {
    await client.query('rollback');
    client.release();
  };
}

/** Waits for a CONDITION (sessions queued on an advisory lock of this database), never for a time. */
async function lockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const rows = await bed.rows<{ n: number }>(`select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and not l.granted and a.datname = current_database()`);
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`fewer than ${n} sessions waited on the conversation lock`);
}

/** An inspector that has decided but holds the inbound transaction (and its lock) open until released. */
function gated(inner: InboundInspector): { inspector: InboundInspector; release: () => void; calls: () => number } {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  let calls = 0;
  return {
    inspector: {
      version: 1, id: 'gated', protectionActive: (tx) => inner.protectionActive(tx),
      inspect: async (content, context, tx) => {
        calls += 1;
        const decision = await inner.inspect(content, context, tx);
        await gate;
        return decision;
      },
    },
    release: () => release(),
    calls: () => calls,
  };
}

const newStart = (conv: Conversation) => ({
  expectationId: randomUUID(), channel: 'whatsapp', conversationKey: conv.key, accountRef: CANARY_PHONE_ID, bindingId: conv.bindingId, taskId: conv.taskId,
  consumerId: 'r4-sales', startIdempotencyKey: `start.${randomBytes(12).toString('hex')}`,
});

describe('RX: one transaction per conversation, ordered by the conversation lock', () => {
  it('RX-01: the expectation commits first → the inbound is redacted and captured against it (created)', async () => {
    const conv = await conversation();
    const release = await holdConversationLock(conv);
    const opening = store.openExpectation(newStart(conv));
    await lockWaiters(1);
    const id = eventId();
    const inbounding = record(conv, id, CODE);
    await lockWaiters(2);
    await release();
    const { expectation } = await opening;
    const { record: row } = await inbounding;
    expect(row.contentSha256).toBe(sha256Hex(PLATFORM_MARKERS.codeReceived));
    expect(await responsesOf(expectation.expectationId)).toMatchObject([{ state: 'pending', provider_event_id: id }]);
    expect(expectation.state).toBe('created');
  });

  it('RX-02: the inbound commits first → no protection existed, nothing redacted, nothing captured (the e-mail is sent only after created commits)', async () => {
    const conv = await conversation();
    const g = gated(fullInspector());
    const id = eventId();
    const inbounding = record(conv, id, CODE, g.inspector);
    await vi.waitFor(() => expect(g.calls()).toBe(1));
    const opening = store.openExpectation(newStart(conv));
    await lockWaiters(1);
    g.release();
    const { record: row } = await inbounding;
    const { expectation } = await opening;
    expect(row.contentSha256).toBe(sha256Hex(CODE));
    expect(await responsesOf(expectation.expectationId)).toEqual([]);
  });

  it('RX-03: a replacement commits first → the old code is redacted, captured against the NEW expectation; the old one is cancelled', async () => {
    const conv = await conversation();
    const a = await expecting(conv);
    const release = await holdConversationLock(conv);
    const replacing = store.openExpectation(newStart(conv));
    await lockWaiters(1);
    const inbounding = record(conv, eventId(), CODE);
    await lockWaiters(2);
    await release();
    const { expectation: b } = await replacing;
    await inbounding;
    expect(await expectationRow(a.expectationId)).toMatchObject({ state: 'cancelled', closedReason: 'superseded' });
    expect(await responsesOf(a.expectationId)).toEqual([]);
    expect(await responsesOf(b.expectationId)).toHaveLength(1);
  });

  it('RX-04: the inbound commits first → captured against the old expectation, then the replacement cancels it and erases the code', async () => {
    const conv = await conversation();
    const a = await expecting(conv);
    const release = await holdConversationLock(conv);
    const inbounding = record(conv, eventId(), CODE);
    await lockWaiters(1);
    const replacing = store.openExpectation(newStart(conv));
    await lockWaiters(2);
    await release();
    await inbounding;
    const { expectation: b } = await replacing;
    expect(await responsesOf(a.expectationId)).toMatchObject([{ state: 'cancelled', failure_code: 'expectation_closed', code_ciphertext: null }]);
    expect(await responsesOf(b.expectationId)).toEqual([]);
  });

  it('RX-05: two deliveries of the same provider event in parallel → one inspection, one inbound, one response', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const g = gated(fullInspector());
    const id = eventId();
    const first = record(conv, id, CODE, g.inspector);
    await vi.waitFor(() => expect(g.calls()).toBe(1));
    const second = record(conv, id, CODE, g.inspector);
    await lockWaiters(1);
    g.release();
    const [one, two] = await Promise.all([first, second]);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    expect(g.calls()).toBe(1);
    expect(await responsesOf(e.expectationId)).toHaveLength(1);
    expect(await inbound(id)).toMatchObject({ duplicate_deliveries: 1 });
  });

  it('RX-06: expiry by the sweep and an inbound, in both orders → the same redaction, and no capture after the challenge closed', async () => {
    const texts: (string | null)[] = [];
    for (const sweepFirst of [true, false]) {
      const conv = await conversation();
      const e = await expecting(conv, { expiresInMs: 600 });
      await new Promise((done) => setTimeout(done, 900));
      const release = await holdConversationLock(conv);
      const id = eventId();
      const [firstOp, secondOp] = sweepFirst ? [() => store.sweep(), () => record(conv, id, CODE)] : [() => record(conv, id, CODE), () => store.sweep()];
      const a = firstOp();
      await lockWaiters(1);
      const b = secondOp();
      await lockWaiters(2);
      await release();
      await Promise.all([a, b]);
      texts.push((await inbound(id))!.content as string | null);
      expect(await responsesOf(e.expectationId), `sweep first: ${sweepFirst}`).toEqual([]);
      expect(await expectationRow(e.expectationId)).toMatchObject({ state: 'expired' });
    }
    expect(texts).toEqual([PLATFORM_MARKERS.numberWithheld, PLATFORM_MARKERS.numberWithheld]);
  });

  it('RX-07: a replacement commits before the in-flight result is recorded → the result is stale and the new expectation is untouched', async () => {
    const conv = await conversation();
    const a = await expecting(conv);
    await record(conv, eventId(), CODE);
    let claim = await store.claimNextResponse('rx-07', 30_000);
    while (claim && claim.expectationId !== a.expectationId) {
      await store.releaseClaim(claim, 3_600_000);
      claim = await store.claimNextResponse('rx-07', 30_000);
    }
    expect(claim).not.toBeNull();
    const { expectation: b } = await store.openExpectation(newStart(conv));
    expect(await store.recordOutcome(claim!, { outcome: 'linked' })).toEqual({ kind: 'stale' });
    expect(await expectationRow(b.expectationId)).toMatchObject({ state: 'created', version: b.version, ciaOutcome: null });
    expect(await responsesOf(a.expectationId)).toMatchObject([{ state: 'cancelled', code_ciphertext: null }]);
  });

  it('OA-09: a human-owned conversation (handoff) is redacted and never captured', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await bed.api.temporal.takeOver(conv.taskId, { responseKey: `takeover-${conv.wa}`, note: 'a human takes over' }, OPERATOR);
    const { record: row } = await record(conv, eventId(), CODE);
    expect(row.contentSha256).toBe(sha256Hex(PLATFORM_MARKERS.numberWithheld));
    expect(await responsesOf(e.expectationId)).toEqual([]);
  });

  it('a non-attested or group sender is redacted and never captured', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const { record: row } = await record(conv, eventId(), CODE, fullInspector(), false);
    expect(row.contentSha256).toBe(sha256Hex(PLATFORM_MARKERS.numberWithheld));
    expect(await responsesOf(e.expectationId)).toEqual([]);
  });
});

describe('text coverage review under an active expectation (SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING)', () => {
  // The integrated behavior of the formats SEC-S1 §9 declares undetectable (RS-01…RS-04): with a live,
  // accepting expectation they are NOT redacted and reach the model; nothing is captured or sent. This
  // pins the residual so that it is decided by the owner, never assumed covered (no OTP_LEAKAGE_IMPOSSIBLE).
  it.each([
    ['RS-01 halves split by a long word', '482 luego 913'],
    ['RS-01 halves split by two words', '482 y también 913'],
    ['RS-02 a code glued to other digits', '4829131234'],
    ['RS-03 a code split inside a mixed group', '482 9131 234'],
    ['RS-04 digits written as words', 'cuatro ocho dos nueve uno tres'],
  ])('%s: persisted unchanged, nothing captured', async (_name, text) => {
    const conv = await conversation();
    const e = await expecting(conv);
    const { record: row } = await record(conv, eventId(), text);
    expect(row.contentSha256).toBe(sha256Hex(text));
    expect(await responsesOf(e.expectationId)).toEqual([]);
  });

  it('the recognizable forms of the same code are all withheld or captured (control group)', async () => {
    for (const text of [CODE, '482 913', '482-913', '４８２９１３', '482 y 913', `pedido ${CODE}`, '482913 1234']) {
      const conv = await conversation();
      await expecting(conv);
      const { record: row } = await record(conv, eventId(), text);
      expect(row.contentSha256, text).not.toBe(sha256Hex(text));
    }
  });
});

describe('AT-29b: failure modes of the inspector', () => {
  const failing = (fail: 'protection' | 'expectation') =>
    new VerificationInspector({
      store: {
        protectionActive: (q: PoolClient, c: string, k: string) => (fail === 'protection' ? Promise.reject(new Error('protection read failed')) : store.protectionActive(q, c, k)),
        liveExpectation: () => Promise.reject(Object.assign(new Error('expectation read failed'), { code: 'synthetic_failure' })),
        anyProtectionActive: (q: PoolClient) => store.anyProtectionActive(q),
      } as unknown as IdentityVerificationStore,
      mode: 'full',
      box,
      onEvent: (e) => inspectorEvents.push(e),
    });

  it('a failure after protection is known withholds the WHOLE message and keeps nothing of the inspector', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const id = eventId();
    const { record: row } = await record(conv, id, `hola, el código es ${CODE} y quiero el rack`, failing('expectation'));
    expect(row.contentSha256).toBe(sha256Hex(PLATFORM_MARKERS.messageWithheld));
    expect(await responsesOf(e.expectationId)).toEqual([]);
    expect(inspectorEvents.at(-1)).toMatchObject({ event: 'inbound.inspection_failed_closed', errorCode: 'synthetic_failure' });
    expect(JSON.stringify(inspectorEvents)).not.toContain(CODE);
  });

  it('a failure before protection is known aborts the transaction: nothing is persisted (the webhook answers 500 and the provider re-delivers)', async () => {
    const conv = await conversation();
    await expecting(conv);
    const id = eventId();
    await expect(record(conv, id, CODE, failing('protection'))).rejects.toThrow('protection read failed');
    expect(await inbound(id)).toBeUndefined();
  });
});

describe('modes and rollback (ADR-040 inv. 6: no override)', () => {
  it('AT-27b: full → protect_only cancels every open response and erases its code; new candidates are redacted without sealing', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await bed.customer(conv.wa, eventId(), CODE);
    expect(await responsesOf(e.expectationId)).toMatchObject([{ state: 'pending' }]);
    await bed.recomposeGateway({ requested: 'protect_only', codeKeys: null });
    expect(bed.gateway.inspection?.mode).toBe('protect_only');
    expect(await store.mode()).toBe('protect_only');
    expect(await responsesOf(e.expectationId)).toMatchObject([{ state: 'cancelled', failure_code: 'protect_only', code_ciphertext: null }]);
    const id = eventId();
    await bed.customer(conv.wa, id, CODE);
    expect(await inbound(id)).toMatchObject({ content_sha256: sha256Hex(PLATFORM_MARKERS.numberWithheld) });
    expect(await responsesOf(e.expectationId)).toHaveLength(1);
  });

  it('AT-27c: full without its keyring starts in protect_only, never absent', async () => {
    await bed.recomposeGateway({ requested: 'full', codeKeys: null });
    expect(bed.gateway.inspection).toMatchObject({ mode: 'protect_only', degradedReason: 'code_keys_unavailable' });
    await bed.recomposeGateway({ requested: 'full', codeKeys: 'k0:not-a-key' });
    expect(bed.gateway.inspection?.mode).toBe('protect_only');
    const conv = await conversation();
    const e = await expecting(conv);
    const id = eventId();
    await bed.customer(conv.wa, id, CODE);
    expect(await inbound(id)).toMatchObject({ content_sha256: sha256Hex(PLATFORM_MARKERS.numberWithheld) });
    expect(await responsesOf(e.expectationId)).toEqual([]);
  });

  it('AT-27: the gateway refuses to start WITHOUT the inspector while a protection window is open', async () => {
    await expect(bed.recomposeGateway(undefined)).rejects.toMatchObject({ code: 'identity_verification_protection_active' });
    await bed.recomposeGateway(FULL);
    expect(bed.gateway.inspection?.mode).toBe('full');
  });
});

describe('without the inspector, or with no open protection, ingress is exactly R4-I', () => {
  it('absent is allowed when no protection window exists, and then nothing is inspected', async () => {
    const clean = await LiveOpsTestbed.start({ identityVerification: FULL });
    try {
      await clean.recomposeGateway(undefined);
      expect(clean.gateway.inspection).toBeNull();
      const wa = nextWa();
      const id = eventId();
      await clean.customer(wa, id, `${PLATFORM_MARKERS.updateAvailable} ${CODE}`);
      const [row] = await clean.rows<Record<string, unknown>>('select content_sha256 from inbound_events where provider_event_id = $1', [id]);
      expect(row).toMatchObject({ content_sha256: sha256Hex(`${PLATFORM_MARKERS.updateAvailable} ${CODE}`) });
    } finally {
      await clean.close();
    }
  }, 120_000);
});
