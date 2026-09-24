import { z } from 'zod';

/**
 * Cost guard of a shadow suite (R4-H). An experimentation limit, not an
 * agent budget: it never interrupts a model call or a running workload. It
 * is checked before each workload execution starts; once a limit is reached
 * the suite stops cleanly and every remaining execution is recorded as
 * `not_run_due_to_budget`. Token limits use what the provider reported.
 */
export const costGuardSchema = z.strictObject({
  maxModelCalls: z.int().positive(),
  maxInputTokens: z.int().positive().nullable(),
  maxOutputTokens: z.int().positive().nullable(),
  maxCases: z.int().positive(),
  maxRepetitions: z.int().positive(),
});
export type CostGuard = z.infer<typeof costGuardSchema>;

export interface CostUsage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Above these a live plan needs an explicit `allowLarge` (cost awareness, like R4-G's live benchmark). */
export const LARGE_RUN = { repetitions: 3, executions: 60 } as const;

export function assertPlanWithinGuard(plan: { cases: number; repetitions: number; live: boolean; allowLarge: boolean }, guard: CostGuard): void {
  const parsed = costGuardSchema.parse(guard);
  if (plan.cases > parsed.maxCases) throw new Error(`plan has ${plan.cases} cases; the cost guard allows ${parsed.maxCases}`);
  if (plan.repetitions > parsed.maxRepetitions) throw new Error(`plan asks for ${plan.repetitions} repetitions; the cost guard allows ${parsed.maxRepetitions}`);
  if (plan.live && !plan.allowLarge && (plan.repetitions > LARGE_RUN.repetitions || plan.cases * plan.repetitions > LARGE_RUN.executions)) {
    throw new Error(`live plans above ${LARGE_RUN.repetitions} repetitions or ${LARGE_RUN.executions} executions need --allow-large (cost awareness)`);
  }
}

export class CostMeter {
  readonly guard: CostGuard;
  #usage: CostUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };

  constructor(guard: CostGuard) {
    this.guard = costGuardSchema.parse(guard);
  }

  get usage(): CostUsage {
    return this.#usage;
  }

  add(usage: CostUsage): void {
    this.#usage = { modelCalls: this.#usage.modelCalls + usage.modelCalls, inputTokens: this.#usage.inputTokens + usage.inputTokens, outputTokens: this.#usage.outputTokens + usage.outputTokens };
  }

  /** Null when another execution may start; otherwise which limit was reached. */
  exhausted(): string | null {
    const u = this.#usage;
    const g = this.guard;
    if (u.modelCalls >= g.maxModelCalls) return `maxModelCalls ${g.maxModelCalls} reached (${u.modelCalls})`;
    if (g.maxInputTokens !== null && u.inputTokens >= g.maxInputTokens) return `maxInputTokens ${g.maxInputTokens} reached (${u.inputTokens})`;
    if (g.maxOutputTokens !== null && u.outputTokens >= g.maxOutputTokens) return `maxOutputTokens ${g.maxOutputTokens} reached (${u.outputTokens})`;
    return null;
  }
}
