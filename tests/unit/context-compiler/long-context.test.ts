import { describe, expect, it } from 'vitest';
import { CONTEXT_SECTIONS, compiledContextSchema, type CompiledContext } from '@r4/contracts';
import { Utf8BytesSizer, type CompiledResult } from '@r4/context-compiler';
import { compiler, fixed, request, TASK } from '../../fixtures/context/builders.js';
import { SCENARIOS, longHistory, type ContextScenario } from '../../fixtures/context/scenarios.js';

const MAX = 6_000;
const POLICY = { budget: fixed(MAX), staleAfterMs: { state: 30 * 60_000 }, conversation: { recentTurns: 20, compaction: { enabled: true, chunkTurns: 10 } } };

async function compileScenario(scenario: ContextScenario, policy: Partial<typeof POLICY> = POLICY): Promise<CompiledResult> {
  const outcome = await compiler({ memory: scenario.memory, sources: scenario.sources, policy }).compile(request({ now: scenario.now, observations: scenario.observations }));
  if (outcome.kind !== 'compiled') throw new Error(`${scenario.name}: ${outcome.kind}`);
  return outcome;
}

const ids = (context: CompiledContext) => new Set(CONTEXT_SECTIONS.flatMap((s) => context.sections[s].map((i) => i.itemId)));

describe('long context: 600+ turns, observations, old summaries, corrections, noise, fresh and stale facts', () => {
  it('stays within budget while the raw history is several times larger', async () => {
    const scenario = longHistory();
    const result = await compileScenario(scenario);
    expect(scenario.memory.entries.length).toBeGreaterThan(600);
    const rawTokens = new Utf8BytesSizer().estimate(scenario.memory.entries);
    expect(rawTokens).toBeGreaterThan(5 * MAX);
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX);
    expect(new Utf8BytesSizer().estimate(result.compiled)).toBeLessThanOrEqual(MAX);
    expect(compiledContextSchema.parse(result.compiled)).toEqual(result.compiled);
  });

  it('keeps the current goal, the task and the required authoritative state', async () => {
    const scenario = longHistory();
    const result = await compileScenario(scenario);
    const included = ids(result.compiled);
    for (const id of scenario.mustInclude) expect(included.has(id), id).toBe(true);
    expect(result.compiled.sections.goals[0]).toMatchObject({ itemId: `goal:${TASK.currentGoalId}`, authority: 'AUTHORITATIVE', freshness: 'fresh' });
    expect(result.compiled.sections.authoritativeState.find((i) => i.itemId === 'state:record:42.status')).toMatchObject({ content: { value: 'open' } });
  });

  it('keeps the recent conversation (including the latest correction) raw and compacts old noise', async () => {
    const scenario = longHistory();
    const result = await compileScenario(scenario);
    const turns = scenario.memory.entries.filter((e) => e.memoryType === 'CONVERSATIONAL');
    const kept = result.compiled.sections.conversation.map((i) => i.itemId);
    // A contiguous, most-recent tail, ending at the correction.
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept).toEqual(turns.slice(turns.length - kept.length).map((e) => `memory:${e.entryId}`));
    expect(kept.at(-1)).toBe(`memory:${turns.at(-1)!.entryId}`);
    // Old turns (noise included) are compacted into one summary or left out for budget — never silently lost.
    expect((result.compiled.omissions.compacted ?? 0) + (result.compiled.omissions.budget ?? 0)).toBeGreaterThan(500);
    expect(result.compiled.sections.derivedMemory.some((i) => i.provenance.producedBy === 'deterministic-extractive@1')).toBe(true);
    // The legacy summary is fully covered by the new one: redundant, not duplicated in context.
    expect(result.decisions.find((d) => d.itemId === `summary:${'a'.repeat(64)}`)).toMatchObject({ decision: 'excluded', reason: 'duplicate' });
  });

  it('never lets summaries or conversation override authoritative state', async () => {
    const scenario = longHistory();
    const result = await compileScenario(scenario);
    const conflict = result.compiled.conflicts.find((c) => c.subject === 'record:42.status');
    expect(conflict).toBeDefined();
    expect(conflict!.authoritativeItemId).toBe('state:record:42.status');
    expect(new Set(conflict!.positions.map((p) => p.authority))).toEqual(new Set(['AUTHORITATIVE', 'CONVERSATIONAL', 'DERIVED']));
    expect(result.compiled.sections.authoritativeState.every((i) => i.authority === 'AUTHORITATIVE')).toBe(true);
  });

  it('labels facts by freshness: expired readings are history only, stale ones are flagged', async () => {
    const scenario = longHistory();
    const result = await compileScenario(scenario);
    const current = CONTEXT_SECTIONS.filter((s) => s !== 'history').flatMap((s) => result.compiled.sections[s]);
    expect(current.some((i) => i.freshness === 'expired')).toBe(false);
    expect(result.compiled.sections.authoritativeState.find((i) => i.itemId === 'state:record:42.priority')).toMatchObject({ freshness: 'stale' });
    const eta = result.decisions.find((d) => d.itemId === 'state:record:42.eta');
    expect(eta?.freshness).toBe('expired');
    expect(eta?.decision === 'excluded' ? eta.reason : eta?.section).toMatch(/^(history|budget)$/);
    // Every expired observation is either history or left out for budget.
    for (const d of result.decisions.filter((x) => x.kind === 'observation' && x.freshness === 'expired')) {
      expect(d.decision === 'included' ? d.section : d.reason).toMatch(/^(history|budget)$/);
    }
  });

  it('is reproducible at scale: same corpus → same hash', async () => {
    const [a, b] = [await compileScenario(longHistory()), await compileScenario(longHistory())];
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.decisions).toEqual(a.decisions);
  });
});

describe('context scenarios (reusable corpus)', () => {
  it.each(SCENARIOS.map((make) => [make().name, make] as const))('%s: required items present, authority prevails, budget holds', async (_name, make) => {
    const scenario = make();
    const result = await compileScenario(scenario);
    const included = ids(result.compiled);
    for (const id of scenario.mustInclude) expect(included.has(id), id).toBe(true);
    for (const [subject, expected] of Object.entries(scenario.authoritative)) {
      const conflict = result.compiled.conflicts.find((c) => c.subject === subject);
      if (conflict) expect(conflict.authoritativeItemId).toBe(expected.itemId);
      expect(result.compiled.sections.authoritativeState.find((i) => i.itemId === expected.itemId)?.content).toMatchObject({ value: expected.value });
    }
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX);
  });

  it('correction: both statements stay CONVERSATIONAL evidence; the owner value is the only current truth', async () => {
    const result = await compileScenario(SCENARIOS[1]!());
    expect(result.compiled.sections.conversation.map((i) => i.authority)).toEqual(['CONVERSATIONAL', 'CONVERSATIONAL']);
    expect(result.compiled.conflicts).toEqual([expect.objectContaining({ subject: 'record:7.channel', authoritativeItemId: 'state:record:7.channel' })]);
  });

  it('stale evidence: the expired observation is history, the valid one current', async () => {
    const result = await compileScenario(SCENARIOS[2]!());
    expect(result.compiled.sections.history.map((i) => i.itemId)).toEqual(['observation:0190e7a2-0000-7000-8000-000000000001']);
    expect(result.compiled.sections.observations.map((i) => i.itemId)).toEqual(['observation:0190e7a2-0000-7000-8000-000000000002']);
  });

  it('summary degradation: the degraded summary is visible as DERIVED, the owner value prevails', async () => {
    const result = await compileScenario(SCENARIOS[6]!());
    expect(result.compiled.sections.derivedMemory).toEqual([expect.objectContaining({ authority: 'DERIVED', assertions: [{ subject: 'record:3.stage', value: 'draft' }] })]);
    expect(result.compiled.conflicts).toEqual([expect.objectContaining({ subject: 'record:3.stage', authoritativeItemId: 'state:record:3.stage' })]);
    // Its expired raw sources are not presented at all (not evidence kinds).
    expect(result.compiled.sections.conversation).toEqual([]);
  });
});
