import { describe, expect, it } from 'vitest';
import { AgentKernel, KernelInterrupt } from '@r4/agent-kernel';
import type { ResponseAuthorityInput, ResponseAuthorityValidator, ResponseAuthorityVerdict } from '@r4/contracts';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { complete, respond } from '../../support/decisions.js';
import { MemorySession, READ_FACT, type MemorySessionOptions } from '../../support/kernel-fixtures.js';

/**
 * ADR-031: the pre-respond authority boundary of the kernel, with a scripted
 * (domain-free) validator. The kernel only enforces the verdicts' bounds.
 */
class ScriptedValidator implements ResponseAuthorityValidator {
  readonly seen: ResponseAuthorityInput[] = [];
  constructor(readonly verdicts: (input: ResponseAuthorityInput, call: number) => ResponseAuthorityVerdict) {}
  validate(input: ResponseAuthorityInput): ResponseAuthorityVerdict {
    this.seen.push(input);
    return this.verdicts(input, this.seen.length);
  }
  degraded(): string {
    return 'safe degraded reply';
  }
}

async function run(script: FakeModelScript, validator: ResponseAuthorityValidator, options: MemorySessionOptions = {}) {
  const logger = createSilentLogger();
  const provider = new FakeModelProvider(script);
  const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger }), logger, responseAuthority: validator });
  const session = new MemorySession(options);
  const outcome = await kernel.run(session);
  return { outcome, session, provider };
}

const summary = (session: MemorySession) => session.steps.map((s) => [s.decision?.type ?? null, s.outcome, s.origin, s.error?.code ?? null]);

describe('ADR-031 pre-respond authority boundary (kernel)', () => {
  it('ALLOW records the draft unchanged', async () => {
    const { session } = await run([respond('hola'), complete('done')], new ScriptedValidator(() => ({ kind: 'allow' })));
    expect(summary(session)).toEqual([
      ['respond', 'recorded', 'model', null],
      ['complete', 'recorded', 'model', null],
    ]);
  });

  it('REVALIDATION_REQUIRED issues token-free platform READs, then keeps the same draft when the truth is unchanged', async () => {
    const validator = new ScriptedValidator((input, call) =>
      call === 1 ? { kind: 'revalidation_required', reads: [{ capabilityId: READ_FACT.capabilityId, arguments: { factKey: 'p1' } }] } : { kind: 'allow' },
    );
    const { session, provider } = await run([respond('precio $84.990'), complete('done')], validator);
    expect(summary(session)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'recorded', 'model', null],
      ['complete', 'recorded', 'model', null],
    ]);
    expect(session.steps[0]!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(session.steps[1]!.decision).toEqual({ type: 'respond', content: 'precio $84.990' });
    // The second check saw the refreshed observation; no extra model call was made for the READ.
    expect(validator.seen[1]!.observations).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
  });

  it('REJECT records the draft refused (never said), feeds the feedback back, and allows one corrected draft', async () => {
    const validator = new ScriptedValidator((input) => (input.content.includes('hay stock') ? { kind: 'reject', code: 'response_authority_contradiction', feedback: 'P187 is out_of_stock' } : { kind: 'allow' }));
    const { session, provider } = await run([respond('hay stock de 24 kg'), respond('la de 24 kg está sin stock'), complete('done')], validator);
    expect(summary(session)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'recorded', 'model', null],
      ['complete', 'recorded', 'model', null],
    ]);
    const second = JSON.stringify(provider.requests[1]);
    expect(second).toContain('response.not_sent');
    expect(second).toContain('P187 is out_of_stock');
  });

  it('after one correction cycle, a still-invalid draft is refused and the safe degradation is recorded by the platform (no loop)', async () => {
    const validator = new ScriptedValidator(() => ({ kind: 'reject', code: 'response_authority_contradiction', feedback: 'still wrong' }));
    const { session, provider } = await run([respond('bad 1'), respond('bad 2'), complete('done')], validator);
    expect(summary(session)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'refused', 'model', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['complete', 'recorded', 'model', null],
    ]);
    expect(session.steps[1]!.decision).toEqual({ type: 'respond', content: 'bad 2' });
    expect(session.steps[2]!.decision).toEqual({ type: 'respond', content: 'safe degraded reply' });
    expect(session.steps[2]!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(provider.requests).toHaveLength(3);
  });

  it('evidence that cannot be revalidated is never sent as current: the draft is refused (unverifiable)', async () => {
    const validator = new ScriptedValidator(() => ({ kind: 'revalidation_required', reads: [{ capabilityId: READ_FACT.capabilityId, arguments: {} }] }));
    const { session } = await run([respond('precio $1'), respond('sin precios'), complete('done')], validator, { read: () => ({ outcome: 'failed', payload: null, errorCode: 'handler_error' }) });
    expect(summary(session)[1]).toEqual(['respond', 'refused', 'model', 'response_authority_unverifiable']);
    // The corrected draft is checked again (one refresh per candidate), then degraded.
    expect(session.steps.at(-2)!.decision).toEqual({ type: 'respond', content: 'safe degraded reply' });
  });

  it('platform READs are not model calls in the budget', async () => {
    const validator = new ScriptedValidator((_i, call) => (call === 1 ? { kind: 'revalidation_required', reads: [{ capabilityId: READ_FACT.capabilityId, arguments: {} }] } : { kind: 'allow' }));
    const { session } = await run([respond('x'), complete('done')], validator);
    expect(() => session.load()).toThrow(); // the run ended
    expect(session.steps.filter((s) => s.origin === 'model')).toHaveLength(2);
    expect(session.steps.filter((s) => s.origin === 'platform')).toHaveLength(1);
  });
});

/**
 * R4-J1E-R2 (ADR-031): near-expiry evidence is revalidated after the owner's
 * window (durable wait/wake, never a sleep); the recovery budget is the run's.
 */
const NOT_BEFORE = '2026-01-01T00:00:03.250Z';
const refreshed = (input: ResponseAuthorityInput) =>
  input.observations.some((o) => o.outcome === 'succeeded' && o.source.kind === 'capability' && o.source.capabilityId === READ_FACT.capabilityId);
const nearExpiry = (then: ResponseAuthorityVerdict = { kind: 'allow' }) =>
  new ScriptedValidator((input) => (refreshed(input) ? then : { kind: 'revalidation_required', notBefore: NOT_BEFORE, reads: [{ capabilityId: READ_FACT.capabilityId, arguments: { factKey: 'p1' } }] }));
const said = (session: MemorySession) => session.steps.filter((s) => s.decision?.type === 'respond' && s.outcome === 'recorded').map((s) => (s.decision as { content: string }).content);
/** Every step names a snapshot of its OWN iteration (the durable FK the in-memory session mirrors). */
const snapshotsOwnIteration = (session: MemorySession) =>
  session.steps.filter((s) => s.contextSnapshotId !== null).every((s) => session.snapshots.some((x) => x.snapshotId === s.contextSnapshotId && x.iteration === s.iteration));
const failedRead = () => ({ outcome: 'failed' as const, payload: null, errorCode: 'handler_error' });

async function wake(previous: MemorySession, script: FakeModelScript, validator: ResponseAuthorityValidator, resolution: 'timer' | 'input' | 'handoff' = 'timer', options: MemorySessionOptions = {}) {
  const logger = createSilentLogger();
  const provider = new FakeModelProvider(script);
  const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger }), logger, responseAuthority: validator });
  const session = MemorySession.continueFrom(previous, resolution, options);
  const outcome = await kernel.run(session);
  return { outcome, session, provider };
}

describe('R4-J1E-R2 near-expiry: notBefore → durable wait → wake → revalidate', () => {
  it('A. evidence inside the owner window but too close: no immediate refresh; the draft is deferred and the run waits until notBefore', async () => {
    const { outcome, session, provider } = await run([respond('precio $84.990')], nearExpiry(), { temporal: true });
    expect(summary(session)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_deferred'],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(session.reads).toHaveLength(0); // no owner call inside the cached window
    expect(session.waits).toEqual([{ type: 'wait', condition: { kind: 'WAIT_UNTIL', until: NOT_BEFORE }, reason: expect.any(String) }]);
    expect(session.steps[1]!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'waiting' } });
    expect(said(session)).toEqual([]); // nothing reaches outbound while waiting
    expect(provider.requests).toHaveLength(1);
    expect(snapshotsOwnIteration(session)).toBe(true);
  });

  it('B/L. wake + new window + unchanged truth: the SAME draft is recorded by the platform without a model call, against its own iteration snapshot', async () => {
    const first = await run([respond('precio $84.990')], nearExpiry(), { temporal: true });
    const { session, provider } = await wake(first.session, [complete('done')], nearExpiry());
    expect(summary(session)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'recorded', 'platform', null],
      ['complete', 'recorded', 'model', null],
    ]);
    expect(said(session)).toEqual(['precio $84.990']);
    expect(session.steps[1]!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(provider.requests).toHaveLength(1); // only the decision after the reply
    expect(session.steps[1]!.contextSnapshotId).not.toBeNull();
    expect(snapshotsOwnIteration(session)).toBe(true);
    expect(JSON.stringify(provider.requests[0])).toContain('precio $84.990'); // the model sees it as said
  });

  it('C. wake + material change: the draft is refused, the model corrects it once, the corrected reply is sent', async () => {
    const first = await run([respond('hay stock: $84.990')], nearExpiry(), { temporal: true });
    const validator = new ScriptedValidator((input) =>
      !refreshed(input)
        ? { kind: 'revalidation_required', notBefore: NOT_BEFORE, reads: [{ capabilityId: READ_FACT.capabilityId, arguments: {} }] }
        : input.content.includes('hay stock')
          ? { kind: 'reject', code: 'response_authority_contradiction', feedback: 'now out_of_stock' }
          : { kind: 'allow' },
    );
    const { session, provider } = await wake(first.session, [respond('ahora está sin stock'), complete('done')], validator);
    expect(summary(session)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'refused', 'platform', 'response_authority_contradiction'],
      ['respond', 'recorded', 'model', null],
      ['complete', 'recorded', 'model', null],
    ]);
    expect(said(session)).toEqual(['ahora está sin stock']);
    expect(JSON.stringify(provider.requests[0])).toContain('now out_of_stock');
    expect(snapshotsOwnIteration(session)).toBe(true);
  });

  it('D. wake + refresh failure: nothing is sent as current; the corrected draft is deferred once more, then one safe degradation', async () => {
    const first = await run([respond('precio $84.990')], nearExpiry(), { temporal: true });
    const second = await wake(first.session, [respond('sigue en $84.990')], nearExpiry(), 'timer', { read: failedRead });
    expect(summary(second.session)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'refused', 'platform', 'response_authority_unverifiable'],
      ['respond', 'refused', 'model', 'response_authority_deferred'],
      ['wait', 'recorded', 'platform', null],
    ]);
    const third = await wake(second.session, [complete('done')], nearExpiry(), 'timer', { read: failedRead });
    expect(summary(third.session)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'refused', 'platform', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['complete', 'recorded', 'model', null],
    ]);
    expect([...said(first.session), ...said(second.session), ...said(third.session)]).toEqual(['safe degraded reply']);
  });

  it('a draft is deferred at most once: woken early (input), it is refreshed immediately instead of waiting again', async () => {
    const first = await run([respond('precio $84.990')], nearExpiry(), { temporal: true });
    const { session } = await wake(first.session, [complete('done')], nearExpiry(), 'input');
    expect(summary(session).slice(0, 2)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'recorded', 'platform', null],
    ]);
    expect(session.waits).toHaveLength(0);
  });

  it('a human takeover drops the deferred draft: it is never sent afterwards', async () => {
    const first = await run([respond('precio $84.990')], nearExpiry(), { temporal: true });
    const { session, provider } = await wake(first.session, [complete('done')], nearExpiry(), 'handoff');
    expect(summary(session)).toEqual([['complete', 'recorded', 'model', null]]);
    expect(provider.requests).toHaveLength(1);
  });

  it('without a temporal runtime the evidence is refreshed immediately (previous behaviour)', async () => {
    const { session } = await run([respond('precio $84.990'), complete('done')], nearExpiry());
    expect(summary(session)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'recorded', 'model', null],
      ['complete', 'recorded', 'model', null],
    ]);
  });

  it('M. crash between the deferral and its wait: the restarted loop records only the wait (the intent survives, the draft is not re-drafted)', async () => {
    const logger = createSilentLogger();
    const validator = nearExpiry();
    const session = new MemorySession({ temporal: true });
    session.failNext.executeTemporal = new KernelInterrupt('unavailable');
    const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider: new FakeModelProvider([respond('precio $84.990')]), logger }), logger, responseAuthority: validator });
    expect(await kernel.run(session)).toEqual({ kind: 'interrupted', cause: 'unavailable' });
    expect(summary(session)).toEqual([['respond', 'refused', 'model', 'response_authority_deferred']]);
    // A new worker process: fresh kernel, same durable state, no model left to ask.
    const again = new AgentKernel({ gateway: new DefaultModelGateway({ provider: new FakeModelProvider([]), logger }), logger, responseAuthority: validator });
    expect(await again.run(session)).toMatchObject({ kind: 'terminated', termination: { reason: 'waiting' } });
    expect(summary(session)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_deferred'],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(session.reads).toHaveLength(0);
  });
});

describe('R4-J1E-R2 run-scoped recovery budget', () => {
  const alwaysReject = () => new ScriptedValidator(() => ({ kind: 'reject', code: 'response_authority_contradiction', feedback: 'wrong' }));

  it('J. one safe degradation per run: a later invalid draft of the same run is refused, never another degradation outbound', async () => {
    const { session } = await run([respond('bad 1'), respond('bad 2'), respond('bad 3'), respond('bad 4'), complete('done')], alwaysReject());
    expect(summary(session)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'refused', 'model', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['complete', 'recorded', 'model', null],
    ]);
    expect(said(session)).toEqual(['safe degraded reply']);
    expect(session.steps[3]!.error?.message).toContain('already sent its safe fallback reply');
  });

  it('a valid reply between drafts does not reset the run budget (the budget is not per draft)', async () => {
    const validator = new ScriptedValidator((input) => (input.content.startsWith('bad') ? { kind: 'reject', code: 'response_authority_contradiction', feedback: 'wrong' } : { kind: 'allow' }));
    const { session } = await run([respond('bad 1'), respond('ok'), respond('bad 2'), respond('bad 3'), complete('done')], validator);
    expect(said(session)).toEqual(['ok', 'safe degraded reply']);
    expect(summary(session).filter(([, , , code]) => code === 'response_authority_degraded')).toHaveLength(1);
  });

  it('K. a new run (woken by customer input) starts with a fresh budget', async () => {
    const waitForInput = { type: 'structured' as const, data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' } } };
    const first = await run([respond('bad 1'), respond('bad 2'), waitForInput], alwaysReject(), { temporal: true });
    expect(said(first.session)).toEqual(['safe degraded reply']);
    const { session } = await wake(first.session, [respond('bad 3'), respond('bad 4'), complete('done')], alwaysReject(), 'input');
    expect(summary(session)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'refused', 'model', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['complete', 'recorded', 'model', null],
    ]);
  });

  it('a run woken from a revalidation wait continues the budget of the run that deferred (no extra correction cycle)', async () => {
    // Run 1: draft 1 rejected (the correction is used); the corrected draft is near expiry → deferred.
    const validator1 = new ScriptedValidator((input) =>
      input.content === 'bad'
        ? { kind: 'reject', code: 'response_authority_contradiction', feedback: 'wrong' }
        : { kind: 'revalidation_required', notBefore: NOT_BEFORE, reads: [{ capabilityId: READ_FACT.capabilityId, arguments: {} }] },
    );
    const first = await run([respond('bad'), respond('corrected')], validator1, { temporal: true });
    expect(summary(first.session).map(([, , , code]) => code)).toEqual(['response_authority_contradiction', 'response_authority_deferred', null]);
    // Run 2: after the refresh the truth changed → no second correction: the run's one degradation.
    const { session } = await wake(first.session, [complete('done')], nearExpiry({ kind: 'reject', code: 'response_authority_contradiction', feedback: 'changed' }));
    expect(summary(session)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'refused', 'platform', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['complete', 'recorded', 'model', null],
    ]);
  });

  it('a degradation interrupted after its refused draft is completed on restart (exactly one degradation)', async () => {
    const logger = createSilentLogger();
    const session = new MemorySession();
    const recordStep = session.recordStep.bind(session);
    let interrupted = false;
    session.recordStep = (record) => {
      if (!interrupted && record.origin === 'platform' && record.decision?.type === 'respond') {
        interrupted = true;
        return Promise.reject(new KernelInterrupt('unavailable'));
      }
      return recordStep(record);
    };
    const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider: new FakeModelProvider([respond('bad 1'), respond('bad 2'), complete('done')]), logger }), logger, responseAuthority: alwaysReject() });
    expect(await kernel.run(session)).toEqual({ kind: 'interrupted', cause: 'unavailable' });
    await kernel.run(session);
    expect(summary(session)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'refused', 'model', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['complete', 'recorded', 'model', null],
    ]);
  });
});
