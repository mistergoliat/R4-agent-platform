import { describe, expect, it } from 'vitest';
import {
  AUTHORITIES_BY_KIND,
  CONTEXT_ITEM_KINDS,
  MEMORY_AUTHORITY,
  MEMORY_ITEM_KIND,
  MEMORY_TYPES,
  compiledContextSchema,
  contextContributionSchema,
  contextItemDecisionSchema,
  memoryEntrySchema,
  type CompiledContext,
} from '@r4/contracts';
import { FixtureMemory, T0, TASK, at, compiler, request, stateItem, staticSource } from '../../fixtures/context/builders.js';

const base = {
  itemId: 'state:record:1.status',
  kind: 'state',
  authority: 'AUTHORITATIVE',
  temporality: 'live',
  content: { value: 'A' },
  provenance: { recordType: 'fixture_record', recordId: 'record:1' },
  createdAt: T0,
} as const;

describe('ContextItem contract', () => {
  it('accepts a minimal item and fills explicit defaults', () => {
    expect(contextContributionSchema.parse(base)).toMatchObject({
      assertions: [],
      observedAt: null,
      validUntil: null,
      sensitivity: 'NORMAL',
      taskId: null,
      required: false,
      supersedes: [],
      provenance: { recordVersion: null, derivedFrom: [], producedBy: null },
    });
  });

  it('is strict: unknown fields are rejected, not dropped', () => {
    expect(contextContributionSchema.safeParse({ ...base, priority: 5 }).success).toBe(false);
    expect(contextContributionSchema.safeParse({ ...base, provenance: { ...base.provenance, extra: 1 } }).success).toBe(false);
  });

  it('rejects malformed ids and point-in-time items without observedAt', () => {
    expect(contextContributionSchema.safeParse({ ...base, itemId: 'no-namespace' }).success).toBe(false);
    expect(contextContributionSchema.safeParse({ ...base, temporality: 'point_in_time' }).success).toBe(false);
    expect(contextContributionSchema.safeParse({ ...base, supersedes: [base.itemId] }).success).toBe(false);
  });

  it.each(CONTEXT_ITEM_KINDS)('enforces the authority allowed for kind %s', (kind) => {
    for (const authority of ['AUTHORITATIVE', 'OBSERVED', 'CONVERSATIONAL', 'DERIVED', 'COGNITIVE'] as const) {
      const item = {
        ...base,
        kind,
        authority,
        temporality: 'point_in_time',
        observedAt: T0,
        provenance: { ...base.provenance, derivedFrom: ['memory:x'], producedBy: 'compactor@1' },
      };
      expect(contextContributionSchema.safeParse(item).success, `${kind}/${authority}`).toBe(AUTHORITIES_BY_KIND[kind].includes(authority));
    }
  });

  it('never allows a derived summary, a conversation turn or a working note to be AUTHORITATIVE', () => {
    for (const kind of ['derived_summary', 'conversation_turn', 'working_note', 'episode', 'observation'] as const) {
      expect(AUTHORITIES_BY_KIND[kind]).not.toContain('AUTHORITATIVE');
    }
  });

  it('requires a derived item to record its derivation and producer', () => {
    const summary = { ...base, itemId: 'summary:x', kind: 'derived_summary', authority: 'DERIVED', temporality: 'point_in_time', observedAt: T0 };
    expect(contextContributionSchema.safeParse(summary).success).toBe(false);
    expect(contextContributionSchema.safeParse({ ...summary, provenance: { ...base.provenance, derivedFrom: ['memory:a'], producedBy: 'c@1' } }).success).toBe(true);
  });
});

describe('memory contract', () => {
  const entry = {
    entryId: '0190e7a1-0000-7000-8000-000000000001',
    taskId: TASK.taskId,
    occurredAt: T0,
    recordedAt: T0,
    recordedBy: { kind: 'service', ref: 'x' },
    correlationId: 'c',
  } as const;

  it('has four types, each with a fixed kind and a non-authoritative authority', () => {
    expect([...MEMORY_TYPES]).toEqual(['WORKING', 'CONVERSATIONAL', 'EPISODIC', 'DERIVED_SUMMARY']);
    for (const type of MEMORY_TYPES) {
      expect(MEMORY_AUTHORITY[type]).not.toBe('AUTHORITATIVE');
      expect(AUTHORITIES_BY_KIND[MEMORY_ITEM_KIND[type]]).toContain(MEMORY_AUTHORITY[type]);
    }
  });

  it('validates the content of each type strictly', () => {
    expect(memoryEntrySchema.safeParse({ ...entry, memoryType: 'WORKING', content: { category: 'hypothesis', text: 'h' } }).success).toBe(true);
    expect(memoryEntrySchema.safeParse({ ...entry, memoryType: 'WORKING', content: { category: 'chain_of_thought', text: 'h' } }).success).toBe(false);
    expect(memoryEntrySchema.safeParse({ ...entry, memoryType: 'WORKING', content: { category: 'note', text: 'x'.repeat(2001) } }).success).toBe(false);
    expect(memoryEntrySchema.safeParse({ ...entry, memoryType: 'CONVERSATIONAL', content: { actor: { role: 'requester', ref: 'p' }, text: 'hi', interactionRef: 'i' } }).success).toBe(true);
    expect(memoryEntrySchema.safeParse({ ...entry, memoryType: 'EPISODIC', content: { event: 'task_resumed', text: 'resumed' } }).success).toBe(true);
  });

  it('cannot store a SECRET, and cannot claim authority', () => {
    expect(memoryEntrySchema.safeParse({ ...entry, sensitivity: 'SECRET', memoryType: 'WORKING', content: { category: 'note', text: 'k' } }).success).toBe(false);
    expect(memoryEntrySchema.safeParse({ ...entry, authority: 'AUTHORITATIVE', memoryType: 'WORKING', content: { category: 'note', text: 'k' } }).success).toBe(false);
  });

  it('requires a full derivation for a derived summary', () => {
    const summary = { ...entry, memoryType: 'DERIVED_SUMMARY', content: { text: 's', derivation: { derivationKey: 'a'.repeat(64), compactorId: 'c', compactorVersion: '1', sourceItemIds: ['memory:1'], fromObservedAt: T0, toObservedAt: at(1) } } };
    expect(memoryEntrySchema.safeParse(summary).success).toBe(true);
    expect(memoryEntrySchema.safeParse({ ...summary, content: { text: 's' } }).success).toBe(false);
    expect(memoryEntrySchema.safeParse({ ...summary, content: { ...summary.content, derivation: { ...summary.content.derivation, sourceItemIds: [] } } }).success).toBe(false);
    expect(memoryEntrySchema.safeParse({ ...summary, content: { ...summary.content, derivation: { ...summary.content.derivation, fromObservedAt: at(5) } } }).success).toBe(false);
  });
});

describe('CompiledContext contract', () => {
  async function compiled(): Promise<CompiledContext> {
    const memory = new FixtureMemory();
    memory.turn(T0, 'hello');
    const outcome = await compiler({ memory, sources: [staticSource('fixture.state', [stateItem('record:1.status', 'A')])] }).compile(request());
    if (outcome.kind !== 'compiled') throw new Error('not compiled');
    return outcome.compiled;
  }

  it('round-trips through its own strict schema', async () => {
    const context = await compiled();
    expect(compiledContextSchema.parse(context)).toEqual(context);
  });

  it('cannot represent a SECRET item', async () => {
    const context = await compiled();
    const item = { ...context.sections.authoritativeState[0]!, sensitivity: 'SECRET' };
    expect(compiledContextSchema.safeParse({ ...context, sections: { ...context.sections, authoritativeState: [item] } }).success).toBe(false);
  });

  it('cannot place a DERIVED or CONVERSATIONAL item among authoritative state', async () => {
    const context = await compiled();
    const turn = context.sections.conversation[0]!;
    expect(compiledContextSchema.safeParse({ ...context, sections: { ...context.sections, authoritativeState: [...context.sections.authoritativeState, turn], conversation: [] } }).success).toBe(false);
    const relabelled = { ...turn, authority: 'AUTHORITATIVE' };
    expect(compiledContextSchema.safeParse({ ...context, sections: { ...context.sections, conversation: [relabelled] } }).success).toBe(false);
  });

  it('cannot present an expired item as current, nor keep non-evidence in history', async () => {
    const context = await compiled();
    const state = context.sections.authoritativeState[0]!;
    expect(compiledContextSchema.safeParse({ ...context, sections: { ...context.sections, authoritativeState: [{ ...state, freshness: 'expired' }] } }).success).toBe(false);
    expect(compiledContextSchema.safeParse({ ...context, sections: { ...context.sections, history: [{ ...context.sections.conversation[0]!, freshness: 'expired' }], conversation: [] } }).success).toBe(false);
  });

  it('only lets an AUTHORITATIVE position prevail in a conflict', async () => {
    const context = await compiled();
    const turn = context.sections.conversation[0]!;
    const state = context.sections.authoritativeState[0]!;
    const conflict = { subject: 'record:1.status', positions: [{ itemId: state.itemId, authority: 'AUTHORITATIVE', value: 'A' }, { itemId: turn.itemId, authority: 'CONVERSATIONAL', value: 'B' }] };
    expect(compiledContextSchema.safeParse({ ...context, conflicts: [{ ...conflict, authoritativeItemId: state.itemId }] }).success).toBe(true);
    expect(compiledContextSchema.safeParse({ ...context, conflicts: [{ ...conflict, authoritativeItemId: turn.itemId }] }).success).toBe(false);
  });

  it('rejects an over-budget context', async () => {
    const context = await compiled();
    // Builders compile under FIXED(8000).
    expect(context.budget.policy).toEqual({ mode: 'fixed', maxEstimatedTokens: 8_000 });
    expect(compiledContextSchema.safeParse({ ...context, budget: { ...context.budget, estimatedTokens: 8_001 } }).success).toBe(false);
    // Unbounded: no R4 limit to exceed.
    expect(compiledContextSchema.safeParse({ ...context, budget: { ...context.budget, policy: { mode: 'unbounded' }, estimatedTokens: 10_000_000 } }).success).toBe(true);
    // A fixed budget always names its limit; an unbounded one never does.
    expect(compiledContextSchema.safeParse({ ...context, budget: { ...context.budget, policy: { mode: 'fixed' } } }).success).toBe(false);
    expect(compiledContextSchema.safeParse({ ...context, budget: { ...context.budget, policy: { mode: 'unbounded', maxEstimatedTokens: 5 } } }).success).toBe(false);
  });

  it('records decisions consistently (included ⇔ section, excluded ⇔ reason)', () => {
    const decision = { itemId: 'memory:x', sourceId: 'platform.memory', kind: 'working_note', authority: 'COGNITIVE', freshness: 'fresh', sensitivity: 'NORMAL', representedBy: null, estimatedTokens: 3 } as const;
    expect(contextItemDecisionSchema.safeParse({ ...decision, decision: 'included', section: 'workingMemory', reason: null }).success).toBe(true);
    expect(contextItemDecisionSchema.safeParse({ ...decision, decision: 'excluded', section: null, reason: 'budget' }).success).toBe(true);
    expect(contextItemDecisionSchema.safeParse({ ...decision, decision: 'included', section: null, reason: null }).success).toBe(false);
    expect(contextItemDecisionSchema.safeParse({ ...decision, decision: 'excluded', section: 'workingMemory', reason: 'budget' }).success).toBe(false);
  });
});
