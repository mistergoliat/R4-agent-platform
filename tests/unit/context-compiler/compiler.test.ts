import { describe, expect, it } from 'vitest';
import { CONTEXT_SECTIONS, compiledContextSchema, type CompiledContext, type ContextContributionInput } from '@r4/contracts';
import { ContextCompiler, Utf8BytesSizer, contentHashOf, platformContextSources, type CompiledResult, type CompileOutcome, type ContextSource } from '@r4/context-compiler';
import { captureLogs } from '../../support/logs.js';
import { FixtureMemory, HOUR, MINUTE, OTHER_TASK_ID, T0, TASK, at, compiler, fixed, observation, request, stateItem, staticSource, type CompilerOptions, type RequestOptions } from '../../fixtures/context/builders.js';

function compiled(outcome: CompileOutcome): CompiledResult {
  if (outcome.kind !== 'compiled') throw new Error(`expected a compiled context, got ${outcome.kind}`);
  return outcome;
}

async function compile(options: CompilerOptions = {}, req: RequestOptions = {}): Promise<CompiledResult> {
  return compiled(await compiler(options).compile(request(req)));
}

const itemIds = (context: CompiledContext) => CONTEXT_SECTIONS.flatMap((s) => context.sections[s].map((i) => i.itemId));
const decision = (result: CompiledResult, itemId: string) => result.decisions.find((d) => d.itemId === itemId);

/** A corpus exercising every section, built fresh each time (no shared state). */
function corpus(): { memory: FixtureMemory; observations: ReturnType<typeof observation>[]; sources: ReturnType<typeof staticSource>[] } {
  const memory = new FixtureMemory();
  for (let i = 0; i < 30; i += 1) memory.turn(at(i * MINUTE), `turn ${i}`);
  memory.add({ memoryType: 'WORKING', occurredAt: at(5 * MINUTE), content: { category: 'note', text: 'check record 1' } });
  memory.add({ memoryType: 'EPISODIC', occurredAt: at(6 * MINUTE), content: { event: 'task_resumed', text: 'resumed after interruption' } });
  const observations = [observation(1, at(0), { validUntil: at(3 * HOUR) }), observation(2, at(MINUTE), { validUntil: at(10 * MINUTE) })];
  return { memory, observations, sources: [staticSource('fixture.state', [stateItem('record:1.status', 'A'), stateItem('record:1.owner', 'x')])] };
}

describe('determinism', () => {
  it('same durable state + compiler version + policy + budget → same ordering, content and hash', async () => {
    const a = corpus();
    const b = corpus();
    const first = await compile({ memory: a.memory, sources: a.sources }, { observations: a.observations });
    const second = await compile({ memory: b.memory, sources: b.sources }, { observations: b.observations });
    expect(second.compiled).toEqual(first.compiled);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(second.decisions).toEqual(first.decisions);
    expect(itemIds(second.compiled)).toEqual(itemIds(first.compiled));
  });

  it('does not depend on the order sources return items in', async () => {
    const { memory } = corpus();
    const items = [stateItem('record:1.status', 'A'), stateItem('record:2.status', 'B'), stateItem('record:3.status', 'C')];
    const forward = await compile({ memory, sources: [staticSource('fixture.state', items)] });
    const reversed = await compile({ memory, sources: [staticSource('fixture.state', [...items].reverse())] });
    expect(reversed.compiled).toEqual(forward.compiled);
    expect(reversed.contentHash).toBe(forward.contentHash);
  });

  it('excludes only temporal metadata (asOf) from the content hash', async () => {
    const { memory } = corpus();
    const first = await compile({ memory }, { now: at(2 * HOUR) });
    const later = await compile({ memory }, { now: at(2 * HOUR + 1) });
    expect(later.compiled.asOf).not.toBe(first.compiled.asOf);
    expect(later.contentHash).toBe(first.contentHash);
    expect(contentHashOf({ ...first.compiled, asOf: T0 })).toBe(first.contentHash);
  });

  it('changes the hash when content changes, and the fingerprint when inputs change', async () => {
    const a = corpus();
    const base = await compile({ memory: a.memory });
    a.memory.turn(at(40 * MINUTE), 'one more turn');
    const more = await compile({ memory: a.memory });
    expect(more.contentHash).not.toBe(base.contentHash);
    expect(more.inputFingerprint).not.toBe(base.inputFingerprint);
  });

  it('orders every section chronologically, then by id', async () => {
    const { memory, observations } = corpus();
    const result = await compile({ memory }, { observations });
    for (const section of CONTEXT_SECTIONS) {
      const items = result.compiled.sections[section];
      const keys = items.map((i) => [Date.parse(i.observedAt ?? i.createdAt), i.itemId] as const);
      const sorted = [...keys].sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
      expect(keys, section).toEqual(sorted);
    }
  });

  it('produces a structured, schema-valid context — never a prompt string', async () => {
    const { memory, observations, sources } = corpus();
    const result = await compile({ memory, sources }, { observations });
    expect(compiledContextSchema.parse(result.compiled)).toEqual(result.compiled);
    expect(typeof result.compiled).toBe('object');
    expect(result.compiled).toMatchObject({ schemaVersion: 1, compilerVersion: '1.0.0', scope: { taskId: TASK.taskId, iteration: 1 } });
  });
});

describe('budget', () => {
  it('keeps the whole context within maxEstimatedTokens, measured on the entire document', async () => {
    const { memory, observations, sources } = corpus();
    for (const max of [1_500, 2_500, 4_000, 8_000]) {
      const result = await compile({ memory, sources, policy: { budget: fixed(max) }, compactor: null }, { observations });
      expect(result.estimatedTokens).toBeLessThanOrEqual(max);
      expect(new Utf8BytesSizer().estimate(result.compiled)).toBeLessThanOrEqual(result.estimatedTokens);
      expect(result.compiled.budget).toEqual({ policy: fixed(max), estimatedTokens: result.estimatedTokens, sizer: 'utf8-bytes-div4.v1' });
    }
  });

  it('never drops required items for budget; drops optional ones and says why', async () => {
    const { memory, observations, sources } = corpus();
    const result = await compile({ memory, sources, policy: { budget: fixed(1_500) }, compactor: null }, { observations });
    const ids = itemIds(result.compiled);
    for (const required of [`task:${TASK.taskId}`, `goal:${TASK.currentGoalId}`, 'agent:kernel-probe.v1', 'capability:platform_test.get_test_fact.v1']) {
      expect(ids).toContain(required);
    }
    expect(result.decisions.filter((d) => d.reason === 'budget').length).toBeGreaterThan(0);
    expect(result.compiled.omissions.budget).toBe(result.decisions.filter((d) => d.reason === 'budget').length);
  });

  it('keeps the most recent conversation, without gaps, when conversation must be cut', async () => {
    const { memory } = corpus();
    const result = await compile({ memory, policy: { budget: fixed(1_800) }, compactor: null });
    const kept = result.compiled.sections.conversation.map((i) => i.itemId);
    const all = memory.entries.filter((e) => e.memoryType === 'CONVERSATIONAL').map((e) => `memory:${e.entryId}`);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(all.length);
    expect(kept).toEqual(all.slice(all.length - kept.length));
  });

  it('honours a tighter ceiling from the request (agent contextPolicy)', async () => {
    const { memory } = corpus();
    const result = await compile({ memory, policy: { budget: fixed(8_000) } }, { budgetCeilingTokens: 2_000 });
    expect(result.budget).toEqual(fixed(2_000));
    expect(result.estimatedTokens).toBeLessThanOrEqual(2_000);
  });

  it('reports exhaustion when the required items alone do not fit', async () => {
    const outcome = await compiler({ policy: { budget: fixed(100) } }).compile(request());
    expect(outcome).toMatchObject({ kind: 'budget_exhausted', maxEstimatedTokens: 100 });
    if (outcome.kind === 'budget_exhausted') expect(outcome.requiredTokens).toBeGreaterThan(100);
  });

  it('applies per-kind caps from the policy', async () => {
    const { memory } = corpus();
    const result = await compile({ memory, policy: { kindLimits: { conversation_turn: { maxItems: 5 } } }, compactor: null });
    expect(result.compiled.sections.conversation).toHaveLength(5);
  });
});

describe('required items', () => {
  it('are required by policy kind or by the source, never hardcoded in the compiler', async () => {
    const policyDriven = await compile({ sources: [staticSource('fixture.state', [stateItem('record:1.status', 'A', { required: true })])], policy: { budget: fixed(1_500), selectionOrder: [] } });
    // `state` is not selectable under this policy, yet the source marked this item required.
    expect(itemIds(policyDriven.compiled)).toContain('state:record:1.status');
    const optional = await compile({ sources: [staticSource('fixture.state', [stateItem('record:1.status', 'A')])], policy: { selectionOrder: [] } });
    expect(decision(optional, 'state:record:1.status')).toMatchObject({ decision: 'excluded', reason: 'policy' });
  });

  it('include the newest observation of the current run (the answer to the last READ)', async () => {
    const observations = Array.from({ length: 6 }, (_, i) => observation(i + 1, at(i * MINUTE), { validUntil: at(5 * HOUR) }));
    const result = await compile({ policy: { budget: fixed(1_600), kindLimits: { observation: { maxItems: 1 } } } }, { observations });
    expect(result.compiled.sections.observations.map((o) => o.itemId)).toContain('observation:0190e7a2-0000-7000-8000-000000000006');
  });
});

describe('expired items: not current truth, still evidence', () => {
  const expiredObservation = observation(1, at(0), { validUntil: at(10 * MINUTE), runId: null });
  const expiredState = stateItem('record:1.eta', '2026-01-03', { observedAt: at(0), validUntil: at(10 * MINUTE) });

  it('never represents an expired item as current', async () => {
    const result = await compile({ sources: [staticSource('fixture.state', [expiredState])] }, { observations: [expiredObservation] });
    const current = CONTEXT_SECTIONS.filter((s) => s !== 'history').flatMap((s) => result.compiled.sections[s]);
    expect(current.some((i) => i.freshness === 'expired')).toBe(false);
    expect(result.compiled.sections.observations).toEqual([]);
    expect(result.compiled.sections.authoritativeState).toEqual([]);
  });

  it('keeps expired AUTHORITATIVE/OBSERVED items as history when the policy allows', async () => {
    const result = await compile({ sources: [staticSource('fixture.state', [expiredState])] }, { observations: [expiredObservation] });
    expect(result.compiled.sections.history.map((i) => [i.itemId, i.freshness])).toEqual([
      ['observation:0190e7a2-0000-7000-8000-000000000001', 'expired'],
      ['state:record:1.eta', 'expired'],
    ]);
  });

  it('drops them with reason "expired" when the policy excludes expired evidence', async () => {
    const result = await compile({ sources: [staticSource('fixture.state', [expiredState])], policy: { expiredEvidence: 'exclude' } }, { observations: [expiredObservation] });
    expect(result.compiled.sections.history).toEqual([]);
    expect(decision(result, 'state:record:1.eta')).toMatchObject({ decision: 'excluded', reason: 'expired', freshness: 'expired' });
  });

  it('never keeps expired non-evidence (memory, summaries) as history', async () => {
    const memory = new FixtureMemory();
    const note = memory.add({ memoryType: 'WORKING', occurredAt: at(0), validUntil: at(MINUTE), content: { category: 'note', text: 'temporary' } });
    const result = await compile({ memory });
    expect(decision(result, `memory:${note.entryId}`)).toMatchObject({ decision: 'excluded', reason: 'expired' });
  });
});

describe('authority and conflicts', () => {
  it('keeps AUTHORITATIVE state, keeps the conversational claim as evidence, and exposes the conflict', async () => {
    const memory = new FixtureMemory();
    const said = memory.turn(at(0), 'status is B now', { assertions: [{ subject: 'record:1.status', value: 'B' }] });
    const result = await compile({ memory, sources: [staticSource('fixture.state', [stateItem('record:1.status', 'A')])] });

    expect(result.compiled.sections.authoritativeState).toEqual([expect.objectContaining({ itemId: 'state:record:1.status', authority: 'AUTHORITATIVE', content: { key: 'record:1.status', value: 'A' } })]);
    expect(result.compiled.sections.conversation).toEqual([expect.objectContaining({ itemId: `memory:${said.entryId}`, authority: 'CONVERSATIONAL' })]);
    expect(result.compiled.conflicts).toEqual([
      {
        subject: 'record:1.status',
        positions: [
          { itemId: `memory:${said.entryId}`, authority: 'CONVERSATIONAL', value: 'B' },
          { itemId: 'state:record:1.status', authority: 'AUTHORITATIVE', value: 'A' },
        ],
        authoritativeItemId: 'state:record:1.status',
      },
    ]);
  });

  it('never lets the latest statement win: two conversational positions stay unresolved', async () => {
    const memory = new FixtureMemory();
    memory.turn(at(0), 'it is X', { assertions: [{ subject: 'record:2.channel', value: 'X' }] });
    memory.turn(at(MINUTE), 'no, it is Y', { assertions: [{ subject: 'record:2.channel', value: 'Y' }] });
    const result = await compile({ memory });
    expect(result.compiled.conflicts).toEqual([expect.objectContaining({ subject: 'record:2.channel', authoritativeItemId: null })]);
  });

  it('DERIVED cannot replace AUTHORITATIVE — not by content, not by supersession', async () => {
    // The summary's raw sources are no longer in memory, so it is not redundant and does reach the context.
    const summary: ContextContributionInput = {
      itemId: 'summary:rogue',
      kind: 'derived_summary',
      authority: 'DERIVED',
      temporality: 'point_in_time',
      content: { text: 'record 1 is B' },
      assertions: [{ subject: 'record:1.status', value: 'B' }],
      provenance: { recordType: 'derived_summary', recordId: 'rogue', derivedFrom: ['memory:archived-1', 'memory:archived-2'], producedBy: 'x@1' },
      createdAt: at(MINUTE),
      observedAt: at(MINUTE),
      // Pointing at the authoritative item does not retire it: a source may only supersede its own items.
      supersedes: ['state:record:1.status'],
    };
    const result = await compile({
      sources: [staticSource('fixture.state', [stateItem('record:1.status', 'A')]), staticSource('fixture.derived', [summary])],
      policy: { budget: fixed(8_000) },
    });
    expect(result.compiled.sections.authoritativeState.map((i) => i.content)).toEqual([{ key: 'record:1.status', value: 'A' }]);
    expect(decision(result, 'state:record:1.status')).toMatchObject({ decision: 'included', section: 'authoritativeState' });
    expect(result.compiled.sections.derivedMemory.map((i) => [i.itemId, i.authority])).toEqual([['summary:rogue', 'DERIVED']]);
    expect(result.compiled.conflicts).toEqual([expect.objectContaining({ subject: 'record:1.status', authoritativeItemId: 'state:record:1.status' })]);
    // A source cannot pass a summary off as authoritative either: the contract refuses it.
    const forged = compiler({ sources: [staticSource('fixture.derived', [{ ...summary, authority: 'AUTHORITATIVE' }])] });
    await expect(forged.compile(request())).rejects.toMatchObject({ code: 'invalid_context_item' });
  });

  it('never merges: a stale authoritative reading and a fresh one both stay visible, labelled', async () => {
    const result = await compile({
      sources: [staticSource('fixture.state', [stateItem('record:1.stage', 'draft', { observedAt: at(0), validUntil: at(3 * HOUR) })])],
      policy: { staleAfterMs: { state: 30 * MINUTE } },
    });
    expect(result.compiled.sections.authoritativeState[0]).toMatchObject({ freshness: 'stale', content: { value: 'draft' } });
  });
});

describe('admission rules', () => {
  it('excludes SECRET items before anything else, never storing or rendering their content', async () => {
    const logs = captureLogs();
    const secret = { ...stateItem('record:1.credential', 'SECRET-VALUE-123'), sensitivity: 'SECRET' as const, required: true };
    const result = await compile({ sources: [staticSource('fixture.state', [secret])], logger: logs.logger });
    expect(decision(result, 'state:record:1.credential')).toMatchObject({ decision: 'excluded', reason: 'sensitivity', sensitivity: 'SECRET' });
    expect(JSON.stringify(result.compiled)).not.toContain('SECRET-VALUE-123');
    expect(JSON.stringify(result.decisions)).not.toContain('SECRET-VALUE-123');
    expect(logs.raw()).not.toContain('SECRET-VALUE-123');
  });

  it('admits SENSITIVE items, labelled as such', async () => {
    const result = await compile({ sources: [staticSource('fixture.state', [{ ...stateItem('record:1.phone', '555'), sensitivity: 'SENSITIVE' }])] });
    expect(result.compiled.sections.authoritativeState[0]).toMatchObject({ sensitivity: 'SENSITIVE' });
  });

  it('deduplicates identical items deterministically (first registered source wins) and refuses conflicting duplicates', async () => {
    const item = stateItem('record:1.status', 'A');
    const result = await compile({ sources: [staticSource('fixture.first', [item]), staticSource('fixture.second', [item])] });
    expect(result.compiled.sections.authoritativeState).toEqual([expect.objectContaining({ itemId: 'state:record:1.status', sourceId: 'fixture.first' })]);
    expect(result.decisions.filter((d) => d.itemId === 'state:record:1.status').map((d) => [d.sourceId, d.decision, d.reason, d.representedBy])).toEqual([
      ['fixture.first', 'included', null, null],
      ['fixture.second', 'excluded', 'duplicate', 'state:record:1.status'],
    ]);
    const clash = compiler({ sources: [staticSource('fixture.first', [item]), staticSource('fixture.second', [stateItem('record:1.status', 'B')])] });
    await expect(clash.compile(request())).rejects.toMatchObject({ code: 'context_item_collision' });
  });

  it("excludes another task's items as not relevant to scope", async () => {
    const result = await compile({ sources: [staticSource('fixture.state', [stateItem('record:9.status', 'Z', { taskId: OTHER_TASK_ID })])] });
    expect(decision(result, 'state:record:9.status')).toMatchObject({ decision: 'excluded', reason: 'not_relevant_to_scope' });
  });

  it('honours supersession within a source (append + supersede, never overwrite)', async () => {
    const memory = new FixtureMemory();
    const first = memory.add({ memoryType: 'WORKING', occurredAt: at(0), content: { category: 'hypothesis', text: 'maybe X' } });
    const second = memory.add({ memoryType: 'WORKING', occurredAt: at(MINUTE), supersedesEntryId: first.entryId, content: { category: 'hypothesis', text: 'actually Y' } });
    const result = await compile({ memory });
    expect(result.compiled.sections.workingMemory.map((i) => i.itemId)).toEqual([`memory:${second.entryId}`]);
    expect(decision(result, `memory:${first.entryId}`)).toMatchObject({ reason: 'superseded', representedBy: `memory:${second.entryId}` });
  });

  it('refuses invalid contributions loudly, naming the source but not echoing content', async () => {
    const bad = compiler({ sources: [staticSource('fixture.bad', [{ ...stateItem('record:1.x', 'LEAK-ME'), createdAt: 'yesterday' }])] });
    const error = (await bad.compile(request()).then(() => null, (e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: 'invalid_context_item' });
    expect(error.message).toContain('fixture.bad');
    expect(error.message).not.toContain('LEAK-ME');
  });

  it('refuses a malformed source registration', () => {
    const logger = captureLogs().logger;
    expect(() => new ContextCompiler({ sources: [staticSource('bad id', [])], policy: { budget: fixed(10) }, logger })).toThrow(/namespaced/);
    expect(() => new ContextCompiler({ sources: [...platformContextSources(), ...platformContextSources()], policy: { budget: fixed(10) }, logger })).toThrow(/registered twice/);
    expect(() => new ContextCompiler({ sources: [], policy: { budget: fixed(10), requiredKinds: ['state'], selectionOrder: ['state'] }, logger })).toThrow();
  });
});

describe('extensibility', () => {
  it('accepts a new (domain) source without any change to the compiler', async () => {
    const domainSource: ContextSource = {
      id: 'external.record_state',
      load: (req) => Promise.resolve([stateItem('record:77.status', 'active', { taskId: req.scope.taskId })]),
    };
    const result = await compile({ sources: [domainSource] });
    expect(result.compiled.sections.authoritativeState).toEqual([expect.objectContaining({ itemId: 'state:record:77.status', sourceId: 'external.record_state' })]);
  });
});

describe('capabilities: visible ≠ executable', () => {
  it('lists exactly the visible capabilities the execution layer passed', async () => {
    const result = await compile();
    expect(result.compiled.sections.capabilities.map((c) => c.content)).toEqual([
      { capabilityId: 'platform_test.get_test_fact', version: 1, description: 'Returns a synthetic test fact', inputSchema: { type: 'object' } },
    ]);
  });
});

describe('context telemetry', () => {
  it('reports compile, sources, inclusion, exclusion and conflicts — metadata only', async () => {
    const logs = captureLogs();
    const memory = new FixtureMemory();
    memory.turn(at(0), 'CONTENT-MARKER says B', { assertions: [{ subject: 'record:1.status', value: 'B' }] });
    await compile({ memory, logger: logs.logger, sources: [staticSource('fixture.state', [stateItem('record:1.status', 'A'), { ...stateItem('record:1.key', 'x'), sensitivity: 'SECRET' }])] });

    expect(logs.events('context.compile.started')).toHaveLength(1);
    expect(logs.events('context.source.loaded').map((e) => e.sourceId)).toEqual([
      'platform.agent', 'platform.task', 'platform.run', 'platform.goal', 'platform.capability', 'platform.observation', 'platform.memory', 'fixture.state',
    ]);
    expect(logs.events('context.item.included').length).toBeGreaterThan(0);
    expect(logs.events('context.item.excluded')).toEqual([expect.objectContaining({ exclusionReason: 'sensitivity', count: 1, taskId: TASK.taskId, iteration: 1 })]);
    expect(logs.events('context.conflict.detected')).toEqual([expect.objectContaining({ subject: 'record:1.status', resolvedByAuthority: true })]);
    for (const event of logs.events('context.item.included')) {
      expect(event).toEqual(expect.objectContaining({ taskId: TASK.taskId, runId: expect.any(String), agentId: 'kernel-probe', iteration: 1, sourceId: expect.any(String), itemKind: expect.any(String), authority: expect.any(String), freshness: expect.any(String), estimatedTokens: expect.any(Number) }));
    }
    expect(logs.raw()).not.toContain('CONTENT-MARKER');
    expect(logs.raw()).not.toContain(TASK.input.factKey as string);
  });

  it('reports budget exhaustion', async () => {
    const logs = captureLogs();
    await compiler({ policy: { budget: fixed(50) }, logger: logs.logger }).compile(request());
    expect(logs.events('context.budget.exhausted')).toEqual([expect.objectContaining({ maxEstimatedTokens: 50, requiredTokens: expect.any(Number) })]);
  });
});
