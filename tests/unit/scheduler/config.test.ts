import { describe, expect, it } from 'vitest';
import { loadSchedulerConfig } from '@r4/scheduler';

const BASE = { R4_DATABASE_URL: 'postgres://u:p@localhost:5432/r4' };
const POLICY = { R4_RECONCILIATION_MAX_ATTEMPTS: '5', R4_RECONCILIATION_INITIAL_BACKOFF_MS: '1000', R4_RECONCILIATION_MAX_BACKOFF_MS: '60000', R4_RECONCILIATION_DEADLINE_MS: '86400000' };

describe('scheduler configuration (R4-E)', () => {
  it('has no implicit reconciliation policy: every value must be configured explicitly', () => {
    expect(() => loadSchedulerConfig(BASE)).toThrow(/R4_RECONCILIATION_MAX_ATTEMPTS/);
    for (const missing of Object.keys(POLICY)) {
      const env: Record<string, string> = { ...BASE, ...POLICY };
      delete env[missing];
      expect(() => loadSchedulerConfig(env), missing).toThrow(new RegExp(missing));
    }
  });

  it('loads an explicit policy; lease/poll pacing have operational defaults', () => {
    const config = loadSchedulerConfig({ ...BASE, ...POLICY, R4_SCHEDULER_ID: 'scheduler-1' });
    expect(config).toMatchObject({ owner: 'scheduler-1', leaseMs: 30_000, pollMs: 1_000, reconciliationPolicy: { maxAttempts: 5, initialBackoffMs: 1_000, maxBackoffMs: 60_000, deadlineMs: 86_400_000 } });
  });

  it('refuses an incoherent policy or owner', () => {
    expect(() => loadSchedulerConfig({ ...BASE, ...POLICY, R4_RECONCILIATION_MAX_BACKOFF_MS: '10' })).toThrow(/maximum backoff/);
    expect(() => loadSchedulerConfig({ ...BASE, ...POLICY, R4_RECONCILIATION_MAX_ATTEMPTS: '0' })).toThrow();
    expect(() => loadSchedulerConfig({ ...BASE, ...POLICY, R4_SCHEDULER_ID: 'bad id!' })).toThrow();
  });
});
