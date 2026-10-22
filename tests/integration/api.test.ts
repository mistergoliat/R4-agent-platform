import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentRunSchema,
  agentSummarySchema,
  registeredAgentDefinitionSchema,
  taskViewSchema,
  uuidSchema,
} from '@r4/contracts';
import { createPlatform, type Platform } from '@r4/api';
import { createSilentLogger } from '@r4/observability';
import { createMigratedTestDatabase, createTestDatabase, type TestDatabase } from '../support/database.js';
import { captureLogs } from '../support/logs.js';
import { REPO_AGENTS_DIR, startTestPlatform, validTaskBody } from '../support/platform.js';

let db: TestDatabase;
let platform: Platform;
const logs = captureLogs('r4-api-test');

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url, { logger: logs.logger });
});

afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  platform.app.inject({ method: 'POST', url: '/v1/tasks', payload: body as object, headers });

describe('health and readiness', () => {
  it('GET /health reports liveness', async () => {
    const res = await platform.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready reports dependency readiness', async () => {
    const res = await platform.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: { database: { ok: true, pendingMigrations: [] }, agentDefinitions: { ok: true, loaded: 7 } } }); // platform-probe + the sales pack (v3 and v4, R4-J2D; v5, R4-J3E; v6, R4-J3E-B; v7, R4-J3E-C1; v8, R4-J4-R4)
  });

  it('refuses to boot against a database without the current schema', async () => {
    const empty = await createTestDatabase();
    try {
      await expect(
        createPlatform(
          { databaseUrl: empty.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: REPO_AGENTS_DIR, dbPoolMax: 2 },
          { logger: createSilentLogger() },
        ),
      ).rejects.toMatchObject({ code: 'schema_not_current' });
    } finally {
      await empty.drop();
    }
  });
});

describe('POST /v1/tasks', () => {
  it('creates a task (201) and returns the task view with Location', async () => {
    const res = await post(validTaskBody());
    expect(res.statusCode).toBe(201);
    const view = taskViewSchema.parse(res.json());
    expect(res.headers.location).toBe(`/v1/tasks/${view.task.taskId}`);
    expect(res.headers['idempotency-replayed']).toBe('false');
    expect(view.task).toMatchObject({ status: 'pending', requestedBy: { kind: 'unauthenticated', ref: 'anonymous' } });
    expect(view.task.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('replays an idempotent request (200) and rejects key reuse with a different body (409)', async () => {
    const first = await post(validTaskBody(), { 'idempotency-key': 'api-key-1' });
    const again = await post(validTaskBody(), { 'idempotency-key': 'api-key-1' });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json().task.taskId).toBe(first.json().task.taskId);

    const reuse = await post(validTaskBody({ input: { message: 'other' } }), { 'idempotency-key': 'api-key-1' });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('idempotency_key_reused');
  });

  it.each([
    ['unknown field', validTaskBody({ status: 'completed' })],
    ['client-asserted identity', validTaskBody({ requestedBy: { kind: 'system', ref: 'root' } })],
    ['missing goal', { taskType: 'probe.echo', agentId: 'platform-probe' }],
    ['invalid agent id', validTaskBody({ agentId: 'Not Valid' })],
    ['array body', [1, 2, 3]],
  ])('rejects %s with 400 and a structured error', async (_label, body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error).toMatchObject({ code: 'validation_failed', correlationId: res.headers['x-correlation-id'] });
    expect(error.details.issues.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON, wrong content type, missing body and oversized bodies', async () => {
    const malformed = await platform.app.inject({ method: 'POST', url: '/v1/tasks', payload: '{"taskType":', headers: { 'content-type': 'application/json' } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('invalid_request');

    const text = await platform.app.inject({ method: 'POST', url: '/v1/tasks', payload: 'hello', headers: { 'content-type': 'text/plain' } });
    expect(text.statusCode).toBe(415);

    const empty = await platform.app.inject({ method: 'POST', url: '/v1/tasks' });
    expect(empty.statusCode).toBe(400);

    const huge = await post(validTaskBody({ input: { blob: 'x'.repeat(300 * 1024) } }));
    expect(huge.statusCode).toBe(413);
  });

  it('rejects a malformed Idempotency-Key header', async () => {
    const res = await post(validTaskBody(), { 'idempotency-key': 'has spaces in it' });
    expect(res.statusCode).toBe(400);
  });

  it('maps runtime preconditions to 422', async () => {
    const unknownAgent = await post(validTaskBody({ agentId: 'ghost-agent' }));
    expect(unknownAgent.statusCode).toBe(422);
    expect(unknownAgent.json().error.code).toBe('agent_not_found');
    const badType = await post(validTaskBody({ taskType: 'other.thing' }));
    expect(badType.statusCode).toBe(422);
    expect(badType.json().error.code).toBe('task_type_not_supported');
  });
});

describe('GET /v1/tasks/:id', () => {
  it('returns the persisted task view', async () => {
    const created = (await post(validTaskBody())).json();
    const res = await platform.app.inject({ method: 'GET', url: `/v1/tasks/${created.task.taskId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
  });

  it('returns 400 for malformed ids and 404 for unknown ones', async () => {
    expect((await platform.app.inject({ method: 'GET', url: '/v1/tasks/not-a-uuid' })).statusCode).toBe(400);
    const missing = await platform.app.inject({ method: 'GET', url: '/v1/tasks/0190a0a0-0000-7000-8000-000000000000' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('task_not_found');
  });
});

describe('GET /v1/agents', () => {
  it('lists agent summaries', async () => {
    const res = await platform.app.inject({ method: 'GET', url: '/v1/agents' });
    expect(res.statusCode).toBe(200);
    const { agents } = res.json();
    expect(agents).toHaveLength(2); // R4-F: the repository also ships the sales reference agent
    expect(agentSummarySchema.parse(agents[0])).toMatchObject({ agentId: 'platform-probe', version: 1 });
  });

  it('returns a full definition, by latest or exact version', async () => {
    const latest = await platform.app.inject({ method: 'GET', url: '/v1/agents/platform-probe' });
    expect(latest.statusCode).toBe(200);
    expect(registeredAgentDefinitionSchema.parse(latest.json()).capabilityScopes).toEqual(['platform_test.read']);
    expect((await platform.app.inject({ method: 'GET', url: '/v1/agents/platform-probe?version=1' })).statusCode).toBe(200);
    expect((await platform.app.inject({ method: 'GET', url: '/v1/agents/platform-probe?version=9' })).statusCode).toBe(404);
    expect((await platform.app.inject({ method: 'GET', url: '/v1/agents/platform-probe?version=abc' })).statusCode).toBe(400);
    expect((await platform.app.inject({ method: 'GET', url: '/v1/agents/platform-probe?extra=1' })).statusCode).toBe(400);
    expect((await platform.app.inject({ method: 'GET', url: '/v1/agents/Bad_Id' })).statusCode).toBe(400);
    expect((await platform.app.inject({ method: 'GET', url: '/v1/agents/unknown-agent' })).statusCode).toBe(404);
  });
});

describe('GET /v1/runs/:id', () => {
  it('returns a run created by the runtime', async () => {
    const created = (await post(validTaskBody())).json();
    const { run } = await platform.tasks.startRun({ taskId: created.task.taskId, actor: { kind: 'system', ref: 'test' }, correlationId: 'c' });
    const res = await platform.app.inject({ method: 'GET', url: `/v1/runs/${run.runId}` });
    expect(res.statusCode).toBe(200);
    expect(agentRunSchema.parse(res.json())).toEqual(run);

    const task = (await platform.app.inject({ method: 'GET', url: `/v1/tasks/${created.task.taskId}` })).json();
    expect(task.task.status).toBe('running');
    expect(task.runs).toEqual([{ runId: run.runId, sequence: 1, status: 'running' }]);
  });

  it('returns 404 for unknown runs', async () => {
    const res = await platform.app.inject({ method: 'GET', url: '/v1/runs/0190a0a0-0000-7000-8000-000000000000' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('run_not_found');
  });
});

describe('surface and observability', () => {
  it('exposes no endpoints for unimplemented features', async () => {
    // R4-E implemented cancel and attention (human-context gated; see temporal-api.test.ts).
    for (const [method, url] of [
      ['POST', '/v1/turns'],
      ['GET', '/v1/artifacts/x'],
      ['POST', '/v1/approvals/x/approve'],
      ['POST', '/v1/tasks/0190a0a0-0000-7000-8000-000000000000/delegate'],
    ] as const) {
      const res = await platform.app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('route_not_found');
    }
  });

  it('echoes a valid correlation id and replaces an invalid one', async () => {
    const echoed = await platform.app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'client-trace-42' } });
    expect(echoed.headers['x-correlation-id']).toBe('client-trace-42');
    const replaced = await platform.app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'bad id\n' } });
    expect(uuidSchema.safeParse(replaced.headers['x-correlation-id']).success).toBe(true);
  });

  it('writes structured logs where runtime events carry the request correlation id', async () => {
    const res = await post(validTaskBody(), { 'x-correlation-id': 'trace-task-create' });
    const taskId = res.json().task.taskId as string;
    const created = logs.events('task.created').find((e) => e.taskId === taskId);
    expect(created).toMatchObject({ correlationId: 'trace-task-create', agentId: 'platform-probe', service: 'r4-api-test' });
    const request = logs.events('http.request.completed').find((e) => e.correlationId === 'trace-task-create');
    expect(request).toMatchObject({ method: 'POST', route: '/v1/tasks', statusCode: 201 });
    // Goal text and task input are data, not telemetry.
    expect(logs.raw()).not.toContain('Echo the input back');
  });
});
