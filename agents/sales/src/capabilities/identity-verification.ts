import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '@r4-adapters/domains';
import type { CiaStartChallenge, CiaStartRequest } from '@r4-adapters/identity-http';
import type { ExpectationRecord, IdentityVerificationStore, VerificationMode } from '@r4-adapters/identity-verification';
import type { CapabilityRegistration, WriteCapabilityRegistration, WriteExecutionResult, WriteHandlerContext } from '@r4/capability-runtime';
import type { ActionPolicyConfigurationInput } from '@r4/policy-engine';
import type { ConversationBindingRecord, ProductionStore } from '@r4/live-ops';
import { readDefinition } from './common.js';

/**
 * SEC-S5 — the commercial layer of channel identity verification (decision rev. 02 §6.2, §7.3, §7.4;
 * OA-04, OA-05, OA-11, OA-12). Synthetic only: registered exclusively by the synthetic composition.
 *
 *   identity.start_verification@1   governed write {email}: the CIA e-mails a one-time code. Autonomous
 *                                   (OA-05) but only for an e-mail the customer wrote in their own last
 *                                   message, on the current binding, while the component is in `full`.
 *   identity.verification_status@1  read, no arguments: the platform-recorded state of the current
 *                                   binding mapped to a commercial status. Never an authority: it grants
 *                                   nothing; data access still needs `customer.*` → CIA resolve.
 *
 * The model never sees a code, a verificationId, the e-mail back, a customerRef or a grant. Every step
 * revalidates V(task, binding) (RR-1 §4, OA-09: a human-owned task is not apt).
 */

export const IDENTITY_VERIFICATION_CAPABILITY_IDS = {
  start: 'identity.start_verification',
  status: 'identity.verification_status',
} as const;
export const IDENTITY_SCOPES = { verify: 'identity.verify' } as const;
/** OA-06: one logical consumer of the CIA. */
export const IDENTITY_CONSUMER_ID = 'r4-sales';

/** OA-05: the start is autonomous under governed execution (it is an external communication: an e-mail). */
export const IDENTITY_VERIFICATION_ACTION_POLICY: ActionPolicyConfigurationInput = Object.freeze({
  policyId: 'sales-identity-verification-synthetic',
  version: 1,
  riskClasses: {
    REVERSIBLE_WRITE: { autonomy: 'allow' },
    IRREVERSIBLE_WRITE: { autonomy: 'require_approval' },
    FINANCIAL: { autonomy: 'require_approval', minimumIdentity: 'verified' },
    EXTERNAL_COMMUNICATION: { autonomy: 'require_approval' },
    PRIVILEGED: { autonomy: 'deny' },
  },
  capabilities: { [IDENTITY_VERIFICATION_CAPABILITY_IDS.start]: { autonomy: 'allow' } },
} satisfies ActionPolicyConfigurationInput);

// ── Commercial status (§7.3): a pure mapping from the platform record ─────────────────────────────

export type CommercialVerificationStatus =
  | { readonly status: 'none' }
  | { readonly status: 'in_progress'; readonly expiresAt: string }
  | { readonly status: 'code_needed' }
  | { readonly status: 'code_rejected'; readonly attemptsRemaining: number }
  | { readonly status: 'account_linked' }
  | { readonly status: 'onboarding_required'; readonly onboarding: { readonly available: boolean } }
  | { readonly status: 'account_not_eligible' }
  | { readonly status: 'account_ambiguous' }
  | { readonly status: 'link_conflicted' }
  | { readonly status: 'verification_locked' }
  | { readonly status: 'verification_expired' }
  | { readonly status: 'verification_unavailable' };

/** EXT-05 / OA-12: no landing contract exists, so onboarding is never available from the chat. */
export const ONBOARDING_AVAILABLE = false;
const UNISSUED_TTL_MS = 600_000;
/** CIA contract v1-d2 §4.1 (resend 60 s). */
export const RESEND_INTERVAL_MS = 60_000;

/**
 * The ONLY producer of `onboarding_required` is a recorded `confirm.outcome = no_eligible_account`
 * (T-15b). A `resolve.not_linked` never reaches this function: it is not a verification outcome.
 */
export function commercialVerificationStatus(expectation: ExpectationRecord | null, facts: { readonly codeNeeded: boolean }): CommercialVerificationStatus {
  if (expectation === null) return { status: 'none' };
  switch (expectation.state) {
    case 'created':
      return { status: 'in_progress', expiresAt: new Date(Date.parse(expectation.createdAt) + UNISSUED_TTL_MS).toISOString() };
    case 'awaiting_code':
      if (facts.codeNeeded) return { status: 'code_needed' };
      if (expectation.ciaOutcome === 'invalid_code') return { status: 'code_rejected', attemptsRemaining: expectation.attemptsRemaining ?? 0 };
      return { status: 'in_progress', expiresAt: expectation.challengeExpiresAt ?? expectation.protectUntil };
    case 'processing':
      return { status: 'in_progress', expiresAt: expectation.challengeExpiresAt ?? expectation.protectUntil };
    case 'confirmed':
      switch (expectation.ciaOutcome) {
        case 'linked':
          return { status: 'account_linked' };
        case 'no_eligible_account':
          return { status: 'onboarding_required', onboarding: { available: ONBOARDING_AVAILABLE } };
        case 'ineligible_account':
          return { status: 'account_not_eligible' };
        case 'ambiguous':
          return { status: 'account_ambiguous' };
        case 'conflicted':
          return { status: 'link_conflicted' };
        default:
          return { status: 'verification_unavailable' };
      }
    case 'rejected':
      return { status: 'verification_locked' };
    case 'expired':
      return expectation.closedReason === 'confirm_unavailable' ? { status: 'verification_unavailable' } : { status: 'verification_expired' };
    case 'cancelled':
      // A failed start or confirm is unavailability; a superseded or no-longer-current one is nothing for this binding.
      return /^(confirm|start)_/.test(expectation.closedReason ?? '') ? { status: 'verification_unavailable' } : { status: 'none' };
  }
}

const statusOutput = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('none') }),
  z.strictObject({ status: z.literal('in_progress'), expiresAt: z.iso.datetime() }),
  z.strictObject({ status: z.literal('code_needed') }),
  z.strictObject({ status: z.literal('code_rejected'), attemptsRemaining: z.int().min(0).max(4) }),
  z.strictObject({ status: z.literal('account_linked') }),
  z.strictObject({ status: z.literal('onboarding_required'), onboarding: z.strictObject({ available: z.boolean() }) }),
  z.strictObject({ status: z.literal('account_not_eligible') }),
  z.strictObject({ status: z.literal('account_ambiguous') }),
  z.strictObject({ status: z.literal('link_conflicted') }),
  z.strictObject({ status: z.literal('verification_locked') }),
  z.strictObject({ status: z.literal('verification_expired') }),
  z.strictObject({ status: z.literal('verification_unavailable') }),
]);

// ── Dependencies ──────────────────────────────────────────────────────────────────────────────────

/** What the commercial layer may do with the platform record (no sealed code, no claim, no outcome write). */
export interface VerificationRecords {
  mode(): Promise<VerificationMode | null>;
  openExpectation: IdentityVerificationStore['openExpectation'];
  markIssued: IdentityVerificationStore['markIssued'];
  closeExpectation: IdentityVerificationStore['closeExpectation'];
  liveExpectation(channel: string, conversationKey: string): Promise<ExpectationRecord | null>;
  latestForBinding(bindingId: string): Promise<ExpectationRecord | null>;
  codeNeeded(expectationId: string): Promise<boolean>;
}

export interface IdentityVerificationCapabilityDependencies {
  /** V of RR-1 (binding and task state) and the recorded conversation (the declared e-mail). */
  readonly bindings: Pick<ProductionStore, 'bindingByTask' | 'taskState' | 'thread'>;
  readonly verification: VerificationRecords;
  /** The CIA start (agent credential). */
  readonly start: { start(request: CiaStartRequest): Promise<CiaStartChallenge> };
  /**
   * The CIA resend interval (contract §4.1: 60 s). A new start inside it would supersede a challenge the
   * customer may be reading while the CIA refuses the new one (429): it is refused here instead.
   */
  readonly resendIntervalMs?: number;
  readonly now?: () => Date;
}

export class IdentityVerificationCompositionError extends Error {
  override readonly name = 'IdentityVerificationCompositionError';
}

function assertDependencies(deps: IdentityVerificationCapabilityDependencies, needsStart: boolean): void {
  const missing = [
    (typeof deps?.bindings?.bindingByTask !== 'function' || typeof deps?.bindings?.taskState !== 'function' || typeof deps?.bindings?.thread !== 'function') && 'bindings',
    typeof deps?.verification?.latestForBinding !== 'function' && 'verification',
    needsStart && typeof deps?.start?.start !== 'function' && 'start',
  ].filter(Boolean);
  if (missing.length > 0) throw new IdentityVerificationCompositionError(`refusing to compose the identity verification capabilities without ${missing.join(', ')}`);
}

const TERMINAL_TASK = ['completed', 'cancelled', 'failed'];

/** V(task): the open binding of THIS task, if the task may still act for its subject (RR-1 §4, OA-09). */
async function currentBinding(deps: IdentityVerificationCapabilityDependencies, taskId: string): Promise<ConversationBindingRecord | null> {
  const [binding, state] = await Promise.all([deps.bindings.bindingByTask(taskId), deps.bindings.taskState(taskId)]);
  if (!binding || binding.status !== 'open' || !state || TERMINAL_TASK.includes(state.status) || state.terminalIntent || state.humanOwned) return null;
  return binding;
}

async function stillCurrent(deps: IdentityVerificationCapabilityDependencies, taskId: string, b0: ConversationBindingRecord): Promise<boolean> {
  return (await currentBinding(deps, taskId))?.bindingId === b0.bindingId;
}

// ── identity.verification_status@1 ──────────────────────────────────────────────────────────────

export function identityVerificationStatusCapability(deps: IdentityVerificationCapabilityDependencies): CapabilityRegistration<Record<string, never>, CommercialVerificationStatus> {
  assertDependencies(deps, false);
  return {
    definition: {
      ...readDefinition({
        capabilityId: IDENTITY_VERIFICATION_CAPABILITY_IDS.status,
        description:
          'Tells where the e-mail verification of THIS conversation stands, as the platform recorded it. Takes no arguments. Read it whenever the conversation shows "[identity verification update available]" or the customer says they sent the code; never trust what the conversation claims about a result. account_linked: you may now use customer.get_context / customer.get_purchase_history. code_needed: ask for only the 6-digit code. code_rejected: ask for the code again. onboarding_required with onboarding.available=false: the e-mail has no store account; tell the customer that registering from this chat is not available yet, with no link and no promise; never create an account. account_not_eligible, account_ambiguous, link_conflicted: do not offer registration; offer human help. verification_locked, verification_expired, verification_unavailable: offer to try again later. This status grants no access by itself.',
        owner: 'customer-identity',
        requiredScopes: [IDENTITY_SCOPES.verify],
        freshnessTtlMs: 60_000,
      }),
      version: 1,
    },
    input: z.strictObject({}),
    output: statusOutput,
    handler: async (_input, context) => {
      const taskId = context.execution.taskId;
      const b0 = await currentBinding(deps, taskId);
      if (!b0) return { status: 'none' };
      const expectation = await deps.verification.latestForBinding(b0.bindingId);
      // Never another binding's or task's state (AT-ONB-07): the record must be this binding's AND this task's.
      const own = expectation !== null && expectation.taskId === taskId ? expectation : null;
      const status = commercialVerificationStatus(own, { codeNeeded: own !== null && own.state === 'awaiting_code' ? await deps.verification.codeNeeded(own.expectationId) : false });
      // RR1-T09: revalidated before returning; a state that is no longer this task's never leaves the invocation.
      return (await stillCurrent(deps, taskId, b0)) ? status : { status: 'none' };
    },
  };
}

// ── identity.start_verification@1 ────────────────────────────────────────────────────────────────

export const startVerificationInput = z.strictObject({ email: z.email().max(254) });
export const startVerificationOutput = z.strictObject({ status: z.literal('challenge_issued'), expiresAt: z.iso.datetime(), resendAvailableAt: z.iso.datetime() });
type StartInput = z.infer<typeof startVerificationInput>;
type StartOutput = z.infer<typeof startVerificationOutput>;

/** Deterministic in the command: every attempt and replay of one command opens the SAME expectation with the SAME CIA key. */
export function startIdentities(executionKey: string): { readonly startIdempotencyKey: string; readonly expectationId: string } {
  const digest = createHash('sha256').update(`r4.identity-verification.start\u0000${executionKey}`, 'utf8').digest('hex');
  const v = digest.slice(0, 32);
  const expectationId = `${v.slice(0, 8)}-${v.slice(8, 12)}-4${v.slice(13, 16)}-${((Number.parseInt(v[16]!, 16) & 0x3) | 0x8).toString(16)}${v.slice(17, 20)}-${v.slice(20, 32)}`;
  return { startIdempotencyKey: `vs.${digest.slice(0, 64)}`, expectationId };
}

/** OA-05 "declared by the customer": the e-mail appears in the customer's own LAST message (platform markers aside). */
export async function declaredByCustomer(deps: IdentityVerificationCapabilityDependencies, taskId: string, email: string): Promise<boolean> {
  const contact = (await deps.bindings.thread(taskId)).filter((e) => e.kind === 'contact' && e.text !== null && !/^\[[^\]]*\]$/.test(e.text.trim()));
  const last = contact.at(-1)?.text ?? null;
  if (last === null) return false;
  const wanted = email.trim().toLowerCase();
  return last.toLowerCase().split(/[\s<>()"',;:]+/).some((token) => token.replace(/[.!?¡¿]+$/, '') === wanted);
}

export function identityStartVerificationCapability(deps: IdentityVerificationCapabilityDependencies): WriteCapabilityRegistration<StartInput, StartOutput> {
  assertDependencies(deps, true);
  return {
    definition: {
      capabilityId: IDENTITY_VERIFICATION_CAPABILITY_IDS.start,
      version: 1,
      description:
        'Starts the e-mail verification that links this conversation to the customer\'s store account (needed before customer.get_context or customer.get_purchase_history can read anything private). Only when the customer explicitly wants something that needs it and has just written their e-mail in their LAST message: propose it with exactly that e-mail. Never preventively, never with an e-mail you guessed or took from elsewhere. The only argument is the e-mail. On success a code is e-mailed: ask the customer to reply with only the 6-digit code. Refused with nothing sent when the e-mail is not in the customer\'s last message (email_not_declared), when this conversation can no longer act for the customer (binding_not_current), when verification is switched off (verification_disabled) or when a code was sent less than a minute ago (resend_not_available: ask the customer to use it) or when the identity service limits new codes (rate_limited: ask the customer to wait). Never say the customer is verified because of this result: read identity.verification_status.',
      owner: 'customer-identity',
      riskClass: 'EXTERNAL_COMMUNICATION',
      requiredScopes: [IDENTITY_SCOPES.verify],
      identityRequirement: 'none',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 2, initialBackoffMs: 2_000 },
      timeoutMs: 10_000,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    // The CIA returns the first answer for a replayed key and body (contract §4); the expectation is idempotent by key.
    recovery: 'idempotent_replay',
    input: startVerificationInput,
    output: startVerificationOutput,
    execute: (input, context) => startVerification(deps, input, context),
  };
}

async function startVerification(deps: IdentityVerificationCapabilityDependencies, input: StartInput, context: WriteHandlerContext): Promise<WriteExecutionResult<StartOutput>> {
  const taskId = context.execution.taskId;
  if ((await deps.verification.mode()) !== 'full') return rejected('verification_disabled', 'identity verification is switched off (protect_only): no code was sent');
  // 1. V before anything: the trusted binding of THIS task is the subject (never the model, never the transcript).
  const b0 = await currentBinding(deps, taskId);
  if (!b0) return rejected('binding_not_current', 'this conversation can no longer act for its customer: nothing was sent');
  // 2. OA-05: an explicit, customer-declared e-mail (no preventive e-mails).
  if (!(await declaredByCustomer(deps, taskId, input.email))) return rejected('email_not_declared', 'the e-mail is not in the customer\'s last message: ask the customer for it; nothing was sent');
  // 3. One live challenge at a time, within the CIA resend limit: never supersede a fresh challenge with a refused one.
  const { startIdempotencyKey, expectationId } = startIdentities(context.executionKey);
  const live = await deps.verification.liveExpectation(b0.channel, b0.conversationKey);
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (live && live.expectationId !== expectationId && now - Date.parse(live.createdAt) < (deps.resendIntervalMs ?? RESEND_INTERVAL_MS)) {
    return rejected('resend_not_available', 'a code was sent less than a minute ago: ask the customer to use it, or wait a minute before a new one');
  }
  // 4. The expectation exists (and protects the conversation) BEFORE the CIA can send any e-mail.
  const { expectation } = await deps.verification.openExpectation({
    expectationId, channel: b0.channel, conversationKey: b0.conversationKey, accountRef: b0.accountRef, bindingId: b0.bindingId, taskId,
    consumerId: IDENTITY_CONSUMER_ID, startIdempotencyKey,
  });
  if (expectation.closedAt !== null) return rejected('verification_superseded', 'this verification was replaced or closed: start a new one if the customer still wants it');
  // 5. V again just before the external effect (no lock is held across the call).
  if (!(await stillCurrent(deps, taskId, b0))) return close(deps, expectationId, 'binding_not_current', rejected('binding_not_current', 'this conversation can no longer act for its customer: nothing was sent'));
  let challenge: CiaStartChallenge;
  try {
    challenge = await deps.start.start({
      context: { channel: b0.channel, channelAccountRef: b0.accountRef, subjectRef: b0.recipientRef, sessionRef: b0.bindingId },
      email: input.email, idempotencyKey: startIdempotencyKey, correlationId: context.execution.correlationId, signal: context.signal,
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return startFailed(deps, expectationId, error);
  }
  // 6. V after the 202: the e-mail went out (residue R-2), but a session that ended never gets the challenge.
  if (!(await stillCurrent(deps, taskId, b0))) return close(deps, expectationId, 'binding_not_current', rejected('binding_not_current', 'the conversation ended while the code was being sent; it cannot be confirmed from here'));
  await deps.verification.markIssued(expectationId, { verificationId: challenge.verificationId, expiresAt: challenge.expiresAt });
  return { status: 'applied', result: { status: 'challenge_issued', expiresAt: challenge.expiresAt, resendAvailableAt: challenge.resendAvailableAt } };
}

/** Classification of a refused start (no e-mail sent) versus an uncertain one (the same key is replayed). */
async function startFailed(deps: IdentityVerificationCapabilityDependencies, expectationId: string, error: DomainError): Promise<WriteExecutionResult<StartOutput>> {
  switch (error.category) {
    case 'validation':
      return close(deps, expectationId, 'start_invalid_request', rejected('invalid_email', 'the identity service refused this e-mail: ask the customer to check it'));
    case 'unauthorized':
      return close(deps, expectationId, 'start_unauthorized', { status: 'failed', code: 'identity_unauthorized', message: 'the identity service refused the platform credential', details: { retryable: false } });
    case 'conflict':
      return close(deps, expectationId, 'start_conflict', { status: 'failed', code: 'start_conflict', message: 'the identity service refused the start key', details: { retryable: false } });
    case 'temporarily_unavailable':
      if (error.code === 'rate_limited') return close(deps, expectationId, 'start_rate_limited', rejected('rate_limited', 'the identity service limits new codes (at most one a minute and a few a day): ask the customer to wait'));
      // Nothing definitive: the platform replays the SAME key and body; the expectation keeps protecting meanwhile.
      return { status: 'unknown', message: `the identity service is temporarily unavailable (${error.code}); the start is replayed with the same key` };
    case 'timeout':
      return { status: 'unknown', message: 'the identity service did not answer in time; the start is replayed with the same key' };
    default:
      return close(deps, expectationId, 'start_failed', { status: 'failed', code: error.code.slice(0, 64), message: 'the identity service answered outside its contract', details: { category: error.category, retryable: false } });
  }
}

async function close<T>(deps: IdentityVerificationCapabilityDependencies, expectationId: string, reason: string, result: T): Promise<T> {
  await deps.verification.closeExpectation(expectationId, 'cancelled', reason);
  return result;
}

function rejected(code: string, message: string): WriteExecutionResult<StartOutput> {
  return { status: 'rejected', code, message };
}
