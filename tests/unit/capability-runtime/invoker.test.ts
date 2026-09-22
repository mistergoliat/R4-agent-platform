import { describe, expect, it, vi } from 'vitest';
import { observationSchema, type TrustedExecutionContext } from '@r4/contracts';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';
import { GET_TEST_FACT_ID, getTestFactCapability } from '../../fixtures/capabilities/get-test-fact.js';

const context: TrustedExecutionContext = {
  taskId: '0190a0a0-0000-7000-8000-00000000000a',
  runId: '0190a0a0-0000-7000-8000-00000000000b',
  agentId: 'platform-probe',
  agentVersion: 1,
  correlationId: 'corr-cap',
  grantedScopes: ['platform_test.read'],
};

function setup(...registrations: ReturnType<typeof getTestFactCapability>[]) {
  const clock = new FakeClock();
  const registry = new CapabilityRegistry();
  for (const r of registrations) registry.register(r);
  const store = new InMemoryObservationStore();
  const invoker = new CapabilityInvoker({ registry, observations: store, ids: idsFrom(clock), clock, logger: createSilentLogger() });
  return { invoker, store, clock, registry };
}

describe('CapabilityInvoker (invocation contract)', () => {
  it('executes a granted READ capability and records a successful observation', async () => {
    const { invoker, store, clock } = setup(getTestFactCapability());
    const observation = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'platform.name' } }, context);

    expect(observationSchema.safeParse(observation).success).toBe(true);
    expect(observation).toMatchObject({
      taskId: context.taskId,
      runId: context.runId,
      agentId: 'platform-probe',
      outcome: 'succeeded',
      payload: { factKey: 'platform.name', found: true, value: 'R4' },
      error: null,
      correlationId: 'corr-cap',
      source: { kind: 'capability', capabilityId: GET_TEST_FACT_ID, capabilityVersion: 1 },
      observedAt: clock.now().toISOString(),
      validUntil: new Date(clock.now().getTime() + 60_000).toISOString(),
    });
    expect(observation.provenance).toMatchObject({ owner: 'platform-test', riskClass: 'READ', attempts: 1 });
    expect(store.byInvocation.size).toBe(1);
  });

  it('records a found=false fact as data, not as an error', async () => {
    const { invoker } = setup(getTestFactCapability());
    const o = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'unknown.key' } }, context);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { found: false, value: null } });
  });

  it('rejects unknown capabilities observably (model may propose names that do not exist)', async () => {
    const { invoker } = setup(getTestFactCapability());
    const o = await invoker.invoke({ capabilityId: 'Totally Made Up!', arguments: {} }, context);
    expect(o).toMatchObject({ outcome: 'rejected', payload: null, error: { code: 'capability_not_found' }, source: { capabilityId: 'Totally Made Up!', capabilityVersion: null } });
    expect(o.provenance).toMatchObject({ attempts: 0 });
  });

  it('denies capabilities outside the granted scopes without running the handler', async () => {
    const handler = vi.fn();
    const { invoker } = setup(getTestFactCapability(handler));
    const o = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, { ...context, grantedScopes: [] });
    expect(o).toMatchObject({ outcome: 'rejected', error: { code: 'scope_denied', details: { requiredScopes: ['platform_test.read'] } } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses to execute non-READ capabilities (writes need the governed action path)', async () => {
    const handler = vi.fn();
    const base = getTestFactCapability(handler);
    const write = { ...base, definition: { ...base.definition, capabilityId: 'platform_test.set_fact', riskClass: 'REVERSIBLE_WRITE' as const, idempotency: 'key_required' as const } };
    const { invoker } = setup(write);
    const o = await invoker.invoke({ capabilityId: 'platform_test.set_fact', arguments: { factKey: 'alpha' } }, context);
    expect(o).toMatchObject({ outcome: 'rejected', error: { code: 'execution_not_permitted' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['missing field', {}],
    ['wrong type', { factKey: 42 }],
    ['extra field', { factKey: 'alpha', sql: 'drop table' }],
    ['pattern violation', { factKey: '../../etc/passwd' }],
    ['not an object', 'alpha'],
  ])('rejects invalid arguments (%s) with structured issues', async (_label, args) => {
    const handler = vi.fn();
    const { invoker } = setup(getTestFactCapability(handler));
    const o = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: args }, context);
    expect(o.outcome).toBe('rejected');
    expect(o.error?.code).toBe('invalid_arguments');
    expect(Array.isArray((o.error?.details as { issues: unknown[] }).issues)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('classifies handler exceptions as failed observations', async () => {
    const { invoker } = setup(getTestFactCapability(() => Promise.reject(new Error('backend exploded'))));
    const o = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context);
    expect(o).toMatchObject({ outcome: 'failed', error: { code: 'handler_error', message: 'backend exploded' } });
  });

  it('enforces the declared timeout', async () => {
    const base = getTestFactCapability(() => new Promise(() => undefined));
    const slow = { ...base, definition: { ...base.definition, timeoutMs: 20 } };
    const { invoker } = setup(slow);
    const o = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context);
    expect(o).toMatchObject({ outcome: 'failed', error: { code: 'timeout' } });
  });

  it('treats capability output as untrusted', async () => {
    const lying = getTestFactCapability(() => Promise.resolve({ factKey: 'alpha', found: 'yes', value: 1 } as never));
    const { invoker } = setup(lying);
    const o = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context);
    expect(o).toMatchObject({ outcome: 'failed', error: { code: 'invalid_capability_output' }, payload: null });
  });

  it('is idempotent per invocation id: a replay returns the recorded observation without re-executing', async () => {
    const handler = vi.fn(({ factKey }: { factKey: string }) => Promise.resolve({ factKey, found: false, value: null }));
    const { invoker } = setup(getTestFactCapability(handler));
    const invocationId = '0190a0a0-0000-7000-8000-0000000000ff';
    const first = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context, { invocationId });
    const second = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context, { invocationId });
    expect(second).toEqual(first);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed trusted context as a platform bug', async () => {
    const { invoker } = setup(getTestFactCapability());
    await expect(
      invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, { ...context, taskId: 'nope' }),
    ).rejects.toMatchObject({ kind: 'internal', code: 'invalid_execution_context' });
  });

  it('hands the handler only the platform-built execution context', async () => {
    let seen: unknown;
    const { invoker } = setup(
      getTestFactCapability((input, ctx) => {
        seen = ctx.execution;
        return Promise.resolve({ factKey: input.factKey, found: false, value: null });
      }),
    );
    await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context);
    expect(seen).toEqual(context);
  });
});
