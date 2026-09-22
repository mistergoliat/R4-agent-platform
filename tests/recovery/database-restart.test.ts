import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';

/**
 * Restarts the real PostgreSQL server under a live platform instance.
 * Requires the docker-compose database (`npm run db:up`); run in isolation
 * with `npm run test:recovery` because it takes the shared server down.
 */
const CONTAINER = process.env.R4_TEST_PG_CONTAINER ?? 'r4-agent-platform-postgres';

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

let db: TestDatabase;
let platform: Platform;

beforeAll(async () => {
  expect(docker('inspect', '-f', '{{.State.Running}}', CONTAINER)).toBe('true');
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
});

afterAll(async () => {
  // Leave the shared database running whatever happened.
  if (docker('inspect', '-f', '{{.State.Running}}', CONTAINER) !== 'true') docker('start', CONTAINER);
  await waitFor(async () => (await platform.app.inject({ method: 'GET', url: '/ready' })).statusCode === 200, 60_000).catch(() => undefined);
  await platform?.close();
  await db?.drop();
});

describe('database server restart', () => {
  it('degrades to 503 while PostgreSQL is down and recovers without a process restart, with no state loss', async () => {
    const created = await platform.app.inject({ method: 'POST', url: '/v1/tasks', payload: validTaskBody(), headers: { 'idempotency-key': 'db-restart-1' } });
    expect(created.statusCode).toBe(201);
    const before = created.json();
    const taskId = before.task.taskId as string;

    docker('stop', '-t', '5', CONTAINER);

    // Liveness is unaffected; readiness and data endpoints report unavailability.
    expect((await platform.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const notReady = await platform.app.inject({ method: 'GET', url: '/ready' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toMatchObject({ status: 'not_ready', checks: { database: { ok: false, reachable: false } } });
    const unavailable = await platform.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe('database_unavailable');

    docker('start', CONTAINER);
    await waitFor(async () => (await platform.app.inject({ method: 'GET', url: '/ready' })).statusCode === 200, 60_000);

    const after = await platform.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(before);

    // Idempotency and writes work again on the same process.
    const replay = await platform.app.inject({ method: 'POST', url: '/v1/tasks', payload: validTaskBody(), headers: { 'idempotency-key': 'db-restart-1' } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().task.taskId).toBe(taskId);
    const fresh = await platform.app.inject({ method: 'POST', url: '/v1/tasks', payload: validTaskBody() });
    expect(fresh.statusCode).toBe(201);
  });
});
