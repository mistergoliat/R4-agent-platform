import { BUDGET_KEYS, PlatformError, type Budget } from '@r4/contracts';

/**
 * Effective budget = requested limits, bounded by the agent's ceilings. A
 * request may ask for less than the ceiling, never more; any limit the request
 * leaves open inherits the ceiling.
 */
export function resolveEffectiveBudget(requested: Budget, ceiling: Budget): Budget {
  const exceeded = BUDGET_KEYS.filter((key) => {
    const want = requested[key];
    const max = ceiling[key];
    return want !== undefined && max !== undefined && want > max;
  });
  if (exceeded.length > 0) {
    throw new PlatformError('precondition', 'budget_exceeds_agent_limit', `requested budget exceeds agent ceilings: ${exceeded.join(', ')}`, {
      exceeded: Object.fromEntries(exceeded.map((key) => [key, { requested: requested[key], ceiling: ceiling[key] }])),
    });
  }
  const effective: Budget = {};
  for (const key of BUDGET_KEYS) {
    const value = requested[key] ?? ceiling[key];
    if (value !== undefined) effective[key] = value;
  }
  return effective;
}
