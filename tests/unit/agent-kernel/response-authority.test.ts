import { describe, expect, it } from 'vitest';
import { AgentKernel } from '@r4/agent-kernel';
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

  it('after one correction cycle, a still-invalid draft is replaced by the safe degradation (no loop)', async () => {
    const validator = new ScriptedValidator(() => ({ kind: 'reject', code: 'response_authority_contradiction', feedback: 'still wrong' }));
    const { session, provider } = await run([respond('bad 1'), respond('bad 2'), complete('done')], validator);
    expect(summary(session)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'recorded', 'model', null],
      ['complete', 'recorded', 'model', null],
    ]);
    expect(session.steps[1]!.decision).toEqual({ type: 'respond', content: 'safe degraded reply' });
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
