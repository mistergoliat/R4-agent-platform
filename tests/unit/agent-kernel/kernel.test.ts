import { describe, expect, it } from 'vitest';
import { AgentKernel, KernelInterrupt, type KernelOutcome } from '@r4/agent-kernel';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { complete, completeFromObservations, contextOf, read, respond, sequence } from '../../support/decisions.js';
import { MemorySession, READ_FACT, WRITE_THING, type MemorySessionOptions } from '../../support/kernel-fixtures.js';
import { captureLogs } from '../../support/logs.js';

function kernelWith(script: FakeModelScript, logger = createSilentLogger()) {
  const provider = new FakeModelProvider(script);
  return { kernel: new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger }), logger }), provider };
}

async function runWith(script: FakeModelScript, options: MemorySessionOptions = {}) {
  const { kernel, provider } = kernelWith(script);
  const session = new MemorySession(options);
  const outcome = await kernel.run(session);
  return { outcome, session, provider };
}

const terminated = (outcome: KernelOutcome) => (outcome.kind === 'terminated' ? outcome.termination : null);

describe('kernel loop: READ → observation → next iteration → COMPLETE', () => {
  it('feeds the observation back to the model and completes citing it', async () => {
    const { outcome, session, provider } = await runWith(sequence([read(READ_FACT.capabilityId, { factKey: 'alpha' }), completeFromObservations('found')]));

    expect(terminated(outcome)).toMatchObject({ reason: 'completed' });
    expect(session.steps.map((s) => [s.iteration, s.decision?.type, s.outcome])).toEqual([
      [1, 'read_capability', 'observed'],
      [2, 'complete', 'recorded'],
    ]);
    expect(session.reads).toHaveLength(1);
    // Iteration 2 was built from state that contains the observation.
    expect(contextOf(provider.requests[1]!).observations.map((o) => o.observationId)).toEqual([session.observations[0]!.observationId]);
    expect(session.ending?.result).toMatchObject({ summary: 'found', evidence: [session.observations[0]!.observationId] });
  });

  it('offers only READ capabilities to the model', async () => {
    const { provider } = await runWith([complete('nothing to do')]);
    expect(contextOf(provider.requests[0]!).capabilities.map((c) => c.capabilityId)).toEqual([READ_FACT.capabilityId]);
  });

  it('records respond and keeps looping, showing the agent its own responses', async () => {
    const { outcome, session, provider } = await runWith([respond('interim note'), complete('done')]);
    expect(terminated(outcome)?.reason).toBe('completed');
    expect(session.steps.map((s) => s.outcome)).toEqual(['recorded', 'recorded']);
    expect(contextOf(provider.requests[1]!).responses).toEqual([{ iteration: 1, content: 'interim note' }]);
  });

  it('feeds failed capability outcomes back as evidence instead of ending the run', async () => {
    const { outcome, session } = await runWith(sequence([read(READ_FACT.capabilityId, {}), completeFromObservations('could not read')]), {
      read: () => ({ outcome: 'failed', payload: null, errorCode: 'handler_error' }),
    });
    expect(terminated(outcome)?.reason).toBe('completed');
    expect(session.observations[0]).toMatchObject({ outcome: 'failed', error: { code: 'handler_error' } });
  });
});

describe('kernel termination mapping', () => {
  it.each([
    ['provider error', [{ type: 'provider_error' as const, message: 'boom' }], 'model_failure', 'provider_error'],
    ['rate limit', [{ type: 'provider_error' as const, kind: 'rate_limited' as const, retryable: true }], 'model_failure', 'rate_limited'],
    ['malformed provider response', [{ type: 'malformed' as const, raw: { nope: true } }], 'model_failure', 'invalid_provider_response'],
    ['non-JSON output', [{ type: 'text' as const, content: 'Sure! Reading now.' }], 'invalid_decision', 'invalid_structured_output'],
    ['unknown decision type', [{ type: 'structured' as const, data: { type: 'delegate' } }], 'invalid_decision', 'unknown_decision_type'],
    ['schema violation', [{ type: 'structured' as const, data: { type: 'respond' } }], 'invalid_decision', 'invalid_decision_schema'],
    ['unknown capability', [read('platform_test.unknown', {})], 'invalid_decision', 'unknown_capability'],
    ['write-class capability', [read(WRITE_THING.capabilityId, {})], 'invalid_decision', 'capability_not_permitted'],
  ])('%s → %s (%s)', async (_name, script, reason, code) => {
    const { outcome, session } = await runWith(script);
    expect(terminated(outcome)).toMatchObject({ reason, code });
    // The failed iteration is recorded atomically with the ending, never executed.
    expect(session.ending?.finalStep).toMatchObject({ iteration: 1, decision: null });
    expect(session.reads).toEqual([]);
  });

  it('times out a model call using the policy timeout', async () => {
    const { outcome } = await runWith([{ type: 'timeout', ignoreAbort: true }], { policy: { modelCallTimeoutMs: 50 } });
    expect(terminated(outcome)).toMatchObject({ reason: 'model_failure', code: 'timeout' });
  });

  it('never executes a write-class capability', async () => {
    const { session } = await runWith([read(WRITE_THING.capabilityId, { anything: true })]);
    expect(session.reads).toEqual([]);
    expect(session.observations).toEqual([]);
  });
});

describe('kernel budgets', () => {
  const readForever: FakeModelScript = () => read(READ_FACT.capabilityId, { factKey: 'alpha' });

  it('stops infinite READs deterministically at the READ budget', async () => {
    const { outcome, session } = await runWith(readForever, { policy: { maxReadCapabilityCalls: 3 } });
    expect(terminated(outcome)).toMatchObject({ reason: 'budget_exhausted', code: 'max_read_capability_calls', details: { dimension: 'maxReadCapabilityCalls', limit: 3, used: 3 } });
    expect(session.reads).toHaveLength(3);
    expect(session.steps.map((s) => s.outcome)).toEqual(['observed', 'observed', 'observed', 'refused']);
  });

  it('stops at maxIterations before calling the model again', async () => {
    const { outcome, provider } = await runWith(() => respond('again'), { policy: { maxIterations: 4 } });
    expect(terminated(outcome)).toMatchObject({ reason: 'budget_exhausted', code: 'max_iterations' });
    expect(provider.callCount).toBe(4);
  });

  it('honors a tighter task budget', async () => {
    const { outcome, provider } = await runWith(() => respond('again'), { task: { ...new MemorySession().task, budget: { maxModelCalls: 2 } } });
    expect(terminated(outcome)).toMatchObject({ reason: 'budget_exhausted', code: 'max_model_calls' });
    expect(provider.callCount).toBe(2);
  });

  it('stops when the run duration is exhausted', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { outcome } = await runWith(
      () => {
        now += 40_000;
        return respond('slow');
      },
      { now: () => new Date(now) },
    );
    expect(terminated(outcome)).toMatchObject({ reason: 'budget_exhausted', code: 'max_run_duration_ms' });
  });

  it('is iterative: hundreds of iterations do not grow the stack', async () => {
    const { outcome, provider } = await runWith(() => respond('tick'), { policy: { maxIterations: 400, maxModelCalls: 400 } });
    expect(terminated(outcome)?.code).toBe('max_iterations');
    expect(provider.callCount).toBe(400);
  });
});

describe('kernel recovery and interruption', () => {
  it('executes a pending READ from a previous owner without asking the model again', async () => {
    const { kernel, provider } = kernelWith(sequence([completeFromObservations('resumed')]));
    const session = new MemorySession();
    // Durable state as a crashed worker left it: READ decided, not observed.
    await session.recordStep({ runId: session.run.runId, iteration: 1, decision: { type: 'read_capability', capabilityId: READ_FACT.capabilityId, arguments: { factKey: 'alpha' } }, outcome: 'pending', error: null, usage: { inputTokens: 1, outputTokens: 1 } });

    const outcome = await kernel.run(session);
    expect(terminated(outcome)?.reason).toBe('completed');
    expect(session.reads).toHaveLength(1);
    expect(provider.callCount).toBe(1);
    expect(session.steps[0]).toMatchObject({ iteration: 1, outcome: 'observed' });
  });

  it('continues from persisted observations: a new kernel instance needs only the session', async () => {
    const session = new MemorySession();
    const first = kernelWith(sequence([read(READ_FACT.capabilityId, { factKey: 'alpha' })]));
    // First "worker" dies after the observation: its next load is refused.
    const out1 = await first.kernel.run({
      load: () => session.load(),
      recordStep: (s) => session.recordStep(s),
      executeRead: async (s, d) => {
        const o = await session.executeRead(s, d);
        session.failNext.load = new KernelInterrupt('lease_lost');
        return o;
      },
      finish: (e) => session.finish(e),
    });
    expect(out1).toEqual({ kind: 'interrupted', cause: 'lease_lost' });

    const second = kernelWith(sequence([completeFromObservations('continued')]));
    const out2 = await second.kernel.run(session);
    expect(terminated(out2)?.reason).toBe('completed');
    expect(session.reads).toHaveLength(1);
    expect(second.provider.callCount).toBe(1);
  });

  it('stops without writing when the session reports lease loss', async () => {
    const { kernel } = kernelWith([read(READ_FACT.capabilityId, {})]);
    const session = new MemorySession();
    session.failNext.recordStep = new KernelInterrupt('lease_lost');
    expect(await kernel.run(session)).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    expect(session.ending).toBeNull();
    expect(session.steps).toEqual([]);
  });

  it('does not record a model result that arrives after the signal aborted', async () => {
    const controller = new AbortController();
    const { kernel } = kernelWith(() => {
      controller.abort(new KernelInterrupt('lease_lost'));
      return complete('too late');
    });
    const session = new MemorySession();
    expect(await kernel.run(session, { signal: controller.signal })).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    expect(session.ending).toBeNull();
  });

  it('stops before the first call when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new KernelInterrupt('stopped'));
    const { kernel, provider } = kernelWith([complete('x')]);
    expect(await kernel.run(new MemorySession(), { signal: controller.signal })).toEqual({ kind: 'interrupted', cause: 'stopped' });
    expect(provider.callCount).toBe(0);
  });

  it('classifies an execution port that cannot produce evidence as capability_failure', async () => {
    const { kernel } = kernelWith([read(READ_FACT.capabilityId, {})]);
    const session = new MemorySession();
    session.failNext.executeRead = new Error('capability runtime crashed');
    expect(terminated(await kernel.run(session))).toMatchObject({ reason: 'capability_failure', code: 'capability_execution_error' });
  });

  it('classifies unexpected session faults as internal_failure', async () => {
    const { kernel } = kernelWith([respond('x')]);
    const session = new MemorySession();
    session.failNext.recordStep = new Error('constraint violated');
    expect(terminated(await kernel.run(session))).toMatchObject({ reason: 'internal_failure' });
  });

  it('records internal_failure when the platform refuses an ending', async () => {
    const { kernel } = kernelWith([complete('done')]);
    const session = new MemorySession();
    session.failNext.finish = new Error('ending violates a constraint');
    expect(terminated(await kernel.run(session))).toMatchObject({ reason: 'internal_failure', code: 'ending_refused', details: { refusedReason: 'completed' } });
    expect(session.ending?.finalStep).toBeNull();
  });

  it('leaves the run resumable when the ending cannot be recorded', async () => {
    const { kernel } = kernelWith([complete('done')]);
    const session = new MemorySession();
    session.failNext.finish = new KernelInterrupt('unavailable');
    expect(await kernel.run(session)).toEqual({ kind: 'interrupted', cause: 'unavailable' });
  });
});

describe('kernel telemetry', () => {
  it('emits structured metadata only — no prompt, output or observation content', async () => {
    const logs = captureLogs();
    const provider = new FakeModelProvider(sequence([read(READ_FACT.capabilityId, { factKey: 'SECRET-ARG' }), completeFromObservations('SECRET-SUMMARY')]));
    const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger: logs.logger }), logger: logs.logger });
    const session = new MemorySession();
    await kernel.run(session, { workerId: 'w-1' });

    const decisions = logs.events('agent.decision');
    expect(decisions.map((e) => e.decisionType)).toEqual(['read_capability', 'complete']);
    for (const event of [...decisions, ...logs.events('capability.invoked')]) {
      expect(event).toMatchObject({ taskId: session.task.taskId, runId: session.run.runId, agentId: session.agent.agentId, workerId: 'w-1' });
      expect(typeof event.iteration).toBe('number');
    }
    expect(logs.raw()).not.toContain('SECRET');
    expect(logs.raw()).not.toContain(session.agent.instructions);
  });
});
