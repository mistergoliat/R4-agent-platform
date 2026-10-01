import { describe, expect, it } from 'vitest';
import { AgentKernel, KernelInterrupt } from '@r4/agent-kernel';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { complete, read, respond } from '../../support/decisions.js';
import { MemorySession, READ_FACT } from '../../support/kernel-fixtures.js';

/**
 * R4-J1E-R2.2 — pure agent execution. A protocol-valid `respond` is recorded
 * exactly as the agent decided it (no semantic or commercial judge between it
 * and outbound) and is terminal for the turn: the platform closes the turn with
 * a token-free WAIT_FOR_INPUT (origin `platform`). No model call, READ or
 * second reply follows a response in its run.
 */
async function run(script: FakeModelScript, session = new MemorySession()) {
  const logger = createSilentLogger();
  const provider = new FakeModelProvider(script);
  const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger }), logger });
  const outcome = await kernel.run(session);
  return { outcome, session, provider };
}

const summary = (session: MemorySession) => session.steps.map((s) => [s.decision?.type ?? null, s.outcome, s.origin, s.error?.code ?? null]);
const said = (session: MemorySession) => session.steps.filter((s) => s.decision?.type === 'respond' && s.outcome === 'recorded').map((s) => (s.decision as { content: string }).content);
const turnWait = { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: expect.any(String) };

describe('R4-J1E-R2.2 respond is terminal for the turn', () => {
  it('respond → FIN: recorded as decided, then a platform WAIT_FOR_INPUT suspends the run; no further model call', async () => {
    const { outcome, session, provider } = await run([respond('hola, ¿en qué te ayudo?'), respond('never asked')]);
    expect(summary(session)).toEqual([
      ['respond', 'recorded', 'model', null],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(session.waits).toEqual([turnWait]);
    expect(session.steps[1]!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(provider.callCount).toBe(1);
    expect(outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'waiting' } });
    expect(said(session)).toEqual(['hola, ¿en qué te ayudo?']);
  });

  it('read → respond → FIN: the scripted decision after the response is never requested', async () => {
    const { session, provider } = await run([read(READ_FACT.capabilityId, { factKey: 'alpha' }), respond('alpha'), complete('never asked')]);
    expect(summary(session)).toEqual([
      ['read_capability', 'observed', 'model', null],
      ['respond', 'recorded', 'model', null],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(provider.callCount).toBe(2);
  });

  it('read → read → respond → FIN', async () => {
    const { session, provider } = await run([read(READ_FACT.capabilityId, { factKey: 'alpha' }), read(READ_FACT.capabilityId, { factKey: 'beta' }), respond('alpha y beta'), read(READ_FACT.capabilityId, { factKey: 'never' })]);
    expect(summary(session)).toEqual([
      ['read_capability', 'observed', 'model', null],
      ['read_capability', 'observed', 'model', null],
      ['respond', 'recorded', 'model', null],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(session.reads).toHaveLength(2); // no READ after the response
    expect(provider.callCount).toBe(3);
  });

  it('the turn-closing wait carries the drafting call\'s snapshot as input horizon (unseen input wakes the task again)', async () => {
    const { session } = await run([respond('listo')]);
    const response = session.steps[0]!;
    expect(response.contextSnapshotId).not.toBeNull();
    expect(session.steps[1]!.contextSnapshotId).toBeNull(); // the wait is a new iteration: no model call, no snapshot
    expect(session.waitHorizons).toEqual([response.contextSnapshotId]);
  });

  it('a protocol-valid response is never judged: any content is recorded unchanged, exactly once', async () => {
    const wrong = 'Sí, tenemos stock de la colchoneta 2da selección.';
    const { session } = await run([read(READ_FACT.capabilityId, { factKey: 'alpha' }), respond(wrong)]);
    expect(said(session)).toEqual([wrong]);
    expect(summary(session).filter(([, outcome]) => outcome === 'refused')).toEqual([]);
  });

  it('crash between the response and its wait: the restarted loop records only the wait (no model call, no second reply)', async () => {
    const logger = createSilentLogger();
    const session = new MemorySession();
    session.failNext.executeTemporal = new KernelInterrupt('unavailable');
    const first = new AgentKernel({ gateway: new DefaultModelGateway({ provider: new FakeModelProvider([respond('hola')]), logger }), logger });
    expect(await first.run(session)).toEqual({ kind: 'interrupted', cause: 'unavailable' });
    expect(summary(session)).toEqual([['respond', 'recorded', 'model', null]]);
    const resumed = new FakeModelProvider([respond('a second reply must never be asked for')]);
    const again = new AgentKernel({ gateway: new DefaultModelGateway({ provider: resumed, logger }), logger });
    expect(await again.run(session)).toMatchObject({ kind: 'terminated', termination: { reason: 'waiting' } });
    expect(summary(session)).toEqual([
      ['respond', 'recorded', 'model', null],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(resumed.callCount).toBe(0);
  });

  it('complete without a response still ends the task as before', async () => {
    const { outcome, session } = await run([read(READ_FACT.capabilityId, { factKey: 'alpha' }), complete('done')]);
    expect(outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });
    expect(session.waits).toHaveLength(0);
  });

  it('the turn-closing wait counts no model call in the budget', async () => {
    const { session } = await run([respond('x')]);
    expect(session.steps.filter((s) => s.origin === 'model')).toHaveLength(1);
    expect(session.steps.filter((s) => s.origin === 'platform')).toHaveLength(1);
    expect(() => session.load()).toThrow(); // the run is suspended
  });
});
