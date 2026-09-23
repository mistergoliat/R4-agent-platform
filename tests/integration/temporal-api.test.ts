import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { Platform } from '@r4/api';
import type { TrustedHumanContext } from '@r4/contracts';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { ACTION_AGENTS_DIR, actionCapabilities, createActionTask, ledgerOf, WRITES } from '../support/actions.js';
import { startTestPlatform } from '../support/platform.js';
import { startTestWorker, type TestWorker } from '../support/worker.js';
import { propose, sequence } from '../support/decisions.js';
import { HUMAN, consult, drain, handoff, testScheduler, waitInput } from '../support/temporal.js';
import { ensureTestLedger, SET_TEST_RECORD_ID } from '../fixtures/capabilities/test-ledger.js';

/**
 * Test-only authentication adapter: a bearer token maps to a TrustedHumanContext
 * the way a real IAM adapter would. R4 ships none (no production IAM yet).
 */
const OPERATORS: Record<string, Omit<TrustedHumanContext, 'correlationId'>> = {
  'token-operator': { humanRef: HUMAN.humanRef, scopes: HUMAN.scopes },
  'token-reader': { humanRef: 'reader-one', scopes: [] },
};
const adapter = (request: FastifyRequest): TrustedHumanContext | null => {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  const operator = token ? OPERATORS[token] : undefined;
  return operator ? { ...operator, correlationId: request.id } : null;
};
const AUTH = { authorization: 'Bearer token-operator' };
const UNKNOWN = '0190a0a0-0000-7000-8000-000000000000';

let db: TestDatabase;
let platform: Platform;
let bare: Platform;
const workers: TestWorker[] = [];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url, { agentDefinitionsDir: ACTION_AGENTS_DIR, humanContext: adapter });
  bare = await startTestPlatform(db.url, { agentDefinitionsDir: ACTION_AGENTS_DIR });
  await ensureTestLedger(platform.pool);
});
afterEach(async () => {
  for (const w of workers.splice(0)) await w.platform.close();
  await platform?.close();
  await bare?.close();
  await db?.drop();
});

async function runWith(script: Parameters<typeof sequence>[0], options: Partial<Parameters<typeof startTestWorker>[1]> = {}) {
  const w = await startTestWorker(db.url, { workerId: `api-worker-${workers.length}`, script: sequence(script), ...options });
  workers.push(w);
  await w.platform.worker.runOnce();
}
const inject = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = AUTH, app: Platform = platform) =>
  app.app.inject({ method, url, headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
const body = (externalKey: string, content = 'hello') => ({ externalKey, content, sourceRef: 'api-test', occurredAt: '2026-09-23T12:00:00.000Z' });

describe('trusted human context boundary', () => {
  it('refuses every human operation without an authentication adapter; identity can never come from the body or headers', async () => {
    const taskId = await createActionTask(platform);
    for (const [method, url, payload] of [
      ['POST', `/v1/tasks/${taskId}/cancel`, {}],
      ['POST', `/v1/tasks/${taskId}/handoff`, { responseKey: 'k', note: 'n' }],
      ['GET', `/v1/tasks/${taskId}/temporal`, undefined],
      ['GET', '/v1/attention', undefined],
      ['POST', `/v1/human-requests/${UNKNOWN}/respond`, { responseKey: 'k', outcome: 'answer', content: 'x' }],
      ['POST', `/v1/executions/${UNKNOWN}/reconciliation/reschedule`, { responseKey: 'k' }],
    ] as const) {
      const res = await inject(method, url, payload, { authorization: 'Bearer token-operator', 'x-human-ref': 'operator-one' }, bare);
      expect(res.statusCode, url).toBe(422);
      expect(res.json().error.code).toBe('trusted_human_required');
    }
    // Unknown token → no context; a body cannot smuggle an identity (strict schema).
    expect((await inject('POST', `/v1/tasks/${taskId}/cancel`, {}, { authorization: 'Bearer nope' })).json().error.code).toBe('trusted_human_required');
    const smuggled = await inject('POST', `/v1/human-requests/${UNKNOWN}/respond`, { responseKey: 'k', outcome: 'answer', content: 'x', humanRef: 'operator-one' });
    expect(smuggled.statusCode).toBe(400);
    // Authenticated but without the scope.
    const reader = await inject('POST', `/v1/tasks/${taskId}/cancel`, {}, { authorization: 'Bearer token-reader' });
    expect([reader.statusCode, reader.json().error.code]).toEqual([422, 'human_scope_denied']);
  });
});

describe('inputs', () => {
  it('submits canonical input: 201, idempotent replay 200, conflicting reuse 409, validation 400, unknown task 404', async () => {
    const taskId = await createActionTask(platform);
    await runWith([waitInput()]);
    const first = await inject('POST', `/v1/tasks/${taskId}/inputs`, body('evt-1'), {});
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBe('false');
    const replay = await inject('POST', `/v1/tasks/${taskId}/inputs`, body('evt-1'), {});
    expect([replay.statusCode, replay.json().inputId, replay.headers['idempotency-replayed']]).toEqual([200, first.json().inputId, 'true']);
    expect((await inject('POST', `/v1/tasks/${taskId}/inputs`, body('evt-1', 'different'), {})).statusCode).toBe(409);
    expect((await inject('POST', `/v1/tasks/${taskId}/inputs`, { ...body('evt-2'), extra: true }, {})).statusCode).toBe(400);
    expect((await inject('POST', `/v1/tasks/${taskId}/inputs`, { content: 'no key' }, {})).statusCode).toBe(400);
    expect((await inject('POST', `/v1/tasks/${UNKNOWN}/inputs`, body('evt-3'), {})).statusCode).toBe(404);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running'); // woken once
  });
});

describe('human requests', () => {
  it('answers a consultation over HTTP (idempotent), refuses a second decision, 404 for unknown requests', async () => {
    const taskId = await createActionTask(platform);
    await runWith([consult('Which option?')]);
    const inspected = await inject('GET', `/v1/tasks/${taskId}/temporal`);
    expect(inspected.statusCode).toBe(200);
    const requestId = inspected.json().humans[0].requestId as string;
    const attention = await inject('GET', '/v1/attention');
    expect(attention.json().requests.map((r: { requestId: string }) => r.requestId)).toEqual([requestId]);
    const answer = { responseKey: 'a1', outcome: 'answer', content: 'Option A.' };
    const ok = await inject('POST', `/v1/human-requests/${requestId}/respond`, answer);
    expect([ok.statusCode, ok.json().request.status]).toEqual([200, 'answered']);
    expect((await inject('POST', `/v1/human-requests/${requestId}/respond`, answer)).statusCode).toBe(200);
    const again = await inject('POST', `/v1/human-requests/${requestId}/respond`, { ...answer, responseKey: 'a2' });
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'human_request_terminal']);
    expect((await inject('POST', `/v1/human-requests/${UNKNOWN}/respond`, answer)).statusCode).toBe(404);
    expect((await inject('POST', `/v1/human-requests/not-a-uuid/respond`, answer)).statusCode).toBe(400);
    expect((await inject('POST', `/v1/human-requests/${requestId}/respond`, { responseKey: 'a3', outcome: 'maybe', content: 'x' })).statusCode).toBe(400);
  });

  it('approves and rejects approval requests; a wrong-kind response is refused', async () => {
    for (const outcome of ['approve', 'reject'] as const) {
      const taskId = await createActionTask(platform);
      await runWith([propose(SET_TEST_RECORD_ID, { recordKey: `api-${outcome}`, value: 'v' })], { capabilities: actionCapabilities(platform.pool, { riskClass: 'IRREVERSIBLE_WRITE' }), policy: WRITES });
      const requestId = (await platform.temporal.inspect(taskId)).humans[0]!.requestId;
      const wrong = await inject('POST', `/v1/human-requests/${requestId}/respond`, { responseKey: 'w', outcome: 'answer', content: 'x' });
      expect([wrong.statusCode, wrong.json().error.code]).toEqual([400, 'invalid_human_response']);
      const decided = await inject('POST', `/v1/human-requests/${requestId}/respond`, { responseKey: 'd', outcome, content: 'Decision.' });
      expect(decided.json().request.status).toBe(outcome === 'approve' ? 'approved' : 'rejected');
      // The HTTP decision executes nothing: only a new policy evaluation in a worker could.
      expect((await ledgerOf(platform.pool, taskId)).executions).toEqual([]);
      expect((await inject('POST', `/v1/tasks/${taskId}/cancel`, {})).json().task.status).toBe('cancelled'); // keep the next round's claim unambiguous
    }
  });

  it('operator takeover and release over HTTP; invalid lifecycle transitions are refused', async () => {
    const taskId = await createActionTask(platform);
    await runWith([waitInput()]);
    const taken = await inject('POST', `/v1/tasks/${taskId}/handoff`, { responseKey: 'take', note: 'Taking over.' });
    expect([taken.statusCode, taken.json().request.status]).toEqual([200, 'active']);
    expect((await inject('POST', `/v1/tasks/${taskId}/handoff`, { responseKey: 'take', note: 'Taking over.' })).json().request.requestId).toBe(taken.json().request.requestId);
    expect((await inject('POST', `/v1/tasks/${taskId}/handoff`, { responseKey: 'take-2', note: 'Again.' })).statusCode).toBe(409);
    expect((await inject('POST', `/v1/tasks/${UNKNOWN}/handoff`, { responseKey: 'k', note: 'x' })).statusCode).toBe(404);
    const requestId = taken.json().request.requestId as string;
    const accept = await inject('POST', `/v1/human-requests/${requestId}/respond`, { responseKey: 'acc', outcome: 'accept', content: 'x' });
    expect([accept.statusCode, accept.json().error.code]).toEqual([409, 'human_request_terminal']);
    const released = await inject('POST', `/v1/human-requests/${requestId}/respond`, { responseKey: 'rel', outcome: 'release', content: 'Back to you.' });
    expect(released.json().request.status).toBe('released');
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running');
    const inspected = (await inject('GET', `/v1/tasks/${taskId}/temporal`)).json();
    expect(inspected.ownership).toMatchObject({ owner: 'agent', humanRef: null });
  });

  it('accepts an agent-requested handoff over HTTP', async () => {
    const taskId = await createActionTask(platform);
    await runWith([handoff('Please take over.')]);
    const requestId = (await platform.temporal.inspect(taskId)).humans[0]!.requestId;
    expect((await inject('POST', `/v1/human-requests/${requestId}/respond`, { responseKey: 'acc', outcome: 'accept', content: 'Mine.' })).json().request.status).toBe('active');
    expect((await inject('GET', `/v1/tasks/${taskId}/temporal`)).json().ownership).toMatchObject({ owner: 'human', humanRef: 'operator-one' });
  });
});

describe('cancel and reconciliation reschedule', () => {
  it('cancels over HTTP (idempotent on a terminal task), refuses a body, 404 for unknown tasks', async () => {
    const taskId = await createActionTask(platform);
    await runWith([waitInput()]);
    expect((await inject('POST', `/v1/tasks/${taskId}/cancel`, { reason: 'x' })).statusCode).toBe(400);
    const cancelled = await inject('POST', `/v1/tasks/${taskId}/cancel`, {});
    expect([cancelled.statusCode, cancelled.json().task.status]).toEqual([200, 'cancelled']);
    expect((await inject('POST', `/v1/tasks/${taskId}/cancel`, {})).json().task.status).toBe('cancelled');
    expect((await inject('POST', `/v1/tasks/${UNKNOWN}/cancel`, {})).statusCode).toBe(404);
    const late = await inject('POST', `/v1/tasks/${taskId}/inputs`, body('late'), {});
    expect([late.statusCode, late.json().error.code]).toEqual([409, 'task_not_accepting_input']);
  });

  it('re-arms only exhausted reconciliation; 404 for unknown executions', async () => {
    const taskId = await createActionTask(platform);
    await runWith([propose(SET_TEST_RECORD_ID, { recordKey: 'api-reconcile', value: 'v' })], { capabilities: actionCapabilities(platform.pool, { maxAttempts: 1, faults: { afterEffect: () => 'unknown', reconcile: () => 'unknown' } }), policy: WRITES });
    const executionId = (await ledgerOf(platform.pool, taskId)).executions[0]!.executionId;
    const early = await inject('POST', `/v1/executions/${executionId}/reconciliation/reschedule`, { responseKey: 'r' });
    expect([early.statusCode, early.json().error.code]).toEqual([409, 'reconciliation_not_exhausted']);
    expect((await inject('POST', `/v1/executions/${UNKNOWN}/reconciliation/reschedule`, { responseKey: 'r' })).statusCode).toBe(404);
    await platform.pool.query("update schedules set status = 'exhausted', policy = $1::jsonb, deadline_at = r4_now() where kind = 'reconciliation'", [JSON.stringify({ maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0, deadlineMs: 60_000 })]);
    const rearmed = await inject('POST', `/v1/executions/${executionId}/reconciliation/reschedule`, { responseKey: 'r' });
    expect([rearmed.statusCode, rearmed.json().schedule.status]).toEqual([200, 'pending']);
    expect(await drain(testScheduler(platform.pool).scheduler)).toBe(1);
  });
});
