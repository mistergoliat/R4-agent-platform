import { describe, expect, it } from 'vitest';
import { defaultWorkerId, loadWorkerConfig } from '@r4/worker';

const env = { R4_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' };

describe('worker configuration', () => {
  it('applies documented defaults', () => {
    const config = loadWorkerConfig(env);
    expect(config).toMatchObject({
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      pollIntervalMs: 1_000,
      maxRunRecoveries: 3,
      execution: { maxIterations: 50, maxModelCalls: 50, maxReadCapabilityCalls: 50, maxRunDurationMs: 900_000, modelCallTimeoutMs: 60_000 },
    });
    expect(config.workerId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });

  it('reads the execution policy from the environment, not from code', () => {
    const config = loadWorkerConfig({ ...env, R4_WORKER_ID: 'w-7', R4_EXEC_MAX_ITERATIONS: '5', R4_EXEC_MAX_READ_CALLS: '0' });
    expect(config.workerId).toBe('w-7');
    expect(config.execution.maxIterations).toBe(5);
    expect(config.execution.maxReadCapabilityCalls).toBe(0);
  });

  it.each([
    ['missing database url', {}],
    ['heartbeat not fitting twice in the lease', { ...env, R4_WORKER_LEASE_MS: '1000', R4_WORKER_HEARTBEAT_MS: '600' }],
    ['unsafe worker id', { ...env, R4_WORKER_ID: 'bad id' }],
    // R4-I: an idle loop renews presence once per cycle; a cycle must fit twice into the freshness window.
    ['poll interval not fitting twice in the lease', { ...env, R4_WORKER_LEASE_MS: '1000', R4_WORKER_HEARTBEAT_MS: '200', R4_WORKER_POLL_MS: '600' }],
    ['zero iterations', { ...env, R4_EXEC_MAX_ITERATIONS: '0' }],
  ])('fails the boot on %s', (_name, bad) => {
    expect(() => loadWorkerConfig(bad)).toThrow();
  });

  it('generates distinct, log-safe worker ids', () => {
    const a = defaultWorkerId();
    const b = defaultWorkerId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });
});
