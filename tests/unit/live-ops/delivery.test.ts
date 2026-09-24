import { describe, expect, it } from 'vitest';
import {
  CANCEL_REASONS,
  CONTROLS_UNAVAILABLE,
  AutonomyControls,
  DISPATCH_HOLD_REASONS,
  decideDispatch,
  dispositionAfterSubmission,
  statusAfterEvidence,
  statusAfterOperatorResolution,
  type DispatchFacts,
  type OutboundStatus,
  type ProductionStore,
  type SubmissionResult,
} from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';

const NOW = '2026-09-24T12:00:00.000Z';
const facts = (over: Partial<DispatchFacts> = {}): DispatchFacts => ({
  origin: 'agent', channel: 'chat', createdAt: '2026-09-24T11:59:30.000Z', now: NOW,
  controls: { globalEnabled: true, channels: {}, version: 'v' },
  binding: { status: 'open', autonomous: true, deniedNow: false },
  task: { status: 'waiting', humanOwned: false },
  supersededByNewerInput: false, windowOpen: true, ...over,
});
const policy = { maxAgeMs: 10 * 60_000 };

describe('delivery gate', () => {
  it('dispatches agent output only when every condition holds', () => {
    expect(decideDispatch(facts(), policy)).toEqual({ kind: 'dispatch' });
  });

  it('kill switch / deny / rollout HOLD (never cancel, never send)', () => {
    expect(decideDispatch(facts({ controls: { globalEnabled: false, channels: {}, version: 'v' } }), policy)).toEqual({ kind: 'hold', reason: DISPATCH_HOLD_REASONS.killSwitch });
    expect(decideDispatch(facts({ binding: { status: 'open', autonomous: true, deniedNow: true } }), policy)).toEqual({ kind: 'hold', reason: DISPATCH_HOLD_REASONS.denied });
    expect(decideDispatch(facts({ binding: { status: 'open', autonomous: false, deniedNow: false } }), policy)).toEqual({ kind: 'hold', reason: DISPATCH_HOLD_REASONS.rolloutExcluded });
  });

  it('human ownership supersedes pending agent output (ported CRM semantics)', () => {
    expect(decideDispatch(facts({ task: { status: 'blocked', humanOwned: true } }), policy)).toEqual({ kind: 'cancel', reason: CANCEL_REASONS.supersededByOperator });
  });

  it('a newer customer input supersedes a pending agent response (causal, not clock based)', () => {
    expect(decideDispatch(facts({ supersededByNewerInput: true }), policy)).toEqual({ kind: 'cancel', reason: CANCEL_REASONS.supersededByNewerInput });
  });

  it('terminal task, stale output and a closed channel window cancel', () => {
    expect(decideDispatch(facts({ task: { status: 'cancelled', humanOwned: false } }), policy)).toMatchObject({ kind: 'cancel', reason: CANCEL_REASONS.taskTerminal });
    expect(decideDispatch(facts({ createdAt: '2026-09-24T10:00:00.000Z' }), policy)).toMatchObject({ kind: 'cancel', reason: CANCEL_REASONS.expired });
    expect(decideDispatch(facts({ windowOpen: false }), policy)).toMatchObject({ kind: 'cancel', reason: CANCEL_REASONS.windowClosed });
  });

  it('operator output is a human act: autonomy controls, ownership and staleness do not apply; the window does', () => {
    const blocked = facts({ origin: 'operator', controls: { globalEnabled: false, channels: {}, version: 'v' }, task: { status: 'blocked', humanOwned: true }, supersededByNewerInput: true, binding: { status: 'open', autonomous: false, deniedNow: true } });
    expect(decideDispatch(blocked, policy)).toEqual({ kind: 'dispatch' });
    expect(decideDispatch({ ...blocked, windowOpen: false }, policy)).toMatchObject({ kind: 'cancel', reason: CANCEL_REASONS.windowClosed });
  });
});

const result = (over: Partial<SubmissionResult>): SubmissionResult => ({ outcome: 'accepted', providerMessageId: 'p1', httpStatus: 200, errorClass: null, errorCode: null, retryAfterMs: null, latencyMs: 5, ...over });

describe('after a submission', () => {
  it('unknown is never retried; only definitely-not-sent is, within a bounded budget', () => {
    expect(dispositionAfterSubmission(result({}), 1, { maxAttempts: 3 })).toEqual({ status: 'accepted' });
    expect(dispositionAfterSubmission(result({ providerMessageId: null }), 1, { maxAttempts: 3 })).toEqual({ status: 'unknown' });
    expect(dispositionAfterSubmission(result({ outcome: 'unknown' }), 1, { maxAttempts: 3 })).toEqual({ status: 'unknown' });
    expect(dispositionAfterSubmission(result({ outcome: 'rejected' }), 1, { maxAttempts: 3 })).toEqual({ status: 'failed' });
    expect(dispositionAfterSubmission(result({ outcome: 'not_sent', retryAfterMs: 2000 }), 1, { maxAttempts: 3 })).toEqual({ status: 'pending', retryInMs: 2000 });
    expect(dispositionAfterSubmission(result({ outcome: 'not_sent' }), 3, { maxAttempts: 3 })).toEqual({ status: 'failed' });
  });
});

describe('provider evidence is monotonic', () => {
  const cases: [OutboundStatus, 'accepted' | 'delivered' | 'read' | 'failed', OutboundStatus | null][] = [
    ['accepted', 'delivered', 'delivered'],
    ['delivered', 'read', 'read'],
    ['delivered', 'accepted', null],
    ['read', 'delivered', null],
    ['delivered', 'failed', null],
    ['accepted', 'failed', 'failed'],
    ['unknown', 'accepted', 'accepted'],
    ['unknown', 'delivered', 'delivered'],
    ['unknown', 'failed', 'failed'],
    ['failed', 'delivered', 'delivered'],
    ['cancelled', 'delivered', null],
    ['pending', 'accepted', null],
    ['accepted', 'accepted', null],
  ];
  it.each(cases)('%s + %s evidence → %s', (from, evidence, to) => {
    expect(statusAfterEvidence(from, evidence)).toBe(to);
  });

  it('operators settle only unknown outcomes', () => {
    expect(statusAfterOperatorResolution('unknown', 'delivered')).toBe('delivered');
    expect(statusAfterOperatorResolution('accepted', 'failed')).toBeNull();
  });
});

describe('autonomy controls fail closed', () => {
  it('unreadable controls mean disabled; worker admission refuses', async () => {
    const broken = { readControls: () => Promise.reject(new Error('db down')) } as unknown as ProductionStore;
    const controls = new AutonomyControls({ store: broken, logger: createSilentLogger() });
    expect(await controls.state()).toBe(CONTROLS_UNAVAILABLE);
    expect(await controls.admit()).toEqual({ admitted: false, reason: 'autonomy_controls_unavailable' });
  });

  it('a disabled global control refuses admission', async () => {
    const store = { readControls: () => Promise.resolve({ state: { globalEnabled: false, channels: {}, version: 'global:1' }, records: [] }) } as unknown as ProductionStore;
    expect(await new AutonomyControls({ store, logger: createSilentLogger() }).admit()).toEqual({ admitted: false, reason: 'autonomy_disabled' });
  });
});
