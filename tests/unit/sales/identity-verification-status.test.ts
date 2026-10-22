import { describe, expect, it } from 'vitest';
import type { CiaConfirmOutcome, ExpectationRecord, ExpectationState } from '@r4-adapters/identity-verification';
import {
  IDENTITY_VERIFICATION_ACTION_POLICY,
  IDENTITY_VERIFICATION_CAPABILITY_IDS,
  ONBOARDING_AVAILABLE,
  commercialVerificationStatus,
  startIdentities,
} from '../../../agents/sales/src/capabilities/identity-verification.js';

// SEC-S5: the commercial reading of the platform-recorded CIA outcome (decision rev. 02 §7.3), as a pure
// mapping. AT-ONB-01 (the matrix), AT-ONB-04/05 (what onboarding_required is and is not). Synthetic only.

const T0 = '2026-10-21T12:00:00.000Z';
const EXPIRES = '2026-10-21T12:10:00.000Z';
function expectation(state: ExpectationState, overrides: Partial<ExpectationRecord> = {}): ExpectationRecord {
  const closed = ['confirmed', 'rejected', 'expired', 'cancelled'].includes(state);
  return {
    expectationId: '0190a0a0-0000-4000-8000-00000000000e', channel: 'whatsapp', conversationKey: 'a'.repeat(64), accountRef: '100000000000001',
    bindingId: '0190b0b0-0000-7000-8000-000000000001', taskId: '0190a0a0-0000-7000-8000-00000000000a', consumerId: 'r4-sales',
    verificationId: state === 'created' ? null : 'Vf0SyntheticChallenge1', state, ciaOutcome: null, attemptsRemaining: null, createdAt: T0,
    challengeExpiresAt: state === 'created' ? null : EXPIRES, protectUntil: '2026-10-21T12:20:00.000Z', closedAt: closed ? T0 : null,
    closedReason: closed ? 'challenge_consumed' : null, version: 2, ...overrides,
  };
}
const confirmed = (ciaOutcome: CiaConfirmOutcome) => expectation('confirmed', { ciaOutcome });
const map = (e: ExpectationRecord | null, codeNeeded = false) => commercialVerificationStatus(e, { codeNeeded });

describe('AT-ONB-01: every recorded state and CIA outcome maps to exactly one commercial status', () => {
  it.each<[string, ExpectationRecord | null, unknown]>([
    ['no expectation', null, { status: 'none' }],
    ['created (start in flight)', expectation('created'), { status: 'in_progress', expiresAt: '2026-10-21T12:10:00.000Z' }],
    ['awaiting_code', expectation('awaiting_code'), { status: 'in_progress', expiresAt: EXPIRES }],
    ['processing', expectation('processing'), { status: 'in_progress', expiresAt: EXPIRES }],
    ['invalid_code with attempts', expectation('awaiting_code', { ciaOutcome: 'invalid_code', attemptsRemaining: 3 }), { status: 'code_rejected', attemptsRemaining: 3 }],
    ['linked', confirmed('linked'), { status: 'account_linked' }],
    ['no_eligible_account', confirmed('no_eligible_account'), { status: 'onboarding_required', onboarding: { available: false } }],
    ['ineligible_account', confirmed('ineligible_account'), { status: 'account_not_eligible' }],
    ['ambiguous', confirmed('ambiguous'), { status: 'account_ambiguous' }],
    ['conflicted', confirmed('conflicted'), { status: 'link_conflicted' }],
    ['locked', expectation('rejected', { ciaOutcome: 'locked', closedReason: 'challenge_rejected' }), { status: 'verification_locked' }],
    ['invalid_code with 0 attempts', expectation('rejected', { ciaOutcome: 'invalid_code', attemptsRemaining: 0, closedReason: 'challenge_rejected' }), { status: 'verification_locked' }],
    ['expired challenge', expectation('expired', { closedReason: 'challenge_expired' }), { status: 'verification_expired' }],
    ['CIA expired outcome', expectation('expired', { ciaOutcome: 'expired', closedReason: 'challenge_expired' }), { status: 'verification_expired' }],
    ['TTL exhausted while the CIA was unavailable', expectation('expired', { closedReason: 'confirm_unavailable' }), { status: 'verification_unavailable' }],
    ['a refused confirm', expectation('cancelled', { closedReason: 'confirm_identity_unauthorized' }), { status: 'verification_unavailable' }],
    ['a refused start', expectation('cancelled', { verificationId: null, challengeExpiresAt: null, closedReason: 'start_rate_limited' }), { status: 'verification_unavailable' }],
    ['superseded', expectation('cancelled', { closedReason: 'superseded' }), { status: 'none' }],
    ['binding no longer current', expectation('cancelled', { closedReason: 'binding_not_current' }), { status: 'none' }],
  ])('%s', (_name, record, expected) => {
    expect(map(record)).toEqual(expected);
  });

  it('a withheld number under a live challenge asks for only the code (code_needed)', () => {
    expect(map(expectation('awaiting_code'), true)).toEqual({ status: 'code_needed' });
    expect(map(expectation('awaiting_code', { ciaOutcome: 'invalid_code', attemptsRemaining: 2 }), true)).toEqual({ status: 'code_needed' });
  });
});

describe('onboarding_required (AT-ONB-04, AT-ONB-05)', () => {
  it('is produced ONLY by a recorded no_eligible_account', () => {
    const producers: string[] = [];
    const states: ExpectationState[] = ['created', 'awaiting_code', 'processing', 'confirmed', 'rejected', 'expired', 'cancelled'];
    const outcomes: (CiaConfirmOutcome | null)[] = [null, 'linked', 'no_eligible_account', 'ineligible_account', 'ambiguous', 'conflicted', 'invalid_code', 'expired', 'locked'];
    for (const state of states) for (const ciaOutcome of outcomes) for (const codeNeeded of [false, true]) {
      if (map(expectation(state, { ciaOutcome }), codeNeeded).status === 'onboarding_required') producers.push(`${state}/${ciaOutcome}`);
    }
    expect(producers).toEqual(['confirmed/no_eligible_account', 'confirmed/no_eligible_account']);
  });

  it('carries no customerRef, grant, e-mail, verificationId or URL, and is never available while the landing contract is missing (OA-12)', () => {
    const status = map(confirmed('no_eligible_account'));
    expect(status).toEqual({ status: 'onboarding_required', onboarding: { available: false } });
    expect(ONBOARDING_AVAILABLE).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/customerRef|grant|@|Vf0|http|url/i);
  });

  it('ineligible, ambiguous and conflicted never offer onboarding', () => {
    for (const outcome of ['ineligible_account', 'ambiguous', 'conflicted'] as const) expect(map(confirmed(outcome)).status).not.toBe('onboarding_required');
  });
});

describe('the start is governed and deterministic in its command', () => {
  it('OA-05: autonomous by an explicit capability override; any other external communication still needs approval', () => {
    expect(IDENTITY_VERIFICATION_ACTION_POLICY.capabilities).toEqual({ [IDENTITY_VERIFICATION_CAPABILITY_IDS.start]: { autonomy: 'allow' } });
    expect(IDENTITY_VERIFICATION_ACTION_POLICY.riskClasses.EXTERNAL_COMMUNICATION).toEqual({ autonomy: 'require_approval' });
  });

  it('one execution key → one expectation id and one CIA key (replays reuse them); different keys never collide', () => {
    const a = startIdentities('r4x_0123456789abcdef0123456789abcdef');
    expect(startIdentities('r4x_0123456789abcdef0123456789abcdef')).toEqual(a);
    expect(a.startIdempotencyKey).toMatch(/^vs\.[0-9a-f]{64}$/);
    expect(a.expectationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(startIdentities('r4x_fedcba9876543210fedcba9876543210').expectationId).not.toBe(a.expectationId);
  });
});
