import type { ContextContributionInput, Observation } from '@r4/contracts';
import type { ContextSource } from '@r4/context-compiler';
import { FixtureMemory, HOUR, MINUTE, at, observation, stateItem, staticSource, TASK } from './builders.js';

/**
 * Reusable, domain-neutral context scenarios (R4-C2). Each returns the
 * durable inputs of one compilation plus what a correct composition must
 * preserve. They are the seed of a future evaluation corpus: composition is
 * checked here, not conversational quality.
 */
export interface ContextScenario {
  readonly name: string;
  readonly memory: FixtureMemory;
  readonly sources: readonly ContextSource[];
  readonly observations: readonly Observation[];
  readonly now: string;
  /** Items that must be in the compiled context. */
  readonly mustInclude: readonly string[];
  /** Subjects whose current AUTHORITATIVE value must prevail in `conflicts`. */
  readonly authoritative: Readonly<Record<string, { readonly itemId: string; readonly value: unknown }>>;
}

const STATE_SOURCE = 'fixture.record_state';

/**
 * Long history: 600 turns (noise, a correction, recent on-topic turns), old
 * derived summaries, many observations (some expired), fresh and stale
 * authoritative facts.
 */
export function longHistory(): ContextScenario {
  const memory = new FixtureMemory();
  // 600 turns, one per minute; turn 300 is a claim that disagrees with the owner's state.
  for (let i = 0; i < 600; i += 1) {
    const text = i % 7 === 0 ? `noise ${i}: unrelated remark about weather and lunch plans ${'lorem '.repeat(8)}` : `turn ${i}: discussing record 42 and its next step ${'ipsum '.repeat(6)}`;
    memory.turn(at(i * MINUTE), text, i === 300 ? { assertions: [{ subject: 'record:42.status', value: 'closed' }] } : {});
  }
  // A correction near the end: said, not true until the owner changes it.
  memory.turn(at(599 * MINUTE + 30_000), 'correction: record 42 should be marked on_hold', { assertions: [{ subject: 'record:42.status', value: 'on_hold' }] });
  // Old derived summary covering the first 50 turns (produced by an older compactor run).
  const first50 = memory.entries.slice(0, 50);
  memory.add({
    memoryType: 'DERIVED_SUMMARY',
    occurredAt: first50.at(-1)!.occurredAt,
    content: {
      text: 'Old summary: record 42 was closed.',
      assertions: [{ subject: 'record:42.status', value: 'closed' }],
      derivation: {
        derivationKey: 'a'.repeat(64),
        compactorId: 'legacy',
        compactorVersion: '0',
        sourceItemIds: first50.map((e) => `memory:${e.entryId}`),
        fromObservedAt: first50[0]!.occurredAt,
        toObservedAt: first50.at(-1)!.occurredAt,
      },
    },
  });
  memory.add({ memoryType: 'WORKING', occurredAt: at(590 * MINUTE), content: { category: 'hypothesis', text: 'the next step depends on the owner status of record 42' } });
  memory.add({ memoryType: 'EPISODIC', occurredAt: at(200 * MINUTE), content: { event: 'capability_failed', text: 'the fact lookup timed out once', refs: [] } });

  const observations = Array.from({ length: 30 }, (_, i) =>
    observation(i + 1, at(i * 20 * MINUTE), { validUntil: i < 20 ? at(i * 20 * MINUTE + 10 * MINUTE) : at(12 * HOUR) }),
  );
  const state: ContextContributionInput[] = [
    stateItem('record:42.status', 'open', { required: true, version: 7 }),
    stateItem('record:42.owner', 'team-a', { version: 7 }),
    // A stale-but-valid fact and an expired one (point-in-time readings of the owner).
    stateItem('record:42.priority', 'high', { observedAt: at(9 * HOUR), validUntil: at(11 * HOUR) }),
    stateItem('record:42.eta', '2026-01-03', { observedAt: at(HOUR), validUntil: at(2 * HOUR) }),
  ];
  return {
    name: 'long_history',
    memory,
    sources: [staticSource(STATE_SOURCE, state)],
    observations,
    now: at(10 * HOUR + 5 * MINUTE),
    mustInclude: ['state:record:42.status', `goal:${TASK.currentGoalId}`, `task:${TASK.taskId}`, `memory:${memory.entries[600]!.entryId}`],
    authoritative: { 'record:42.status': { itemId: 'state:record:42.status', value: 'open' } },
  };
}

/** Correction: the requester corrects an earlier statement; both remain what was said. */
export function correction(): ContextScenario {
  const memory = new FixtureMemory();
  memory.turn(at(0), 'the preferred channel is email', { assertions: [{ subject: 'record:7.channel', value: 'email' }] });
  memory.turn(at(MINUTE), 'sorry, correction: the preferred channel is phone', { assertions: [{ subject: 'record:7.channel', value: 'phone' }] });
  return {
    name: 'correction',
    memory,
    sources: [staticSource(STATE_SOURCE, [stateItem('record:7.channel', 'email', { version: 2 })])],
    observations: [],
    now: at(2 * MINUTE),
    mustInclude: memory.entries.map((e) => `memory:${e.entryId}`),
    authoritative: { 'record:7.channel': { itemId: 'state:record:7.channel', value: 'email' } },
  };
}

/** Stale evidence: an expired observation is history, a fresh one is current. */
export function staleEvidence(): ContextScenario {
  return {
    name: 'stale_evidence',
    memory: new FixtureMemory(),
    sources: [],
    observations: [observation(1, at(0), { validUntil: at(10 * MINUTE), payload: { level: 3 } }), observation(2, at(30 * MINUTE), { validUntil: at(2 * HOUR), payload: { level: 5 } })],
    now: at(HOUR),
    mustInclude: ['observation:0190e7a2-0000-7000-8000-000000000001', 'observation:0190e7a2-0000-7000-8000-000000000002'],
    authoritative: {},
  };
}

/** Conflicting state: the owner says A, the conversation says B, a summary says C. */
export function conflictingState(): ContextScenario {
  const memory = new FixtureMemory();
  memory.turn(at(0), 'status is B now', { assertions: [{ subject: 'record:9.status', value: 'B' }] });
  return {
    name: 'conflicting_state',
    memory,
    sources: [staticSource(STATE_SOURCE, [stateItem('record:9.status', 'A', { required: true })])],
    observations: [],
    now: at(MINUTE),
    mustInclude: ['state:record:9.status', `memory:${memory.entries[0]!.entryId}`],
    authoritative: { 'record:9.status': { itemId: 'state:record:9.status', value: 'A' } },
  };
}

/** Irrelevant interruption: a burst of off-topic turns between on-topic ones. */
export function irrelevantInterruption(): ContextScenario {
  const memory = new FixtureMemory();
  for (let i = 0; i < 10; i += 1) memory.turn(at(i * MINUTE), `on-topic ${i}: record 5 needs review`);
  for (let i = 10; i < 70; i += 1) memory.turn(at(i * MINUTE), `interruption ${i}: ${'unrelated chatter '.repeat(10)}`);
  for (let i = 70; i < 75; i += 1) memory.turn(at(i * MINUTE), `back on topic ${i}: record 5 review continues`);
  return {
    name: 'irrelevant_interruption',
    memory,
    sources: [],
    observations: [],
    now: at(80 * MINUTE),
    mustInclude: [`goal:${TASK.currentGoalId}`, ...memory.entries.slice(70).map((e) => `memory:${e.entryId}`)],
    authoritative: {},
  };
}

/** Goal continuity: hundreds of turns later, the goal is still there. */
export function goalContinuity(): ContextScenario {
  const memory = new FixtureMemory();
  for (let i = 0; i < 300; i += 1) memory.turn(at(i * MINUTE), `turn ${i} ${'filler '.repeat(20)}`);
  return { name: 'goal_continuity', memory, sources: [], observations: [], now: at(301 * MINUTE), mustInclude: [`goal:${TASK.currentGoalId}`, `task:${TASK.taskId}`], authoritative: {} };
}

/**
 * Summary degradation: the raw turns a summary was made from have expired,
 * the summary remains — and asserts a value the owner no longer holds.
 */
export function summaryDegradation(): ContextScenario {
  const memory = new FixtureMemory();
  const turns = Array.from({ length: 5 }, (_, i) =>
    memory.add({
      memoryType: 'CONVERSATIONAL',
      occurredAt: at(i * MINUTE),
      validUntil: at(6 * MINUTE),
      content: { actor: { role: 'requester', ref: 'participant-1' }, text: `turn ${i}`, interactionRef: 'interaction-1', assertions: i === 2 ? [{ subject: 'record:3.stage', value: 'draft' }] : [] },
    }),
  );
  const sourceItemIds = turns.map((t) => `memory:${t.entryId}`);
  memory.add({
    memoryType: 'DERIVED_SUMMARY',
    occurredAt: turns.at(-1)!.occurredAt,
    content: {
      text: 'Summary: record 3 is a draft.',
      assertions: [{ subject: 'record:3.stage', value: 'draft' }],
      derivation: {
        derivationKey: 'b'.repeat(64),
        compactorId: 'legacy',
        compactorVersion: '0',
        sourceItemIds,
        fromObservedAt: turns[0]!.occurredAt,
        toObservedAt: turns.at(-1)!.occurredAt,
      },
    },
  });
  return {
    name: 'summary_degradation',
    memory,
    sources: [staticSource(STATE_SOURCE, [stateItem('record:3.stage', 'published', { required: true, version: 4 })])],
    observations: [],
    now: at(10 * MINUTE),
    mustInclude: ['state:record:3.stage', 'summary:' + 'b'.repeat(64)],
    authoritative: { 'record:3.stage': { itemId: 'state:record:3.stage', value: 'published' } },
  };
}

export const SCENARIOS = [longHistory, correction, staleEvidence, conflictingState, irrelevantInterruption, goalContinuity, summaryDegradation];
