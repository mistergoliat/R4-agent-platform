import { describe, expect, it } from 'vitest';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';
import { draftDefinition, type DraftEditable } from '@r4/agent-registry';

/** ADR-054 Decision 2: a draft is a REDUCTION of its registered base. */
const base: AgentDefinition = agentDefinitionSchema.parse({
  schemaVersion: 1, agentId: 'probe', version: 7, displayName: 'Probe', description: 'Base agent', instructions: 'Base instructions',
  taskTypes: ['probe.task'], capabilityScopes: ['things.read', 'things.write'], skills: [],
  modelRequirements: { reasoningLevel: 'low', latencySensitivity: 'medium', costSensitivity: 'high', structuredOutput: true, toolUse: false },
  budgets: { maxDurationMs: 600_000, maxModelCalls: 40, maxCapabilityCalls: 40, maxWrites: 5, maxDelegations: 0 },
});
const edits = (over: Partial<DraftEditable> = {}): DraftEditable => ({
  displayName: 'Probe · canal', description: 'Draft', instructions: 'New instructions',
  capabilityScopes: ['things.read', 'things.write'], budgets: { ...base.budgets } as Record<string, number>, ...over,
});
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe('draftDefinition', () => {
  it('keeps everything that is not editable from the base, for the draft agent id, at version 1', () => {
    const d = draftDefinition(base, 'probe-canal', edits({ capabilityScopes: ['things.read'], budgets: { ...base.budgets, maxModelCalls: 20 } as Record<string, number> }));
    expect(d).toMatchObject({ agentId: 'probe-canal', version: 1, displayName: 'Probe · canal', instructions: 'New instructions', capabilityScopes: ['things.read'], taskTypes: base.taskTypes, modelRequirements: base.modelRequirements });
    expect(d.budgets.maxModelCalls).toBe(20);
  });

  it('refuses anything that would widen the base', () => {
    expect(codeOf(() => draftDefinition(base, 'probe-canal', edits({ capabilityScopes: ['things.read', 'payments.write'] })))).toBe('capability_not_in_base');
    expect(codeOf(() => draftDefinition(base, 'probe-canal', edits({ budgets: { ...base.budgets, maxModelCalls: 41 } as Record<string, number> })))).toBe('budget_above_base');
    expect(codeOf(() => draftDefinition({ ...base, budgets: { maxModelCalls: 40 } }, 'probe-canal', edits({ budgets: { maxModelCalls: 10, maxWrites: 1 } })))).toBe('budget_not_in_base');
    const { maxWrites: _dropped, ...withoutWrites } = base.budgets;
    expect(codeOf(() => draftDefinition(base, 'probe-canal', edits({ budgets: withoutWrites as Record<string, number> })))).toBe('budget_removed');
  });

  it('refuses an invalid definition (bad id, empty instructions, unknown budget key)', () => {
    expect(codeOf(() => draftDefinition(base, 'Probe Canal', edits()))).toBe('invalid_definition');
    expect(codeOf(() => draftDefinition(base, 'probe-canal', edits({ instructions: '' })))).toBe('invalid_definition');
    expect(codeOf(() => draftDefinition(base, 'probe-canal', edits({ budgets: { ...base.budgets, maxEverything: 1 } as Record<string, number> })))).toBe('invalid_definition');
  });
});
