import { z } from 'zod';
import type { RiskClass, WriteRecoveryStrategy } from '@r4/contracts';
import type { WriteCapabilityRegistration, WriteHandlerContext } from '@r4/capability-runtime';
import type { Pool } from '@r4/persistence-postgres';

/**
 * Test-only, domain-neutral "external" system: a ledger of generic test
 * records living in its own schema (`platform_test`) of the test database —
 * created here, never by an R4 migration. It stands in for a domain owner:
 * it applies at most one effect per platform execution key (unique key),
 * returns the original outcome when the same key is executed again
 * (idempotent replay), can be queried by key (reconciliation), and enforces
 * an optional `expectedVersion` itself (optimistic concurrency is the
 * domain's, not R4's).
 *
 * Fault hooks let tests put the "worker" into every crash window.
 */

export const SET_TEST_RECORD_ID = 'platform_test.set_test_record';

export const setTestRecordInput = z.strictObject({
  recordKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  value: z.string().max(200),
  expectedVersion: z.int().nonnegative().optional(),
});
export const setTestRecordOutput = z.strictObject({
  recordKey: z.string(),
  version: z.int().positive(),
  value: z.string(),
});
export type SetTestRecordInput = z.infer<typeof setTestRecordInput>;
export type SetTestRecordOutput = z.infer<typeof setTestRecordOutput>;

export async function ensureTestLedger(pool: Pool): Promise<void> {
  await pool.query(`
    create schema if not exists platform_test;
    create table if not exists platform_test.records (
      record_key  text primary key,
      value       text,
      version     integer not null default 0,
      write_count integer not null default 0
    );
    create table if not exists platform_test.operations (
      execution_key text primary key,
      record_key    text not null,
      outcome       text not null check (outcome in ('pending', 'applied', 'rejected')),
      result        jsonb,
      applied_at    timestamptz
    );`);
}

export interface TestRecord {
  readonly recordKey: string;
  readonly value: string | null;
  readonly version: number;
  /** Number of effects actually applied to this record: the duplicate detector. */
  readonly writeCount: number;
}

export async function testRecord(pool: Pool, recordKey: string): Promise<TestRecord | null> {
  const result = await pool.query<{ record_key: string; value: string | null; version: number; write_count: number }>('select * from platform_test.records where record_key = $1', [recordKey]);
  const row = result.rows[0];
  return row ? { recordKey: row.record_key, value: row.value, version: row.version, writeCount: row.write_count } : null;
}

export async function ledgerOperations(pool: Pool): Promise<{ executionKey: string; recordKey: string; outcome: string }[]> {
  const result = await pool.query<{ execution_key: string; record_key: string; outcome: string }>('select execution_key, record_key, outcome from platform_test.operations order by applied_at nulls last, execution_key');
  return result.rows.map((r) => ({ executionKey: r.execution_key, recordKey: r.record_key, outcome: r.outcome }));
}

/** Seeds a record at a given version (for optimistic-concurrency scenarios). */
export async function seedTestRecord(pool: Pool, recordKey: string, value: string, version: number): Promise<void> {
  await pool.query(
    `insert into platform_test.records (record_key, value, version) values ($1, $2, $3)
     on conflict (record_key) do update set value = excluded.value, version = excluded.version`,
    [recordKey, value, version],
  );
}

type Answer = Awaited<ReturnType<WriteCapabilityRegistration<SetTestRecordInput, SetTestRecordOutput>['execute']>>;

/** Applies the effect at most once per execution key; returns the stored outcome on replay. */
export async function applyTestRecord(pool: Pool, input: SetTestRecordInput, executionKey: string): Promise<Answer> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Claim the key first: a concurrent call with the same key waits here and then sees the claim.
    const claimed = await client.query(`insert into platform_test.operations (execution_key, record_key, outcome) values ($1, $2, 'pending') on conflict (execution_key) do nothing returning execution_key`, [executionKey, input.recordKey]);
    if (claimed.rowCount === 0) {
      const existing = await client.query<{ outcome: string; result: Record<string, unknown> }>('select outcome, result from platform_test.operations where execution_key = $1', [executionKey]);
      await client.query('commit');
      return storedAnswer(existing.rows[0]!, true);
    }
    await client.query('insert into platform_test.records (record_key) values ($1) on conflict (record_key) do nothing', [input.recordKey]);
    const record = (await client.query<{ version: number }>('select version from platform_test.records where record_key = $1 for update', [input.recordKey])).rows[0]!;
    if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) {
      const result = { code: 'version_conflict', expectedVersion: input.expectedVersion, currentVersion: record.version };
      await client.query(`update platform_test.operations set outcome = 'rejected', result = $2, applied_at = clock_timestamp() where execution_key = $1`, [executionKey, JSON.stringify(result)]);
      await client.query('commit');
      return storedAnswer({ outcome: 'rejected', result }, false);
    }
    const updated = (
      await client.query<{ version: number }>('update platform_test.records set value = $2, version = version + 1, write_count = write_count + 1 where record_key = $1 returning version', [input.recordKey, input.value])
    ).rows[0]!;
    const result = { recordKey: input.recordKey, version: updated.version, value: input.value };
    await client.query(`update platform_test.operations set outcome = 'applied', result = $2, applied_at = clock_timestamp() where execution_key = $1`, [executionKey, JSON.stringify(result)]);
    await client.query('commit');
    return storedAnswer({ outcome: 'applied', result }, false);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Lookup by execution key: what the ledger knows about it. */
export async function reconcileTestRecord(pool: Pool, executionKey: string): Promise<Answer | { status: 'not_applied' }> {
  const existing = await pool.query<{ outcome: string; result: Record<string, unknown> }>('select outcome, result from platform_test.operations where execution_key = $1', [executionKey]);
  const row = existing.rows[0];
  if (!row) return { status: 'not_applied' };
  return storedAnswer(row, true);
}

function storedAnswer(row: { outcome: string; result: Record<string, unknown> | null }, replayed: boolean): Answer {
  if (row.outcome === 'applied') {
    const result = row.result as SetTestRecordOutput;
    return { status: 'applied', result, resourceRef: `test-record:${result.recordKey}`, externalOperationRef: `test-op:v${result.version}`, replayed };
  }
  if (row.outcome === 'rejected') {
    return { status: 'rejected', code: typeof row.result?.code === 'string' ? row.result.code : 'rejected', message: 'the ledger refused the command', details: row.result as never };
  }
  // Claimed by a call that has not committed an outcome: the ledger cannot tell yet.
  return { status: 'unknown', message: 'operation in progress' };
}

/** Where a test wants the "worker" to stop or misbehave. */
export interface TestLedgerFaults {
  /** Runs before the ledger is touched (e.g. crash before the external call). */
  beforeEffect?: (context: WriteHandlerContext) => Promise<void> | void;
  /**
   * Runs after the effect committed, before the answer reaches the platform:
   * return normally, throw (connection lost), return an unknown answer, or
   * never return (hang until the process dies).
   */
  afterEffect?: (context: WriteHandlerContext) => Promise<'answer' | 'throw' | 'unknown' | 'hang'> | 'answer' | 'throw' | 'unknown' | 'hang';
  /** Reconciliation behavior. */
  reconcile?: (context: WriteHandlerContext) => Promise<'answer' | 'throw' | 'unknown'> | 'answer' | 'throw' | 'unknown';
}

export interface TestLedgerCapabilityOptions {
  readonly capabilityId?: string;
  readonly riskClass?: Exclude<RiskClass, 'READ'>;
  readonly recovery?: WriteRecoveryStrategy;
  /** Omit the reconcile handler (only valid with idempotent_replay). */
  readonly withoutReconcile?: boolean;
  readonly maxAttempts?: number;
  readonly approvalPolicy?: 'none' | 'required';
  readonly identityRequirement?: 'none' | 'provisional' | 'verified';
  readonly requiredScopes?: string[];
  readonly timeoutMs?: number;
  readonly faults?: TestLedgerFaults;
  /** Counts handler calls (all attempts, including replays). */
  readonly calls?: { execute: number; reconcile: number; keys: string[]; contexts: WriteHandlerContext[] };
}

/** The ledger as a governed write capability. */
export function testLedgerCapability(pool: Pool, options: TestLedgerCapabilityOptions = {}): WriteCapabilityRegistration<SetTestRecordInput, SetTestRecordOutput> {
  const faults = options.faults ?? {};
  return {
    definition: {
      capabilityId: options.capabilityId ?? SET_TEST_RECORD_ID,
      version: 1,
      description: 'Sets the value of a generic test record in the test ledger (optionally only at an expected version). Test-only.',
      owner: 'platform-test',
      riskClass: options.riskClass ?? 'REVERSIBLE_WRITE',
      requiredScopes: options.requiredScopes ?? ['platform_test.write'],
      identityRequirement: options.identityRequirement ?? 'none',
      confirmationPolicy: 'none',
      approvalPolicy: options.approvalPolicy ?? 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: options.maxAttempts ?? 3, initialBackoffMs: 0 },
      timeoutMs: options.timeoutMs ?? 2_000,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: options.recovery ?? 'idempotent_replay',
    input: setTestRecordInput,
    output: setTestRecordOutput,
    async execute(input, context) {
      if (options.calls) {
        options.calls.execute += 1;
        options.calls.keys.push(context.executionKey);
        options.calls.contexts.push(context);
      }
      await faults.beforeEffect?.(context);
      const answer = await applyTestRecord(pool, input, context.executionKey);
      const after = (await faults.afterEffect?.(context)) ?? 'answer';
      if (after === 'throw') throw new Error('connection reset after the request was sent');
      if (after === 'unknown') return { status: 'unknown', message: 'no response received' };
      if (after === 'hang') return new Promise<never>(() => undefined);
      return answer;
    },
    ...(options.withoutReconcile
      ? {}
      : {
          async reconcile(context: WriteHandlerContext) {
            if (options.calls) options.calls.reconcile += 1;
            const mode = (await faults.reconcile?.(context)) ?? 'answer';
            if (mode === 'throw') throw new Error('ledger lookup unavailable');
            if (mode === 'unknown') return { status: 'unknown' as const, message: 'ledger cannot tell' };
            return reconcileTestRecord(pool, context.executionKey);
          },
        }),
  };
}

export function handlerCalls(): { execute: number; reconcile: number; keys: string[]; contexts: WriteHandlerContext[] } {
  return { execute: 0, reconcile: 0, keys: [], contexts: [] };
}
