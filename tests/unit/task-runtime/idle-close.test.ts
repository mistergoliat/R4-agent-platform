import { describe, expect, it } from 'vitest';
import { idleRefusal, type IdleFacts } from '@r4/task-runtime';
import { ProductionConfigError, loadProductionConfig, productionConfigFingerprint } from '@r4/live-ops';

const DAY = 86_400_000;
const NOW = '2026-11-17T12:00:00.000Z';
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const idle: IdleFacts = {
  status: 'waiting', waitKind: 'WAIT_FOR_INPUT', terminalIntent: false, openHumanRequests: 0, unsettledActions: 0, openDeliveries: 0, approvalPending: false,
  lastActivityAt: ago(DAY + 1), now: NOW, idleForMs: DAY,
};

describe('case idle close: the selection rule (idleRefusal)', () => {
  it('closes a task waiting for input whose newest input is at least the threshold old — not a millisecond before', () => {
    expect(idleRefusal(idle)).toBeNull();
    expect(idleRefusal({ ...idle, lastActivityAt: ago(DAY) })).toBeNull();
    expect(idleRefusal({ ...idle, lastActivityAt: ago(DAY - 1) })).toBe('recent_input');
  });

  it('only a task suspended waiting for input: never one running, pending, blocked (handoff, hold, reconciliation) or on its own timer', () => {
    for (const status of ['pending', 'running', 'blocked', 'requires_approval']) expect(idleRefusal({ ...idle, status })).toBe('not_waiting_for_input');
    for (const waitKind of ['WAIT_UNTIL', 'WAIT_FOR_HUMAN', 'WAIT_FOR_APPROVAL', 'WAIT_FOR_RECONCILIATION', null]) expect(idleRefusal({ ...idle, waitKind })).toBe('not_waiting_for_input');
  });

  it('never while something still needs the task', () => {
    expect(idleRefusal({ ...idle, terminalIntent: true })).toBe('terminal_intent');
    expect(idleRefusal({ ...idle, openHumanRequests: 1 })).toBe('human_request_open');
    expect(idleRefusal({ ...idle, unsettledActions: 1 })).toBe('action_unsettled');
    expect(idleRefusal({ ...idle, openDeliveries: 1 })).toBe('delivery_open');
    expect(idleRefusal({ ...idle, approvalPending: true })).toBe('approval_pending');
  });
});

describe('case idle close: R4_PROD_CASE_IDLE_CLOSE_HOURS', () => {
  const env = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@1', R4_PROD_ROLLOUT_PERCENT: '0',
    R4_PROD_IDENTITY_HASH_KEY: 'k'.repeat(32), R4_PROD_ALLOW_NETWORK: 'false',
  };

  it('is off by default (unset or 0), and off leaves the configuration and its fingerprint unchanged', () => {
    const off = loadProductionConfig(env).config;
    expect(off.caseIdleCloseHours).toBeUndefined();
    expect('caseIdleCloseHours' in off).toBe(false);
    expect(productionConfigFingerprint(loadProductionConfig({ ...env, R4_PROD_CASE_IDLE_CLOSE_HOURS: '0' }).config)).toBe(productionConfigFingerprint(off));
    expect(productionConfigFingerprint(loadProductionConfig({ ...env, R4_PROD_CASE_IDLE_CLOSE_HOURS: '' }).config)).toBe(productionConfigFingerprint(off));
  });

  it('takes whole hours (1–720); anything else refuses to compose production', () => {
    expect(loadProductionConfig({ ...env, R4_PROD_CASE_IDLE_CLOSE_HOURS: '24' }).config.caseIdleCloseHours).toBe(24);
    for (const bad of ['-1', '721', '1.5', 'x']) expect(() => loadProductionConfig({ ...env, R4_PROD_CASE_IDLE_CLOSE_HOURS: bad })).toThrow(ProductionConfigError);
  });
});
