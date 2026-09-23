import { describe, expect, it } from 'vitest';
import type { AgentDecision, Goal, HumanRequest, RunStep, TaskWait, TemporalEvent } from '@r4/contracts';
import type { CompiledResult, CompileOutcome, ContextCompileRequest, InteractionFacts } from '@r4/context-compiler';
import { AGENT, GOAL, HOUR, MINUTE, RUN, TASK, at, compiler, fixed, newId, request } from '../../fixtures/context/builders.js';

/**
 * R4-E platform sources, in isolation: the cross-run interaction projection
 * and the goal source. They only map durable records; selection, budget and
 * compaction stay the compiler's (C2) — nothing is forced into the context.
 */
const EARLIER_RUN = '0190e7a0-0000-7000-8000-0000000000e1';

function step(runId: string, iteration: number, decision: AgentDecision, createdAt: string, outcome: RunStep['outcome'] = 'recorded', error: RunStep['error'] = null): RunStep {
  return {
    stepId: newId(), runId, taskId: TASK.taskId, iteration, leaseGeneration: 1, decision, outcome, error, invocationId: null, observationId: null,
    contextSnapshotId: null, proposalId: null, usage: { inputTokens: 0, outputTokens: 0 }, correlationId: 'c', createdAt, completedAt: createdAt,
  };
}
function consultation(createdAt: string, question: string): HumanRequest {
  return { requestId: newId(), taskId: TASK.taskId, runId: EARLIER_RUN, kind: 'consultation', status: 'answered', humanRef: 'operator-one', createdAt, updatedAt: createdAt, expiresAt: null, correlationId: 'c', payload: { question, contextRefs: [] } };
}
function answer(request: HumanRequest, occurredAt: string, content: string): TemporalEvent {
  return { eventId: newId(), taskId: TASK.taskId, entityId: request.requestId, type: 'consultation.answered', occurredAt, correlationId: 'c', actorRef: 'operator-one', responseKey: 'k', data: { content, outcome: 'answer', status: 'answered', requestHash: 'h' } };
}
function wait(runId: string, createdAt: string, completedAt: string): TaskWait {
  return { waitId: newId(), taskId: TASK.taskId, runId, kind: 'WAIT_FOR_INPUT', status: 'completed', resolution: 'input', referenceId: null, dueAt: null, createdAt, completedAt, correlationId: 'c' };
}
function withFacts(base: ContextCompileRequest, facts: { interactions?: InteractionFacts; goals?: Goal[]; currentGoalId?: string }): ContextCompileRequest {
  return {
    ...base,
    execution: {
      ...base.execution,
      ...(facts.goals ? { goals: facts.goals } : {}),
      ...(facts.interactions ? { interactions: facts.interactions } : {}),
      ...(facts.currentGoalId ? { task: { ...TASK, currentGoalId: facts.currentGoalId } } : {}),
    },
  };
}
function compiled(outcome: CompileOutcome): CompiledResult {
  if (outcome.kind !== 'compiled') throw new Error(`expected a compiled context, got ${outcome.kind}`);
  return outcome;
}

function conversationFacts(turns = 1): InteractionFacts {
  const steps: RunStep[] = [];
  const humans: HumanRequest[] = [];
  const responses: TemporalEvent[] = [];
  for (let i = 0; i < turns; i += 1) {
    steps.push(step(EARLIER_RUN, 2 * i + 1, { type: 'respond', content: `Earlier question ${i}?` }, at(i * MINUTE)));
    const request = consultation(at(i * MINUTE + 10_000), `Consult ${i}?`);
    humans.push(request);
    responses.push(answer(request, at(i * MINUTE + 20_000), `Answer ${i}.`));
  }
  steps.push(step(EARLIER_RUN, 2 * turns + 1, { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'need an answer' }, at(turns * MINUTE)));
  // The current run's own respond comes from platform.run, never twice.
  steps.push(step(RUN.runId, 1, { type: 'respond', content: 'Current run says hi.' }, at(turns * MINUTE + 30_000)));
  return { steps, humans, responses, waits: [wait(EARLIER_RUN, at(turns * MINUTE), at(turns * MINUTE + 25_000))] };
}

describe('interaction projection (platform.interaction)', () => {
  it('projects earlier-run agent turns, human questions and answers, and waits — with their authority and provenance', async () => {
    const facts = conversationFacts();
    const result = compiled(await compiler({ policy: { budget: { mode: 'unbounded' } } }).compile(withFacts(request({ now: at(HOUR) }), { interactions: facts })));
    const conversation = result.compiled.sections.conversation.filter((i) => i.sourceId === 'platform.interaction');
    expect(conversation.map((i) => (i.content as { text: string }).text)).toEqual(['Earlier question 0?', 'Consult 0?', 'Answer 0.']);
    expect(conversation.every((i) => i.authority === 'CONVERSATIONAL')).toBe(true);
    expect(conversation[2]).toMatchObject({ provenance: { recordType: 'temporal_event', producedBy: 'user:operator-one' }, content: { actor: { role: 'operator', ref: 'operator-one' } } });
    // The current run's respond is not duplicated by the projection.
    expect(JSON.stringify(result.compiled.sections.conversation)).not.toContain('Current run says hi.');
    const episodes = result.compiled.sections.episodicMemory.map((i) => i.content);
    expect(episodes).toContainEqual(expect.objectContaining({ event: 'task.wait', kind: 'WAIT_FOR_INPUT', resolution: 'input', statedReason: 'need an answer' }));
    expect(result.compiled.sections.authoritativeState).toEqual([]); // human text is never authoritative state
  });

  it('competes for a bounded budget like any conversation: under FIXED(N) old interaction turns are dropped, never forced', async () => {
    const facts = conversationFacts(60);
    const bounded = compiled(await compiler({ policy: { budget: fixed(3_000) }, compactor: null }).compile(withFacts(request({ now: at(2 * HOUR) }), { interactions: facts })));
    const projected = bounded.decisions.filter((d) => d.sourceId === 'platform.interaction' && d.kind === 'conversation_turn');
    expect(projected.length).toBe(180);
    expect(projected.filter((d) => d.decision === 'excluded' && d.reason === 'budget').length).toBeGreaterThan(0);
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(3_000);
    // The most recent turns are the ones kept, without gaps.
    const kept = bounded.compiled.sections.conversation.map((i) => (i.content as { text: string }).text);
    expect(kept.at(-1)).toBe('Answer 59.');
    const unbounded = compiled(await compiler({ policy: { budget: { mode: 'unbounded' } } }).compile(withFacts(request({ now: at(2 * HOUR) }), { interactions: facts })));
    expect(unbounded.decisions.filter((d) => d.sourceId === 'platform.interaction' && d.decision === 'excluded')).toEqual([]);
  });

  it('shows refused goal changes as observed evidence the agent can recover from', async () => {
    const refused = step(RUN.runId, 1, { type: 'manage_goal', change: { operation: 'focus', goalId: GOAL.goalId } }, at(MINUTE), 'refused', { code: 'goal_not_active', message: 'closed' });
    const result = compiled(await compiler().compile(withFacts(request(), { interactions: { steps: [refused], humans: [], responses: [], waits: [] } })));
    expect(result.compiled.sections.episodicMemory.map((i) => i.content)).toEqual([expect.objectContaining({ event: 'goal.change.rejected', code: 'goal_not_active' })]);
  });

  it('is deterministic: the same records yield the same items and fingerprint', async () => {
    const facts = conversationFacts(3);
    const a = compiled(await compiler().compile(withFacts(request(), { interactions: facts })));
    const b = compiled(await compiler().compile(withFacts(request(), { interactions: structuredClone(facts) })));
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.compiled).toEqual(a.compiled);
  });
});

describe('goal source with several goals (R4-E)', () => {
  const child = (status: Goal['status'], description: string): Goal => ({ ...GOAL, goalId: newId(), parentGoalId: GOAL.goalId, description, status, origin: 'agent', createdAt: at(MINUTE), updatedAt: at(2 * MINUTE) });

  it('marks root and current focus; active goals are live and required, closed ones are history episodes', async () => {
    const focus = child('active', 'Current focus');
    const closed = child('achieved', 'Incidental, done');
    const result = compiled(await compiler({ policy: { budget: fixed(3_000) } }).compile(withFacts(request(), { goals: [GOAL, focus, closed], currentGoalId: focus.goalId })));
    expect(result.compiled.sections.goals.map((i) => [i.itemId, i.authority, (i.content as { isRoot: boolean }).isRoot, (i.content as { isCurrent: boolean }).isCurrent])).toEqual([
      [`goal:${GOAL.goalId}`, 'AUTHORITATIVE', true, false],
      [`goal:${focus.goalId}`, 'COGNITIVE', false, true],
    ]);
    expect(result.compiled.sections.episodicMemory).toEqual([expect.objectContaining({ itemId: `goal_history:${closed.goalId}`, authority: 'OBSERVED', content: expect.objectContaining({ event: 'goal.achieved' }) })]);
    expect(result.decisions.find((d) => d.itemId === `goal_history:${closed.goalId}`)?.kind).toBe('episode');
  });

  it('keeps a closed current focus visible as a goal (so the agent sees it must refocus)', async () => {
    const closed = child('achieved', 'Done but still focused');
    const result = compiled(await compiler().compile(withFacts(request(), { goals: [GOAL, closed], currentGoalId: closed.goalId })));
    expect(result.compiled.sections.goals.map((i) => (i.content as { status: string; isCurrent: boolean }))).toContainEqual(expect.objectContaining({ status: 'achieved', isCurrent: true }));
  });

  it('with a single goal the item shape is unchanged from C2', async () => {
    const result = compiled(await compiler().compile(withFacts(request(), { goals: [GOAL] })));
    expect(Object.keys(result.compiled.sections.goals[0]!.content as object).sort()).toEqual(['description', 'goalId', 'origin', 'status', 'successCriteria']);
    expect(AGENT.agentId).toBeTruthy();
  });
});
