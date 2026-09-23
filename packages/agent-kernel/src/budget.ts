import { PlatformError, type Budget } from '@r4/contracts';

/**
 * Execution policy: operator configuration (worker), never constants in the
 * kernel. These are safety ceilings that stop runaway loops; the task's own
 * budget (clamped by its agent's ceilings at creation) may only tighten them.
 */
export interface ExecutionPolicy {
  readonly maxIterations: number;
  readonly maxModelCalls: number;
  readonly maxReadCapabilityCalls: number;
  readonly maxRunDurationMs: number;
  /** Upper bound for one model call; also capped by the remaining run duration. */
  readonly modelCallTimeoutMs: number;
}

/** The limits one run executes under. */
export interface ExecutionLimits {
  readonly maxIterations: number;
  readonly maxModelCalls: number;
  readonly maxReadCapabilityCalls: number;
  readonly maxRunDurationMs: number;
  /** From the task budget only; null when the task declares none. */
  readonly maxTokens: number | null;
  readonly modelCallTimeoutMs: number;
}

/** Consumption so far, derived from the durable step log — never from process memory. */
export interface ExecutionUsage {
  readonly iterations: number;
  readonly modelCalls: number;
  readonly readCapabilityCalls: number;
  readonly tokens: number;
  readonly elapsedMs: number;
}

export type BudgetDimension =
  | 'maxIterations'
  | 'maxModelCalls'
  | 'maxReadCapabilityCalls'
  | 'maxRunDurationMs'
  | 'maxTokens'
  /** R4-C2: the context the policy requires does not fit the context budget. */
  | 'maxContextTokens';

/** Stable, machine-readable termination code for a dimension (snake_case). */
export function budgetTerminationCode(dimension: BudgetDimension): string {
  return dimension.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export interface BudgetExhaustion {
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly used: number;
}

export function assertExecutionPolicy(policy: ExecutionPolicy): void {
  const entries: [keyof ExecutionPolicy, number, number][] = [
    ['maxIterations', policy.maxIterations, 1],
    ['maxModelCalls', policy.maxModelCalls, 1],
    ['maxReadCapabilityCalls', policy.maxReadCapabilityCalls, 0],
    ['maxRunDurationMs', policy.maxRunDurationMs, 1],
    ['modelCallTimeoutMs', policy.modelCallTimeoutMs, 1],
  ];
  for (const [name, value, min] of entries) {
    if (!Number.isInteger(value) || value < min) {
      throw new PlatformError('validation', 'invalid_execution_policy', `${name} must be an integer >= ${min}`);
    }
  }
}

/** Policy ceilings, tightened by whatever the task budget declares. */
export function resolveExecutionLimits(policy: ExecutionPolicy, taskBudget: Budget): ExecutionLimits {
  return {
    maxIterations: policy.maxIterations,
    maxModelCalls: tighter(policy.maxModelCalls, taskBudget.maxModelCalls),
    maxReadCapabilityCalls: tighter(policy.maxReadCapabilityCalls, taskBudget.maxCapabilityCalls),
    maxRunDurationMs: tighter(policy.maxRunDurationMs, taskBudget.maxDurationMs),
    maxTokens: taskBudget.maxTokens ?? null,
    modelCallTimeoutMs: policy.modelCallTimeoutMs,
  };
}

function tighter(ceiling: number, requested: number | undefined): number {
  return requested === undefined ? ceiling : Math.min(ceiling, requested);
}

/** Checked before every model call. Order is fixed so the reported dimension is deterministic. */
export function checkBeforeModelCall(limits: ExecutionLimits, usage: ExecutionUsage): BudgetExhaustion | null {
  if (usage.elapsedMs >= limits.maxRunDurationMs) return { dimension: 'maxRunDurationMs', limit: limits.maxRunDurationMs, used: usage.elapsedMs };
  if (usage.iterations >= limits.maxIterations) return { dimension: 'maxIterations', limit: limits.maxIterations, used: usage.iterations };
  if (usage.modelCalls >= limits.maxModelCalls) return { dimension: 'maxModelCalls', limit: limits.maxModelCalls, used: usage.modelCalls };
  if (limits.maxTokens !== null && usage.tokens >= limits.maxTokens) return { dimension: 'maxTokens', limit: limits.maxTokens, used: usage.tokens };
  return null;
}

/** Checked before executing a READ the model asked for. */
export function checkBeforeRead(limits: ExecutionLimits, usage: ExecutionUsage): BudgetExhaustion | null {
  if (usage.readCapabilityCalls >= limits.maxReadCapabilityCalls) {
    return { dimension: 'maxReadCapabilityCalls', limit: limits.maxReadCapabilityCalls, used: usage.readCapabilityCalls };
  }
  return null;
}

/** Timeout for the next model call: the policy bound, never beyond the run's remaining time. */
export function modelCallTimeout(limits: ExecutionLimits, usage: ExecutionUsage): number {
  return Math.max(1, Math.min(limits.modelCallTimeoutMs, limits.maxRunDurationMs - usage.elapsedMs));
}
