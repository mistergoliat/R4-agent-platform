import { BUDGET_KEYS, PlatformError, agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';

/**
 * ADR-054: an agent draft derived from a registered base definition. A draft never runs in production and is never
 * registered; this is the rule that keeps it a REDUCTION of its base (Decision 2):
 *   - it is a valid definition for the draft's own agent id;
 *   - its capability scopes, task types and skills are subsets of the base's;
 *   - every budget is present in the base and not above it;
 *   - model requirements, context and delegation policy, and evaluation profile are the base's, unchanged.
 * Only the display name, description and instructions are free text, and they are the operator's (never a model's).
 */
export interface DraftEditable {
  readonly displayName: string;
  readonly description: string;
  readonly instructions: string;
  readonly capabilityScopes: readonly string[];
  readonly budgets: Readonly<Record<string, number>>;
}

/** The draft definition: the base with the operator's edits, checked. `version` is 1 until a launch assigns one. */
export function draftDefinition(base: AgentDefinition, agentId: string, edits: DraftEditable): AgentDefinition {
  // Only the definition's own fields: a registered base also carries contentHash and registeredAt.
  const fields = Object.fromEntries(Object.keys(agentDefinitionSchema.shape).map((k) => [k, (base as Record<string, unknown>)[k]]));
  const parsed = agentDefinitionSchema.safeParse({
    ...fields,
    agentId,
    version: 1,
    displayName: edits.displayName,
    description: edits.description,
    instructions: edits.instructions,
    capabilityScopes: [...edits.capabilityScopes],
    budgets: { ...edits.budgets },
  });
  if (!parsed.success) throw refused('invalid_definition', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const draft = parsed.data;
  const extra = draft.capabilityScopes.filter((s) => !base.capabilityScopes.includes(s));
  if (extra.length) throw refused('capability_not_in_base', `a draft can only remove capabilities of its base; not in the base: ${extra.join(', ')}`);
  for (const key of Object.keys(draft.budgets) as (typeof BUDGET_KEYS)[number][]) {
    const limit = base.budgets[key];
    const value = draft.budgets[key];
    if (value === undefined) continue;
    if (limit === undefined) throw refused('budget_not_in_base', `the base has no ${key} budget`);
    if (value > limit) throw refused('budget_above_base', `${key} ${value} is above the base's ${limit}`);
  }
  for (const key of Object.keys(base.budgets) as (typeof BUDGET_KEYS)[number][]) {
    if (draft.budgets[key] === undefined) throw refused('budget_removed', `${key} must stay (at most the base's ${base.budgets[key]})`);
  }
  return draft;
}

function refused(code: string, message: string): PlatformError {
  return new PlatformError('validation', code, message);
}
