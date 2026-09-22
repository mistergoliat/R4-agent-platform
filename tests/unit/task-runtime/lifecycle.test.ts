import { describe, expect, it } from 'vitest';
import { PlatformError, TASK_STATUSES, type TaskStatus } from '@r4/contracts';
import {
  allowedTaskTransitions,
  assertGoalTransition,
  assertTaskTransition,
  canTransitionTask,
  isTerminalTaskStatus,
} from '@r4/task-runtime';

const REQUIRED_STATUSES = ['pending', 'running', 'waiting', 'blocked', 'requires_approval', 'completed', 'failed', 'cancelled'];

/** The authoritative expected matrix, written independently of the implementation. */
const EXPECTED: Record<TaskStatus, TaskStatus[]> = {
  pending: ['running', 'blocked', 'cancelled', 'failed'],
  running: ['waiting', 'blocked', 'requires_approval', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'blocked', 'cancelled', 'failed'],
  blocked: ['pending', 'running', 'cancelled', 'failed'],
  requires_approval: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

describe('task lifecycle', () => {
  it('supports exactly the required statuses', () => {
    expect([...TASK_STATUSES].sort()).toEqual([...REQUIRED_STATUSES].sort());
  });

  it.each(TASK_STATUSES.flatMap((from) => TASK_STATUSES.map((to) => [from, to] as const)))(
    '%s -> %s matches the lifecycle matrix',
    (from, to) => {
      const expected = EXPECTED[from].includes(to);
      expect(canTransitionTask(from, to)).toBe(expected);
      if (expected) {
        expect(() => assertTaskTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertTaskTransition(from, to)).toThrow(PlatformError);
      }
    },
  );

  it('rejects invalid transitions with a classified error carrying the allowed set', () => {
    try {
      assertTaskTransition('completed', 'running');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      const e = error as PlatformError;
      expect(e.kind).toBe('conflict');
      expect(e.code).toBe('invalid_transition');
      expect(e.details).toEqual({ from: 'completed', to: 'running', allowed: [] });
    }
  });

  it('treats completed, failed and cancelled as terminal with no exits', () => {
    for (const status of TASK_STATUSES) {
      const terminal = ['completed', 'failed', 'cancelled'].includes(status);
      expect(isTerminalTaskStatus(status)).toBe(terminal);
      if (terminal) expect(allowedTaskTransitions(status)).toEqual([]);
    }
  });

  it('never allows self-transitions', () => {
    for (const status of TASK_STATUSES) expect(canTransitionTask(status, status)).toBe(false);
  });

  it('only reaches requires_approval from running (a proposal exists only during execution)', () => {
    const sources = TASK_STATUSES.filter((s) => canTransitionTask(s, 'requires_approval'));
    expect(sources).toEqual(['running']);
  });
});

describe('goal lifecycle', () => {
  it('closes active goals exactly once', () => {
    expect(() => assertGoalTransition('active', 'achieved')).not.toThrow();
    expect(() => assertGoalTransition('active', 'abandoned')).not.toThrow();
    expect(() => assertGoalTransition('active', 'superseded')).not.toThrow();
    expect(() => assertGoalTransition('achieved', 'active')).toThrow(/invalid|cannot/);
    expect(() => assertGoalTransition('abandoned', 'achieved')).toThrow(PlatformError);
  });
});
