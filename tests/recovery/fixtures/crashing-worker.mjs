// Child process for tests/recovery/worker-process-crash.test.ts.
// A real worker process (built @r4/worker, real heartbeats) whose model READs
// the synthetic test fact once and then hangs forever, so the parent can
// SIGKILL it right after the observation is persisted. Test-only.
import { z } from 'zod';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { FakeModelProvider } from '@r4/model-gateway';
import { loadWorkerConfig, runWorkerProcess } from '@r4/worker';

const capabilities = new CapabilityRegistry();
capabilities.register({
  definition: {
    capabilityId: 'platform_test.get_test_fact',
    version: 1,
    description: 'Returns a fixed synthetic test fact by key. Test-only.',
    owner: 'platform-test',
    riskClass: 'READ',
    requiredScopes: ['platform_test.read'],
    identityRequirement: 'none',
    confirmationPolicy: 'none',
    approvalPolicy: 'none',
    idempotency: 'inherent',
    retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
    timeoutMs: 1000,
    freshnessTtlMs: 60000,
    auditLevel: 'standard',
  },
  input: z.strictObject({ factKey: z.string() }),
  output: z.strictObject({ factKey: z.string(), found: z.boolean(), value: z.string().nullable() }),
  handler: ({ factKey }) => {
    process.stdout.write(`${JSON.stringify({ event: 'child.handler.executed', factKey })}\n`);
    return Promise.resolve({ factKey, found: true, value: 'R4' });
  },
});

const modelProvider = new FakeModelProvider((_request, index) =>
  index === 0
    ? { type: 'structured', data: { type: 'read_capability', capabilityId: 'platform_test.get_test_fact', arguments: { factKey: 'platform.name' } } }
    : { type: 'timeout' },
);

await runWorkerProcess(loadWorkerConfig(process.env), { modelProvider, capabilities });
