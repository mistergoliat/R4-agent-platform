import type { ProductionStore } from '@r4/live-ops';
import { PLATFORM_MARKERS } from './markers.js';
import { SecretBoxError, type SecretBox } from './secret-box.js';
import type { CiaConfirmOutcome, IdentityVerificationStore, ResponseClaim } from './state-store.js';

/**
 * SEC-S4 — deferred confirmation (plan §4). Runs in the channel gateway, the only process holding the
 * keyring and the channel-integration credential, never inside the webhook:
 *
 *   claim (lease + fencing, skip locked, oldest response of an expectation first)
 *   → revalidate: deadline, and V(task, binding) = same open binding, task not terminal, no terminal
 *     intent, not human-owned (RR-1 §4, OA-09) — failing V cancels WITHOUT calling the CIA
 *   → open the sealed code (only here, only for this attempt)
 *   → confirm (same idempotency key and identical context on every attempt)
 *   → record under the conversation lock (fenced: a stale result is discarded, its existence traced)
 *   → resume the task with a marker that carries NO outcome (the model reads the platform state).
 *
 * No lock is held across the call. Ports are structural: the gateway composes the identity-http
 * client, the production store and the temporal runtime.
 */

export type ConfirmAnswer =
  | { readonly kind: 'outcome'; readonly outcome: CiaConfirmOutcome; readonly attemptsRemaining?: number }
  | { readonly kind: 'retry'; readonly code: string; readonly retryAfterMs: number | null }
  | { readonly kind: 'refused'; readonly code: string; readonly credentialRejected: boolean };

export interface ConfirmPort {
  confirm(request: {
    readonly context: { readonly channel: string; readonly channelAccountRef: string; readonly subjectRef: string; readonly sessionRef: string };
    readonly verificationId: string;
    readonly code: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<ConfirmAnswer>;
}

/** The resume seam (TemporalRuntime.submitInput, structurally). */
export interface ResumePort {
  submitInput(
    taskId: string,
    input: { readonly externalKey: string; readonly content: string; readonly sourceRef: string; readonly occurredAt: string },
    actor: { readonly kind: 'system'; readonly ref: string },
    correlationId: string,
  ): Promise<unknown>;
}

export type DispatchResult =
  | 'idle'
  | 'confirmed'
  | 'discarded'
  | 'retry_scheduled'
  | 'cancelled_binding_not_current'
  | 'expired'
  | 'failed'
  | 'stale';

export interface DispatchEvent {
  readonly event:
    | 'verification.confirm_dispatched'
    | 'verification.confirm_result_discarded'
    | 'verification.confirm_refused'
    | 'verification.confirm_breaker_open'
    | 'verification.resumed'
    | 'verification.resume_failed'
    | 'verification.dispatch_error';
  readonly result: DispatchResult | null;
  readonly responseId: string | null;
  readonly expectationId: string | null;
  readonly outcome: CiaConfirmOutcome | null;
  readonly code: string | null;
}

export interface VerificationConfirmDispatcherOptions {
  readonly store: IdentityVerificationStore;
  readonly box: SecretBox;
  readonly confirm: ConfirmPort;
  readonly bindings: Pick<ProductionStore, 'bindingByTask' | 'taskState'>;
  readonly resume: ResumePort;
  /** Lease owner (the gateway id). */
  readonly owner: string;
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly concurrency?: number;
  readonly sweepMs?: number;
  /** A resolved response not notified for this long is resumed again by the sweep (idempotent). */
  readonly resumeAfterMs?: number;
  /** Three consecutive 401/403 answers: the breaker opens and the composition must stop confirming (protect_only). */
  readonly onBreakerOpen?: () => Promise<void> | void;
  readonly onEvent?: (event: DispatchEvent) => void;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
}

export const RESUME_SOURCE = 'platform:identity-verification';
const DEADLINE_MARGIN_MS = 5_000;
const BREAKER_THRESHOLD = 3;
const TERMINAL_TASK = ['completed', 'cancelled', 'failed'];

export class VerificationConfirmDispatcher {
  readonly #o: VerificationConfirmDispatcherOptions;
  readonly #leaseMs: number;
  #credentialRejections = 0;
  #running = false;
  #loops: Promise<void>[] = [];
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #wake: (() => void)[] = [];

  constructor(options: VerificationConfirmDispatcherOptions) {
    this.#o = options;
    this.#leaseMs = options.leaseMs ?? 30_000;
  }

  /** One claim → confirm → record → resume cycle. */
  async dispatchOnce(): Promise<DispatchResult> {
    const { store, box, confirm } = this.#o;
    const claim = await store.claimNextResponse(this.#o.owner, this.#leaseMs);
    if (!claim) return 'idle';
    const deadline = Date.parse(claim.deadlineAt) - DEADLINE_MARGIN_MS;
    if (!(Date.now() < deadline)) {
      // An earlier attempt that never got an answer means the CIA was unavailable, not that the customer was late.
      const reason = claim.attempts > 1 ? 'confirm_unavailable' : 'challenge_expired';
      return this.#abandoned(claim, await store.abandonClaim(claim, 'expired', reason), 'expired');
    }
    const subjectRef = await this.#currentSubject(claim);
    if (subjectRef === null) return this.#abandoned(claim, await store.abandonClaim(claim, 'cancelled', 'binding_not_current'), 'cancelled_binding_not_current');

    let code: string;
    try {
      code = box.open(claim.sealed, { responseId: claim.responseId, expectationId: claim.expectationId, channel: claim.channel, providerEventId: claim.providerEventId });
    } catch (error) {
      const failure = error instanceof SecretBoxError ? error.code : 'decrypt_failed';
      await store.failClaim(claim, failure === 'unknown_key' ? 'unknown_key' : 'decrypt_failed');
      this.#emit('verification.confirm_refused', 'failed', claim, null, failure);
      return 'failed';
    }
    const answer = await confirm.confirm({
      context: { channel: claim.channel, channelAccountRef: claim.accountRef, subjectRef, sessionRef: claim.bindingId },
      verificationId: claim.verificationId,
      code,
      idempotencyKey: claim.confirmIdempotencyKey,
      correlationId: `verification-${claim.responseId}`,
    });

    if (answer.kind === 'outcome') {
      this.#credentialRejections = 0;
      const settlement = await store.recordOutcome(claim, answer.attemptsRemaining === undefined ? { outcome: answer.outcome } : { outcome: answer.outcome, attemptsRemaining: answer.attemptsRemaining });
      if (settlement.kind === 'stale') {
        // The response was closed while the call was in flight: the outcome never reaches the new expectation.
        const traced = await store.recordDiscardedOutcome(claim, answer.outcome);
        this.#emit('verification.confirm_result_discarded', traced ? 'discarded' : 'stale', claim, answer.outcome, null);
        return traced ? 'discarded' : 'stale';
      }
      this.#emit('verification.confirm_dispatched', 'confirmed', claim, answer.outcome, null);
      if (settlement.resume) await this.#resume(claim.responseId, claim.taskId);
      return 'confirmed';
    }
    if (answer.kind === 'retry') {
      this.#credentialRejections = 0;
      const delay = answer.retryAfterMs ?? this.#backoff(claim.attempts);
      if (!(Date.now() + delay < deadline)) return this.#abandoned(claim, await store.abandonClaim(claim, 'expired', 'confirm_unavailable'), 'expired');
      const released = await store.releaseClaim(claim, delay);
      return released.kind === 'released' ? 'retry_scheduled' : 'stale';
    }
    const failed = await store.failClaim(claim, answer.code);
    this.#emit('verification.confirm_refused', failed.kind === 'failed' ? 'failed' : 'stale', claim, null, answer.code);
    if (answer.credentialRejected) {
      this.#credentialRejections += 1;
      if (this.#credentialRejections >= BREAKER_THRESHOLD) {
        this.#emit('verification.confirm_breaker_open', null, claim, null, answer.code);
        this.#running = false;
        await this.#o.onBreakerOpen?.();
      }
    } else {
      this.#credentialRejections = 0;
    }
    return failed.kind === 'failed' ? 'failed' : 'stale';
  }

  /** Expiry, resumes left behind by a crash, and purge. */
  async sweepOnce(): Promise<{ readonly expectationsExpired: number; readonly responsesExpired: number; readonly resumed: number; readonly purged: number }> {
    const { store } = this.#o;
    const swept = await store.sweep();
    let resumed = 0;
    for (const pending of await store.resolvedAwaitingResume(this.#o.resumeAfterMs ?? 10_000, 50)) {
      if (await this.#resume(pending.responseId, pending.taskId)) resumed += 1;
    }
    const purged = await store.purge();
    return { ...swept, resumed, purged: purged.responses + purged.expectations };
  }

  /** In-process nudge after a capture (no wait for the next poll). */
  notify(): void {
    for (const wake of this.#wake.splice(0)) wake();
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const concurrency = Math.max(1, this.#o.concurrency ?? 4);
    this.#loops = Array.from({ length: concurrency }, () => this.#loop());
    this.#sweepTimer = setInterval(() => {
      void this.sweepOnce().catch((error: unknown) => this.#emit('verification.dispatch_error', null, null, null, codeOf(error)));
    }, this.#o.sweepMs ?? 30_000);
  }

  /** Stops claiming; lets the attempts in flight finish (their leases fence any late writer anyway). */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    this.notify();
    await Promise.allSettled(this.#loops);
    this.#loops = [];
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      let result: DispatchResult = 'idle';
      try {
        result = await this.dispatchOnce();
      } catch (error) {
        this.#emit('verification.dispatch_error', null, null, null, codeOf(error));
      }
      if (result === 'idle' && this.#running) await this.#idle();
    }
  }

  #idle(): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(finish, this.#o.pollMs ?? 250);
      function finish() {
        clearTimeout(timer);
        done();
      }
      this.#wake.push(finish);
    });
  }

  /** The binding subject if V(task, binding) holds now; null otherwise (RR-1 §5.2). */
  async #currentSubject(claim: ResponseClaim): Promise<string | null> {
    const [binding, state] = await Promise.all([this.#o.bindings.bindingByTask(claim.taskId), this.#o.bindings.taskState(claim.taskId)]);
    if (!binding || binding.bindingId !== claim.bindingId || binding.status !== 'open' || binding.channel !== claim.channel || binding.accountRef !== claim.accountRef) return null;
    if (!state || TERMINAL_TASK.includes(state.status) || state.terminalIntent || state.humanOwned) return null;
    return binding.recipientRef;
  }

  /** The platform marker only; the outcome is read with identity.verification_status (OA-11). */
  async #resume(responseId: string, taskId: string): Promise<boolean> {
    try {
      await this.#o.resume.submitInput(
        taskId,
        { externalKey: `verification-update:${responseId}`, content: PLATFORM_MARKERS.updateAvailable, sourceRef: RESUME_SOURCE, occurredAt: new Date().toISOString() },
        { kind: 'system', ref: RESUME_SOURCE },
        `verification-${responseId}`,
      );
    } catch (error) {
      const code = codeOf(error);
      if (code !== 'task_not_accepting_input' && code !== 'task_terminal') {
        this.#emit('verification.resume_failed', null, null, null, code);
        return false;
      }
      // A terminal task is never woken: the response is settled as notified (nothing to resume).
    }
    await this.#o.store.markNotified(responseId);
    this.#emit('verification.resumed', null, { responseId, expectationId: null }, null, null);
    return true;
  }

  #abandoned(claim: ResponseClaim, result: { readonly kind: 'abandoned' | 'stale' }, as: DispatchResult): DispatchResult {
    this.#emit('verification.confirm_refused', result.kind === 'abandoned' ? as : 'stale', claim, null, as);
    return result.kind === 'abandoned' ? as : 'stale';
  }

  /** min(500 ms · 2^(n-1), 10 s), with ±50 % jitter (plan §4.5). */
  #backoff(attempts: number): number {
    const base = Math.min(500 * 2 ** Math.max(0, attempts - 1), 10_000);
    return Math.round(base * (0.5 + (this.#o.random ?? Math.random)() / 2));
  }

  #emit(event: DispatchEvent['event'], result: DispatchResult | null, claim: Pick<ResponseClaim, 'responseId' | 'expectationId'> | { responseId: string; expectationId: null } | null, outcome: CiaConfirmOutcome | null, code: string | null): void {
    try {
      this.#o.onEvent?.({ event, result, responseId: claim?.responseId ?? null, expectationId: claim?.expectationId ?? null, outcome, code });
    } catch {
      // Telemetry never changes a decision.
    }
  }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_:]{1,80}$/.test(code) ? code : 'internal_error';
}
