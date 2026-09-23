import { z } from 'zod';
import {
  UNBOUNDED_CONTEXT_BUDGET,
  contextBudgetPolicySchema,
  contextItemKindSchema,
  fingerprint,
  positiveIntSchema,
  uniqueArray,
  type ContextItemKind,
} from '@r4/contracts';

/** Semantic version of the compiler's selection/rendering rules. Part of every snapshot. */
export const CONTEXT_COMPILER_VERSION = '1.0.0';

/**
 * Context compilation policy: operator configuration, never constants in the
 * compiler. Selection is deterministic and governed entirely by this object;
 * no model decides what enters the context.
 */
export const contextCompilationPolicySchema = z
  .strictObject({
    /**
     * R4's own budget (ADR-015). Default `unbounded`: no artificial limit, so
     * nothing is excluded or compacted for budget. `fixed` enables bounded
     * selection, budget-driven compaction and `budget_exhausted`.
     */
    budget: contextBudgetPolicySchema.default(UNBOUNDED_CONTEXT_BUDGET),
    /** Kinds that are always included (never dropped for budget). Sources may also mark single items required. */
    requiredKinds: uniqueArray(contextItemKindSchema).default(['agent_definition', 'task', 'execution_constraints', 'goal', 'capability']),
    /**
     * Priority order of the remaining kinds, highest first. A kind that is
     * neither required nor listed is excluded with reason `policy`.
     */
    selectionOrder: uniqueArray(contextItemKindSchema).default(['state', 'observation', 'conversation_turn', 'working_note', 'episode', 'derived_summary']),
    /** Optional caps per kind (a selection policy, reason `policy`), so that one kind cannot starve the ones after it. */
    kindLimits: z.partialRecord(contextItemKindSchema, z.strictObject({ maxItems: positiveIntSchema.optional(), maxTokens: positiveIntSchema.optional() })).default({}),
    /** A point-in-time item of this kind is `stale` once this long has passed since `observedAt`. */
    staleAfterMs: z.partialRecord(contextItemKindSchema, positiveIntSchema).default({}),
    /** Expired AUTHORITATIVE/OBSERVED items: keep them as history (lowest priority) or drop them. */
    expiredEvidence: z.enum(['include', 'exclude']).default('include'),
    conversation: z
      .strictObject({
        /**
         * Most recent turns kept raw when the conversation must be compacted.
         * Compaction only happens under a `fixed` budget that the conversation
         * does not fit (never in `unbounded` mode).
         */
        recentTurns: positiveIntSchema.default(20),
        compaction: z
          .strictObject({
            enabled: z.boolean().default(true),
            /**
             * The compacted prefix grows in whole chunks, so a summary is not
             * recomputed on every new turn.
             */
            chunkTurns: positiveIntSchema.default(10),
          })
          .default({ enabled: true, chunkTurns: 10 }),
      })
      .default({ recentTurns: 20, compaction: { enabled: true, chunkTurns: 10 } }),
  })
  .superRefine((policy, ctx) => {
    const overlap = policy.selectionOrder.filter((kind) => policy.requiredKinds.includes(kind));
    if (overlap.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['selectionOrder'], message: `kinds cannot be both required and selectable: ${overlap.join(', ')}` });
    }
  });
export type ContextCompilationPolicyInput = z.input<typeof contextCompilationPolicySchema>;
export type ContextCompilationPolicy = z.output<typeof contextCompilationPolicySchema>;

/** The policy's version is its content: any change to the effective policy yields a new version. */
export function policyVersionOf(policy: ContextCompilationPolicy): string {
  return fingerprint(policy);
}

export function isRequiredKind(policy: ContextCompilationPolicy, kind: ContextItemKind): boolean {
  return policy.requiredKinds.includes(kind);
}
