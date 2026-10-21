import { withTransaction, type Pool, type PoolClient } from '@r4/persistence-postgres';
import { confirmIdempotencyKey, conversationLockKey } from './keys.js';
import type { SealedCode } from './secret-box.js';

/**
 * SEC-S2 — transient state of channel identity verification (schema `identity_verification`).
 * Expectations carry no secret; responses carry a code only as AES-256-GCM ciphertext while open.
 * Every transition that decides protection or persistible content runs in a short transaction under
 * the per-conversation advisory lock (decision rev. 02 §6.4); no lock is held across a network call.
 * The store never sees a plaintext code: sealing and opening belong to the SecretBox holder.
 * Errors carry only a code (never row values, codes, ciphertext or keys).
 */

export type ExpectationState = 'created' | 'awaiting_code' | 'processing' | 'confirmed' | 'rejected' | 'expired' | 'cancelled';
export type ResponseState = 'pending' | 'dispatching' | 'resolved' | 'notified' | 'cancelled' | 'failed' | 'expired';
export type CiaConfirmOutcome = 'linked' | 'no_eligible_account' | 'ineligible_account' | 'ambiguous' | 'conflicted' | 'invalid_code' | 'expired' | 'locked';

export interface ExpectationRecord {
  readonly expectationId: string;
  readonly channel: string;
  readonly conversationKey: string;
  readonly accountRef: string;
  readonly bindingId: string;
  readonly taskId: string;
  readonly consumerId: string;
  readonly verificationId: string | null;
  readonly state: ExpectationState;
  readonly ciaOutcome: CiaConfirmOutcome | null;
  readonly attemptsRemaining: number | null;
  readonly createdAt: string;
  readonly challengeExpiresAt: string | null;
  readonly protectUntil: string;
  readonly closedAt: string | null;
  readonly closedReason: string | null;
  readonly version: number;
}

export interface ResponseRecord {
  readonly responseId: string;
  readonly expectationId: string;
  readonly channel: string;
  readonly providerEventId: string;
  readonly receivedSeq: string;
  readonly state: ResponseState;
  readonly sealed: SealedCode | null;
  readonly confirmIdempotencyKey: string;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leaseGeneration: string;
  readonly ciaOutcome: CiaConfirmOutcome | null;
  readonly failureCode: string | null;
  readonly deadlineAt: string;
}

export interface NewExpectation {
  readonly expectationId: string;
  readonly channel: string;
  readonly conversationKey: string;
  readonly accountRef: string;
  readonly bindingId: string;
  readonly taskId: string;
  readonly consumerId: string;
  readonly startIdempotencyKey: string;
}

export interface CapturedResponse {
  readonly responseId: string;
  readonly expectationId: string;
  readonly channel: string;
  readonly providerEventId: string;
  /** Sealed by the SecretBox holder with `sealedCodeAad({ responseId, expectationId, channel, providerEventId })`. */
  readonly sealed: SealedCode;
}

/** A leased response, fenced by `leaseOwner` + `leaseGeneration`. */
export interface ResponseClaim {
  readonly responseId: string;
  readonly expectationId: string;
  readonly channel: string;
  readonly conversationKey: string;
  readonly providerEventId: string;
  readonly verificationId: string;
  readonly accountRef: string;
  readonly bindingId: string;
  readonly taskId: string;
  readonly confirmIdempotencyKey: string;
  readonly leaseOwner: string;
  readonly leaseGeneration: string;
  readonly attempts: number;
  readonly sealed: SealedCode;
}

export type ClaimSettlement =
  | { readonly kind: 'settled'; readonly expectation: ExpectationRecord; readonly resume: boolean }
  /** The lease was lost, or the response was closed (superseded, expired): the result is discarded. */
  | { readonly kind: 'stale' };

export interface IdentityVerificationStoreOptions {
  /** OA-07: protection lasts this long after the challenge expiry. Composition must keep the default. */
  readonly protectionGraceMs?: number;
  /** A `created` expectation never issued by the CIA expires after this (contract: challenge TTL 600 s). */
  readonly unissuedTtlMs?: number;
  /** Terminal responses and closed expectations are kept this long for idempotency (CIA retention 24 h). */
  readonly retentionMs?: number;
}

export const DEFAULT_PROTECTION_GRACE_MS = 600_000;
export const DEFAULT_UNISSUED_TTL_MS = 600_000;
export const DEFAULT_RETENTION_MS = 86_400_000;

/** A domain code (`idempotency_conflict`, `expectation_not_found`, `expectation_not_issuable`…), a trigger reason or `database_<SQLSTATE>`. */
export type IdentityVerificationErrorCode = string;

/** Carries only a code (a trigger reason, a SQLSTATE or a domain code). */
export class IdentityVerificationError extends Error {
  readonly code: IdentityVerificationErrorCode;

  constructor(code: IdentityVerificationErrorCode) {
    super(`identity verification store: ${code}`);
    this.name = 'IdentityVerificationError';
    this.code = code;
  }
}

const LIVE: readonly ExpectationState[] = ['created', 'awaiting_code', 'processing'];
const CONSUMED: readonly CiaConfirmOutcome[] = ['linked', 'no_eligible_account', 'ineligible_account', 'ambiguous', 'conflicted'];

/** Takes the per-conversation advisory lock for the current transaction (re-entrant within it). */
export async function lockConversation(client: PoolClient, channel: string, conversationKey: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock($1::bigint)', [conversationLockKey(channel, conversationKey)]);
}

export class IdentityVerificationStore {
  readonly #pool: Pool;
  readonly #graceMs: number;
  readonly #unissuedTtlMs: number;
  readonly #retentionMs: number;

  constructor(pool: Pool, options: IdentityVerificationStoreOptions = {}) {
    this.#pool = pool;
    this.#graceMs = options.protectionGraceMs ?? DEFAULT_PROTECTION_GRACE_MS;
    this.#unissuedTtlMs = options.unissuedTtlMs ?? DEFAULT_UNISSUED_TTL_MS;
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  // ── Expectations ──────────────────────────────────────────────────────────────────────────────

  /** Registers a `created` expectation (before the CIA start) and supersedes the live one. Idempotent by start key. */
  openExpectation(input: NewExpectation): Promise<{ readonly expectation: ExpectationRecord; readonly replayed: boolean }> {
    return guard(() =>
      withTransaction(this.#pool, async (c) => {
        await lockConversation(c, input.channel, input.conversationKey);
        const existing = await one(c, 'select * from identity_verification.expectations where start_idempotency_key = $1', [input.startIdempotencyKey]);
        if (existing) {
          const same = existing.expectation_id === input.expectationId && existing.channel === input.channel && existing.conversation_key === input.conversationKey
            && existing.binding_id === input.bindingId && existing.task_id === input.taskId;
          if (!same) throw new IdentityVerificationError('idempotency_conflict');
          return { expectation: expectationOf(existing), replayed: true };
        }
        await c.query(
          `update identity_verification.expectations
              set state = 'cancelled', closed_at = clock_timestamp(), closed_reason = 'superseded', version = version + 1
            where channel = $1 and conversation_key = $2 and state in ('created', 'awaiting_code', 'processing')`,
          [input.channel, input.conversationKey],
        );
        const row = await one(
          c,
          `insert into identity_verification.expectations
             (expectation_id, channel, conversation_key, account_ref, binding_id, task_id, consumer_id, start_idempotency_key, state, protect_until)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'created', clock_timestamp() + make_interval(secs => $9::double precision / 1000))
           returning *`,
          [input.expectationId, input.channel, input.conversationKey, input.accountRef, input.bindingId, input.taskId, input.consumerId, input.startIdempotencyKey, this.#unissuedTtlMs + this.#graceMs],
        );
        return { expectation: expectationOf(required(row)), replayed: false };
      }),
    );
  }

  /** `created → awaiting_code` with the CIA challenge; protection grows to cover expiry + grace. Idempotent. */
  markIssued(expectationId: string, issued: { readonly verificationId: string; readonly expiresAt: string }): Promise<ExpectationRecord> {
    return guard(() =>
      withTransaction(this.#pool, async (c) => {
        const current = await this.#lockedExpectation(c, expectationId);
        if (current.state !== 'created') {
          if (current.verification_id === issued.verificationId && (current.state === 'awaiting_code' || current.state === 'processing')) return expectationOf(current);
          throw new IdentityVerificationError('expectation_not_issuable');
        }
        const row = await one(
          c,
          `update identity_verification.expectations
              set state = 'awaiting_code', verification_id = $2, challenge_expires_at = $3::timestamptz,
                  protect_until = greatest(protect_until, $3::timestamptz + make_interval(secs => $4::double precision / 1000)),
                  version = version + 1
            where expectation_id = $1 returning *`,
          [expectationId, issued.verificationId, issued.expiresAt, this.#graceMs],
        );
        return expectationOf(required(row));
      }),
    );
  }

  /** Closes a live expectation (`cancelled` or `expired`); its pending sealed codes are erased (trigger). Idempotent. */
  closeExpectation(expectationId: string, to: 'cancelled' | 'expired', reason: string): Promise<ExpectationRecord> {
    return guard(() =>
      withTransaction(this.#pool, async (c) => {
        const current = await this.#lockedExpectation(c, expectationId);
        if (!LIVE.includes(current.state as ExpectationState)) return expectationOf(current);
        const row = await one(
          c,
          `update identity_verification.expectations
              set state = $2, closed_at = clock_timestamp(), closed_reason = $3, version = version + 1
            where expectation_id = $1 returning *`,
          [expectationId, to, reason],
        );
        return expectationOf(required(row));
      }),
    );
  }

  /** Whether any expectation of the conversation still protects it (any state: protection survives closing). */
  async protectionActive(q: Pool | PoolClient, channel: string, conversationKey: string): Promise<boolean> {
    return guard(async () => {
      const r = await q.query<{ active: boolean }>(
        `select exists (select 1 from identity_verification.expectations
                         where channel = $1 and conversation_key = $2 and protect_until > clock_timestamp()) as active`,
        [channel, conversationKey],
      );
      return r.rows[0]?.active === true;
    });
  }

  async liveExpectation(q: Pool | PoolClient, channel: string, conversationKey: string): Promise<ExpectationRecord | null> {
    return guard(async () => {
      const row = await one(
        q,
        `select * from identity_verification.expectations
          where channel = $1 and conversation_key = $2 and state in ('created', 'awaiting_code', 'processing')`,
        [channel, conversationKey],
      );
      return row ? expectationOf(row) : null;
    });
  }

  async expectation(q: Pool | PoolClient, expectationId: string): Promise<ExpectationRecord | null> {
    return guard(async () => {
      const row = await one(q, 'select * from identity_verification.expectations where expectation_id = $1', [expectationId]);
      return row ? expectationOf(row) : null;
    });
  }

  // ── Responses ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Stores a sealed code INSIDE the caller's transaction (SEC-S3: the inbound transaction), under the
   * conversation lock. Only under a live expectation (trigger). Idempotent by (channel, providerEventId).
   */
  async captureResponse(client: PoolClient, input: CapturedResponse): Promise<{ readonly created: boolean; readonly responseId: string }> {
    return guard(async () => {
      const owner = await one(client, 'select channel, conversation_key from identity_verification.expectations where expectation_id = $1', [input.expectationId]);
      if (!owner) throw new IdentityVerificationError('expectation_not_found');
      await lockConversation(client, owner.channel as string, owner.conversation_key as string);
      const row = await one(
        client,
        `insert into identity_verification.responses
           (response_id, expectation_id, channel, provider_event_id, state, code_ciphertext, code_iv, code_tag, key_id,
            confirm_idempotency_key, deadline_at, purge_after)
         select $1, e.expectation_id, $3, $4, 'pending', $5, $6, $7, $8, $9, d.deadline,
                d.deadline + make_interval(secs => $10::double precision / 1000)
           from identity_verification.expectations e
          cross join lateral (select coalesce(e.challenge_expires_at,
                                              e.created_at + make_interval(secs => $11::double precision / 1000)) as deadline) d
          where e.expectation_id = $2
         on conflict (channel, provider_event_id) do nothing
         returning response_id`,
        [input.responseId, input.expectationId, input.channel, input.providerEventId, input.sealed.ciphertext, input.sealed.iv, input.sealed.tag,
          input.sealed.keyId, confirmIdempotencyKey(input.channel, input.providerEventId), this.#retentionMs, this.#unissuedTtlMs],
      );
      if (row) return { created: true, responseId: row.response_id as string };
      const existing = await one(client, 'select response_id from identity_verification.responses where channel = $1 and provider_event_id = $2', [input.channel, input.providerEventId]);
      return { created: false, responseId: required(existing).response_id as string };
    });
  }

  async response(q: Pool | PoolClient, responseId: string): Promise<ResponseRecord | null> {
    return guard(async () => {
      const row = await one(q, 'select * from identity_verification.responses where response_id = $1', [responseId]);
      return row ? responseOf(row) : null;
    });
  }

  /**
   * Leases the OLDEST open response of one issued expectation that has no live lease (one at a time per
   * expectation, in arrival order). `skip locked`: concurrent claimers never take the same expectation.
   * A dispatching response whose lease expired (crash) is claimable again with a higher generation.
   */
  claimNextResponse(owner: string, leaseMs: number): Promise<ResponseClaim | null> {
    return guard(() =>
      withTransaction(this.#pool, async (c) => {
        const e = await one(
          c,
          `select e.* from identity_verification.expectations e
            cross join lateral (select r.state, r.next_attempt_at, r.lease_expires_at from identity_verification.responses r
                                 where r.expectation_id = e.expectation_id and r.state in ('pending', 'dispatching')
                                 order by r.received_seq limit 1) o
            where e.state in ('awaiting_code', 'processing') and e.verification_id is not null
              and not exists (select 1 from identity_verification.responses r
                               where r.expectation_id = e.expectation_id and r.state = 'dispatching' and r.lease_expires_at >= clock_timestamp())
              and ((o.state = 'pending' and o.next_attempt_at <= clock_timestamp())
                   or (o.state = 'dispatching' and o.lease_expires_at < clock_timestamp()))
            order by e.created_at
            for update of e skip locked
            limit 1`,
          [],
        );
        if (!e) return null;
        const oldest = await one(
          c,
          `select response_id, state, next_attempt_at <= clock_timestamp() as due, lease_expires_at < clock_timestamp() as lease_expired
             from identity_verification.responses
            where expectation_id = $1 and state in ('pending', 'dispatching')
            order by received_seq limit 1 for update`,
          [e.expectation_id],
        );
        if (!oldest || (oldest.state === 'pending' && oldest.due !== true) || (oldest.state === 'dispatching' && oldest.lease_expired !== true)) return null;
        const r = required(await one(
          c,
          `update identity_verification.responses
              set state = 'dispatching', lease_owner = $2, lease_generation = lease_generation + 1,
                  lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000), attempts = attempts + 1
            where response_id = $1 returning *`,
          [oldest.response_id, owner, leaseMs],
        ));
        if (e.state === 'awaiting_code') {
          await c.query(`update identity_verification.expectations set state = 'processing', version = version + 1 where expectation_id = $1`, [e.expectation_id]);
        }
        const sealed = sealedOf(r);
        if (!sealed) throw new IdentityVerificationError('sealed_code_missing');
        return {
          responseId: r.response_id as string,
          expectationId: e.expectation_id as string,
          channel: e.channel as string,
          conversationKey: e.conversation_key as string,
          providerEventId: r.provider_event_id as string,
          verificationId: e.verification_id as string,
          accountRef: e.account_ref as string,
          bindingId: e.binding_id as string,
          taskId: e.task_id as string,
          confirmIdempotencyKey: r.confirm_idempotency_key as string,
          leaseOwner: owner,
          leaseGeneration: String(r.lease_generation),
          attempts: Number(r.attempts),
          sealed,
        };
      }),
    );
  }

  /** Records the CIA outcome of a claim (fenced). The sealed code is erased in the same statement. */
  recordOutcome(claim: ResponseClaim, result: { readonly outcome: CiaConfirmOutcome; readonly attemptsRemaining?: number }): Promise<ClaimSettlement> {
    return guard(() =>
      withTransaction(this.#pool, async (c) => {
        await lockConversation(c, claim.channel, claim.conversationKey);
        const settled = await this.#fenced(c, claim, `state = 'resolved', cia_outcome = $4`, [result.outcome]);
        if (!settled) return { kind: 'stale' } as const;
        const e = await this.#lockedExpectation(c, claim.expectationId);
        if (e.state !== 'processing') return { kind: 'settled', expectation: expectationOf(e), resume: false } as const;
        const { outcome } = result;
        const remaining = outcome === 'invalid_code' ? Math.max(0, Math.min(4, result.attemptsRemaining ?? 0)) : null;
        const [state, reason] = CONSUMED.includes(outcome)
          ? ['confirmed', 'challenge_consumed']
          : outcome === 'expired'
            ? ['expired', 'challenge_expired']
            : outcome === 'locked' || remaining === 0
              ? ['rejected', 'challenge_rejected']
              : ['awaiting_code', null];
        const row = await one(
          c,
          `update identity_verification.expectations
              set state = $2, cia_outcome = $3, attempts_remaining = $4,
                  closed_at = case when $5::text is null then null else clock_timestamp() end, closed_reason = $5, version = version + 1
            where expectation_id = $1 returning *`,
          [claim.expectationId, state, outcome, remaining, reason],
        );
        return { kind: 'settled', expectation: expectationOf(required(row)), resume: true } as const;
      }),
    );
  }

  /** Returns a claim to `pending` for a retry after `retryAfterMs` (fenced; the sealed code stays). */
  releaseClaim(claim: ResponseClaim, retryAfterMs: number): Promise<{ readonly kind: 'released' | 'stale' }> {
    return guard(() =>
      withTransaction(this.#pool, async (c) => {
        await lockConversation(c, claim.channel, claim.conversationKey);
        const released = await one(
          c,
          `update identity_verification.responses
              set state = 'pending', lease_owner = null, lease_expires_at = null,
                  next_attempt_at = clock_timestamp() + make_interval(secs => $4::double precision / 1000)
            where response_id = $1 and state = 'dispatching' and lease_owner = $2 and lease_generation = $3::bigint
            returning response_id`,
          [claim.responseId, claim.leaseOwner, claim.leaseGeneration, retryAfterMs],
        );
        if (!released) return { kind: 'stale' } as const;
        await c.query(
          `update identity_verification.expectations set state = 'awaiting_code', version = version + 1
            where expectation_id = $1 and state = 'processing'`,
          [claim.expectationId],
        );
        return { kind: 'released' } as const;
      }),
    );
  }

  /** Terminal failure of a claim (fenced): the response fails and the expectation is cancelled. */
  failClaim(claim: ResponseClaim, failureCode: string): Promise<{ readonly kind: 'failed' | 'stale' }> {
    return guard(() =>
      withTransaction(this.#pool, async (c) => {
        await lockConversation(c, claim.channel, claim.conversationKey);
        const failed = await this.#fenced(c, claim, `state = 'failed', failure_code = $4`, [failureCode]);
        if (!failed) return { kind: 'stale' } as const;
        await c.query(
          `update identity_verification.expectations
              set state = 'cancelled', closed_at = clock_timestamp(), closed_reason = $2, version = version + 1
            where expectation_id = $1 and state in ('created', 'awaiting_code', 'processing')`,
          [claim.expectationId, `confirm_${failureCode}`.slice(0, 64)],
        );
        return { kind: 'failed' } as const;
      }),
    );
  }

  async markNotified(responseId: string): Promise<boolean> {
    return guard(async () => {
      const r = await this.#pool.query(`update identity_verification.responses set state = 'notified' where response_id = $1 and state = 'resolved'`, [responseId]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  // ── Expiry and purge ──────────────────────────────────────────────────────────────────────────

  /** Expires due expectations (one short locked transaction each) and open responses past their deadline. */
  async sweep(): Promise<{ readonly expectationsExpired: number; readonly responsesExpired: number }> {
    return guard(async () => {
      const due = await this.#pool.query<{ expectation_id: string }>(
        `select expectation_id from identity_verification.expectations
          where (state in ('awaiting_code', 'processing') and challenge_expires_at <= clock_timestamp())
             or (state = 'created' and created_at + make_interval(secs => $1::double precision / 1000) <= clock_timestamp())`,
        [this.#unissuedTtlMs],
      );
      let expectationsExpired = 0;
      for (const { expectation_id: id } of due.rows) {
        expectationsExpired += await withTransaction(this.#pool, async (c) => {
          await this.#lockedExpectation(c, id);
          const r = await c.query(
            `update identity_verification.expectations
                set state = 'expired', closed_at = clock_timestamp(), closed_reason = 'challenge_expired', version = version + 1
              where expectation_id = $1
                and ((state in ('awaiting_code', 'processing') and challenge_expires_at <= clock_timestamp())
                     or (state = 'created' and created_at + make_interval(secs => $2::double precision / 1000) <= clock_timestamp()))`,
            [id, this.#unissuedTtlMs],
          );
          return r.rowCount ?? 0;
        });
      }
      const responses = await this.#pool.query(
        `update identity_verification.responses
            set state = 'expired', failure_code = 'deadline_passed',
                code_ciphertext = null, code_iv = null, code_tag = null, key_id = null, lease_owner = null, lease_expires_at = null
          where state in ('pending', 'dispatching') and deadline_at <= clock_timestamp()`,
      );
      return { expectationsExpired, responsesExpired: responses.rowCount ?? 0 };
    });
  }

  /** Deletes terminal responses past retention, then closed expectations whose protection ended a retention ago. */
  async purge(): Promise<{ readonly responses: number; readonly expectations: number }> {
    return guard(async () => {
      const responses = await this.#pool.query(
        `delete from identity_verification.responses
          where state in ('notified', 'cancelled', 'failed', 'expired') and purge_after <= clock_timestamp()`,
      );
      const expectations = await this.#pool.query(
        `delete from identity_verification.expectations e
          where e.state in ('confirmed', 'rejected', 'expired', 'cancelled')
            and e.protect_until + make_interval(secs => $1::double precision / 1000) <= clock_timestamp()
            and not exists (select 1 from identity_verification.responses r where r.expectation_id = e.expectation_id)`,
        [this.#retentionMs],
      );
      return { responses: responses.rowCount ?? 0, expectations: expectations.rowCount ?? 0 };
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────

  async #lockedExpectation(c: PoolClient, expectationId: string): Promise<Row> {
    const key = await one(c, 'select channel, conversation_key from identity_verification.expectations where expectation_id = $1', [expectationId]);
    if (!key) throw new IdentityVerificationError('expectation_not_found');
    await lockConversation(c, key.channel as string, key.conversation_key as string);
    return required(await one(c, 'select * from identity_verification.expectations where expectation_id = $1 for update', [expectationId]));
  }

  async #fenced(c: PoolClient, claim: ResponseClaim, assignments: string, extra: unknown[]): Promise<boolean> {
    const r = await c.query(
      `update identity_verification.responses
          set ${assignments}, code_ciphertext = null, code_iv = null, code_tag = null, key_id = null, lease_owner = null, lease_expires_at = null
        where response_id = $1 and state = 'dispatching' and lease_owner = $2 and lease_generation = $3::bigint`,
      [claim.responseId, claim.leaseOwner, claim.leaseGeneration, ...extra],
    );
    return (r.rowCount ?? 0) > 0;
  }
}

// ── Rows ───────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

async function one(q: Pool | PoolClient, text: string, values: unknown[]): Promise<Row | null> {
  const r = await q.query<Row>(text, values);
  return r.rows[0] ?? null;
}

function required(row: Row | null): Row {
  if (!row) throw new IdentityVerificationError('row_missing');
  return row;
}

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null);

function expectationOf(r: Row): ExpectationRecord {
  return {
    expectationId: r.expectation_id as string,
    channel: r.channel as string,
    conversationKey: r.conversation_key as string,
    accountRef: r.account_ref as string,
    bindingId: r.binding_id as string,
    taskId: r.task_id as string,
    consumerId: r.consumer_id as string,
    verificationId: (r.verification_id as string | null) ?? null,
    state: r.state as ExpectationState,
    ciaOutcome: (r.cia_outcome as CiaConfirmOutcome | null) ?? null,
    attemptsRemaining: r.attempts_remaining == null ? null : Number(r.attempts_remaining),
    createdAt: iso(r.created_at) ?? '',
    challengeExpiresAt: iso(r.challenge_expires_at),
    protectUntil: iso(r.protect_until) ?? '',
    closedAt: iso(r.closed_at),
    closedReason: (r.closed_reason as string | null) ?? null,
    version: Number(r.version),
  };
}

function sealedOf(r: Row): SealedCode | null {
  if (!(r.code_ciphertext instanceof Buffer) || !(r.code_iv instanceof Buffer) || !(r.code_tag instanceof Buffer) || typeof r.key_id !== 'string') return null;
  return { ciphertext: r.code_ciphertext, iv: r.code_iv, tag: r.code_tag, keyId: r.key_id };
}

function responseOf(r: Row): ResponseRecord {
  return {
    responseId: r.response_id as string,
    expectationId: r.expectation_id as string,
    channel: r.channel as string,
    providerEventId: r.provider_event_id as string,
    receivedSeq: String(r.received_seq),
    state: r.state as ResponseState,
    sealed: sealedOf(r),
    confirmIdempotencyKey: r.confirm_idempotency_key as string,
    attempts: Number(r.attempts),
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseGeneration: String(r.lease_generation),
    ciaOutcome: (r.cia_outcome as CiaConfirmOutcome | null) ?? null,
    failureCode: (r.failure_code as string | null) ?? null,
    deadlineAt: iso(r.deadline_at) ?? '',
  };
}

// ── Errors: never row values ───────────────────────────────────────────────────────────────────

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw sanitized(error);
  }
}

function sanitized(error: unknown): Error {
  if (error instanceof IdentityVerificationError) return error;
  const message = error instanceof Error ? error.message : '';
  const trigger = /^identity_verification: ([a-z_]+)$/.exec(message);
  if (trigger?.[1]) return new IdentityVerificationError(trigger[1]);
  const code = (error as { code?: unknown } | null)?.code;
  const shaped = error as { constraint?: unknown; details?: { constraint?: unknown } } | null;
  const constraint = shaped?.constraint ?? shaped?.details?.constraint;
  const suffix = typeof constraint === 'string' && /^[a-z0-9_]{1,63}$/.test(constraint) ? `:${constraint}` : '';
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return new IdentityVerificationError(`database_${code}${suffix}`);
  if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) return new IdentityVerificationError(`${code}${suffix}`);
  return new IdentityVerificationError('internal_error');
}
