import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createSilentLogger } from '@r4/observability';
import { AutonomyControls, type ProductionStore } from '@r4/live-ops';
import { DomainError, type QuoteV2Service } from '@r4-adapters/domains';
import { QUOTE_ISSUANCE_LOCK, SALES_PRODUCTION_PROFILE_V17, SALES_PRODUCTION_PROFILE_V8, salesQuotePort, singleFlightQuoteIssuance } from '@r4-sales/agent/production';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * F1 concurrency (owner mandate «Quote V2 production connectivity», 2026-11-09): at most ONE Quote V2 issuance in
 * flight across every worker of the deployment, through the shared PostgreSQL advisory lock — never a per-process
 * semaphore. Two pools stand for two worker processes on the same production database.
 */
let db: TestDatabase;
let workerA: pg.Pool;
let workerB: pg.Pool;
let observer: pg.Pool;
beforeAll(async () => {
  db = await createTestDatabase('r4_qsf');
  [workerA, workerB, observer] = [openPool(db.url), openPool(db.url), openPool(db.url)];
});
afterAll(async () => {
  await Promise.all([workerA, workerB, observer].map((p) => p?.end().catch(() => undefined)));
  await db?.drop();
});

function slowOwner(ms: number) {
  const state = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const quotes = {
    createAndIssue: async () => {
      state.calls += 1;
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((ok) => setTimeout(ok, ms));
      state.inFlight -= 1;
      return { httpStatus: 201 } as never;
    },
    getQuote: async () => ({ status: 'issued' }) as never,
    getOperation: async () => ({}) as never,
    lookupIdempotency: async () => null,
    getDocument: async () => ({}) as never,
  } satisfies QuoteV2Service;
  return { quotes, state };
}
const issue = (q: QuoteV2Service, i: number) => q.createAndIssue({} as never, `r4x_${i}`);
const lockHeld = async () => (await observer.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and objid = (hashtextextended($1, 8) & 4294967295)::bigint::oid`, [QUOTE_ISSUANCE_LOCK])).rows[0].n as number;

describe('one Quote V2 issuance in flight across workers', { timeout: 60_000 }, () => {
  it('six concurrent issuances from two workers run one at a time; every one is sent exactly once', async () => {
    const { quotes, state } = slowOwner(120);
    const a = singleFlightQuoteIssuance(quotes, workerA);
    const b = singleFlightQuoteIssuance(quotes, workerB);
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => issue(i % 2 ? a : b, i)));
    expect(state).toEqual({ inFlight: 0, maxInFlight: 1, calls: 6 });
    expect(await lockHeld()).toBe(0);
  });

  it('a wait longer than the limit fails before calling the owner (temporarily_unavailable: held on its key)', async () => {
    const holder = await observer.connect();
    await holder.query('select pg_advisory_lock(hashtextextended($1, 8))', [QUOTE_ISSUANCE_LOCK]);
    const { quotes, state } = slowOwner(10);
    const error = await singleFlightQuoteIssuance(quotes, workerA, 300).createAndIssue({} as never, 'r4x_busy').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ category: 'temporarily_unavailable', code: 'quote_issuance_busy', retryable: true });
    expect(state.calls).toBe(0);
    // Reads are never serialized.
    await expect(singleFlightQuoteIssuance(quotes, workerA, 300).getQuote('q')).resolves.toMatchObject({ status: 'issued' });
    await holder.query('select pg_advisory_unlock(hashtextextended($1, 8))', [QUOTE_ISSUANCE_LOCK]);
    holder.release();
    await issue(singleFlightQuoteIssuance(quotes, workerA, 300), 1);
    expect(state.calls).toBe(1);
  });

  it('a worker that dies while issuing releases the lock with its connection', async () => {
    const dying = await observer.connect();
    await dying.query('select pg_advisory_lock(hashtextextended($1, 8))', [QUOTE_ISSUANCE_LOCK]);
    const pid = (await dying.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    dying.on('error', () => undefined);
    await workerB.query('select pg_terminate_backend($1)', [pid]);
    dying.release(true);
    const { quotes, state } = slowOwner(10);
    await issue(singleFlightQuoteIssuance(quotes, workerA, 2_000), 2);
    expect(state.calls).toBe(1);
  });

  it('an owner failure still releases the lock', async () => {
    const failing = { ...slowOwner(0).quotes, createAndIssue: () => Promise.reject(new DomainError('unknown_outcome', 'lost', 'lost')) } satisfies QuoteV2Service;
    await expect(singleFlightQuoteIssuance(failing, workerA).createAndIssue({} as never, 'x')).rejects.toMatchObject({ category: 'unknown_outcome' });
    expect(await lockHeld()).toBe(0);
  });

  it('the composition serializes @17 (F1) and leaves @8 as it was', async () => {
    const controls = new AutonomyControls({ store: { readControls: () => Promise.resolve({ state: { globalEnabled: true, channels: {}, version: '1' }, records: [] }) } as unknown as ProductionStore, logger: createSilentLogger() });
    for (const [profile, expected] of [[SALES_PRODUCTION_PROFILE_V17, 1], [SALES_PRODUCTION_PROFILE_V8, 3]] as const) {
      const { quotes, state } = slowOwner(100);
      const port = salesQuotePort(profile, quotes, controls, workerA, createSilentLogger());
      await Promise.all([0, 1, 2].map((i) => issue(port, i)));
      expect(state.maxInFlight).toBe(expected);
    }
  });
});
