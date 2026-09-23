// Child process for tests/recovery/temporal-process-crash.test.ts.
// A real worker process (built @r4/worker) whose only job here is to pick up
// DISPATCHED reconciliation work. Its reconcile handler reports the execution
// key it was given and then never answers, so the parent can SIGKILL the
// process in the middle of reconciliation. Test-only.
import { z } from 'zod';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { FakeModelProvider } from '@r4/model-gateway';
import { loadWorkerConfig, runWorkerProcess } from '@r4/worker';

const capabilities = new CapabilityRegistry();
capabilities.registerWrite({
  definition: {
    capabilityId: 'platform_test.set_test_record',
    version: 1,
    description: 'Sets the value of a generic test record in the test ledger (optionally only at an expected version). Test-only.',
    owner: 'platform-test',
    riskClass: 'REVERSIBLE_WRITE',
    requiredScopes: ['platform_test.write'],
    identityRequirement: 'none',
    confirmationPolicy: 'none',
    approvalPolicy: 'none',
    idempotency: 'key_required',
    retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
    timeoutMs: 300000,
    freshnessTtlMs: null,
    auditLevel: 'full',
  },
  recovery: 'idempotent_replay',
  input: z.strictObject({ recordKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), value: z.string().max(200), expectedVersion: z.int().nonnegative().optional() }),
  output: z.strictObject({ recordKey: z.string(), version: z.int().positive(), value: z.string() }),
  execute: async () => {
    throw new Error('the reconciling process must never execute a write');
  },
  reconcile: async (context) => {
    process.stdout.write(`${JSON.stringify({ event: 'child.reconcile.started', executionKey: context.executionKey })}\n`);
    return new Promise(() => undefined);
  },
});

// The model is never called: reconciliation is not cognition.
const modelProvider = new FakeModelProvider(() => {
  process.stdout.write(`${JSON.stringify({ event: 'child.model.called' })}\n`);
  return { type: 'timeout' };
});

await runWorkerProcess(loadWorkerConfig(process.env), { modelProvider, capabilities });
