import { describe, expect, it } from 'vitest';
import { contextItemSchema, memoryEntrySchema, type MemoryEntry } from '@r4/contracts';
import { DeterministicCompactor, derivedSummaryContribution, memoryEntryContribution, type CompiledResult, type CompileOutcome } from '@r4/context-compiler';
import { FixtureMemory, HOUR, MINUTE, TASK, at, compiler, fixed, request } from '../../fixtures/context/builders.js';

function compiled(outcome: CompileOutcome): CompiledResult {
  if (outcome.kind !== 'compiled') throw new Error(`expected a compiled context, got ${outcome.kind}`);
  return outcome;
}

function conversation(turns: number): FixtureMemory {
  const memory = new FixtureMemory();
  for (let i = 0; i < turns; i += 1) {
    memory.turn(at(i * MINUTE), `turn ${i}: ${'words '.repeat(12)}`, i === 3 ? { assertions: [{ subject: 'record:1.status', value: 'B' }] } : {});
  }
  return memory;
}

const MAX = 4_000;
const POLICY = { budget: fixed(MAX), conversation: { recentTurns: 10, compaction: { enabled: true, chunkTurns: 10 } } };

/** Persists what a compilation produced, the way the execution runtime does. */
function persist(memory: FixtureMemory, result: CompiledResult): MemoryEntry[] {
  return result.newSummaries.map((summary) =>
    memory.add({ memoryType: 'DERIVED_SUMMARY', occurredAt: summary.occurredAt, sensitivity: summary.sensitivity, content: summary.content, recordedBy: { kind: 'system', ref: 'context-compiler' } }),
  );
}

describe('compaction', () => {
  it('replaces the oldest whole chunks by one DERIVED summary plus the recent raw tail, within budget', async () => {
    const memory = conversation(100);
    const without = compiled(await compiler({ memory, policy: POLICY, compactor: null }).compile(request({ now: at(2 * HOUR) })));
    const result = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));

    const [summary] = result.compiled.sections.derivedMemory;
    expect(summary).toMatchObject({ kind: 'derived_summary', authority: 'DERIVED', sourceId: 'platform.memory', provenance: { recordType: 'derived_summary', producedBy: 'deterministic-extractive@1', derivedFromCount: 90 } });
    expect(summary!.content).toMatchObject({ derivation: { compactorId: 'deterministic-extractive', compactorVersion: '1', sourceCount: 90, fromObservedAt: at(0), toObservedAt: at(89 * MINUTE) } });
    // The recent raw tail survives as-is.
    const tail = memory.entries.slice(90).map((e) => `memory:${e.entryId}`);
    expect(result.compiled.sections.conversation.map((i) => i.itemId)).toEqual(tail);
    // Compacted turns are accounted for; compaction reduced what is left out for budget.
    expect(result.compiled.omissions.compacted).toBe(90);
    expect(result.compiled.omissions.budget ?? 0).toBeLessThan(without.compiled.omissions.budget ?? 0);
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX);
  });

  it('records full provenance and returns the summary for durable storage; sources are untouched', async () => {
    const memory = conversation(100);
    const before = JSON.stringify(memory.entries);
    const result = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));
    expect(result.newSummaries).toHaveLength(1);
    const [draft] = result.newSummaries;
    expect(draft!.content.derivation.sourceItemIds).toEqual(memory.entries.slice(0, 90).map((e) => `memory:${e.entryId}`));
    expect(draft!.taskId).toBe(TASK.taskId);
    // A valid DERIVED_SUMMARY memory entry once the platform assigns id and recording metadata.
    expect(memoryEntrySchema.safeParse({ ...draft, entryId: '0190e7a1-0000-7000-8000-00000000f000', memoryType: 'DERIVED_SUMMARY', recordedAt: at(2 * HOUR), recordedBy: { kind: 'system', ref: 'context-compiler' }, correlationId: 'c' }).success).toBe(true);
    // Raw evidence is never destroyed or altered by compaction.
    expect(JSON.stringify(memory.entries)).toBe(before);
    // Every compacted item is recorded, pointing at the summary that represents it (ADR-015 accounting).
    const summaryId = `summary:${draft!.content.derivation.derivationKey}`;
    expect(result.decisions.filter((d) => d.reason === 'compacted').map((d) => [d.itemId, d.representedBy])).toEqual(
      draft!.content.derivation.sourceItemIds.map((id) => [id, summaryId]),
    );
  });

  it('carries claims over only as DERIVED claims: the summary never becomes truth', async () => {
    const memory = conversation(100);
    const result = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));
    const [summary] = result.compiled.sections.derivedMemory;
    expect(summary!.assertions).toEqual([{ subject: 'record:1.status', value: 'B' }]);
    expect(summary!.authority).toBe('DERIVED');
    expect(result.compiled.sections.authoritativeState).toEqual([]);
  });

  it('is deterministic for the same source range, and reuses a stored identical summary instead of recompacting', async () => {
    const memory = conversation(100);
    const first = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));
    const again = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));
    expect(again.newSummaries).toEqual(first.newSummaries);
    expect(again.contentHash).toBe(first.contentHash);

    persist(memory, first);
    let calls = 0;
    const counting = new DeterministicCompactor();
    const compact = counting.compact.bind(counting);
    counting.compact = (input) => {
      calls += 1;
      return compact(input);
    };
    const reused = compiled(await compiler({ memory, policy: POLICY, compactor: counting }).compile(request({ now: at(2 * HOUR) })));
    expect(calls).toBe(0);
    expect(reused.newSummaries).toEqual([]);
    // The stored summary yields exactly the item that was compiled from the fresh one.
    expect(reused.compiled).toEqual(first.compiled);
    expect(reused.inputFingerprint).toBe(first.inputFingerprint);
  });

  it('only recompacts when a whole new chunk accumulates', async () => {
    const memory = conversation(100);
    const first = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));
    persist(memory, first);
    for (let i = 100; i < 105; i += 1) memory.turn(at(i * MINUTE), `turn ${i}: ${'words '.repeat(12)}`);
    const partial = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));
    expect(partial.newSummaries).toEqual([]);
    for (let i = 105; i < 110; i += 1) memory.turn(at(i * MINUTE), `turn ${i}: ${'words '.repeat(12)}`);
    const next = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));
    expect(next.newSummaries).toHaveLength(1);
    expect(next.newSummaries[0]!.content.derivation.sourceItemIds).toHaveLength(100);
    // The older summary is now fully represented by the newer one: redundant.
    persist(memory, next);
    const settled = compiled(await compiler({ memory, policy: POLICY }).compile(request({ now: at(2 * HOUR) })));
    const old = settled.decisions.find((d) => d.itemId === `summary:${first.newSummaries[0]!.content.derivation.derivationKey}`);
    expect(old).toMatchObject({ decision: 'excluded', reason: 'duplicate' });
  });

  it('does not compact what fits', async () => {
    const memory = conversation(20);
    const result = compiled(await compiler({ memory, policy: { ...POLICY, budget: fixed(8_000) } }).compile(request({ now: at(2 * HOUR) })));
    expect(result.newSummaries).toEqual([]);
    expect(result.compiled.sections.conversation).toHaveLength(20);
  });

  it('maps a stored summary and a freshly produced one to the same item', () => {
    const content = {
      text: 'summary',
      assertions: [],
      derivation: { derivationKey: 'c'.repeat(64), compactorId: 'deterministic-extractive', compactorVersion: '1', sourceItemIds: ['memory:a', 'memory:b'], fromObservedAt: at(0), toObservedAt: at(MINUTE) },
    };
    const entry = memoryEntrySchema.parse({ entryId: '0190e7a1-0000-7000-8000-00000000f001', taskId: TASK.taskId, memoryType: 'DERIVED_SUMMARY', occurredAt: at(MINUTE), recordedAt: at(HOUR), recordedBy: { kind: 'system', ref: 'context-compiler' }, correlationId: 'c', content });
    expect(memoryEntryContribution(entry)).toEqual(derivedSummaryContribution({ taskId: TASK.taskId, sensitivity: 'NORMAL', content, validUntil: null }));
  });

  it('deterministic compactor: bounded, extractive, same input → same output', async () => {
    const compactor = new DeterministicCompactor({ maxChars: 300 });
    const items = conversation(40).entries.map((e) => contextItemSchema.parse({ ...memoryEntryContribution(e), sourceId: 'platform.memory' }));
    const a = await compactor.compact({ items });
    const b = await compactor.compact({ items });
    expect(a).toEqual(b);
    expect(a.text.length).toBeLessThanOrEqual(300 + 20);
    expect(a.text).toMatch(/^Summary of 40 earlier items/);
    expect(a.text).toMatch(/more\)$/);
  });
});
