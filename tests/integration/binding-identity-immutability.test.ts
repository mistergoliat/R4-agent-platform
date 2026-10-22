import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock, uuidV7Generator, type TrustedExecutionContext } from '@r4/contracts';
import { AgentRegistry, loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { DEFAULT_MIGRATIONS_DIR, PostgresAgentDefinitionStore, PostgresProductionStore, PostgresTaskRuntimeStore, migrate, type Pool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import type { CustomerIdentityResolver, CustomerProfilePort } from '@r4-adapters/domains';
import {
  IdentityVerificationStore,
  Keyring,
  SecretBox,
  VerificationConfirmDispatcher,
  confirmIdempotencyKey,
  type ConfirmAnswer,
  type ConfirmPort,
} from '@r4-adapters/identity-verification';
import { customerContextV3Capability, customerPurchaseHistoryV2Capability } from '../../agents/sales/src/capabilities/customer-v3.js';
import { createTestDatabase, openPool } from '../support/database.js';
import { FakeClock, idsFrom } from '../support/deterministic.js';
import { CANARY_PHONE_ID, LiveOpsTestbed, OPERATOR, keyOf } from '../support/live-ops.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';
import { REPO_AGENTS_DIR, validTaskBody } from '../support/platform.js';

// RR-1 R-4 (ADR-038; R4_J4_RR1_BINDING_RACE_ANALYSIS.md §8 R-4): migration 0011_binding_identity_immutability
// freezes channel, conversation_key, account_ref, recipient_ref and task_id (assigned once) of
// channel_conversation_bindings. Real PostgreSQL, real ProductionStore, real ingress; synthetic only.
// Every LiveOpsTestbed / test database is created fresh, so a mutated migration is always applied.

const KEYS = `k0:${randomBytes(32).toString('base64')}`;
const RIGHT = '482913';
const NOT_STARTED: ConfirmPort = { confirm: () => Promise.reject(new Error('the composed dispatcher is not started in this suite')) };
const IMMUTABLE = { code: '55000', message: expect.stringContaining('identity is immutable') as string };

type Column = 'channel' | 'conversation_key' | 'account_ref' | 'recipient_ref' | 'task_id';
const IDENTITY = 'select binding_id, channel, conversation_key, account_ref, recipient_ref, task_id from channel_conversation_bindings where binding_id = $1';

/** An UPDATE of one column that keeps binding_id (raw SQL: no store path writes these columns). */
const rewrite = (pool: Pool, bindingId: string, column: Column, value: string | null) =>
  pool.query(`update channel_conversation_bindings set ${column} = $2 where binding_id = $1`, [bindingId, value]);
const identityOf = async (pool: Pool, bindingId: string) => (await pool.query(IDENTITY, [bindingId])).rows[0] as Record<string, unknown>;

let bed: LiveOpsTestbed;
let subjects = 0;
const nextWa = () => `5691400${String(++subjects).padStart(4, '0')}`;
const eventId = () => `wamid.RR1R4.${randomBytes(6).toString('hex')}`;

/** A conversation opened by the real webhook ingress (binding + task). */
async function conversation() {
  const wa = nextWa();
  expect((await bed.customer(wa, eventId(), 'hola')).status).toBe(200);
  const binding = (await bed.store.findOpenBinding('whatsapp', keyOf(wa)))!;
  return { wa, taskId: binding.taskId!, bindingId: binding.bindingId };
}

/** A task with no binding (so a reassignment is never refused by the one-binding-per-task index instead of the trigger). */
async function bareTask(): Promise<string> {
  const { view } = await bed.api.tasks.createTask({ request: { taskType: 'sales.conversation', agentId: 'sales', goal: { description: 'bare task (RR-1 R-4)' } }, requestedBy: { kind: 'service', ref: 'rr1-r4' }, correlationId: 'rr1-r4' });
  return view.task.taskId;
}

function openBinding(store: PostgresProductionStore, wa: string) {
  return store.openBinding({
    bindingId: randomUUID(), channel: 'whatsapp', conversationKey: randomBytes(32).toString('hex'), accountRef: CANARY_PHONE_ID, recipientRef: wa,
    autonomy: 'autonomous', eligibilityReason: 'test', rolloutFingerprint: 'test', profile: 'sales-production@1', profileFingerprint: 'test',
  });
}

function barrier() {
  let open!: () => void;
  const opened = new Promise<void>((done) => (open = done));
  let reached!: () => void;
  const arrived = new Promise<void>((done) => (reached = done));
  return { open: () => open(), opened, arrived, arrive: () => reached() };
}

beforeAll(async () => {
  bed = await LiveOpsTestbed.start({ identityVerification: { requested: 'full', codeKeys: KEYS, confirm: NOT_STARTED }, autonomy: true, percent: 100 });
}, 120_000);

afterAll(async () => {
  await bed?.close();
});

describe('R4-T01: every frozen column refuses a rewrite that keeps binding_id; the row is unchanged', () => {
  const values: Record<Column, () => Promise<string>> = {
    channel: () => Promise.resolve('telegram'),
    conversation_key: () => Promise.resolve(randomBytes(32).toString('hex')),
    account_ref: () => Promise.resolve('9999999999'),
    recipient_ref: () => Promise.resolve('56999999999'),
    task_id: bareTask,
  };
  for (const column of Object.keys(values) as Column[]) {
    it(`R4-T01 ${column}: refused (55000), row unchanged`, async () => {
      const conv = await conversation();
      const before = await identityOf(bed.pool, conv.bindingId);
      await expect(rewrite(bed.pool, conv.bindingId, column, await values[column]())).rejects.toMatchObject(IMMUTABLE);
      expect(await identityOf(bed.pool, conv.bindingId)).toEqual(before);
    });
  }
});

describe('R4-T02: task_id is assigned once', () => {
  it('R4-T02 null → value once; the same value again (attachTask idempotent); value → other and value → null refused', async () => {
    const binding = await openBinding(bed.store, nextWa());
    expect(binding.taskId).toBeNull();
    const [a, b] = [await bareTask(), await bareTask()];
    expect(await bed.store.attachTask(binding.bindingId, a)).toMatchObject({ bindingId: binding.bindingId, taskId: a });
    expect(await bed.store.attachTask(binding.bindingId, a)).toMatchObject({ bindingId: binding.bindingId, taskId: a });
    await expect(rewrite(bed.pool, binding.bindingId, 'task_id', a)).resolves.toMatchObject({ rowCount: 1 });
    await expect(rewrite(bed.pool, binding.bindingId, 'task_id', b)).rejects.toMatchObject(IMMUTABLE);
    await expect(rewrite(bed.pool, binding.bindingId, 'task_id', null)).rejects.toMatchObject(IMMUTABLE);
    // The store's own guard still answers first on its path.
    await expect(bed.store.attachTask(binding.bindingId, b)).rejects.toMatchObject({ code: 'binding_task_mismatch' });
    expect(await identityOf(bed.pool, binding.bindingId)).toMatchObject({ task_id: a });
  });
});

describe('R4-T03: the non-identity writes keep working', () => {
  it('R4-T03 touch (last_inbound_at) and close (status, closed_at, closed_reason) through the store', async () => {
    const binding = await openBinding(bed.store, nextWa());
    const before = await identityOf(bed.pool, binding.bindingId);
    const at = new Date().toISOString();
    await bed.store.touchBinding(binding.bindingId, at);
    await bed.store.closeBinding(binding.bindingId, 'test_closed');
    const [row] = (await bed.pool.query('select status, closed_at, closed_reason, last_inbound_at from channel_conversation_bindings where binding_id = $1', [binding.bindingId])).rows as Record<string, unknown>[];
    expect(row).toMatchObject({ status: 'closed', closed_reason: 'test_closed', last_inbound_at: new Date(at) });
    expect(row!.closed_at).toBeInstanceOf(Date);
    expect(await identityOf(bed.pool, binding.bindingId)).toEqual(before);
  });

  it('R4-T03 the real ingress: message → binding + task; cancellation closes it; a new message opens a NEW binding', async () => {
    const conv = await conversation();
    const before = await identityOf(bed.pool, conv.bindingId);
    await bed.api.temporal.cancelTask(conv.taskId, OPERATOR);
    expect((await bed.customer(conv.wa, eventId(), 'hola de nuevo')).status).toBe(200);
    expect(await bed.store.bindingByTask(conv.taskId)).toMatchObject({ bindingId: conv.bindingId, status: 'closed', closedReason: 'task_cancelled' });
    expect(await identityOf(bed.pool, conv.bindingId)).toEqual(before);
    const current = (await bed.store.findOpenBinding('whatsapp', keyOf(conv.wa)))!;
    expect(current.bindingId).not.toBe(conv.bindingId);
    expect(current.taskId).not.toBeNull();
    expect(current.taskId).not.toBe(conv.taskId);
  });
});

describe('R4-T04: resolve in flight (customer.get_context@3, RR1-T06 harness)', () => {
  it('R4-T04 a rewrite of recipient_ref / account_ref during the CIA call is refused; the capability reads the unchanged identity', async () => {
    const conv = await conversation();
    const before = await identityOf(bed.pool, conv.bindingId);
    const gate = barrier();
    const resolve = vi.fn<CustomerIdentityResolver['resolve']>(async (_subject, purposes) => {
      gate.arrive();
      await gate.opened;
      return { status: 'verified', customerRef: 'prestashop_customer:900000201', grant: { token: 'synthetic.grant.token', expiresAt: new Date(Date.now() + 300_000).toISOString(), purposes: [...purposes] }, resolvedAt: new Date().toISOString() };
    });
    const profile = {
      getSalesContext: vi.fn<CustomerProfilePort['getSalesContext']>(() => Promise.resolve({ status: 'available', purchaseHistory: 'present', validUntil: null })),
      getPurchaseHistory: vi.fn<CustomerProfilePort['getPurchaseHistory']>(() => Promise.reject(new Error('not used'))),
    };
    const deps = { bindings: bed.store, identity: { resolve }, profile };
    const registry = new CapabilityRegistry();
    registry.register(customerContextV3Capability(deps));
    registry.register(customerPurchaseHistoryV2Capability(deps));
    const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(new FakeClock(new Date().toISOString())), clock: { now: () => new Date() }, logger: createSilentLogger() });
    const context: TrustedExecutionContext = { taskId: conv.taskId, runId: '0190a0a0-0000-7000-8000-0000000000fe', agentId: 'sales', agentVersion: 1, correlationId: 'rr1-r4-t04', grantedScopes: ['customer.read'] };

    const pending = invoker.invoke({ capabilityId: 'customer.get_context', capabilityVersion: 3, arguments: {} }, context);
    await gate.arrived;
    await expect(rewrite(bed.pool, conv.bindingId, 'recipient_ref', '56999999999')).rejects.toMatchObject(IMMUTABLE);
    await expect(rewrite(bed.pool, conv.bindingId, 'account_ref', '9999999999')).rejects.toMatchObject(IMMUTABLE);
    gate.open();

    expect(await pending).toMatchObject({ outcome: 'succeeded', payload: { identity: 'verified', purchaseHistory: 'present' } });
    expect(resolve.mock.calls[0]![0]).toEqual({ channel: 'whatsapp', accountRef: CANARY_PHONE_ID, subjectRef: conv.wa, sessionRef: conv.bindingId });
    expect(profile.getSalesContext).toHaveBeenCalledTimes(1);
    expect(await bed.store.bindingByTask(conv.taskId)).toMatchObject({ bindingId: conv.bindingId, channel: 'whatsapp', accountRef: CANARY_PHONE_ID, recipientRef: conv.wa, status: 'open' });
    expect(await identityOf(bed.pool, conv.bindingId)).toEqual(before);
  });
});

describe('R4-T05: confirm in flight (VerificationConfirmDispatcher)', () => {
  it('R4-T05 a rewrite of recipient_ref / account_ref during confirm is refused; the retry sends the same key and context', async () => {
    const verification = new IdentityVerificationStore(bed.pool);
    const conv = await conversation();
    const { expectation } = await verification.openExpectation({
      expectationId: randomUUID(), channel: 'whatsapp', conversationKey: keyOf(conv.wa), accountRef: CANARY_PHONE_ID, bindingId: conv.bindingId, taskId: conv.taskId,
      consumerId: 'r4-sales', startIdempotencyKey: `start.${randomBytes(12).toString('hex')}`,
    });
    await verification.markIssued(expectation.expectationId, { verificationId: randomBytes(16).toString('base64url'), expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const providerEventId = eventId();
    expect((await bed.customer(conv.wa, providerEventId, RIGHT)).status).toBe(200);

    const gate = barrier();
    const calls: Parameters<ConfirmPort['confirm']>[0][] = [];
    const cia: ConfirmPort = {
      confirm: async (request): Promise<ConfirmAnswer> => {
        calls.push(structuredClone(request));
        if (calls.length > 1) return { kind: 'outcome', outcome: 'linked' };
        gate.arrive();
        await gate.opened;
        return { kind: 'retry', code: 'identity_unreachable', retryAfterMs: 0 };
      },
    };
    const d = new VerificationConfirmDispatcher({ store: verification, box: new SecretBox(Keyring.parse(KEYS)), confirm: cia, bindings: bed.store, resume: bed.api.temporal, owner: 'gw-rr1-r4', random: () => 0.5 });

    const first = d.dispatchOnce();
    await gate.arrived;
    await expect(rewrite(bed.pool, conv.bindingId, 'recipient_ref', '56999999999')).rejects.toMatchObject(IMMUTABLE);
    await expect(rewrite(bed.pool, conv.bindingId, 'account_ref', '9999999999')).rejects.toMatchObject(IMMUTABLE);
    gate.open();
    expect(await first).toBe('retry_scheduled');
    expect(await d.dispatchOnce()).toBe('confirmed');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      context: { channel: 'whatsapp', channelAccountRef: CANARY_PHONE_ID, subjectRef: conv.wa, sessionRef: conv.bindingId },
      idempotencyKey: confirmIdempotencyKey('whatsapp', providerEventId),
    });
    expect(calls[1]).toEqual(calls[0]);
    expect(await verification.expectation(bed.pool, expectation.expectationId)).toMatchObject({ state: 'confirmed', ciaOutcome: 'linked' });
  });
});

describe('R4-T06: migration over a 0010 database that already holds bindings', () => {
  it('R4-T06 an open and a closed binding survive 0011 intact; then the trigger applies to them', async () => {
    const db = await createTestDatabase();
    const pool = openPool(db.url);
    const dir = await mkdtemp(join(tmpdir(), 'r4-core-0010-'));
    try {
      for (const name of await readdir(DEFAULT_MIGRATIONS_DIR)) {
        if (name.endsWith('.sql') && name < '0011') await cp(join(DEFAULT_MIGRATIONS_DIR, name), join(dir, name));
      }
      expect((await migrate(pool, { directory: dir })).applied.at(-1)).toBe('0010_platform_step_decisions');

      // Bindings written by the real store at 0010 (tasks of the probe agent: the binding never reads the task's agent).
      const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger: createSilentLogger() });
      await agents.sync((await loadAgentDefinitionsFromDirectory(REPO_AGENTS_DIR)).map((def) => def.definition));
      const runtime = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger() });
      const task = async () => (await runtime.createTask({ request: validTaskBody(), requestedBy: { kind: 'service', ref: 'rr1-r4' }, correlationId: 'rr1-r4-t06' })).view.task.taskId;
      const store = new PostgresProductionStore(pool);
      const open = await openBinding(store, '56914000901');
      await store.attachTask(open.bindingId, await task());
      await store.touchBinding(open.bindingId, new Date().toISOString());
      const closed = await openBinding(store, '56914000902');
      await store.attachTask(closed.bindingId, await task());
      await store.closeBinding(closed.bindingId, 'task_cancelled');
      const all = 'select * from channel_conversation_bindings order by created_at';
      const before = (await pool.query(all)).rows;
      expect(before.map((r: Record<string, unknown>) => r.status)).toEqual(['open', 'closed']);

      expect(await migrate(pool)).toEqual({ applied: ['0011_binding_identity_immutability'] });
      expect((await pool.query(all)).rows).toEqual(before);

      const spare = await task();
      for (const b of [open, closed]) {
        await expect(rewrite(pool, b.bindingId, 'recipient_ref', '56999999999')).rejects.toMatchObject(IMMUTABLE);
        await expect(rewrite(pool, b.bindingId, 'task_id', spare)).rejects.toMatchObject(IMMUTABLE);
      }
      await store.closeBinding(open.bindingId, 'test_closed');
      expect((await pool.query(all)).rows.map((r: Record<string, unknown>) => [r.binding_id, r.status, r.recipient_ref, r.task_id])).toEqual(
        before.map((r: Record<string, unknown>) => [r.binding_id, 'closed', r.recipient_ref, r.task_id]),
      );
    } finally {
      await pool.end();
      await db.drop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
