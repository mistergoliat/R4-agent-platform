import { afterEach, describe, expect, it } from 'vitest';
import type { FakeModelStep } from '@r4/model-gateway';
import { SALES_RUN_FAILURE_FALLBACK_TEXT } from '@r4-sales/agent/production';
import { LiveOpsTestbed, OPERATOR, say } from '../support/live-ops.js';

/**
 * R4-J5 P0 / ADR-041: a malformed model answer must never silently abandon an
 * active customer conversation. ADR-028 retries once; when recovery is
 * exhausted (or the model failure is not retryable) the task is handed to a
 * human AND the delivery owner sends the pack's fixed notice, exactly once.
 * The real production composition over PostgreSQL: webhook, Sales worker,
 * scripted model, delivery runtime and a local WhatsApp provider.
 */
const CUSTOMER = '56933334444';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

// The answer shapes the J4-R5 canary replay observed (finish_reason "stop", JSON mode on).
const TWO_DOCUMENTS: FakeModelStep = { type: 'text', content: '{"type":"read_capability","capabilityId":"catalog.search","arguments":{"query":"disco"}}{"type":"read_capability","capabilityId":"catalog.search","arguments":{"query":"barra"}}' };
const TRAILING_PROSE: FakeModelStep = { type: 'text', content: '{"type":"respond","content":"Hola"}\nEspero que esto te sirva, cualquier duda me dices.' };
const SCHEMA_INVALID: FakeModelStep = { type: 'structured', data: { type: 'respond' } };
const TRUNCATED: FakeModelStep = { type: 'text', content: '{"type":"respond","content":"Hola, te cuento que los discos', finishReason: 'length' };
const TRANSIENT: FakeModelStep = { type: 'provider_error', retryable: true };

async function start(): Promise<LiveOpsTestbed> {
  bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
  return bed;
}

async function settle(b: LiveOpsTestbed): Promise<void> {
  await b.runAgent();
  await b.deliver();
}

const outbound = (b: LiveOpsTestbed) => b.rows<{ origin: string; status: string; cancel_reason: string | null; attempts: number; body: string | null }>(`select origin, status, cancel_reason, attempts, body from outbound_messages order by created_at`);
const sentTexts = (b: LiveOpsTestbed) => b.provider.sends.filter((s) => s.to === CUSTOMER).map((s) => s.text);

describe('a malformed model answer never leaves the contact without a reply', { timeout: 90_000 }, () => {
  it('one malformed answer: ADR-028 recovers, the agent answers, no fallback', async () => {
    const b = await start();
    b.next(TWO_DOCUMENTS, say('Hola, ¿en qué te ayudo?'));
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    await settle(b);
    expect(sentTexts(b)).toEqual(['Hola, ¿en qué te ayudo?']);
    expect((await outbound(b)).map((o) => o.origin)).toEqual(['agent']);
  });

  it.each([
    ['two JSON documents', TWO_DOCUMENTS, TWO_DOCUMENTS],
    ['JSON followed by prose', TRAILING_PROSE, TRAILING_PROSE],
    ['schema-invalid but syntactically valid JSON', SCHEMA_INVALID, SCHEMA_INVALID],
    ['truncated answers', TRUNCATED, TRUNCATED],
    ['a transient provider error, then a malformed answer', TRANSIENT, TWO_DOCUMENTS],
  ])('two consecutive failures (%s): handoff + exactly one fixed fallback, delivered', async (_name, first, second) => {
    const b = await start();
    b.next(first, second);
    await b.customer(CUSTOMER, 'wamid.1', 'Hola, busco discos');
    await settle(b);
    const taskId = await b.taskOf(CUSTOMER);
    expect((await b.api.tasks.getTask(taskId)).task).toMatchObject({ status: 'blocked', statusReason: 'run_failure_recovery_exhausted' });
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
    expect(await outbound(b)).toEqual([{ origin: 'platform', status: 'accepted', cancel_reason: null, attempts: 1, body: SALES_RUN_FAILURE_FALLBACK_TEXT }]);
    // Idempotent: more delivery passes and more customer messages while the handoff waits add nothing.
    await b.customer(CUSTOMER, 'wamid.2', '¿hola?');
    await settle(b);
    await b.deliver();
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
    expect(b.pendingSteps).toBe(0);
  });

  it('a non-retryable model failure hands off at once and still sends the fallback', async () => {
    const b = await start();
    b.next({ type: 'provider_error', retryable: false, message: 'credentials rejected' });
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    await settle(b);
    const taskId = await b.taskOf(CUSTOMER);
    expect((await b.api.tasks.getTask(taskId)).task).toMatchObject({ status: 'blocked', statusReason: 'non_retryable_model_failure' });
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
  });

  it('a provider timeout twice: exhausted recovery, fallback sent', { timeout: 60_000 }, async () => {
    const b = await start();
    b.next({ type: 'timeout' }, { type: 'timeout' });
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    await settle(b);
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
  });

  it('a worker restart during recovery: the durable failure count carries over to the new worker', async () => {
    const b = await start();
    b.next(TWO_DOCUMENTS);
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    const first = await b.worker('worker-1');
    expect((await first.worker.runOnce()).kind).not.toBe('idle');
    await first.close();
    b.next(TRAILING_PROSE);
    const second = await b.worker('worker-2');
    for (let i = 0; i < 10 && (await second.worker.runOnce()).kind !== 'idle'; i += 1);
    await b.deliver();
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
    expect(await b.rows(`select payload->>'reason' as reason from human_requests`)).toEqual([{ reason: 'run_failure_recovery_exhausted' }]);
  });

  it('after a committed write the fallback claims nothing; before any write nothing was committed', async () => {
    const b = await start();
    const write: FakeModelStep = { type: 'structured', data: { type: 'propose_action', capabilityId: 'sales.workspace.update', arguments: { operations: [{ op: 'record_fact', key: 'budget', value: 300000, statedBy: 'customer' }] } } };
    b.next(write, TWO_DOCUMENTS, TRAILING_PROSE);
    await b.customer(CUSTOMER, 'wamid.1', 'Tengo 300 mil de presupuesto');
    await settle(b);
    expect(await b.rows(`select capability_id, status from action_receipts`)).toEqual([{ capability_id: 'sales.workspace.update', status: 'succeeded' }]);
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
    // The fixed text announces a problem and a person; it confirms no effect (quote, verification, order, payment).
    expect(SALES_RUN_FAILURE_FALLBACK_TEXT).not.toMatch(/cotizaci[oó]n|emit|confirm|pedido|pago|verific|listo|qued[oó]/i);
  });

  it('the fallback is retried when the provider definitely did not take it (429), and sent once', async () => {
    const b = await start();
    b.provider.script({ kind: 'status', status: 429, retryAfter: '0' });
    b.next(TWO_DOCUMENTS, TWO_DOCUMENTS);
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    await b.runAgent();
    await b.deliver();
    expect((await outbound(b))[0]).toMatchObject({ origin: 'platform', status: 'accepted', attempts: 2 });
    expect(await b.rows(`select a.attempt, a.outcome from outbound_delivery_attempts a join outbound_messages o using (outbound_id) where o.origin = 'platform' order by a.attempt`)).toEqual([{ attempt: 1, outcome: 'not_sent' }, { attempt: 2, outcome: 'accepted' }]);
    // The provider saw two requests: the first refused (429, definitely not sent), the second accepted.
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT, SALES_RUN_FAILURE_FALLBACK_TEXT]);
  });

  it('an operator who takes the conversation before the dispatch supersedes the fallback (nothing sent)', async () => {
    const b = await start();
    b.next(TWO_DOCUMENTS, TWO_DOCUMENTS);
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    await b.runAgent();
    await b.gateway.delivery.materialize();
    const [handoff] = await b.rows<{ request_id: string }>(`select request_id from human_requests`);
    await b.api.temporal.respondHuman(handoff!.request_id, { responseKey: 'accept', outcome: 'accept', content: 'Lo tomo yo.' }, OPERATOR);
    await b.deliver();
    expect(sentTexts(b)).toEqual([]);
    expect(await outbound(b)).toEqual([expect.objectContaining({ origin: 'platform', status: 'cancelled', cancel_reason: 'superseded_by_operator' })]);
  });

  it('the kill switch holds the fallback; re-enabling autonomy sends it', async () => {
    const b = await start();
    b.next(TWO_DOCUMENTS, TWO_DOCUMENTS);
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    await b.runAgent();
    await b.setAutonomy(false);
    await b.deliver();
    expect(sentTexts(b)).toEqual([]);
    expect((await outbound(b))[0]).toMatchObject({ origin: 'platform', status: 'pending' });
    await b.setAutonomy(true);
    await b.rows(`update outbound_messages set next_attempt_at = clock_timestamp() where origin = 'platform'`);
    await b.deliver();
    expect(sentTexts(b)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
  });

  it('the schema keeps a platform row tied to its handoff and its text', async () => {
    const b = await start();
    b.next(say('Hola'));
    await b.customer(CUSTOMER, 'wamid.1', 'Hola');
    await settle(b);
    const [o] = await b.rows<{ task_id: string; binding_id: string }>(`select task_id, binding_id from outbound_messages`);
    await expect(b.rows(
      `insert into outbound_messages (outbound_id, origin, task_id, binding_id, channel, idempotency_key, content_sha256, body, status, profile, correlation_id)
       values (gen_random_uuid(), 'platform', $1, $2, 'whatsapp', 'x', repeat('a', 64), 'texto', 'pending', 'p', 'c')`,
      [o!.task_id, o!.binding_id],
    )).rejects.toThrow(/outbound_messages_platform_fallback/);
  });
});
