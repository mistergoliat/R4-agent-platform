import { describe, expect, it } from 'vitest';
import { agentDecisionSchema, uuidv7 } from '@r4/contracts';
import { AGENT_DECISION_JSON_SCHEMA, DECISION_PROTOCOL, PROTOCOL_INSTRUCTIONS, buildExecutionState, renderModelRequest } from '@r4/agent-kernel';
import { contextOf } from '../../support/decisions.js';
import { MemorySession, READ_FACT, WRITE_THING } from '../../support/kernel-fixtures.js';

describe('minimal execution context', () => {
  it('is rebuilt purely from durable pieces (same input, same context)', async () => {
    const session = new MemorySession();
    const a = await session.load();
    const b = await session.load();
    expect(a).toEqual(b);
    expect(a.context.iteration).toBe(1);
    expect(a.pendingRead).toBeNull();
  });

  it('derives usage from the step log, including READs awaiting observation', async () => {
    const session = new MemorySession();
    await session.recordStep({ runId: session.run.runId, iteration: 1, decision: { type: 'respond', content: 'a' }, outcome: 'recorded', error: null, usage: { inputTokens: 10, outputTokens: 5 } });
    const pending = await session.recordStep({ runId: session.run.runId, iteration: 2, decision: { type: 'read_capability', capabilityId: READ_FACT.capabilityId, arguments: {} }, outcome: 'pending', error: null, usage: { inputTokens: 1, outputTokens: 1 } });
    const state = await session.load();
    expect(state.context.budget.usage).toMatchObject({ iterations: 2, modelCalls: 2, readCapabilityCalls: 1, tokens: 17 });
    expect(state.context.iteration).toBe(3);
    expect(state.pendingRead?.step.stepId).toBe(pending.stepId);
    expect(state.context.responses).toEqual([{ iteration: 1, content: 'a' }]);
  });

  it('measures elapsed time from the run start, across owners', () => {
    const session = new MemorySession();
    const state = buildExecutionState({
      agent: session.agent,
      task: session.task,
      run: session.run,
      goal: { goalId: uuidv7(), taskId: session.task.taskId, parentGoalId: null, description: 'g', successCriteria: [], status: 'active', origin: 'requester', correlationId: 'c', version: 1, createdAt: session.run.startedAt, updatedAt: session.run.startedAt },
      steps: [],
      observations: [],
      capabilities: [],
      policy: { maxIterations: 1, maxModelCalls: 1, maxReadCapabilityCalls: 1, maxRunDurationMs: 1_000, modelCallTimeoutMs: 1 },
      now: new Date(Date.parse(session.run.startedAt) + 1_234),
    });
    expect(state.context.budget.usage.elapsedMs).toBe(1_234);
  });
});

describe('model request rendering', () => {
  // R4-C2: the context travels structured (the compiled context of the snapshot), never as one prompt string.
  it('is provider-neutral and carries the compiled context structured, next to the protocol instructions', async () => {
    const session = new MemorySession({ capabilities: [READ_FACT, WRITE_THING] });
    const { context } = await session.load();
    const prepared = await session.prepareContext(context);
    if (prepared.kind !== 'ready') throw new Error('context not ready');
    const request = renderModelRequest(context, prepared.context, 1_000);

    expect(request.outputContract).toEqual({ kind: 'json', name: 'agent_decision', schema: AGENT_DECISION_JSON_SCHEMA });
    expect(request.tools).toBeUndefined();
    expect(request.limits).toEqual({ timeoutMs: 1_000 });
    expect(request.correlation).toEqual({ correlationId: session.task.correlationId, taskId: session.task.taskId, runId: session.run.runId, agentId: session.agent.agentId });
    // Only the kernel's protocol is text; the agent's instructions are a context item.
    expect(request.messages).toEqual([{ role: 'system', content: PROTOCOL_INSTRUCTIONS }]);
    expect(request.messages[0]!.content).toContain(DECISION_PROTOCOL);
    expect(request.messages[0]!.content).not.toContain(session.agent.instructions);
    expect(request.context).toBe(prepared.context);
    expect(request.context!.sections.agent[0]!.content).toMatchObject({ instructions: session.agent.instructions });

    const doc = contextOf(request);
    expect(doc.iteration).toBe(1);
    expect(doc.task.taskId).toBe(session.task.taskId);
    // Write-class capabilities are never offered.
    expect(doc.capabilities.map((c) => c.capabilityId)).toEqual([READ_FACT.capabilityId]);
  });

  it('exposes a JSON Schema derived from the AgentDecision contract', () => {
    expect(AGENT_DECISION_JSON_SCHEMA).toHaveProperty('oneOf');
    expect(JSON.stringify(AGENT_DECISION_JSON_SCHEMA)).toContain('read_capability');
    expect(agentDecisionSchema.safeParse({ type: 'respond', content: 'x' }).success).toBe(true);
  });
});
