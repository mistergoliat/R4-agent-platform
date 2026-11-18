import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequirements } from '@r4/contracts';
import { DefaultModelGateway, FakeModelProvider, RequestRateLimiter, type ModelRequest, type ModelResult } from '@r4/model-gateway';
import { loadWorkerConfig } from '@r4/worker';
import { captureLogs } from '../../support/logs.js';

const requirements: ModelRequirements = { reasoningLevel: 'low', latencySensitivity: 'medium', costSensitivity: 'high', structuredOutput: true, toolUse: true };
const request = (i: number, timeoutMs: number): ModelRequest => ({
  correlation: { correlationId: `corr-${i}` },
  requirements,
  messages: [{ role: 'user', content: 'hi' }],
  outputContract: { kind: 'text' },
  limits: { timeoutMs },
});

/** Max number of starts inside any window of `windowMs` (starts ascending). */
function maxInWindow(starts: readonly number[], windowMs: number): number {
  let max = 0;
  for (let i = 0, j = 0; i < starts.length; i++) {
    while (starts[i]! - starts[j]! >= windowMs) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RequestRateLimiter', () => {
  const limiter = (max: number, windowMs = 60_000) => new RequestRateLimiter(max, { windowMs, now: () => Date.now() });

  it('admits up to the budget at once, then makes the next call wait for the window instead of failing', async () => {
    const l = limiter(2);
    expect(await l.acquire(1_000)).toBe(0);
    expect(await l.acquire(1_000)).toBe(0);
    let waited: number | null | undefined;
    void l.acquire(90_000).then((w) => (waited = w));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(waited).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toBe(60_000);
  });

  it('is bounded by the caller deadline: refuses at once, reserving nothing', async () => {
    const l = limiter(1);
    await l.acquire(0);
    expect(await l.acquire(59_999)).toBeNull();
    expect(await l.acquire(59_999)).toBeNull();
    // The refused calls took no slot: the next caller that may wait gets the first free start.
    expect(l.reserve(60_000)).toBe(60_000);
  });

  it('sleeps on a single timer per waiter and reads the clock once per call (no busy loop)', async () => {
    let reads = 0;
    const l = new RequestRateLimiter(1, { windowMs: 60_000, now: () => (reads++, Date.now()) });
    await l.acquire(0);
    const pending = Promise.all([l.acquire(200_000), l.acquire(200_000), l.acquire(200_000)]);
    expect(vi.getTimerCount()).toBe(3);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await pending).toEqual([60_000, 120_000, 180_000]);
    expect(reads).toBe(4);
  });

  it('grants in arrival order (FIFO), never letting a later caller overtake', async () => {
    const l = limiter(1, 1_000);
    const order: number[] = [];
    const pending = [0, 1, 2, 3, 4].map((i) => l.acquire(10_000).then(() => order.push(i)));
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(pending);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps at most maxRequests starts in any rolling window (a token bucket would admit twice that)', () => {
    const l = limiter(20);
    const starts: number[] = [];
    for (let i = 0; i < 100; i++) starts.push(Date.now() + l.reserve(Infinity)!);
    expect(maxInWindow(starts, 60_000)).toBe(20);
  });

  it('rejects with the signal reason when aborted while waiting', async () => {
    const l = limiter(1);
    await l.acquire(0);
    const controller = new AbortController();
    const pending = l.acquire(90_000, controller.signal);
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DefaultModelGateway with a request-rate budget', () => {
  function rig(maxRequests: number, latencyMs = 0) {
    const starts: number[] = [];
    const provider = new FakeModelProvider(async () => {
      starts.push(Date.now());
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return { type: 'text', content: 'ok' };
    });
    const logs = captureLogs();
    const gateway = new DefaultModelGateway({ provider, logger: logs.logger, rateLimiter: new RequestRateLimiter(maxRequests, { now: () => Date.now() }) });
    return { gateway, starts, logs };
  }

  it('25 calls on a 20/min budget all succeed and never reach the provider faster than 20 per rolling minute', async () => {
    const { gateway, starts, logs } = rig(20);
    const results: ModelResult[] = [];
    // A call may wait up to its own timeout for a start: 150 s covers the 61 s window.
    const calls = Array.from({ length: 25 }, (_, i) => gateway.generate(request(i, 150_000)).then((r) => results.push(r)));
    await vi.advanceTimersByTimeAsync(61_000);
    await Promise.all(calls);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(starts).toHaveLength(25);
    expect(maxInWindow(starts, 60_000)).toBe(20);
    expect(starts.filter((t) => t === 0)).toHaveLength(20);
    expect(starts.slice(20)).toEqual([61_000, 61_000, 61_000, 61_000, 61_000]);
    const throttled = logs.events('model.call.throttled');
    expect(throttled).toHaveLength(5);
    expect(throttled[0]).toMatchObject({ outcome: 'waited', waitMs: 61_000, maxRequests: 20, correlationId: 'corr-20' });
    expect(logs.events('model.call.failed')).toHaveLength(0);
  });

  it('fails as retryable rate_limited, without calling the provider, when no start fits within the call timeout', async () => {
    const { gateway, starts, logs } = rig(20);
    const first = await Promise.all(Array.from({ length: 20 }, (_, i) => gateway.generate(request(i, 60_000))));
    expect(first.every((r) => r.ok)).toBe(true);
    const refused = await gateway.generate(request(20, 60_000));
    expect(refused).toMatchObject({ ok: false, error: { kind: 'rate_limited', retryable: true } });
    expect(starts).toHaveLength(20);
    expect(logs.events('model.call.throttled')).toMatchObject([{ outcome: 'refused', waitMs: 0, correlationId: 'corr-20' }]);
    expect(logs.events('model.call.failed')).toMatchObject([{ errorKind: 'rate_limited', retryable: true }]);
  });

  it('a call cancelled while waiting for capacity is cancelled, not sent', async () => {
    const { gateway, starts } = rig(1);
    await gateway.generate(request(0, 150_000));
    const controller = new AbortController();
    const pending = gateway.generate(request(1, 150_000), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled', retryable: false } });
    expect(starts).toHaveLength(1);
  });

  it('a serial caller (one call at a time, like a worker) is never refused, even on a budget of 1', async () => {
    const { gateway, starts, logs } = rig(1, 3_000); // each answer takes 3 s, the fastest production calls
    for (let i = 0; i < 4; i++) {
      const pending = gateway.generate(request(i, 60_000));
      await vi.runAllTimersAsync();
      expect((await pending).ok).toBe(true);
    }
    expect(starts).toEqual([0, 61_000, 122_000, 183_000]);
    expect(logs.events('model.call.throttled').map((e) => e.outcome)).toEqual(['waited', 'waited', 'waited']);
  });

  it('after waiting, the provider still gets the full call timeout', async () => {
    const provider = new FakeModelProvider((_, i) => (i === 0 ? { type: 'text', content: 'ok' } : { type: 'timeout' }));
    const gateway = new DefaultModelGateway({ provider, logger: captureLogs().logger, rateLimiter: new RequestRateLimiter(1, { windowMs: 40_000, now: () => Date.now() }) });
    await gateway.generate(request(0, 100_000));
    let result: ModelResult | undefined;
    void gateway.generate(request(1, 100_000)).then((r) => (result = r));
    // 40 s waiting, then 100 s for the provider.
    await vi.advanceTimersByTimeAsync(139_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });
});

describe('R4_MODEL_MAX_REQUESTS_PER_MINUTE', () => {
  const base = { R4_DATABASE_URL: 'postgres://localhost/r4' };
  it('is unlimited when unset or blank, a positive integer otherwise', () => {
    expect(loadWorkerConfig(base).modelMaxRequestsPerMinute).toBeUndefined();
    expect(loadWorkerConfig({ ...base, R4_MODEL_MAX_REQUESTS_PER_MINUTE: '' }).modelMaxRequestsPerMinute).toBeUndefined();
    expect(loadWorkerConfig({ ...base, R4_MODEL_MAX_REQUESTS_PER_MINUTE: '15' }).modelMaxRequestsPerMinute).toBe(15);
    expect(() => loadWorkerConfig({ ...base, R4_MODEL_MAX_REQUESTS_PER_MINUTE: '0' })).toThrow(/R4_MODEL_MAX_REQUESTS_PER_MINUTE/);
    expect(() => loadWorkerConfig({ ...base, R4_MODEL_MAX_REQUESTS_PER_MINUTE: '2.5' })).toThrow(/R4_MODEL_MAX_REQUESTS_PER_MINUTE/);
  });
});
