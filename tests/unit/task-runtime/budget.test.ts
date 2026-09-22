import { describe, expect, it } from 'vitest';
import type { PlatformError } from '@r4/contracts';
import { resolveEffectiveBudget } from '@r4/task-runtime';

describe('resolveEffectiveBudget', () => {
  const ceiling = { maxModelCalls: 10, maxTokens: 20_000, maxWrites: 0 };

  it('inherits ceilings for limits the request leaves open', () => {
    expect(resolveEffectiveBudget({}, ceiling)).toEqual(ceiling);
  });

  it('keeps stricter requested limits', () => {
    expect(resolveEffectiveBudget({ maxModelCalls: 3 }, ceiling)).toEqual({ ...ceiling, maxModelCalls: 3 });
  });

  it('keeps requested limits for dimensions the agent does not cap', () => {
    expect(resolveEffectiveBudget({ maxDurationMs: 5_000 }, ceiling)).toEqual({ ...ceiling, maxDurationMs: 5_000 });
  });

  it('refuses requests above the agent ceiling and names every exceeded limit', () => {
    try {
      resolveEffectiveBudget({ maxModelCalls: 11, maxWrites: 1 }, ceiling);
      expect.unreachable();
    } catch (error) {
      const e = error as PlatformError;
      expect(e.code).toBe('budget_exceeds_agent_limit');
      expect(e.kind).toBe('precondition');
      expect(Object.keys(e.details as object)).toEqual(['exceeded']);
      expect(Object.keys((e.details as { exceeded: object }).exceeded).sort()).toEqual(['maxModelCalls', 'maxWrites']);
    }
  });
});
