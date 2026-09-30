import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import type { WorkerPresenceStore } from '@r4/task-runtime';
import { PRESENCE_RETENTION_MS, WorkerPresence } from '@r4/worker';

type Call = [string, ...unknown[]];

/** In-memory store honoring the port contract (refresh never overrides stopping). */
function fakeStore(options: { fail?: () => boolean } = {}) {
  const calls: Call[] = [];
  let state: string | null = null;
  const attempt = <T>(fn: () => T): Promise<T> => (options.fail?.() ? Promise.reject(new Error('database unavailable')) : Promise.resolve(fn()));
  const store: WorkerPresenceStore = {
    registerWorker: (identity) => attempt(() => {
      calls.push(['register', identity.workerId]);
      state = 'ready';
    }),
    refreshWorker: (_id, update) => attempt(() => {
      calls.push(['refresh', update.state, update.reason]);
      if (state === null || state === 'stopping') return false;
      state = update.state;
      return true;
    }),
    markWorkerStopping: () => attempt(() => {
      calls.push(['stopping']);
      state = 'stopping';
    }),
    summarizeWorkers: () => Promise.reject(new Error('not used')),
    purgeExpiredWorkers: (ms) => {
      calls.push(['purge', ms]);
      return Promise.resolve(0);
    },
  };
  return { store, calls, state: () => state };
}

function presence(store: WorkerPresenceStore, clock: { t: number }) {
  return new WorkerPresence({
    store,
    identity: { workerId: 'w-1', executionMode: 'production', compatibility: '0009_run_step_origin:p@1', buildRef: null },
    freshForMs: 3000,
    heartbeatIntervalMs: 1000,
    logger: createSilentLogger(),
    now: () => clock.t,
  });
}

describe('WorkerPresence (R4-I): renewed by progress only', () => {
  it('publishes nothing until the first progress, then registers ready and purges long-expired rows once', async () => {
    const { store, calls } = fakeStore();
    const clock = { t: 0 };
    const p = presence(store, clock);
    await p.cycleFailed();
    expect(calls).toEqual([]);
    await p.progressed();
    expect(calls).toEqual([['register', 'w-1'], ['purge', PRESENCE_RETENTION_MS]]);
  });

  it('paces renewals by the heartbeat interval (not every cycle) and never purges per heartbeat', async () => {
    const { store, calls } = fakeStore();
    const clock = { t: 0 };
    const p = presence(store, clock);
    await p.progressed();
    for (const t of [100, 500, 999]) {
      clock.t = t;
      await p.progressed();
    }
    expect(calls.filter((c) => c[0] === 'refresh')).toEqual([]);
    clock.t = 1000;
    await p.progressed();
    clock.t = 2000;
    await p.progressed();
    expect(calls.filter((c) => c[0] === 'refresh')).toEqual([['refresh', 'ready', null], ['refresh', 'ready', null]]);
    expect(calls.filter((c) => c[0] === 'purge')).toHaveLength(1);
    clock.t = 60 * 60_000 + 1;
    await p.progressed();
    expect(calls.filter((c) => c[0] === 'purge')).toHaveLength(2);
  });

  it('one transient loop failure changes nothing; failing for a heartbeat interval reports not_ready; progress restores ready', async () => {
    const { store, calls, state } = fakeStore();
    const clock = { t: 0 };
    const p = presence(store, clock);
    await p.progressed();
    clock.t = 400;
    await p.cycleFailed();
    expect(calls.filter((c) => c[0] === 'refresh')).toEqual([]);
    clock.t = 1200;
    await p.cycleFailed();
    expect(state()).toBe('not_ready');
    expect(calls.at(-1)).toEqual(['refresh', 'not_ready', 'claim_loop_error']);
    clock.t = 1300;
    await p.progressed();
    expect(state()).toBe('ready');
  });

  it('stop is terminal: stopping is persisted and no later progress or failure renews', async () => {
    const { store, calls, state } = fakeStore();
    const clock = { t: 0 };
    const p = presence(store, clock);
    await p.progressed();
    await p.stop();
    expect(state()).toBe('stopping');
    const before = calls.length;
    for (const t of [5000, 10_000]) {
      clock.t = t;
      await p.progressed();
      await p.cycleFailed();
    }
    expect(calls.length).toBe(before);
  });

  it('stop during an in-flight renewal still ends in stopping', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    const { store, state } = fakeStore();
    const slow: WorkerPresenceStore = { ...store, registerWorker: async (identity, ms) => { await gate; await store.registerWorker(identity, ms); } };
    const p = presence(slow, { t: 0 });
    const renewing = p.progressed();
    const stopping = p.stop();
    unblock();
    await Promise.all([renewing, stopping]);
    expect(state()).toBe('stopping');
  });

  it('a stop before any registration writes nothing', async () => {
    const { store, calls } = fakeStore();
    await presence(store, { t: 0 }).stop();
    expect(calls).toEqual([]);
  });

  it('store failures never throw into the worker loop (expiry is the fallback)', async () => {
    let down = true;
    const { store } = fakeStore({ fail: () => down });
    const clock = { t: 0 };
    const p = presence(store, clock);
    await expect(p.progressed()).resolves.toBeUndefined();
    await expect(p.stop()).resolves.toBeUndefined();
    down = false;
  });

  it('re-registers when its row disappeared (e.g. purged) while it kept progressing', async () => {
    const { store, calls } = fakeStore();
    const clock = { t: 0 };
    const p = presence(store, clock);
    await p.progressed();
    const gone: WorkerPresenceStore = { ...store, refreshWorker: () => Promise.resolve(false) };
    const q = presence(gone, clock);
    await q.progressed();
    clock.t = 1000;
    await q.progressed();
    clock.t = 1100;
    await q.progressed();
    expect(calls.filter((c) => c[0] === 'register')).toHaveLength(3);
  });
});
