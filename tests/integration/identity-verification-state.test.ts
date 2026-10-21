import { randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, type Pool } from '@r4/persistence-postgres';
import {
  IdentityVerificationError,
  IdentityVerificationStore,
  Keyring,
  SecretBox,
  SecretBoxError,
  migrateIdentityVerification,
  type CiaConfirmOutcome,
  type ExpectationRecord,
  type NewExpectation,
  type ResponseClaim,
} from '@r4-adapters/identity-verification';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';

// SEC-S2: transient verification state on real PostgreSQL, synthetic data only. AT-TR-01…13, AT-20,
// AT-15 (storage), rotation, tampering, supersede/expiry, concurrency, erasure, protect_until.

const CODE = '482913';
const K0 = randomBytes(32).toString('base64');
const K1 = randomBytes(32).toString('base64');
const box = new SecretBox(Keyring.parse(`k0:${K0}`));

let db: TestDatabase;
let pool: Pool;
let store: IdentityVerificationStore;

beforeAll(async () => {
  db = await createTestDatabase('r4_iv');
  pool = openPool(db.url);
  await migrateIdentityVerification(pool);
  store = new IdentityVerificationStore(pool);
});

// Responses left open by earlier tests must not be claimed by later ones: park them (no production behaviour involved).
beforeEach(async () => {
  for (let claim = await store.claimNextResponse('test-parking', 30_000); claim; claim = await store.claimNextResponse('test-parking', 30_000)) {
    await store.releaseClaim(claim, 3_600_000);
  }
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const hex64 = () => randomBytes(32).toString('hex');
const conversation = () => ({ channel: 'synthetic', conversationKey: hex64() });

function expectationInput(conv = conversation(), overrides: Partial<NewExpectation> = {}): NewExpectation {
  return {
    expectationId: randomUUID(), ...conv, accountRef: 'acct-synthetic-1', bindingId: randomUUID(), taskId: randomUUID(),
    consumerId: 'r4-sales', startIdempotencyKey: `start.${randomBytes(12).toString('hex')}`, ...overrides,
  };
}

const future = (ms = 600_000) => new Date(Date.now() + ms).toISOString();
const past = (ms = 60_000) => new Date(Date.now() - ms).toISOString();

async function issued(conv = conversation(), s = store, expiresAt = future()): Promise<ExpectationRecord> {
  const { expectation } = await s.openExpectation(expectationInput(conv));
  return s.markIssued(expectation.expectationId, { verificationId: `Vf${randomBytes(8).toString('hex')}`, expiresAt });
}

async function capture(e: ExpectationRecord, providerEventId = `evt.${randomBytes(6).toString('hex')}`, code = CODE, secretBox = box, s = store) {
  const responseId = randomUUID();
  const sealed = secretBox.seal(code, { responseId, expectationId: e.expectationId, channel: e.channel, providerEventId });
  return withTransaction(pool, (c) => s.captureResponse(c, { responseId, expectationId: e.expectationId, channel: e.channel, providerEventId, sealed }));
}

const open = (claim: ResponseClaim, secretBox = box) =>
  secretBox.open(claim.sealed, { responseId: claim.responseId, expectationId: claim.expectationId, channel: claim.channel, providerEventId: claim.providerEventId });

async function claimFor(expectationId: string, s = store, owner = 'dispatcher-a', leaseMs = 30_000): Promise<ResponseClaim> {
  for (let i = 0; i < 20; i += 1) {
    const claim = await s.claimNextResponse(owner, leaseMs);
    if (claim?.expectationId === expectationId) return claim;
    if (claim) await s.releaseClaim(claim, 3_600_000);
  }
  throw new Error('no claim for the expectation');
}

const stateOf = async (expectationId: string) => (await store.expectation(pool, expectationId))?.state;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error);
  }
  throw new Error('expected a refusal');
}

describe('AT-TR: expectation transitions', () => {
  it('AT-TR-01 created → awaiting_code; protection grows to expiry + 10 min', async () => {
    const { expectation } = await store.openExpectation(expectationInput());
    expect(expectation).toMatchObject({ state: 'created', verificationId: null, version: 1 });
    const expiresAt = future(600_000);
    const e = await store.markIssued(expectation.expectationId, { verificationId: 'VfSynthetic01', expiresAt });
    expect(e).toMatchObject({ state: 'awaiting_code', verificationId: 'VfSynthetic01', version: 2 });
    expect(Date.parse(e.protectUntil)).toBeGreaterThanOrEqual(Date.parse(expiresAt) + 600_000 - 5);
    expect(await store.markIssued(expectation.expectationId, { verificationId: 'VfSynthetic01', expiresAt })).toMatchObject({ version: 2 });
  });

  it('AT-TR-02 created → cancelled without a verificationId (rev. 02 CHECK correction)', async () => {
    const { expectation } = await store.openExpectation(expectationInput());
    const e = await store.closeExpectation(expectation.expectationId, 'cancelled', 'start_unavailable');
    expect(e).toMatchObject({ state: 'cancelled', verificationId: null, closedReason: 'start_unavailable' });
  });

  it('AT-TR-03 created → expired without a verificationId (never issued)', async () => {
    const quick = new IdentityVerificationStore(pool, { unissuedTtlMs: 0 });
    const { expectation } = await quick.openExpectation(expectationInput());
    await quick.sweep();
    expect(await store.expectation(pool, expectation.expectationId)).toMatchObject({ state: 'expired', verificationId: null, closedReason: 'challenge_expired' });
  });

  it('AT-TR-04 awaiting_code → processing on claim; AT-TR-05 processing → awaiting_code on release and on invalid_code', async () => {
    const e = await issued();
    await capture(e);
    const claim = await claimFor(e.expectationId);
    expect(await stateOf(e.expectationId)).toBe('processing');
    expect(await store.releaseClaim(claim, 0)).toEqual({ kind: 'released' });
    expect(await stateOf(e.expectationId)).toBe('awaiting_code');
    const again = await claimFor(e.expectationId);
    const settled = await store.recordOutcome(again, { outcome: 'invalid_code', attemptsRemaining: 3 });
    expect(settled).toMatchObject({ kind: 'settled', resume: true, expectation: { state: 'awaiting_code', attemptsRemaining: 3, ciaOutcome: 'invalid_code', closedAt: null } });
  });

  it.each<CiaConfirmOutcome>(['linked', 'no_eligible_account', 'ineligible_account', 'ambiguous', 'conflicted'])('AT-TR-06 processing → confirmed (%s)', async (outcome) => {
    const e = await issued();
    await capture(e);
    const settled = await store.recordOutcome(await claimFor(e.expectationId), { outcome });
    expect(settled).toMatchObject({ kind: 'settled', expectation: { state: 'confirmed', ciaOutcome: outcome, closedReason: 'challenge_consumed' } });
  });

  it.each<[CiaConfirmOutcome, number | undefined]>([['locked', undefined], ['invalid_code', 0]])('AT-TR-07 processing → rejected (%s)', async (outcome, attemptsRemaining) => {
    const e = await issued();
    await capture(e);
    const settled = await store.recordOutcome(await claimFor(e.expectationId), attemptsRemaining === undefined ? { outcome } : { outcome, attemptsRemaining });
    expect(settled).toMatchObject({ kind: 'settled', expectation: { state: 'rejected', ciaOutcome: outcome } });
  });

  it('AT-TR-08 processing → expired (CIA outcome expired, and challenge expiry while processing)', async () => {
    const a = await issued();
    await capture(a);
    expect(await store.recordOutcome(await claimFor(a.expectationId), { outcome: 'expired' })).toMatchObject({ expectation: { state: 'expired' } });
    const b = await issued(conversation(), store, future(1_500));
    await capture(b);
    const claim = await claimFor(b.expectationId);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await store.sweep();
    expect(await stateOf(b.expectationId)).toBe('expired');
    expect(await store.recordOutcome(claim, { outcome: 'linked' })).toEqual({ kind: 'stale' });
  });

  it('AT-TR-09 awaiting_code → expired by the sweep', async () => {
    const e = await issued(conversation(), store, past());
    await store.sweep();
    expect(await stateOf(e.expectationId)).toBe('expired');
  });

  it('AT-TR-10 awaiting_code → cancelled (close and supersede)', async () => {
    const conv = conversation();
    const a = await issued(conv);
    expect(await store.closeExpectation(a.expectationId, 'cancelled', 'binding_not_current')).toMatchObject({ state: 'cancelled' });
    const b = await issued(conv);
    await store.openExpectation(expectationInput(conv));
    expect(await store.expectation(pool, b.expectationId)).toMatchObject({ state: 'cancelled', closedReason: 'superseded' });
  });

  it('AT-TR-11 processing → cancelled by a supersede: the in-flight claim becomes stale and its code is erased', async () => {
    const conv = conversation();
    const e = await issued(conv);
    const { responseId } = await capture(e);
    const claim = await claimFor(e.expectationId);
    await store.openExpectation(expectationInput(conv));
    expect(await stateOf(e.expectationId)).toBe('cancelled');
    expect(await store.response(pool, responseId)).toMatchObject({ state: 'cancelled', sealed: null, failureCode: 'expectation_closed' });
    expect(await store.recordOutcome(claim, { outcome: 'linked' })).toEqual({ kind: 'stale' });
  });

  it('AT-TR-12 terminal expectations and responses are immutable', async () => {
    const e = await issued();
    const { responseId } = await capture(e);
    await store.closeExpectation(e.expectationId, 'cancelled', 'operator');
    expect(await refusal(pool.query(`update identity_verification.expectations set state = 'awaiting_code', version = version + 1 where expectation_id = $1`, [e.expectationId]))).toContain('expectation_terminal_immutable');
    expect(await refusal(pool.query(`update identity_verification.expectations set closed_reason = 'other', version = version + 1 where expectation_id = $1`, [e.expectationId]))).toContain('expectation_terminal_immutable');
    expect(await refusal(pool.query(`update identity_verification.responses set state = 'pending' where response_id = $1`, [responseId]))).toContain('response_terminal_immutable');
  });

  describe('AT-TR-13 illegal transitions and states are refused by the database', () => {
    it('illegal transitions', async () => {
      const { expectation } = await store.openExpectation(expectationInput());
      const id = expectation.expectationId;
      expect(await refusal(pool.query(`update identity_verification.expectations set state = 'confirmed', verification_id = 'Vf1', challenge_expires_at = clock_timestamp(), cia_outcome = 'linked', closed_at = clock_timestamp(), closed_reason = 'x', version = version + 1 where expectation_id = $1`, [id]))).toContain('illegal_expectation_transition');
      expect(await refusal(pool.query(`update identity_verification.expectations set state = 'processing', verification_id = 'Vf1', challenge_expires_at = clock_timestamp(), version = version + 1 where expectation_id = $1`, [id]))).toContain('illegal_expectation_transition');
    });

    it('states inconsistent with the challenge', async () => {
      const { expectation } = await store.openExpectation(expectationInput());
      const id = expectation.expectationId;
      expect(await refusal(pool.query(`update identity_verification.expectations set state = 'awaiting_code', version = version + 1 where expectation_id = $1`, [id]))).toContain('issued_states_have_challenge');
      expect(await refusal(pool.query(`update identity_verification.expectations set verification_id = 'Vf1', challenge_expires_at = clock_timestamp(), version = version + 1 where expectation_id = $1`, [id]))).toContain('created_has_no_challenge');
      const e = await issued();
      await capture(e);
      const claim = await claimFor(e.expectationId);
      expect(await refusal(pool.query(`update identity_verification.expectations set state = 'confirmed', closed_at = clock_timestamp(), closed_reason = 'x', version = version + 1 where expectation_id = $1`, [claim.expectationId]))).toContain('confirmed_has_consumed_outcome');
      expect(await refusal(pool.query(`update identity_verification.expectations set state = 'rejected', cia_outcome = 'linked', closed_at = clock_timestamp(), closed_reason = 'x', version = version + 1 where expectation_id = $1`, [claim.expectationId]))).toContain('rejected_has_rejecting_outcome');
      expect(await refusal(pool.query(`update identity_verification.expectations set state = 'awaiting_code', closed_at = clock_timestamp(), closed_reason = 'x', version = version + 1 where expectation_id = $1`, [claim.expectationId]))).toContain('terminal_iff_closed');
    });

    it('identity, version and protection guards', async () => {
      const e = await issued();
      const id = e.expectationId;
      expect(await refusal(pool.query(`update identity_verification.expectations set binding_id = $2, version = version + 1 where expectation_id = $1`, [id, randomUUID()]))).toContain('expectation_identity_immutable');
      expect(await refusal(pool.query(`update identity_verification.expectations set verification_id = 'VfOther', version = version + 1 where expectation_id = $1`, [id]))).toContain('expectation_identity_immutable');
      expect(await refusal(pool.query(`update identity_verification.expectations set attempts_remaining = 2 where expectation_id = $1`, [id]))).toContain('version_must_increment');
      expect(await refusal(pool.query(`update identity_verification.expectations set protect_until = protect_until - interval '1 second', version = version + 1 where expectation_id = $1`, [id]))).toContain('protection_cannot_shrink');
    });

    it('illegal response transitions and inserts', async () => {
      const e = await issued();
      const { responseId } = await capture(e);
      expect(await refusal(pool.query(`update identity_verification.responses set state = 'resolved', cia_outcome = 'linked', code_ciphertext = null, code_iv = null, code_tag = null, key_id = null where response_id = $1`, [responseId]))).toContain('illegal_response_transition');
      expect(await refusal(pool.query(
        `insert into identity_verification.responses (response_id, expectation_id, channel, provider_event_id, state, confirm_idempotency_key, deadline_at, purge_after)
         values ($1, $2, 'synthetic', 'evt.x1', 'cancelled', 'vr.aaaaaaaaaaaaaaaaaaaa', clock_timestamp(), clock_timestamp())`,
        [randomUUID(), e.expectationId],
      ))).toContain('response_must_start_pending');
    });
  });
});

describe('AT-20 sealed material', () => {
  it('a terminal response cannot keep ciphertext, and sealed material is write-once (no tampering in place)', async () => {
    const e = await issued();
    const { responseId } = await capture(e);
    expect(await refusal(pool.query(`update identity_verification.responses set state = 'cancelled' where response_id = $1`, [responseId]))).toContain('secret_only_while_open');
    expect(await refusal(pool.query(`update identity_verification.responses set code_ciphertext = '\\x00'::bytea where response_id = $1`, [responseId]))).toContain('sealed_code_write_once');
    expect(await refusal(pool.query(
      `insert into identity_verification.responses (response_id, expectation_id, channel, provider_event_id, state, code_ciphertext, key_id, confirm_idempotency_key, deadline_at, purge_after)
       values ($1, $2, 'synthetic', 'evt.partial.1', 'pending', '\x01'::bytea, 'k0', 'vr.bbbbbbbbbbbbbbbbbbbb', clock_timestamp(), clock_timestamp())`,
      [randomUUID(), e.expectationId],
    ))).toContain('sealed_fields_together');
  });

  it('the code is never stored in clear and no key material is persisted', async () => {
    const e = await issued();
    await capture(e, 'evt.cleartext');
    const dump = await pool.query<{ row: string }>(
      `select row_to_json(t)::text as row from identity_verification.expectations t
        union all select row_to_json(r)::text from identity_verification.responses r`,
    );
    const all = dump.rows.map((r) => r.row).join('\n');
    for (const secret of [CODE, Buffer.from(CODE).toString('hex'), K0, Buffer.from(K0, 'base64').toString('hex'), K1]) expect(all).not.toContain(secret);
    expect(all).toContain('"key_id":"k0"');
  });

  it('a stored code opens only with the right key and binding; a tampered copy does not', async () => {
    const e = await issued();
    await capture(e);
    const claim = await claimFor(e.expectationId);
    expect(open(claim)).toBe(CODE);
    expect(() => open({ ...claim, responseId: randomUUID() })).toThrow(SecretBoxError);
    const tampered = Buffer.from(claim.sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => open({ ...claim, sealed: { ...claim.sealed, ciphertext: tampered } })).toThrow(SecretBoxError);
    await store.releaseClaim(claim, 0);
  });
});

describe('rotation of synthetic keys', () => {
  it('codes sealed before a rotation still open; a retired key fails closed (unknown_key)', async () => {
    const e = await issued();
    await capture(e, `evt.rot.${randomBytes(4).toString('hex')}`, CODE, box);
    const rotated = new SecretBox(Keyring.parse(`k1:${K1},k0:${K0}`));
    const claim = await claimFor(e.expectationId);
    expect(open(claim, rotated)).toBe(CODE);
    expect(rotated.seal(CODE, { responseId: 'r', expectationId: 'e', channel: 'c', providerEventId: 'p' }).keyId).toBe('k1');
    const retired = new SecretBox(Keyring.parse(`k1:${K1}`));
    let code = '';
    try {
      open(claim, retired);
    } catch (error) {
      code = (error as SecretBoxError).code;
    }
    expect(code).toBe('unknown_key');
    await store.releaseClaim(claim, 0);
  });
});

describe('AT-15 (storage): a failed capture transaction leaves nothing', () => {
  it('rolls back the sealed code with the transaction; a retry then succeeds once', async () => {
    const e = await issued();
    const providerEventId = 'evt.rollback.0001';
    const responseId = randomUUID();
    const sealed = box.seal(CODE, { responseId, expectationId: e.expectationId, channel: e.channel, providerEventId });
    await expect(withTransaction(pool, async (c) => {
      await store.captureResponse(c, { responseId, expectationId: e.expectationId, channel: e.channel, providerEventId, sealed });
      throw new Error('inbound insert failed');
    })).rejects.toThrow('inbound insert failed');
    expect((await pool.query('select 1 from identity_verification.responses where provider_event_id = $1', [providerEventId])).rowCount).toBe(0);
    expect(await capture(e, providerEventId)).toMatchObject({ created: true });
    expect(await capture(e, providerEventId)).toMatchObject({ created: false });
  });

  it('refuses a capture under a closed expectation', async () => {
    const e = await issued();
    await store.closeExpectation(e.expectationId, 'cancelled', 'binding_not_current');
    expect(await refusal(capture(e))).toContain('expectation_not_live');
  });
});

describe('supersede, expiry and erasure of pending material', () => {
  it('a supersede cancels the live expectation and erases its pending codes in the same transaction', async () => {
    const conv = conversation();
    const a = await issued(conv);
    const first = await capture(a);
    const second = await capture(a);
    const { expectation: b } = await store.openExpectation(expectationInput(conv));
    expect(b.state).toBe('created');
    for (const { responseId } of [first, second]) expect(await store.response(pool, responseId)).toMatchObject({ state: 'cancelled', sealed: null });
    expect((await store.liveExpectation(pool, conv.channel, conv.conversationKey))?.expectationId).toBe(b.expectationId);
  });

  it('processing erases the code: resolved, failed and deadline-expired responses keep no ciphertext', async () => {
    const r = await issued();
    const resolved = await capture(r);
    await store.recordOutcome(await claimFor(r.expectationId), { outcome: 'linked' });
    expect(await store.response(pool, resolved.responseId)).toMatchObject({ state: 'resolved', sealed: null, ciaOutcome: 'linked' });
    expect(await store.markNotified(resolved.responseId)).toBe(true);

    const f = await issued();
    const failed = await capture(f);
    expect(await store.failClaim(await claimFor(f.expectationId), 'invalid_request')).toEqual({ kind: 'failed' });
    expect(await store.response(pool, failed.responseId)).toMatchObject({ state: 'failed', sealed: null });
    expect(await store.expectation(pool, f.expectationId)).toMatchObject({ state: 'cancelled', closedReason: 'confirm_invalid_request' });

    const d = await issued(conversation(), store, future(1_000));
    const late = await capture(d);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await store.sweep();
    expect((await store.response(pool, late.responseId))?.sealed).toBeNull();
    expect(await stateOf(d.expectationId)).toBe('expired');
  });

  it('a later code of a confirmed challenge is cancelled without dispatch', async () => {
    const e = await issued();
    await capture(e);
    const later = await capture(e);
    await store.recordOutcome(await claimFor(e.expectationId), { outcome: 'linked' });
    expect(await store.response(pool, later.responseId)).toMatchObject({ state: 'cancelled', sealed: null });
  });
});

describe('protect_until survives closing; no deletion removes a live protection obligation', () => {
  it('protection stays active after confirm, cancel and expiry', async () => {
    for (const close of ['confirm', 'cancel', 'expire'] as const) {
      const conv = conversation();
      const e = await issued(conv, store, close === 'expire' ? past(1_000) : future());
      if (close === 'confirm') {
        await capture(e);
        await store.recordOutcome(await claimFor(e.expectationId), { outcome: 'linked' });
      } else if (close === 'cancel') {
        await store.closeExpectation(e.expectationId, 'cancelled', 'operator');
      } else {
        await store.sweep();
      }
      expect(await store.liveExpectation(pool, conv.channel, conv.conversationKey)).toBeNull();
      expect(await store.protectionActive(pool, conv.channel, conv.conversationKey)).toBe(true);
    }
  });

  it('deleting a live or still-protected expectation, or an open response, is refused; purge skips them', async () => {
    const live = await issued();
    const { responseId } = await capture(live);
    const closed = await issued();
    await store.closeExpectation(closed.expectationId, 'cancelled', 'operator');
    expect(await refusal(pool.query('delete from identity_verification.responses where response_id = $1', [responseId]))).toContain('response_not_terminal');
    for (const id of [live.expectationId, closed.expectationId]) {
      expect(await refusal(pool.query('delete from identity_verification.expectations where expectation_id = $1', [id]))).toContain('protection_active');
    }
    await store.purge();
    expect(await store.expectation(pool, live.expectationId)).not.toBeNull();
    expect(await store.expectation(pool, closed.expectationId)).not.toBeNull();
  });

  it('once protection and retention have passed, purge removes the rows (sealed material long erased)', async () => {
    const quick = new IdentityVerificationStore(pool, { protectionGraceMs: 0, unissuedTtlMs: 0, retentionMs: 0 });
    const conv = conversation();
    const e = await issued(conv, quick, past(1_000));
    await capture(e, undefined, CODE, box, quick);
    await quick.sweep();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const purged = await quick.purge();
    expect(purged.responses).toBeGreaterThanOrEqual(1);
    expect(purged.expectations).toBeGreaterThanOrEqual(1);
    expect((await pool.query('select 1 from identity_verification.responses where expectation_id = $1', [e.expectationId])).rowCount).toBe(0);
    expect(await store.expectation(pool, e.expectationId)).toBeNull();
    expect(await store.protectionActive(pool, conv.channel, conv.conversationKey)).toBe(false);
  });
});

describe('concurrency, leases and fencing', () => {
  it('concurrent opens of one conversation leave exactly one live expectation', async () => {
    const conv = conversation();
    const results = await Promise.all(Array.from({ length: 6 }, () => store.openExpectation(expectationInput(conv))));
    const live = await pool.query(`select count(*)::int as n from identity_verification.expectations where conversation_key = $1 and state in ('created','awaiting_code','processing')`, [conv.conversationKey]);
    expect(live.rows[0]).toEqual({ n: 1 });
    expect(results.filter((r) => !r.replayed)).toHaveLength(6);
  });

  it('openExpectation is idempotent by start key and refuses the key for another expectation', async () => {
    const input = expectationInput();
    const first = await store.openExpectation(input);
    expect(await store.openExpectation(input)).toEqual({ expectation: first.expectation, replayed: true });
    expect(await refusal(store.openExpectation({ ...input, expectationId: randomUUID() }))).toContain('idempotency_conflict');
  });

  it('concurrent captures of one provider event store one sealed code', async () => {
    const e = await issued();
    const results = await Promise.all(Array.from({ length: 5 }, () => capture(e, 'evt.dup.0001')));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.responseId)).size).toBe(1);
  });

  it('one response at a time per expectation, oldest first; a backoff never lets a newer code overtake nor blocks other expectations', async () => {
    const quiet = new IdentityVerificationStore(pool);
    const e = await issued();
    const older = await capture(e, 'evt.order.0001');
    await capture(e, 'evt.order.0002');
    const claims = (await Promise.all(Array.from({ length: 4 }, (_, i) => quiet.claimNextResponse(`racer-${i}`, 30_000)))).filter((c) => c?.expectationId === e.expectationId);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.responseId).toBe(older.responseId);
    await quiet.releaseClaim(claims[0] as ResponseClaim, 60_000);
    const other = await issued();
    await capture(other, 'evt.order.other');
    const next = await quiet.claimNextResponse('racer-x', 30_000);
    expect(next?.expectationId).toBe(other.expectationId);
    if (next) await quiet.releaseClaim(next, 3_600_000);
  });

  it('restart recovery: an expired lease is re-claimed with a higher generation and the old owner is fenced out', async () => {
    const e = await issued();
    await capture(e);
    const crashed = await claimFor(e.expectationId, store, 'dispatcher-crashed', 0);
    const recovered = await claimFor(e.expectationId, store, 'dispatcher-new', 30_000);
    expect(recovered.responseId).toBe(crashed.responseId);
    expect(BigInt(recovered.leaseGeneration)).toBeGreaterThan(BigInt(crashed.leaseGeneration));
    expect(recovered.attempts).toBe(2);
    expect(recovered.confirmIdempotencyKey).toBe(crashed.confirmIdempotencyKey);
    expect(open(recovered)).toBe(CODE);
    expect(await store.recordOutcome(crashed, { outcome: 'linked' })).toEqual({ kind: 'stale' });
    expect(await store.releaseClaim(crashed, 0)).toEqual({ kind: 'stale' });
    expect(await store.failClaim(crashed, 'invalid_request')).toEqual({ kind: 'stale' });
    expect(await store.recordOutcome(recovered, { outcome: 'linked' })).toMatchObject({ kind: 'settled', resume: true });
    expect(await store.recordOutcome(recovered, { outcome: 'linked' })).toEqual({ kind: 'stale' });
  });
});

describe('errors never expose secrets', () => {
  it('store refusals carry only a code', async () => {
    const e = await issued();
    const { responseId } = await capture(e, 'evt.err.0001');
    const row = await store.response(pool, responseId);
    const ciphertextHex = row?.sealed?.ciphertext.toString('hex') ?? 'missing';
    const errors: unknown[] = [];
    const sealed = box.seal(CODE, { responseId, expectationId: e.expectationId, channel: e.channel, providerEventId: 'evt.err.0002' });
    for (const attempt of [
      () => withTransaction(pool, (c) => store.captureResponse(c, { responseId, expectationId: e.expectationId, channel: e.channel, providerEventId: 'evt.err.0002', sealed })),
      () => store.markIssued(randomUUID(), { verificationId: 'Vf1', expiresAt: future() }),
      () => store.openExpectation({ ...expectationInput(), conversationKey: 'not-hex' }),
    ]) {
      try {
        await attempt();
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(error).toBeInstanceOf(IdentityVerificationError);
      expect(Object.keys(error as object).sort()).toEqual(['code', 'name']);
      const rendered = `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error)} ${inspect(error)}`;
      for (const secret of [CODE, ciphertextHex, sealed.ciphertext.toString('hex'), K0, 'not-hex']) expect(rendered).not.toContain(secret);
    }
    expect((errors[0] as IdentityVerificationError).code).toBe('database_23505:responses_pkey');
  });
});
