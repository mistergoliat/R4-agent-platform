import { randomUUID } from 'node:crypto';
import type { InboundInspector, InspectableContent, InspectionDecision, TrustedChannelContext } from '@r4/live-ops';
import type { PoolClient } from '@r4/persistence-postgres';
import { inspectVerificationText, type ReplacementReason } from './classifier.js';
import { PLATFORM_MARKERS } from './markers.js';
import type { SecretBox } from './secret-box.js';
import type { ExpectationRecord, IdentityVerificationStore, VerificationMode } from './state-store.js';

/**
 * SEC-S3 — the identity-verification implementation of the generic InboundInspector v1 (ADR-040).
 * It runs inside the locked inbound transaction, before anything of the message is persisted or
 * hashed, and decides the only text that may be:
 *
 *   1. protection is read first, in the transaction; if that read fails the error propagates and the
 *      inbound transaction aborts (500, provider re-delivery): nothing is ever persisted untreated;
 *   2. with protection known, any later failure withholds the WHOLE message (fail closed) and rolls
 *      back this inspector's own writes to a savepoint; the inbound is still recorded, redacted;
 *   3. a code is captured (sealed, `pending`) only in `full` mode, under the live expectation of the
 *      SAME binding and task, while the task accepts input, is not human-owned and the challenge is
 *      open, from an attested direct sender who is the binding subject; otherwise it is only redacted;
 *   4. a live expectation whose binding or task is no longer current is cancelled (`binding_not_current`).
 * No network, model, clock (the database clock comes in the context), environment or log: events go
 * to `onEvent` with no content, code or identifier of the person.
 */

export interface VerificationInspectionEvent {
  readonly event: 'verification.inspected' | 'inbound.inspection_failed_closed';
  readonly reason: ReplacementReason | 'pass' | 'inspection_error';
  readonly captured: boolean;
  readonly channel: string;
  readonly expectationId: string | null;
  readonly errorCode: string | null;
}

export interface VerificationInspectorOptions {
  readonly store: IdentityVerificationStore;
  readonly mode: VerificationMode;
  /** Required in `full` (the gateway's keyring); never present in `protect_only`. */
  readonly box: SecretBox | null;
  readonly onEvent?: (event: VerificationInspectionEvent) => void;
  /** In-process nudge to the confirm dispatcher after a capture. */
  readonly onCaptured?: () => void;
}

export class VerificationInspector implements InboundInspector<PoolClient> {
  readonly version = 1 as const;
  readonly id = 'identity-verification';
  readonly #o: VerificationInspectorOptions;
  #mode: VerificationMode;

  constructor(options: VerificationInspectorOptions) {
    if (options.mode === 'full' && !options.box) throw new Error('identity verification: full mode needs the keyring');
    this.#o = options;
    this.#mode = options.mode;
  }

  get mode(): VerificationMode {
    return this.#mode;
  }

  /** One way only (emergency, breaker): from here on nothing is captured; redaction continues. */
  enterProtectOnly(): void {
    this.#mode = 'protect_only';
  }

  protectionActive(tx: PoolClient): Promise<boolean> {
    return this.#o.store.anyProtectionActive(tx);
  }

  async inspect(content: InspectableContent, context: TrustedChannelContext, tx: PoolClient): Promise<InspectionDecision> {
    const { store } = this.#o;
    // (1) Unknown protection: propagate (the inbound transaction aborts; nothing is persisted).
    const protectionActive = await store.protectionActive(tx, context.channel, context.conversationKey);
    await tx.query('savepoint identity_verification_inspection');
    let expectationId: string | null = null;
    try {
      const live = protectionActive ? await store.liveExpectation(tx, context.channel, context.conversationKey) : null;
      expectationId = live?.expectationId ?? null;
      const current = live !== null && isCurrent(live, context);
      if (live !== null && !current) await store.closeExpectationWithin(tx, live.expectationId, 'cancelled', 'binding_not_current');
      const accepts = this.#mode === 'full' && live !== null && current && challengeOpen(live, context.now) && context.binding?.humanOwned === false;
      const result = inspectVerificationText(content.text, {
        protectionActive,
        expectationAcceptsCode: accepts,
        directSubjectAttested: context.direct && context.binding !== null && context.senderRef === context.binding.recipientRef,
      });
      let captured = false;
      if (result.kind === 'replace' && result.submission && live && this.#o.box && this.#mode === 'full') {
        const responseId = randomUUID();
        const binding = { responseId, expectationId: live.expectationId, channel: context.channel, providerEventId: context.providerEventId };
        await store.captureResponse(tx, { ...binding, sealed: this.#o.box.seal(result.submission.code, binding) });
        captured = true;
      }
      await tx.query('release savepoint identity_verification_inspection');
      this.#emit({ event: 'verification.inspected', reason: result.kind === 'pass' ? 'pass' : result.reason, captured, channel: context.channel, expectationId, errorCode: null });
      if (captured) this.#o.onCaptured?.();
      return result.kind === 'pass' ? { kind: 'pass' } : { kind: 'replace', text: result.text };
    } catch (error) {
      if (!protectionActive) throw error;
      // (2) Protection is known and could not be honored precisely: withhold everything, keep nothing of ours.
      await tx.query('rollback to savepoint identity_verification_inspection');
      this.#emit({ event: 'inbound.inspection_failed_closed', reason: 'inspection_error', captured: false, channel: context.channel, expectationId, errorCode: codeOf(error) });
      return { kind: 'replace', text: PLATFORM_MARKERS.messageWithheld };
    }
  }

  #emit(event: VerificationInspectionEvent): void {
    try {
      this.#o.onEvent?.(event);
    } catch {
      // Telemetry never changes a decision.
    }
  }
}

/** The live expectation belongs to the binding and task the inbound arrives on, and that task accepts input. */
function isCurrent(live: ExpectationRecord, context: TrustedChannelContext): boolean {
  const binding = context.binding;
  return binding !== null && binding.bindingId === live.bindingId && binding.taskId === live.taskId && binding.taskAcceptsInput;
}

/** `created` (start in flight) accepts a capture; an issued challenge only before its expiry (database clock). */
function challengeOpen(live: ExpectationRecord, now: string): boolean {
  if (live.state === 'created') return true;
  return live.challengeExpiresAt !== null && Date.parse(now) < Date.parse(live.challengeExpiresAt);
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_:]{1,80}$/.test(code) ? code : 'internal_error';
}
