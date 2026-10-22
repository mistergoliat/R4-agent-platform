import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationLockKey } from '@r4/live-ops';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import {
  IdentityVerificationStore,
  Keyring,
  PLATFORM_MARKERS,
  RESUME_SOURCE,
  SecretBox,
  VerificationConfirmDispatcher,
  VerificationInspector,
  confirmIdempotencyKey,
  type ConfirmAnswer,
  type ConfirmPort,
  type DispatchEvent,
  type ExpectationRecord,
  type IdentityVerificationInspection,
  type ResumePort,
  type VerificationConfirmDispatcherOptions,
} from '@r4-adapters/identity-verification';
import { CANARY_PHONE_ID, LiveOpsTestbed, OPERATOR, keyOf } from '../support/live-ops.js';

// SEC-S4: deferred confirmation on real PostgreSQL, with codes captured by the real gateway webhook and
// inspector, the real ProductionStore (V of RR-1) and the real TemporalRuntime (resume). The CIA is an
// in-process double with the contract's idempotency semantics (a replay of the same key returns the
// first answer, I06). AT-05, AT-06, AT-09, AT-14, AT-16, AT-17, AT-29, AT-30, AT-31, RR1-T07, RR1-T08,
// RX-08 and the special condition (an in-flight result of a replaced expectation). Synthetic only.

const KEYS = `k0:${randomBytes(32).toString('base64')}`;
const box = new SecretBox(Keyring.parse(KEYS));
const RIGHT = '482913';
const WRONG = '111222';

/** The bed's own composed dispatcher is never started here: each test drives a dispatcher of its own. */
const NOT_STARTED: ConfirmPort = { confirm: () => Promise.reject(new Error('the composed dispatcher is not started in this suite')) };

let bed: LiveOpsTestbed;
let store: IdentityVerificationStore;

beforeAll(async () => {
  bed = await LiveOpsTestbed.start({ identityVerification: { requested: 'full', codeKeys: KEYS, confirm: NOT_STARTED }, autonomy: true, percent: 100 });
  store = new IdentityVerificationStore(bed.pool);
}, 120_000);

afterAll(async () => {
  await bed?.close();
});

// A response left open by an earlier test must never be claimed by a later one: park it (test plumbing only).
beforeEach(async () => {
  for (let claim = await store.claimNextResponse('test-parking', 30_000); claim; claim = await store.claimNextResponse('test-parking', 30_000)) {
    await store.releaseClaim(claim, 3_600_000);
  }
});

/** The CIA double: one answer per call from a script; a replay of an APPLIED key returns the stored answer. */
class CiaDouble implements ConfirmPort {
  readonly calls: Parameters<ConfirmPort['confirm']>[0][] = [];
  readonly #applied = new Map<string, ConfirmAnswer>();
  #script: (request: Parameters<ConfirmPort['confirm']>[0], call: number) => Promise<ConfirmAnswer> | ConfirmAnswer;

  constructor(script: CiaDouble['script'] = () => ({ kind: 'outcome', outcome: 'linked' })) {
    this.#script = script;
  }

  set script(script: (request: Parameters<ConfirmPort['confirm']>[0], call: number) => Promise<ConfirmAnswer> | ConfirmAnswer) {
    this.#script = script;
  }

  /** The CIA applies an outcome but the answer is lost (the connection is cut): a later replay returns it. */
  applyAndCut(key: string, answer: ConfirmAnswer): ConfirmAnswer {
    this.#applied.set(key, answer);
    return { kind: 'retry', code: 'identity_unreachable', retryAfterMs: null };
  }

  async confirm(request: Parameters<ConfirmPort['confirm']>[0]): Promise<ConfirmAnswer> {
    this.calls.push(structuredClone(request));
    const stored = this.#applied.get(request.idempotencyKey);
    if (stored) return stored;
    const answer = await this.#script(request, this.calls.length);
    if (answer.kind === 'outcome') this.#applied.set(request.idempotencyKey, answer);
    return answer;
  }
}

const events: DispatchEvent[] = [];
function dispatcher(cia: ConfirmPort, overrides: Partial<VerificationConfirmDispatcherOptions> = {}) {
  return new VerificationConfirmDispatcher({
    store, box, confirm: cia, bindings: bed.store, resume: bed.api.temporal, owner: `gw-${randomBytes(3).toString('hex')}`,
    random: () => 0.5, onEvent: (e) => events.push(e), ...overrides,
  });
}

let subjects = 0;
const nextWa = () => `5691300${String(++subjects).padStart(4, '0')}`;
let counter = 0;
const eventId = () => `wamid.SECS4.${randomBytes(4).toString('hex')}.${++counter}`;

interface Conversation { readonly wa: string; readonly key: string; readonly taskId: string; readonly bindingId: string }
const issued: string[] = [];

async function conversation(): Promise<Conversation> {
  const wa = nextWa();
  await bed.customer(wa, eventId(), 'hola');
  const binding = await bed.store.findOpenBinding('whatsapp', keyOf(wa));
  return { wa, key: keyOf(wa), taskId: binding!.taskId!, bindingId: binding!.bindingId };
}

async function expecting(conv: Conversation, expiresInMs = 600_000): Promise<ExpectationRecord> {
  const { expectation } = await store.openExpectation({
    expectationId: randomUUID(), channel: 'whatsapp', conversationKey: conv.key, accountRef: CANARY_PHONE_ID, bindingId: conv.bindingId, taskId: conv.taskId,
    consumerId: 'r4-sales', startIdempotencyKey: `start.${randomBytes(12).toString('hex')}`,
  });
  const verificationId = randomBytes(16).toString('base64url');
  issued.push(verificationId);
  return store.markIssued(expectation.expectationId, { verificationId, expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
}

/** The customer replies with a code through the real webhook; returns its provider event id. */
async function reply(conv: Conversation, code: string): Promise<string> {
  const id = eventId();
  expect((await bed.customer(conv.wa, id, code)).status).toBe(200);
  return id;
}

const responses = (expectationId: string) => bed.rows<Record<string, unknown>>('select * from identity_verification.responses where expectation_id = $1 order by received_seq', [expectationId]);
const expectationOf = async (id: string) => (await store.expectation(bed.pool, id))!;
const resumeInputs = (taskId: string) =>
  bed.rows<{ text: string; external_key: string }>(
    `select m.content->>'text' as text, i.external_key from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id where i.task_id = $1 and i.source_ref = $2 order by i.received_at`,
    [taskId, RESUME_SOURCE],
  );

/** Repeats dispatch cycles (honoring backoff) until `done` holds; fails after `ms`. */
async function until(d: VerificationConfirmDispatcher, done: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error('condition not reached');
    if ((await d.dispatchOnce()) === 'idle') await new Promise((r) => setTimeout(r, 50));
  }
}

function barrier() {
  let open!: () => void;
  const opened = new Promise<void>((done) => (open = done));
  let reached!: () => void;
  const arrived = new Promise<void>((done) => (reached = done));
  return { open: () => open(), opened, arrived, arrive: () => reached() };
}

describe('the cycle: claim → V → open → confirm → record → resume', () => {
  it('a captured code is confirmed with the binding context and the event-derived key; the task is resumed with a marker that carries no outcome', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const id = await reply(conv, `mi código es ${RIGHT}`);
    const cia = new CiaDouble();
    expect(await dispatcher(cia).dispatchOnce()).toBe('confirmed');
    expect(cia.calls).toEqual([{
      context: { channel: 'whatsapp', channelAccountRef: CANARY_PHONE_ID, subjectRef: conv.wa, sessionRef: conv.bindingId },
      verificationId: e.verificationId, code: RIGHT, idempotencyKey: confirmIdempotencyKey('whatsapp', id), correlationId: expect.stringMatching(/^verification-/) as string,
    }]);
    expect(await expectationOf(e.expectationId)).toMatchObject({ state: 'confirmed', ciaOutcome: 'linked' });
    expect(await responses(e.expectationId)).toMatchObject([{ state: 'notified', cia_outcome: 'linked', code_ciphertext: null }]);
    const inputs = await resumeInputs(conv.taskId);
    expect(inputs.map((i) => i.text)).toEqual([PLATFORM_MARKERS.updateAvailable]);
    expect(JSON.stringify(inputs)).not.toMatch(/linked|482913/);
  });

  it('AT-05: the same correct code twice → one confirm; the second response is cancelled with its code erased, never sent', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    await reply(conv, RIGHT);
    const cia = new CiaDouble();
    const d = dispatcher(cia);
    expect(await d.dispatchOnce()).toBe('confirmed');
    expect(await d.dispatchOnce()).toBe('idle');
    expect(cia.calls).toHaveLength(1);
    expect((await responses(e.expectationId)).map((r) => [r.state, r.code_ciphertext])).toEqual([['notified', null], ['cancelled', null]]);
  });

  it('AT-06: start A, start B, then the code of A → A is cancelled, the code is confirmed against B, and the CIA answers invalid_code', async () => {
    const conv = await conversation();
    const a = await expecting(conv);
    const b = await expecting(conv);
    await reply(conv, RIGHT);
    const cia = new CiaDouble((request) => (request.verificationId === a.verificationId ? { kind: 'outcome', outcome: 'linked' } : { kind: 'outcome', outcome: 'invalid_code', attemptsRemaining: 4 }));
    expect(await dispatcher(cia).dispatchOnce()).toBe('confirmed');
    expect(cia.calls.map((c) => c.verificationId)).toEqual([b.verificationId]);
    expect(await expectationOf(a.expectationId)).toMatchObject({ state: 'cancelled', closedReason: 'superseded' });
    expect(await expectationOf(b.expectationId)).toMatchObject({ state: 'awaiting_code', ciaOutcome: 'invalid_code', attemptsRemaining: 4 });
  });

  it('AT-09: two codes are dispatched in arrival order and never in parallel for one expectation', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, WRONG);
    await reply(conv, RIGHT);
    const gate = barrier();
    const cia = new CiaDouble(async (request) => {
      gate.arrive();
      await gate.opened;
      return request.code === RIGHT ? { kind: 'outcome', outcome: 'linked' } : { kind: 'outcome', outcome: 'invalid_code', attemptsRemaining: 4 };
    });
    const d1 = dispatcher(cia);
    const first = d1.dispatchOnce();
    await gate.arrived;
    expect(await dispatcher(cia).dispatchOnce()).toBe('idle'); // the expectation is leased: not claimable in parallel
    gate.open();
    expect(await first).toBe('confirmed');
    expect(await d1.dispatchOnce()).toBe('confirmed');
    expect(cia.calls.map((c) => c.code)).toEqual([WRONG, RIGHT]);
    expect(await expectationOf(e.expectationId)).toMatchObject({ state: 'confirmed', ciaOutcome: 'linked' });
  });
});

describe('recovery and idempotency', () => {
  it('AT-14: the dispatcher dies after sending → a new claim after the lease, the same key and body; the CIA counts one attempt; one resume', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    const cia = new CiaDouble();
    const crashing = dispatcher({ confirm: async (request) => { await cia.confirm(request); throw new Error('process died after the send'); } }, { leaseMs: 300 });
    await expect(crashing.dispatchOnce()).rejects.toThrow('process died');
    expect(await responses(e.expectationId)).toMatchObject([{ state: 'dispatching' }]);
    await new Promise((r) => setTimeout(r, 400));
    expect(await dispatcher(cia).dispatchOnce()).toBe('confirmed');
    expect(cia.calls).toHaveLength(2);
    expect(cia.calls[1]).toEqual(cia.calls[0]);
    expect(await responses(e.expectationId)).toMatchObject([{ state: 'notified', attempts: 2, lease_generation: '2' }]);
    expect(await resumeInputs(conv.taskId)).toHaveLength(1);
  });

  it('AT-16: the CIA applied the attempt and the connection was cut → retried with the same key; the stored answer is recorded', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    const cia: CiaDouble = new CiaDouble((request): ConfirmAnswer => cia.applyAndCut(request.idempotencyKey, { kind: 'outcome', outcome: 'linked' }));
    const d = dispatcher(cia);
    expect(await d.dispatchOnce()).toBe('retry_scheduled');
    await until(d, async () => (await expectationOf(e.expectationId)).state === 'confirmed');
    expect(new Set(cia.calls.map((c) => JSON.stringify(c))).size).toBe(1);
  });

  it('AT-17: two dispatchers → one dispatch per response; a result written with an older generation is rejected', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    const cia = new CiaDouble();
    const results = await Promise.all([dispatcher(cia).dispatchOnce(), dispatcher(cia).dispatchOnce()]);
    expect(results.sort()).toEqual(['confirmed', 'idle']);
    expect(cia.calls).toHaveLength(1);
    // Fencing: an expired lease re-claimed with a newer generation makes the old owner's writes stale.
    const conv2 = await conversation();
    const e2 = await expecting(conv2);
    await reply(conv2, RIGHT);
    const old = (await store.claimNextResponse('old-owner', 100))!;
    await new Promise((r) => setTimeout(r, 200));
    const current = (await store.claimNextResponse('new-owner', 30_000))!;
    expect(current.leaseGeneration).toBe('2');
    expect(await store.recordOutcome(old, { outcome: 'linked' })).toEqual({ kind: 'stale' });
    expect(await store.recordOutcome(current, { outcome: 'linked' })).toMatchObject({ kind: 'settled' });
    expect(await expectationOf(e2.expectationId)).toMatchObject({ state: 'confirmed' });
    expect(e.expectationId).not.toBe(e2.expectationId);
  });

  it('AT-29: a death between resolved and notified → the sweep resumes once (idempotent by external key)', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    const failingResume: ResumePort = { submitInput: () => Promise.reject(Object.assign(new Error('worker database blip'), { code: 'database_unavailable' })) };
    expect(await dispatcher(new CiaDouble(), { resume: failingResume }).dispatchOnce()).toBe('confirmed');
    expect(await responses(e.expectationId)).toMatchObject([{ state: 'resolved' }]);
    const sweeper = dispatcher(new CiaDouble(), { resumeAfterMs: 0 });
    expect((await sweeper.sweepOnce()).resumed).toBeGreaterThanOrEqual(1);
    await sweeper.sweepOnce();
    expect(await responses(e.expectationId)).toMatchObject([{ state: 'notified' }]);
    expect(await resumeInputs(conv.taskId)).toHaveLength(1);
  });

  it('AT-30: 503 → 503 → 200 → backoff, the same key, linked', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    const cia = new CiaDouble((_r, call) => (call < 3 ? { kind: 'retry', code: 'dependency_unavailable', retryAfterMs: null } : { kind: 'outcome', outcome: 'linked' }));
    const d = dispatcher(cia);
    await until(d, async () => (await expectationOf(e.expectationId)).state === 'confirmed');
    expect(cia.calls).toHaveLength(3);
    expect(new Set(cia.calls.map((c) => c.idempotencyKey)).size).toBe(1);
  });

  it('AT-30: 503 until the deadline → expired (verification unavailable) with the code erased; never confirmed after deadline - 5 s', async () => {
    const conv = await conversation();
    const e = await expecting(conv, 7_000);
    await reply(conv, RIGHT);
    const cia = new CiaDouble(() => ({ kind: 'retry', code: 'dependency_unavailable', retryAfterMs: null }));
    await until(dispatcher(cia), async () => (await expectationOf(e.expectationId)).state === 'expired', 10_000);
    expect(await expectationOf(e.expectationId)).toMatchObject({ state: 'expired', closedReason: 'confirm_unavailable' });
    expect(await responses(e.expectationId)).toMatchObject([{ state: 'expired', code_ciphertext: null }]);
    expect(cia.calls.length).toBeGreaterThanOrEqual(2);
    // A retry that cannot fit before the deadline expires at once: no claim is ever spent without a CIA attempt.
    expect((await responses(e.expectationId))[0]!.attempts).toBe(cia.calls.length);
  }, 15_000);
});

describe('AT-31: retryable versus definitive answers, and the credential breaker', () => {
  it('429, 409 in progress and a timeout are retried with the same key', async () => {
    for (const answer of [
      { kind: 'retry', code: 'rate_limited', retryAfterMs: 100 },
      { kind: 'retry', code: 'operation_in_progress', retryAfterMs: 100 },
      { kind: 'retry', code: 'deadline_exceeded', retryAfterMs: null },
    ] as const) {
      const conv = await conversation();
      const e = await expecting(conv);
      await reply(conv, RIGHT);
      const cia = new CiaDouble((_r, call) => (call === 1 ? answer : { kind: 'outcome', outcome: 'linked' }));
      await until(dispatcher(cia), async () => (await expectationOf(e.expectationId)).state === 'confirmed');
      expect(new Set(cia.calls.map((c) => c.idempotencyKey)).size, answer.code).toBe(1);
    }
  });

  it('400, 409 idempotency_conflict and an off-contract answer fail the response and cancel the expectation, with an alert', async () => {
    for (const code of ['invalid_request', 'idempotency_conflict', 'invalid_response']) {
      const conv = await conversation();
      const e = await expecting(conv);
      await reply(conv, RIGHT);
      expect(await dispatcher(new CiaDouble(() => ({ kind: 'refused', code, credentialRejected: false }))).dispatchOnce()).toBe('failed');
      expect(await expectationOf(e.expectationId)).toMatchObject({ state: 'cancelled', closedReason: `confirm_${code}` });
      expect(await responses(e.expectationId)).toMatchObject([{ state: 'failed', failure_code: code, code_ciphertext: null }]);
      expect(events.at(-1)).toMatchObject({ event: 'verification.confirm_refused', code });
    }
  });

  it('three consecutive 401/403 answers open the breaker (the composition then switches to protect_only)', async () => {
    const opened = vi.fn();
    const d = dispatcher(new CiaDouble(() => ({ kind: 'refused', code: 'identity_unauthorized', credentialRejected: true })), { onBreakerOpen: opened });
    for (let i = 0; i < 3; i += 1) {
      const conv = await conversation();
      await expecting(conv);
      await reply(conv, RIGHT);
      expect(await d.dispatchOnce()).toBe('failed');
      expect(opened).toHaveBeenCalledTimes(i === 2 ? 1 : 0);
    }
  });
});

describe('RR-1 inside the dispatcher (RR1-T07, RR1-T08)', () => {
  it('RR1-T07: the binding is no longer current before the claim → no confirm; cancelled (binding_not_current), code erased', async () => {
    const cases: [string, (conv: Conversation) => Promise<void>][] = [
      ['binding closed', (conv) => bed.store.closeBinding(conv.bindingId, 'test_closed')],
      ['task cancelled (binding still open)', (conv) => bed.api.temporal.cancelTask(conv.taskId, OPERATOR).then(() => undefined)],
      ['human-owned (OA-09)', (conv) => bed.api.temporal.takeOver(conv.taskId, { responseKey: `takeover-${conv.wa}`, note: 'a human takes over' }, OPERATOR).then(() => undefined)],
    ];
    for (const [name, invalidate] of cases) {
      const conv = await conversation();
      const e = await expecting(conv);
      await reply(conv, RIGHT);
      await invalidate(conv);
      const cia = new CiaDouble();
      expect(await dispatcher(cia).dispatchOnce(), name).toBe('cancelled_binding_not_current');
      expect(cia.calls, name).toEqual([]);
      expect(await expectationOf(e.expectationId), name).toMatchObject({ state: 'cancelled', closedReason: 'binding_not_current' });
      expect(await responses(e.expectationId), name).toMatchObject([{ state: 'cancelled', code_ciphertext: null }]);
    }
  });

  it('RR1-T08: the task is cancelled while confirm is in flight → the result is recorded, the terminal task is never woken', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    const gate = barrier();
    const cia = new CiaDouble(async () => {
      gate.arrive();
      await gate.opened;
      return { kind: 'outcome', outcome: 'linked' };
    });
    const running = dispatcher(cia).dispatchOnce();
    await gate.arrived;
    await bed.api.temporal.cancelTask(conv.taskId, OPERATOR);
    gate.open();
    expect(await running).toBe('confirmed');
    expect(await expectationOf(e.expectationId)).toMatchObject({ state: 'confirmed', ciaOutcome: 'linked' });
    expect(await responses(e.expectationId)).toMatchObject([{ state: 'notified' }]);
    expect(await resumeInputs(conv.taskId)).toEqual([]);
  });
});

describe('races with the network call in flight', () => {
  it('RX-08: an inbound of the same conversation never waits for the CIA (no lock is held across the call)', async () => {
    const conv = await conversation();
    await expecting(conv);
    await reply(conv, RIGHT);
    const gate = barrier();
    const cia = new CiaDouble(async () => {
      gate.arrive();
      await gate.opened;
      return { kind: 'outcome', outcome: 'invalid_code', attemptsRemaining: 4 };
    });
    const running = dispatcher(cia).dispatchOnce();
    await gate.arrived;
    // Nobody holds the conversation lock while the call is in flight.
    const probe = await bed.pool.connect();
    try {
      const locked = await probe.query<{ ok: boolean }>('select pg_try_advisory_lock($1::bigint) as ok', [conversationLockKey('whatsapp', conv.key)]);
      expect(locked.rows[0]!.ok).toBe(true);
      await probe.query('select pg_advisory_unlock($1::bigint)', [conversationLockKey('whatsapp', conv.key)]);
    } finally {
      probe.release();
    }
    expect((await bed.customer(conv.wa, eventId(), 'sigo esperando')).status).toBe(200);
    gate.open();
    expect(await running).toBe('confirmed');
  });

  it('special condition: a confirm completed at the CIA while its expectation was replaced → discarded, traced without secrets, the new expectation untouched', async () => {
    const conv = await conversation();
    const a = await expecting(conv);
    await reply(conv, RIGHT);
    const gate = barrier();
    const cia = new CiaDouble(async () => {
      gate.arrive();
      await gate.opened;
      return { kind: 'outcome', outcome: 'linked' };
    });
    const running = dispatcher(cia).dispatchOnce();
    await gate.arrived;
    const b = await expecting(conv); // the replacement commits while the call is in flight
    gate.open();
    expect(await running).toBe('discarded');
    expect(await expectationOf(a.expectationId)).toMatchObject({ state: 'cancelled', closedReason: 'superseded', ciaOutcome: null });
    expect(await expectationOf(b.expectationId)).toMatchObject({ state: 'awaiting_code', version: b.version, ciaOutcome: null });
    const [trace] = await bed.rows<Record<string, unknown>>('select * from identity_verification.discarded_outcomes where expectation_id = $1', [a.expectationId]);
    expect(trace).toMatchObject({ cia_outcome: 'linked', response_state: 'cancelled', lease_generation: '1' });
    expect(Object.keys(trace!).sort()).toEqual(['cia_outcome', 'expectation_id', 'lease_generation', 'recorded_at', 'response_id', 'response_state']);
    expect(await responses(a.expectationId)).toMatchObject([{ state: 'cancelled', code_ciphertext: null }]);
    expect(await resumeInputs(conv.taskId)).toEqual([]);
  });
});

describe('the sealed code is opened only by the right keyring', () => {
  it('an unknown key fails the response (alert) without calling the CIA', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    const cia = new CiaDouble();
    const other = new SecretBox(Keyring.parse(`k9:${randomBytes(32).toString('base64')}`));
    expect(await dispatcher(cia, { box: other }).dispatchOnce()).toBe('failed');
    expect(cia.calls).toEqual([]);
    expect(await expectationOf(e.expectationId)).toMatchObject({ state: 'cancelled', closedReason: 'confirm_unknown_key' });
  });

  it('no dispatcher event carries a code, a verificationId or a subject', () => {
    const text = JSON.stringify(events);
    expect(events.length).toBeGreaterThan(10);
    for (const secret of [RIGHT, WRONG, '56913', ...issued]) expect(text).not.toContain(secret);
  });
});

describe('the gateway composition of the dispatcher (AT-27c, breaker)', () => {
  it('AT-27c: full without the CIA confirm client starts in protect_only, never without an inspector', async () => {
    await bed.recomposeGateway({ requested: 'full', codeKeys: KEYS, confirm: null });
    expect(bed.gateway.inspection).toMatchObject({ mode: 'protect_only', degradedReason: 'confirm_credential_unavailable' });
    expect((bed.gateway.inspection as unknown as IdentityVerificationInspection).dispatcher).toBeNull();
    await bed.recomposeGateway({ requested: 'full', codeKeys: KEYS, confirm: NOT_STARTED });
    expect(bed.gateway.inspection?.mode).toBe('full');
  });

  it('three credential rejections switch the composed component to protect_only: no capture, durable mode, redaction continues', async () => {
    const cia = new CiaDouble(() => ({ kind: 'refused', code: 'identity_unauthorized', credentialRejected: true }));
    await bed.recomposeGateway({ requested: 'full', codeKeys: KEYS, confirm: cia });
    const composed = bed.gateway.inspection as unknown as IdentityVerificationInspection;
    for (let i = 0; i < 3; i += 1) {
      const conv = await conversation();
      await expecting(conv);
      await reply(conv, RIGHT);
      expect(await composed.dispatcher!.dispatchOnce()).toBe('failed');
    }
    expect(composed.inspector.mode).toBe('protect_only');
    expect(await store.mode()).toBe('protect_only');
    const conv = await conversation();
    const e = await expecting(conv);
    await reply(conv, RIGHT);
    expect(await responses(e.expectationId)).toEqual([]);
    await bed.recomposeGateway({ requested: 'full', codeKeys: KEYS, confirm: NOT_STARTED });
    expect(await store.mode()).toBe('full');
  });
});

describe('composition guard against a capture without a dispatcher', () => {
  it('the inspector in protect_only never captures, whatever the dispatcher does', async () => {
    const conv = await conversation();
    const e = await expecting(conv);
    const production = new PostgresProductionStore(bed.pool);
    const inspector = new VerificationInspector({ store, mode: 'protect_only', box: null });
    await production.recordInboundInspected(
      { inboundId: randomUUID(), channel: 'whatsapp', providerEventId: eventId(), contentKind: 'text', contentType: 'text', content: RIGHT, contentSha256: null, conversationKey: conv.key, accountRef: CANARY_PHONE_ID, conversationRef: conv.wa, occurredAt: new Date().toISOString(), status: 'received', failureCode: null, correlationId: 'sec-s4' },
      { inspector, inspectable: true, senderRef: conv.wa, direct: true },
    );
    expect(await responses(e.expectationId)).toEqual([]);
  });
});
