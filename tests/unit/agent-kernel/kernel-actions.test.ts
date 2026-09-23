import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@r4/contracts';
import { AgentKernel, checkBeforeWrite, parseAgentDecision, resolveExecutionLimits, type DecisionValidationContext } from '@r4/agent-kernel';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript, type ModelResponse } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { contextOf, propose, read, sequence, completeFromObservations } from '../../support/decisions.js';
import { MemorySession, READ_FACT, TEST_POLICY, WRITE_THING, type MemorySessionOptions } from '../../support/kernel-fixtures.js';

const WRITES = { policy: { maxWriteActions: 3 } } as const;

function kernelWith(script: FakeModelScript) {
  const provider = new FakeModelProvider(script);
  const logger = createSilentLogger();
  return { provider, kernel: new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger }), logger }) };
}

async function run(script: FakeModelScript, options: MemorySessionOptions = {}) {
  const session = new MemorySession({ ...WRITES, ...options });
  const { kernel, provider } = kernelWith(script);
  const outcome = await kernel.run(session);
  return { session, provider, outcome };
}

function response(structuredData: unknown): ModelResponse {
  return { content: null, toolCalls: [], structuredData, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop', latencyMs: 1, provider: { providerId: 'fake', modelId: 'fake', requestId: null } };
}

describe('decision parser: propose_action', () => {
  const observationId = uuidv7();
  const context: DecisionValidationContext = { capabilities: [READ_FACT, WRITE_THING], observationIds: new Set([observationId]) };

  it('accepts a proposal of a granted write capability with known evidence', () => {
    expect(parseAgentDecision(response({ type: 'propose_action', capabilityId: WRITE_THING.capabilityId, arguments: { v: 1 }, evidenceRefs: [observationId] }), context)).toMatchObject({ ok: true });
  });

  it.each([
    ['an unknown capability', { type: 'propose_action', capabilityId: 'platform_test.nope', arguments: {} }, 'unknown_capability'],
    ['a READ capability', { type: 'propose_action', capabilityId: READ_FACT.capabilityId, arguments: {} }, 'capability_not_permitted'],
    ['invented evidence', { type: 'propose_action', capabilityId: WRITE_THING.capabilityId, arguments: {}, evidenceRefs: [uuidv7()] }, 'unknown_evidence'],
    ['a trusted field', { type: 'propose_action', capabilityId: WRITE_THING.capabilityId, arguments: {}, executionKey: 'mine' }, 'invalid_decision_schema'],
  ])('rejects %s', (_name, data, code) => {
    expect(parseAgentDecision(response(data), context)).toMatchObject({ ok: false, error: { code } });
  });
});

describe('kernel: propose_action goes only through the session (platform)', () => {
  it('records a pending step with a platform proposal id, hands it to the platform, continues with the observation', async () => {
    const { session, outcome, provider } = await run(sequence([propose(WRITE_THING.capabilityId, { v: 1 }), completeFromObservations('written')]));
    expect(outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });
    expect(session.actions).toEqual([{ type: 'propose_action', capabilityId: WRITE_THING.capabilityId, arguments: { v: 1 } }]);
    expect(session.steps[0]).toMatchObject({ outcome: 'observed', proposalId: expect.any(String) });
    // The action observation reached the next model call.
    expect(contextOf(provider.requests[1]!).observations).toHaveLength(1);
  });

  it('a platform suspension ends the loop as reported, without another model call', async () => {
    const { outcome, provider } = await run(sequence([propose(WRITE_THING.capabilityId, {})]), {
      action: () => ({ suspend: { reason: 'approval_required', code: 'risk_class_requires_approval', message: 'needs a human', details: null } }),
    });
    expect(outcome).toEqual({ kind: 'terminated', termination: { reason: 'approval_required', code: 'risk_class_requires_approval', message: 'needs a human', details: null } });
    expect(provider.callCount).toBe(1);
  });

  it('write budget: refused BEFORE a proposal is recorded (budget_exhausted / max_write_actions)', async () => {
    const { session, outcome } = await run(sequence([propose(WRITE_THING.capabilityId, {}), propose(WRITE_THING.capabilityId, {})]), { policy: { maxWriteActions: 1 } });
    expect(outcome).toMatchObject({ termination: { reason: 'budget_exhausted', code: 'max_write_actions', details: { dimension: 'maxWriteActions', limit: 1, used: 1 } } });
    expect(session.actions).toHaveLength(1);
    expect(session.steps.map((s) => [s.outcome, s.proposalId !== null])).toEqual([
      ['observed', true],
      ['refused', false],
    ]);
  });

  it('task budget maxWrites tightens the operator ceiling; 0 writes by default', () => {
    expect(resolveExecutionLimits({ ...TEST_POLICY, maxWriteActions: 5 }, { maxWrites: 2 }).maxWriteActions).toBe(2);
    expect(resolveExecutionLimits({ ...TEST_POLICY, maxWriteActions: 1 }, { maxWrites: 9 }).maxWriteActions).toBe(1);
    expect(resolveExecutionLimits(TEST_POLICY, {}).maxWriteActions).toBe(0);
    const limits = resolveExecutionLimits({ ...TEST_POLICY, maxWriteActions: 1 }, {});
    expect(checkBeforeWrite(limits, { iterations: 0, modelCalls: 0, readCapabilityCalls: 0, tokens: 0, elapsedMs: 0, writeActions: 0 })).toBeNull();
    expect(checkBeforeWrite(limits, { iterations: 0, modelCalls: 0, readCapabilityCalls: 0, tokens: 0, elapsedMs: 0, writeActions: 1 })).toMatchObject({ dimension: 'maxWriteActions' });
  });

  it('recovery: a pending proposal is resolved by the platform before the model is asked anything', async () => {
    const session = new MemorySession(WRITES);
    const first = kernelWith(sequence([propose(WRITE_THING.capabilityId, { v: 1 })]));
    session.failNext.executeAction = new (await import('@r4/agent-kernel')).KernelInterrupt('lease_lost');
    expect(await first.kernel.run(session)).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    expect(session.steps[0]).toMatchObject({ outcome: 'pending' });

    const second = kernelWith(sequence([completeFromObservations('recovered')]));
    expect(await second.kernel.run(session)).toMatchObject({ termination: { reason: 'completed' } });
    expect(second.provider.callCount).toBe(1);
    expect(session.actions).toHaveLength(1);
    expect(contextOf(second.provider.requests[0]!).observations).toHaveLength(1);
  });

  it('an unresolvable platform error ends the run as a platform fault — never as "the action failed"', async () => {
    const session = new MemorySession(WRITES);
    session.failNext.executeAction = new Error('ledger unreachable');
    const { kernel } = kernelWith(sequence([propose(WRITE_THING.capabilityId, {})]));
    expect(await kernel.run(session)).toMatchObject({ termination: { reason: 'internal_failure', code: 'action_execution_error' } });
  });

  it('the kernel never offers or executes a write itself: READ path unchanged, writes visible only with a write budget', async () => {
    const withoutBudget = await run(sequence([read(READ_FACT.capabilityId, {}), completeFromObservations()]), { policy: { maxWriteActions: 0 } });
    expect(contextOf(withoutBudget.provider.requests[0]!).capabilities.map((c) => c.capabilityId)).toEqual([READ_FACT.capabilityId]);
    const withBudget = await run(sequence([read(READ_FACT.capabilityId, {}), completeFromObservations()]));
    expect(contextOf(withBudget.provider.requests[0]!).capabilities.map((c) => [c.capabilityId, (c as { riskClass?: string }).riskClass])).toEqual([
      [READ_FACT.capabilityId, 'READ'],
      [WRITE_THING.capabilityId, 'REVERSIBLE_WRITE'],
    ]);
    expect(withBudget.session.actions).toEqual([]);
  });
});
