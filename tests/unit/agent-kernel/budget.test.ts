import { describe, expect, it } from 'vitest';
import {
  assertExecutionPolicy,
  budgetTerminationCode,
  checkBeforeModelCall,
  checkBeforeRead,
  modelCallTimeout,
  resolveExecutionLimits,
  type ExecutionUsage,
} from '@r4/agent-kernel';
import { reasonCodeSchema } from '@r4/contracts';
import { TEST_POLICY } from '../../support/kernel-fixtures.js';

const fresh: ExecutionUsage = { iterations: 0, modelCalls: 0, readCapabilityCalls: 0, tokens: 0, elapsedMs: 0 };

describe('budget controller', () => {
  it('uses policy ceilings when the task declares nothing', () => {
    expect(resolveExecutionLimits(TEST_POLICY, {})).toEqual({
      maxIterations: 20,
      maxModelCalls: 20,
      maxReadCapabilityCalls: 20,
      maxRunDurationMs: 60_000,
      maxTokens: null,
      modelCallTimeoutMs: 5_000,
    });
  });

  it('lets the task budget tighten, never loosen, the policy', () => {
    const limits = resolveExecutionLimits(TEST_POLICY, { maxModelCalls: 3, maxCapabilityCalls: 500, maxDurationMs: 1_000, maxTokens: 900 });
    expect(limits).toMatchObject({ maxModelCalls: 3, maxReadCapabilityCalls: 20, maxRunDurationMs: 1_000, maxTokens: 900 });
  });

  it('allows a model call while every dimension has room', () => {
    expect(checkBeforeModelCall(resolveExecutionLimits(TEST_POLICY, {}), fresh)).toBeNull();
  });

  it.each([
    ['maxRunDurationMs', { elapsedMs: 60_000 }],
    ['maxIterations', { iterations: 20 }],
    ['maxModelCalls', { modelCalls: 20 }],
  ] as const)('stops at %s', (dimension, usage) => {
    expect(checkBeforeModelCall(resolveExecutionLimits(TEST_POLICY, {}), { ...fresh, ...usage })).toMatchObject({ dimension });
  });

  it('enforces maxTokens only when the task declares it', () => {
    expect(checkBeforeModelCall(resolveExecutionLimits(TEST_POLICY, {}), { ...fresh, tokens: 10_000_000 })).toBeNull();
    expect(checkBeforeModelCall(resolveExecutionLimits(TEST_POLICY, { maxTokens: 100 }), { ...fresh, tokens: 100 })).toEqual({ dimension: 'maxTokens', limit: 100, used: 100 });
  });

  it('reports a deterministic dimension when several are exhausted', () => {
    const all = { iterations: 99, modelCalls: 99, readCapabilityCalls: 99, tokens: 99, elapsedMs: 999_999 };
    expect(checkBeforeModelCall(resolveExecutionLimits(TEST_POLICY, {}), all)?.dimension).toBe('maxRunDurationMs');
  });

  it('checks READ budget separately', () => {
    const limits = resolveExecutionLimits(TEST_POLICY, { maxCapabilityCalls: 2 });
    expect(checkBeforeRead(limits, { ...fresh, readCapabilityCalls: 1 })).toBeNull();
    expect(checkBeforeRead(limits, { ...fresh, readCapabilityCalls: 2 })).toEqual({ dimension: 'maxReadCapabilityCalls', limit: 2, used: 2 });
  });

  it('caps the model call timeout by the remaining run time', () => {
    const limits = resolveExecutionLimits(TEST_POLICY, {});
    expect(modelCallTimeout(limits, fresh)).toBe(5_000);
    expect(modelCallTimeout(limits, { ...fresh, elapsedMs: 59_000 })).toBe(1_000);
    expect(modelCallTimeout(limits, { ...fresh, elapsedMs: 70_000 })).toBe(1);
  });

  it('produces reason codes valid for the termination contract', () => {
    const dimensions = ['maxIterations', 'maxModelCalls', 'maxReadCapabilityCalls', 'maxRunDurationMs', 'maxTokens'] as const;
    expect(dimensions.map(budgetTerminationCode)).toEqual(['max_iterations', 'max_model_calls', 'max_read_capability_calls', 'max_run_duration_ms', 'max_tokens']);
    for (const d of dimensions) expect(reasonCodeSchema.safeParse(budgetTerminationCode(d)).success).toBe(true);
  });

  it('validates the execution policy', () => {
    expect(() => assertExecutionPolicy(TEST_POLICY)).not.toThrow();
    expect(() => assertExecutionPolicy({ ...TEST_POLICY, maxIterations: 0 })).toThrow(/maxIterations/);
    expect(() => assertExecutionPolicy({ ...TEST_POLICY, modelCallTimeoutMs: 1.5 })).toThrow(/modelCallTimeoutMs/);
    expect(() => assertExecutionPolicy({ ...TEST_POLICY, maxReadCapabilityCalls: 0 })).not.toThrow();
  });
});
