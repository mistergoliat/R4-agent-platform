import { describe, expect, it } from 'vitest';
import { assertBuildRef, executionReadinessStatus, workerCompatibility, type WorkerPresenceSummary } from '@r4/task-runtime';

const none: WorkerPresenceSummary = { ready: 0, notReady: 0, stopping: 0, incompatible: 0, stale: 0, otherMode: 0, reasons: [], buildRefs: [] };

describe('execution readiness status (R4-I)', () => {
  it('is ready iff at least one fresh, compatible, ready worker exists — whatever else is present', () => {
    expect(executionReadinessStatus({ ...none, ready: 1, notReady: 2, stopping: 1, incompatible: 3, stale: 4, otherMode: 5 })).toBe('ready');
  });

  it.each([
    ['no row at all', none, 'no_worker'],
    ['only other execution modes (shadow/test)', { ...none, otherMode: 3 }, 'no_worker'],
    ['only expired rows', { ...none, stale: 2 }, 'stale'],
    ['only another execution contract', { ...none, incompatible: 1, stale: 1 }, 'incompatible'],
    ['only stopping', { ...none, stopping: 1, incompatible: 1 }, 'stopping'],
    ['a compatible worker reporting not_ready', { ...none, notReady: 1, stopping: 1 }, 'not_ready'],
  ] as const)('is NOT ready with %s', (_name, summary, status) => {
    expect(executionReadinessStatus(summary)).toBe(status);
  });
});

describe('worker compatibility', () => {
  it('is only the schema head and the runtime profile version', () => {
    expect(workerCompatibility('0008_worker_presence', 'sales-production@1')).toBe('0008_worker_presence:sales-production@1');
  });

  it.each([['whitespace', 'a b'], ['a URL', 'postgres://u:p@h/db'], ['empty', '']])('refuses %s', (_name, profile) => {
    expect(() => workerCompatibility(profile === '' ? '' : '0008', profile)).toThrow();
  });

  it('build refs are optional, bounded and log-safe', () => {
    expect(assertBuildRef(null)).toBeNull();
    expect(assertBuildRef('git-0123abc')).toBe('git-0123abc');
    expect(() => assertBuildRef('x'.repeat(65))).toThrow();
    expect(() => assertBuildRef('sha with spaces')).toThrow();
  });
});
