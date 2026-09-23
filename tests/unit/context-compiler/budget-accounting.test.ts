import { describe, expect, it } from 'vitest';
import { CONTEXT_SECTIONS, contextCompositionSchema, type ContextContributionInput } from '@r4/contracts';
import { Utf8BytesSizer, contextComposition, type CompiledResult } from '@r4/context-compiler';
import { UNBOUNDED, compiler, fixed, request, stateItem, staticSource, type CompilerOptions } from '../../fixtures/context/builders.js';
import { compareCompilations } from '../../fixtures/context/compare.js';
import { longHistory, type ContextScenario } from '../../fixtures/context/scenarios.js';

/**
 * ADR-015: budgeting is a mechanism, the budget is an empirical decision.
 * The same large corpus (≈87k raw tokens) is compiled UNBOUNDED (the runtime
 * default) and FIXED(6000) (the bounded experiment); accounting must match
 * exactly what was compiled in both.
 */
const BASE = { staleAfterMs: { state: 30 * 60_000 }, conversation: { recentTurns: 20, compaction: { enabled: true, chunkTurns: 10 } } } as const;
const UNBOUNDED_POLICY = { ...BASE, budget: UNBOUNDED };
const FIXED_POLICY = { ...BASE, budget: fixed(6_000) };

const SECRET: ContextContributionInput = { ...stateItem('record:42.access_key', 'SECRET-TOKEN-XYZ'), sensitivity: 'SECRET' };

async function compileCorpus(policy: NonNullable<CompilerOptions['policy']>, scenario: ContextScenario = longHistory(), extra: CompilerOptions['sources'] = []): Promise<CompiledResult> {
  const outcome = await compiler({ memory: scenario.memory, sources: [...scenario.sources, staticSource('fixture.secrets', [SECRET]), ...extra], policy }).compile(
    request({ now: scenario.now, observations: scenario.observations }),
  );
  if (outcome.kind !== 'compiled') throw new Error(`expected a compiled context, got ${outcome.kind}`);
  return outcome;
}

const included = (tallies: Partial<Record<string, { included: { count: number; estimatedTokens: number } }>>) =>
  Object.values(tallies).reduce((sum, t) => sum + t!.included.estimatedTokens, 0);
const excluded = (tallies: Partial<Record<string, { excluded: { estimatedTokens: number } }>>) => Object.values(tallies).reduce((sum, t) => sum + t!.excluded.estimatedTokens, 0);

/** The accounting must describe exactly the compiled document — no rounding hidden anywhere. */
function expectAccountingMatches(result: CompiledResult): void {
  const c = result.composition;
  const sizer = new Utf8BytesSizer();
  const items = CONTEXT_SECTIONS.flatMap((s) => result.compiled.sections[s]);
  expect(contextCompositionSchema.parse(c)).toEqual(c);
  // Included tokens are exactly the compiled items as serialized (+1 separator each).
  expect(items.reduce((sum, item) => sum + sizer.estimate(item) + 1, 0)).toBe(c.includedEstimatedTokens);
  expect(c.includedCount).toBe(items.length);
  // Every breakdown partitions the same totals.
  for (const breakdown of [c.byKind, c.byAuthority, c.bySource]) {
    expect(included(breakdown)).toBe(c.includedEstimatedTokens);
    expect(excluded(breakdown)).toBe(c.excludedEstimatedTokens);
  }
  expect(Object.values(c.bySection).reduce((sum, t) => sum + t.estimatedTokens, 0)).toBe(c.includedEstimatedTokens);
  expect(Object.values(c.byExclusionReason).reduce((sum, t) => sum + t.estimatedTokens, 0)).toBe(c.excludedEstimatedTokens);
  // Identities.
  expect(c.rawEstimatedTokens).toBe(c.includedEstimatedTokens + c.excludedEstimatedTokens);
  expect(c.compiledEstimatedTokens).toBe(result.estimatedTokens);
  expect(c.includedEstimatedTokens + c.overheadEstimatedTokens).toBe(c.compiledEstimatedTokens);
  expect(c.compiledEstimatedTokens).toBe(result.compiled.budget.estimatedTokens);
  // The accounted size is a conservative upper bound of the real document. The gap is fully explained:
  // the frame/conflict overhead bound plus, per included item, < 1 token of ceil() rounding and the
  // 1-token separator allowance for a 1-byte comma — i.e. < 2 tokens per item. Nothing else is hidden.
  const actual = sizer.estimate(result.compiled);
  expect(actual).toBeLessThanOrEqual(c.compiledEstimatedTokens);
  expect(c.compiledEstimatedTokens - actual).toBeLessThan(c.overheadEstimatedTokens + 2 * c.includedCount);
  // Derivable from the decisions alone (what the snapshot stores).
  expect(contextComposition({ decisions: result.decisions, estimatedTokens: result.estimatedTokens, budget: result.budget })).toEqual(c);
  expect(c.includedCount + c.excludedCount).toBe(result.decisions.length);
}

describe('UNBOUNDED (runtime default): no artificial limit', () => {
  it('excludes nothing for budget and never compacts, however large the context', async () => {
    const result = await compileCorpus(UNBOUNDED_POLICY);
    expect(result.budget).toEqual({ mode: 'unbounded' });
    expect(result.compiled.budget.policy).toEqual({ mode: 'unbounded' });
    expect(result.decisions.filter((d) => d.reason === 'budget')).toEqual([]);
    expect(result.decisions.filter((d) => d.reason === 'compacted')).toEqual([]);
    expect(result.newSummaries).toEqual([]);
    expect(result.composition.compaction).toBeNull();
    expect(result.compiled.sections.derivedMemory.some((i) => i.provenance.producedBy === 'deterministic-extractive@1')).toBe(false);
    // Far above any bound used in tests: nothing was cut to fit.
    expect(result.estimatedTokens).toBeGreaterThan(50_000);
  });

  it('keeps every memory boundary and authority represented', async () => {
    const scenario = longHistory();
    const result = await compileCorpus(UNBOUNDED_POLICY, scenario);
    const { sections } = result.compiled;
    const turns = scenario.memory.entries.filter((e) => e.memoryType === 'CONVERSATIONAL');
    expect(sections.conversation.map((i) => i.itemId)).toEqual(turns.map((e) => `memory:${e.entryId}`));
    expect(sections.workingMemory.map((i) => i.authority)).toEqual(['COGNITIVE']);
    expect(sections.episodicMemory.map((i) => i.authority)).toEqual(['OBSERVED']);
    expect(sections.authoritativeState.map((i) => i.itemId).sort()).toEqual(['state:record:42.owner', 'state:record:42.priority', 'state:record:42.status']);
    expect(sections.observations).toHaveLength(10);
    expect(sections.history.filter((i) => i.kind === 'observation')).toHaveLength(20);
    // The legacy summary keeps its authority; all its sources are present raw, so it is redundant (not cut for budget).
    expect(result.decisions.find((d) => d.itemId === `summary:${'a'.repeat(64)}`)).toMatchObject({ authority: 'DERIVED', decision: 'excluded', reason: 'duplicate' });
    // SECRET stays out, unsized.
    expect(result.decisions.find((d) => d.itemId === 'state:record:42.access_key')).toMatchObject({ decision: 'excluded', reason: 'sensitivity', estimatedTokens: 0 });
    expect(JSON.stringify(result.compiled)).not.toContain('SECRET-TOKEN-XYZ');
    // Expired state is still never current truth.
    expect(result.decisions.find((d) => d.itemId === 'state:record:42.eta')).toMatchObject({ freshness: 'expired', decision: 'included', section: 'history' });
    // Authority still prevails in conflicts.
    expect(result.compiled.conflicts.find((c) => c.subject === 'record:42.status')?.authoritativeItemId).toBe('state:record:42.status');
  });

  it('applies per-kind caps as selection policy (reason "policy"), never as budget, and does not compact', async () => {
    const result = await compileCorpus({ ...UNBOUNDED_POLICY, kindLimits: { conversation_turn: { maxItems: 5 } } });
    expect(result.compiled.sections.conversation).toHaveLength(5);
    expect(result.decisions.filter((d) => d.kind === 'conversation_turn' && d.decision === 'excluded').every((d) => d.reason === 'policy')).toBe(true);
    expect(result.decisions.filter((d) => d.reason === 'budget' || d.reason === 'compacted')).toEqual([]);
  });

  it('accounting matches the compiled context exactly', async () => {
    expectAccountingMatches(await compileCorpus(UNBOUNDED_POLICY));
  });
});

describe('FIXED(6000): the bounded experiment', () => {
  it('stays within budget with required context, authority, compaction and explainable omissions', async () => {
    const scenario = longHistory();
    const result = await compileCorpus(FIXED_POLICY, scenario);
    const c = result.composition;
    expect(result.budget).toEqual(fixed(6_000));
    expect(result.estimatedTokens).toBeLessThanOrEqual(6_000);
    expect(new Utf8BytesSizer().estimate(result.compiled)).toBeLessThanOrEqual(6_000);
    for (const id of scenario.mustInclude) expect(result.decisions.find((d) => d.itemId === id)?.decision, id).toBe('included');
    expect(result.compiled.conflicts.find((x) => x.subject === 'record:42.status')?.authoritativeItemId).toBe('state:record:42.status');
    // Compaction worked and is measured.
    expect(c.compaction).toMatchObject({ summaryCount: 1, compactedItemCount: c.compactedCount });
    expect(c.compaction!.outputEstimatedTokens).toBeLessThan(c.compaction!.inputEstimatedTokens);
    expect(c.compaction!.ratio).toBe(c.compaction!.outputEstimatedTokens / c.compaction!.inputEstimatedTokens);
    expect(c.compactedCount).toBe(result.compiled.omissions.compacted);
    // Every omission has a reason and the snapshot records every evaluated item (compacted included).
    for (const [reason, tally] of Object.entries(c.byExclusionReason)) expect(result.compiled.omissions[reason as keyof typeof result.compiled.omissions]).toBe(tally.count);
    const recorded = new Set(result.decisions.map((d) => d.itemId));
    for (const e of scenario.memory.entries) expect(recorded.has(e.memoryType === 'DERIVED_SUMMARY' ? `summary:${e.content.derivation.derivationKey}` : `memory:${e.entryId}`)).toBe(true);
    for (const o of scenario.observations) expect(recorded.has(`observation:${o.observationId}`)).toBe(true);
    expectAccountingMatches(result);
  });

  it('observed under this bounded policy and the current selection order: working and episodic memory are starved', async () => {
    // Documented behaviour, not a verdict: which allocation serves tasks best needs evals (ADR-015).
    const c = (await compileCorpus(FIXED_POLICY)).composition;
    expect(c.byKind.working_note).toMatchObject({ included: { count: 0 }, excluded: { count: 1 } });
    expect(c.byKind.episode).toMatchObject({ included: { count: 0 }, excluded: { count: 1 } });
    expect(c.byExclusionReason.budget?.count).toBeGreaterThan(0);
  });
});

describe('reproducibility and equivalence', () => {
  it('same state + policy + budget + compiler → same context, hash and accounting (both modes)', async () => {
    for (const policy of [UNBOUNDED_POLICY, FIXED_POLICY]) {
      const [a, b] = [await compileCorpus(policy), await compileCorpus(policy)];
      expect(b.compiled).toEqual(a.compiled);
      expect(b.contentHash).toBe(a.contentHash);
      expect(b.inputFingerprint).toBe(a.inputFingerprint);
      expect(b.composition).toEqual(a.composition);
      expect(JSON.stringify(b.composition)).toBe(JSON.stringify(a.composition));
    }
  });

  it('the effective budget is part of equivalence: changing it never matches an earlier snapshot', async () => {
    const unbounded = await compileCorpus(UNBOUNDED_POLICY);
    const bounded = await compileCorpus(FIXED_POLICY);
    const bounded2 = await compileCorpus({ ...BASE, budget: fixed(6_001) });
    const ceiling = compiler({ policy: UNBOUNDED_POLICY });
    expect(new Set([unbounded.inputFingerprint, bounded.inputFingerprint, bounded2.inputFingerprint]).size).toBe(3);
    expect(new Set([unbounded.contentHash, bounded.contentHash, bounded2.contentHash]).size).toBe(3);
    // A request ceiling (the agent's) tightens unbounded into fixed, and that too is a different compilation.
    const withCeiling = await ceiling.compile(request({ budgetCeilingTokens: 6_000 }));
    const withoutCeiling = await ceiling.compile(request());
    if (withCeiling.kind !== 'compiled' || withoutCeiling.kind !== 'compiled') throw new Error('not compiled');
    expect(withCeiling.budget).toEqual(fixed(6_000));
    expect(withCeiling.inputFingerprint).not.toBe(withoutCeiling.inputFingerprint);
  });
});

describe('UNBOUNDED vs FIXED(6000): R4 can measure the difference', () => {
  it('produces a structured comparison of size, items, compaction and composition', async () => {
    const unbounded = await compileCorpus(UNBOUNDED_POLICY);
    const bounded = await compileCorpus(FIXED_POLICY);
    const diff = compareCompilations(unbounded, bounded);
    expect(diff.budgets).toEqual(['unbounded', 'fixed(6000)']);
    expect(diff.compiledEstimatedTokens[1]).toBeLessThan(diff.compiledEstimatedTokens[0]);
    expect(diff.includedCount[1]).toBeLessThan(diff.includedCount[0]);
    expect(diff.excludedForBudget).toEqual([0, bounded.composition.byExclusionReason.budget!.count]);
    expect(diff.compactedCount[0]).toBe(0);
    expect(diff.compactedCount[1]).toBeGreaterThan(0);
    // Per kind: both sides and the delta are reported and consistent with each composition.
    for (const [kind, row] of Object.entries(diff.byKind)) expect(row.delta, kind).toBe(row.b - row.a);
    expect(Object.values(diff.byKind).reduce((sum, row) => sum + row.a, 0)).toBe(unbounded.composition.includedEstimatedTokens);
    expect(Object.values(diff.byKind).reduce((sum, row) => sum + row.b, 0)).toBe(bounded.composition.includedEstimatedTokens);
    expect(diff.droppedByKind.conversation_turn).toBeGreaterThan(0);
    // Deterministic, so experiments can be diffed run over run.
    expect(compareCompilations(await compileCorpus(UNBOUNDED_POLICY), await compileCorpus(FIXED_POLICY))).toEqual(diff);
  });
});

describe('contextComposition projection', () => {
  it('is empty-safe and orders keys by contract, sources alphabetically', () => {
    const c = contextComposition({
      decisions: [
        { itemId: 'state:b', sourceId: 'zeta.src', kind: 'state', authority: 'AUTHORITATIVE', freshness: 'fresh', sensitivity: 'NORMAL', decision: 'included', section: 'authoritativeState', reason: null, representedBy: null, estimatedTokens: 7 },
        { itemId: 'memory:a', sourceId: 'alpha.src', kind: 'conversation_turn', authority: 'CONVERSATIONAL', freshness: 'unknown', sensitivity: 'NORMAL', decision: 'excluded', section: null, reason: 'policy', representedBy: null, estimatedTokens: 3 },
      ],
      estimatedTokens: 20,
      budget: UNBOUNDED,
    });
    expect(Object.keys(c.byKind)).toEqual(['state', 'conversation_turn']);
    expect(Object.keys(c.bySource)).toEqual(['alpha.src', 'zeta.src']);
    expect(c).toMatchObject({ rawEstimatedTokens: 10, includedEstimatedTokens: 7, excludedEstimatedTokens: 3, overheadEstimatedTokens: 13, compactedCount: 0, compaction: null });
    expect(contextComposition({ decisions: [], estimatedTokens: 0, budget: UNBOUNDED })).toMatchObject({ rawEstimatedTokens: 0, includedCount: 0, byKind: {}, compaction: null });
  });
});
