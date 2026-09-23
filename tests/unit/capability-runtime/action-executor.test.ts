import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { systemClock, uuidV7Generator, uuidv7, type ActionCommand, type PolicyDecision } from '@r4/contracts';
import { ActionExecutor, CapabilityInvoker, CapabilityRegistry, type WriteCapabilityRegistration, type WriteHandlerContext } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { executionKeyFor } from '@r4/task-runtime';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';

const T0 = '2026-01-01T00:00:00.000Z';
const input = z.strictObject({ key: z.string(), value: z.string() });
const output = z.strictObject({ key: z.string(), version: z.int() });

function write(overrides: Partial<WriteCapabilityRegistration<z.infer<typeof input>, z.infer<typeof output>>> = {}, timeoutMs = 200): WriteCapabilityRegistration<z.infer<typeof input>, z.infer<typeof output>> {
  return {
    definition: {
      capabilityId: 'test.set_thing',
      version: 1,
      description: 'test write',
      owner: 'test',
      riskClass: 'REVERSIBLE_WRITE',
      requiredScopes: ['test.write'],
      identityRequirement: 'none',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 2, initialBackoffMs: 0 },
      timeoutMs,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: 'idempotent_replay',
    input,
    output,
    execute: ({ key }) => Promise.resolve({ status: 'applied', result: { key, version: 1 } }),
    ...overrides,
  };
}

function authorized(overrides: { decision?: Partial<PolicyDecision>; command?: Partial<ActionCommand> } = {}) {
  const executionId = uuidv7();
  const proposalId = uuidv7();
  const decisionId = uuidv7();
  const command: ActionCommand = {
    executionId,
    proposalId,
    policyDecisionId: decisionId,
    taskId: uuidv7(),
    runId: uuidv7(),
    capabilityId: 'test.set_thing',
    capabilityVersion: 1,
    riskClass: 'REVERSIBLE_WRITE',
    executionKey: executionKeyFor(executionId),
    semantics: { recovery: 'idempotent_replay', reconcileSupported: false, maxAttempts: 2, initialBackoffMs: 0 },
    validatedArguments: { key: 'k', value: 'v' },
    trustedContext: { taskId: uuidv7(), runId: uuidv7(), agentId: 'probe', agentVersion: 1, correlationId: 'c', grantedScopes: ['test.write'], actor: { kind: 'service', ref: 's' }, identityAssurance: 'provisional' },
    correlationId: 'c',
    createdAt: T0,
    ...overrides.command,
  };
  const decision: PolicyDecision = {
    decisionId,
    proposalId,
    taskId: command.taskId,
    runId: command.runId,
    agentId: 'probe',
    agentVersion: 1,
    capabilityId: 'test.set_thing',
    capabilityVersion: 1,
    riskClass: 'REVERSIBLE_WRITE',
    outcome: 'allow',
    reasonCode: 'autonomous',
    rule: 'r',
    message: '',
    policy: { policyId: 'p', version: 1, hash: '0'.repeat(64), engineVersion: 'e' },
    identityAssurance: 'provisional',
    leaseGeneration: 1,
    correlationId: 'c',
    evaluatedAt: T0,
    ...overrides.decision,
  };
  return { command, decision };
}

function executorWith(registration: WriteCapabilityRegistration<z.infer<typeof input>, z.infer<typeof output>>) {
  const registry = new CapabilityRegistry();
  registry.registerWrite(registration);
  return new ActionExecutor({ registry, logger: createSilentLogger() });
}

describe('write registration', () => {
  it('requires a non-READ class, key-required idempotency and a declared strategy (reconcile for reconcile_before_retry)', () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.registerWrite(write({ definition: { ...write().definition, riskClass: 'READ' } }))).toThrow(/READ capabilities/);
    expect(() => registry.registerWrite(write({ definition: { ...write().definition, idempotency: 'unsupported' } }))).toThrow(/key_required/);
    expect(() => registry.registerWrite(write({ recovery: 'reconcile_before_retry' }))).toThrow(/reconcile handler/);
    expect(registry.registerWrite(write())).toMatchObject({ writeRecovery: 'idempotent_replay' });
  });

  it('the READ invoker cannot execute a registered write: rejected before any handler', async () => {
    let called = 0;
    const registry = new CapabilityRegistry();
    registry.registerWrite(write({ execute: () => { called += 1; return Promise.resolve({ status: 'applied', result: { key: 'k', version: 1 } }); } }));
    const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger() });
    const observation = await invoker.invoke({ capabilityId: 'test.set_thing', arguments: { key: 'k', value: 'v' } }, { taskId: uuidv7(), runId: uuidv7(), agentId: 'probe', agentVersion: 1, correlationId: 'c', grantedScopes: ['test.write'] });
    expect(observation).toMatchObject({ outcome: 'rejected', error: { code: 'execution_not_permitted' } });
    expect(called).toBe(0);
    // Even the READ handler slot of a write refuses.
    await expect(registry.resolve('test.set_thing')!.handler({}, { execution: {} as never, invocationId: 'x', signal: new AbortController().signal })).rejects.toThrow(/ActionExecutor/);
  });
});

describe('ActionExecutor.prepare (before policy)', () => {
  it('resolves and validates proposed arguments; never executes', () => {
    let called = 0;
    const executor = executorWith(write({ execute: () => { called += 1; return Promise.resolve({ status: 'applied', result: { key: 'k', version: 1 } }); } }));
    expect(executor.prepare({ capabilityId: 'test.set_thing', arguments: { key: 'k', value: 'v' } })).toMatchObject({ ok: true, validatedArguments: { key: 'k', value: 'v' }, semantics: { recovery: 'idempotent_replay', reconcileSupported: false, maxAttempts: 2 } });
    expect(executor.prepare({ capabilityId: 'test.nope', arguments: {} })).toMatchObject({ ok: false, cause: 'capability_not_found' });
    expect(executor.prepare({ capabilityId: 'test.set_thing', arguments: { key: 'k', value: 'v', grantedScopes: ['*'] } })).toMatchObject({ ok: false, cause: 'invalid_arguments' });
    expect(called).toBe(0);
  });

  it('READ capabilities are not actions', () => {
    const registry = new CapabilityRegistry();
    registry.register({ definition: { ...write().definition, capabilityId: 'test.read_thing', riskClass: 'READ', idempotency: 'inherent', retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 } }, input, output, handler: () => Promise.resolve({ key: 'k', version: 1 }) });
    expect(new ActionExecutor({ registry, logger: createSilentLogger() }).prepare({ capabilityId: 'test.read_thing', arguments: { key: 'k', value: 'v' } })).toMatchObject({ ok: false, cause: 'not_a_write' });
  });
});

describe('ActionExecutor.attempt: platform key, trusted context, conservative classification', () => {
  it('passes only the platform execution key and trusted context to the handler', async () => {
    const seen: WriteHandlerContext[] = [];
    const executor = executorWith(write({ execute: (args, context) => { seen.push(context); return Promise.resolve({ status: 'applied', result: { key: args.key, version: 3 }, resourceRef: 'thing:k', replayed: true }); } }));
    const a = authorized();
    const report = await executor.attempt(a, { attemptNumber: 1, kind: 'execute' });
    expect(report).toMatchObject({ outcome: 'applied', result: { key: 'k', version: 3 }, resourceRef: 'thing:k', replayed: true, errorCode: null });
    expect(seen[0]).toMatchObject({ executionKey: a.command.executionKey, execution: a.command.trustedContext, attempt: 1 });
  });

  it('replays with the SAME key; the key never changes across attempts', async () => {
    const keys: string[] = [];
    const executor = executorWith(write({ execute: (_args, context) => { keys.push(context.executionKey); return Promise.resolve({ status: 'unknown', message: 'no answer' }); } }));
    const a = authorized();
    await executor.attempt(a, { attemptNumber: 1, kind: 'execute' });
    await executor.attempt(a, { attemptNumber: 2, kind: 'replay' });
    expect(keys).toEqual([a.command.executionKey, a.command.executionKey]);
  });

  it.each([
    ['a thrown error', write({ execute: () => Promise.reject(new Error('socket hang up')) }), 'handler_error'],
    ['a timeout', write({ execute: () => new Promise(() => undefined) }, 30), 'timeout'],
    ['an explicit unknown', write({ execute: () => Promise.resolve({ status: 'unknown', message: '?' }) }), 'domain_unknown'],
    ['output violating its schema', write({ execute: () => Promise.resolve({ status: 'applied', result: { key: 1 } as never }) }), 'invalid_capability_output'],
    ['an answer outside the write contract', write({ execute: () => Promise.resolve({ ok: true } as never) }), 'invalid_capability_output'],
    ['"not_applied" from an execution', write({ execute: () => Promise.resolve({ status: 'not_applied' } as never) }), 'invalid_capability_output'],
  ])('%s is UNKNOWN — never success, never failure', async (_name, registration, code) => {
    const report = await executorWith(registration).attempt(authorized(), { attemptNumber: 1, kind: 'execute' });
    expect(report).toMatchObject({ outcome: 'unknown', errorCode: code, result: null });
  });

  it('domain rejections and failures are definitive and carry the domain code', async () => {
    const rejected = await executorWith(write({ execute: () => Promise.resolve({ status: 'rejected', code: 'version_conflict', message: 'stale', details: { current: 4 } }) })).attempt(authorized(), { attemptNumber: 1, kind: 'execute' });
    expect(rejected).toMatchObject({ outcome: 'rejected', errorCode: 'version_conflict', details: { current: 4 } });
    const failed = await executorWith(write({ execute: () => Promise.resolve({ status: 'failed', code: 'refused', message: 'no' }) })).attempt(authorized(), { attemptNumber: 1, kind: 'execute' });
    expect(failed).toMatchObject({ outcome: 'failed', errorCode: 'refused' });
  });

  it('reconciliation can establish not_applied; a failing reconciler is unknown', async () => {
    const reconcilable = (answer: () => Promise<unknown>) => write({ recovery: 'reconcile_before_retry', reconcile: answer as never });
    const a = authorized({ command: { semantics: { recovery: 'reconcile_before_retry', reconcileSupported: true, maxAttempts: 2, initialBackoffMs: 0 } } });
    expect(await executorWith(reconcilable(() => Promise.resolve({ status: 'not_applied' }))).attempt(a, { attemptNumber: 2, kind: 'reconcile' })).toMatchObject({ outcome: 'not_applied' });
    expect(await executorWith(reconcilable(() => Promise.reject(new Error('down')))).attempt(a, { attemptNumber: 2, kind: 'reconcile' })).toMatchObject({ outcome: 'unknown', errorCode: 'reconciliation_error' });
  });

  it('refuses to call a handler for a command not backed by the matching ALLOW decision', async () => {
    let called = 0;
    const registration = write({ execute: () => { called += 1; return Promise.resolve({ status: 'applied', result: { key: 'k', version: 1 } }); } });
    for (const decision of [{ outcome: 'deny' as const }, { outcome: 'require_approval' as const }, { decisionId: uuidv7() }, { proposalId: uuidv7() }, { capabilityId: 'test.other' }]) {
      const report = await executorWith(registration).attempt(authorized({ decision }), { attemptNumber: 1, kind: 'execute' });
      expect(report).toMatchObject({ outcome: 'unknown', errorCode: 'command_not_authorized' });
    }
    // A command whose capability no longer matches (class or strategy) does not execute either.
    expect(await executorWith(registration).attempt(authorized({ command: { riskClass: 'FINANCIAL' } }), { attemptNumber: 1, kind: 'execute' })).toMatchObject({ errorCode: 'capability_changed' });
    expect(called).toBe(0);
  });
});
