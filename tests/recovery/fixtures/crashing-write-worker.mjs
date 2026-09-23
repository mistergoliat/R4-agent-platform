// Child process for tests/recovery/governed-write-crash.test.ts.
// A real worker process (built @r4/worker, real heartbeats) whose model
// proposes ONE write to the generic test ledger. The write handler commits the
// effect in the ledger, reports it on stdout and then never answers, so the
// parent can SIGKILL the process after the external effect and BEFORE R4 could
// persist any receipt. Test-only.
import pg from 'pg';
import { z } from 'zod';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { FakeModelProvider } from '@r4/model-gateway';
import { loadWorkerConfig, runWorkerProcess } from '@r4/worker';

const ledger = new pg.Pool({ connectionString: process.env.R4_DATABASE_URL, max: 2 });

// Same ledger semantics as tests/fixtures/capabilities/test-ledger.ts (applyTestRecord):
// at most one effect per execution key. Kept minimal; the parent asserts on the ledger.
async function apply(input, executionKey) {
  const client = await ledger.connect();
  try {
    await client.query('begin');
    const claimed = await client.query(
      `insert into platform_test.operations (execution_key, record_key, outcome) values ($1, $2, 'pending') on conflict (execution_key) do nothing returning execution_key`,
      [executionKey, input.recordKey],
    );
    if (claimed.rowCount === 0) throw new Error('unexpected replay in the crashing process');
    await client.query('insert into platform_test.records (record_key) values ($1) on conflict (record_key) do nothing', [input.recordKey]);
    const updated = await client.query(
      'update platform_test.records set value = $2, version = version + 1, write_count = write_count + 1 where record_key = $1 returning version',
      [input.recordKey, input.value],
    );
    const result = { recordKey: input.recordKey, version: updated.rows[0].version, value: input.value };
    await client.query(`update platform_test.operations set outcome = 'applied', result = $2, applied_at = clock_timestamp() where execution_key = $1`, [executionKey, JSON.stringify(result)]);
    await client.query('commit');
    return result;
  } finally {
    client.release();
  }
}

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
    retryPolicy: { maxAttempts: 3, initialBackoffMs: 0 },
    timeoutMs: 300000,
    freshnessTtlMs: null,
    auditLevel: 'full',
  },
  recovery: 'idempotent_replay',
  input: z.strictObject({ recordKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), value: z.string().max(200), expectedVersion: z.int().nonnegative().optional() }),
  output: z.strictObject({ recordKey: z.string(), version: z.int().positive(), value: z.string() }),
  execute: async (input, context) => {
    const result = await apply(input, context.executionKey);
    process.stdout.write(`${JSON.stringify({ event: 'child.effect.committed', executionKey: context.executionKey, version: result.version })}\n`);
    // The network answer never arrives: the process is killed while waiting.
    return new Promise(() => undefined);
  },
});

const modelProvider = new FakeModelProvider((_request, index) =>
  index === 0
    ? { type: 'structured', data: { type: 'propose_action', capabilityId: 'platform_test.set_test_record', arguments: { recordKey: 'sigkill', value: 'once' } } }
    : { type: 'timeout' },
);

await runWorkerProcess(loadWorkerConfig(process.env), { modelProvider, capabilities });
