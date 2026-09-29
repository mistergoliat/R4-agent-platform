import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@r4/model-gateway';
import { OpenAICompatibleModelProvider, type FetchLike } from '@r4-adapters/openai-compatible';
import {
  CAPABILITY_IDS,
  PostgresSalesStore,
  SalesHarness,
  add,
  customerOnFile,
  destination,
  fact,
  migrateSales,
  observedQuote,
  proposeQuote,
  read,
  respond,
  scriptedAgent,
  update,
  waitForCustomer,
  workspaceUpdateInputSchema,
  type ScriptedStep,
} from '@r4-sales/agent';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { drain, testScheduler } from '../support/temporal.js';
import type { Pool } from '@r4/persistence-postgres';

let db: TestDatabase;
let pool: Pool;
const harnesses: SalesHarness[] = [];

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  expect((await migrateSales(pool)).applied).toEqual(['0006_sales_reference_application']);
  expect((await migrateSales(pool)).applied).toEqual([]);
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

async function harness(steps: readonly ScriptedStep[], options: Partial<Parameters<typeof SalesHarness.start>[0]> = {}) {
  const provider = new FakeModelProvider(scriptedAgent(steps));
  const h = await SalesHarness.start({ databaseUrl: db.url, modelProvider: provider, execution: { modelCallTimeoutMs: 10_000 }, ...options });
  harnesses.push(h);
  return { h, provider };
}

const TASK_A = '0190a0a0-0000-7000-8000-0000000000a1';
const ops = (input: unknown) => workspaceUpdateInputSchema.parse(input);

describe('Sales workspace store (PostgreSQL, sales schema)', () => {
  it('applies a command at most once per execution key; a replay returns the original answer', async () => {
    const store = new PostgresSalesStore(pool);
    const first = await store.applyCommand({ taskId: TASK_A, executionKey: 'r4x_a1', input: ops({ operations: [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }] }), unknownProducts: [], now: '2026-09-23T10:00:00.000Z' });
    await store.applyCommand({ taskId: TASK_A, executionKey: 'r4x_a2', input: ops({ operations: [{ op: 'set_item_quantity', productId: 'BAR-OLY20', quantity: 3 }] }), unknownProducts: [], now: '2026-09-23T10:01:00.000Z' });
    const replay = await store.applyCommand({ taskId: TASK_A, executionKey: 'r4x_a1', input: ops({ operations: [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }] }), unknownProducts: [], now: '2026-09-23T10:02:00.000Z' });
    expect(first).toMatchObject({ replayed: false, result: { status: 'applied', version: 1 } });
    expect(replay).toMatchObject({ replayed: true, result: { status: 'applied', version: 1, state: { items: [{ productId: 'BAR-OLY20', quantity: 1 }] } } });
    expect((await store.workspace(TASK_A)).version).toBe(2);
    expect((await store.transitions(TASK_A)).map((t) => [t.executionKey, t.outcome, t.fromVersion, t.toVersion])).toEqual([['r4x_a1', 'applied', 0, 1], ['r4x_a2', 'applied', 1, 2]]);
  });

  it('serializes concurrent commands of one conversation (no lost update, one row per key)', async () => {
    const store = new PostgresSalesStore(pool);
    const task = '0190a0a0-0000-7000-8000-0000000000a2';
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.applyCommand({ taskId: task, executionKey: `r4x_c${i % 4}`, input: ops({ operations: [{ op: 'record_fact', key: `k${i % 4}`, value: i % 4, statedBy: 'customer' }] }), unknownProducts: [], now: '2026-09-23T10:00:00.000Z' })));
    const w = await store.workspace(task);
    expect(w.version).toBe(4);
    expect(Object.keys(w.state.facts).sort()).toEqual(['k0', 'k1', 'k2', 'k3']);
    expect(await store.transitions(task)).toHaveLength(4);
  });

  it('records rejected commands too, without moving the version', async () => {
    const store = new PostgresSalesStore(pool);
    const task = '0190a0a0-0000-7000-8000-0000000000a3';
    const out = await store.applyCommand({ taskId: task, executionKey: 'r4x_r1', input: ops({ operations: [{ op: 'remove_item', productId: 'BAR-OLY20' }] }), unknownProducts: [], now: '2026-09-23T10:00:00.000Z' });
    expect(out.result).toMatchObject({ status: 'rejected', code: 'item_not_selected', version: 0 });
    expect(await store.transitions(task)).toMatchObject([{ outcome: 'rejected', fromVersion: 0, toVersion: 0 }]);
  });

  it('the audit trail and quote records are append-only; state survives a new pool (restart)', async () => {
    await expect(pool.query(`update sales.workspace_transitions set outcome = 'rejected' where execution_key = 'r4x_a1'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`delete from sales.workspace_transitions where execution_key = 'r4x_a1'`)).rejects.toThrow(/append-only/);
    const fresh = openPool(db.url);
    try {
      expect(await new PostgresSalesStore(fresh).workspace(TASK_A)).toMatchObject({ version: 2, state: { items: [{ productId: 'BAR-OLY20', quantity: 3 }] } });
    } finally {
      await fresh.end();
    }
  });
});

describe('Sales conversation on R4 (governed quote, owners, recovery)', () => {
  it('creates the quote through propose_action → policy → command → receipt, keyed by the platform execution key', async () => {
    const { h } = await harness([
      read(CAPABILITY_IDS.customerContext),
      read(CAPABILITY_IDS.productContext, { productKey: 'KB-16' }),
      update([add('KB-16', 2), destination('Maipú')]),
      proposeQuote(customerOnFile),
      respond((v) => `Cotización ${observedQuote(v).quoteNumber}.`),
      waitForCustomer(),
    ]);
    const taskId = await h.openConversation({ customerRef: 'cust-demo-001' });
    await h.say(taskId, 'Cotízame 2 kettlebells de 16 kg a Maipú.');
    const state = await h.inspect(taskId);
    const proposal = state.ledger.proposals.find((p) => p.capabilityId === CAPABILITY_IDS.quoteCreate)!;
    const decision = state.ledger.decisions.find((d) => d.proposalId === proposal.proposalId)!;
    const execution = state.ledger.executions.find((e) => e.proposalId === proposal.proposalId)!;
    const receipt = state.ledger.receipts.find((r) => r.executionId === execution.executionId)!;
    expect(proposal.evidenceRefs.length).toBeGreaterThan(0);
    expect(decision).toMatchObject({ outcome: 'allow', rule: 'capabilities.quote.create.autonomy', policy: { policyId: 'sales-reference-policy', version: 1 }, identityAssurance: 'provisional' });
    expect(execution).toMatchObject({ status: 'succeeded', riskClass: 'IRREVERSIBLE_WRITE' });
    expect(receipt).toMatchObject({ status: 'succeeded', executionKey: execution.executionKey, externalOperationRef: 'COT-100001' });
    // The downstream idempotency key IS the platform execution key: one command, one logical quote.
    expect(h.domains.quotes.issued).toHaveLength(1);
    expect(await h.domains.quotes.findByIdempotencyKey(execution.executionKey)).toMatchObject({ quoteNumber: 'COT-100001' });
    // The quote reference in Sales state comes from the owner's answer, tied to the workspace version it quoted.
    expect(state.quoteReferences).toEqual([expect.objectContaining({ executionKey: execution.executionKey, quoteNumber: 'COT-100001', basedOnWorkspaceVersion: 1 })]);
    // The agent answered only after the receipt-backed observation, and the task waits for the customer.
    expect(state.task.status).toBe('waiting');
  });

  it('denies a quote proposal that cites no evidence; nothing reaches the Quote owner', async () => {
    const bare: ScriptedStep = (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { workspaceVersion: v.workspace.workspaceVersion, customer: { name: 'Ana Test', email: 'ana@example.test' } } });
    const { h } = await harness([update([add('KB-16'), destination('Maipú')]), bare, respond('Necesito revisar el catálogo antes de cotizar.'), waitForCustomer()]);
    const taskId = await h.openConversation();
    await h.say(taskId, 'Cotiza una kettlebell a Maipú.');
    const state = await h.inspect(taskId);
    expect(state.observations.find((o) => o.source.capabilityId === CAPABILITY_IDS.quoteCreate)).toMatchObject({ outcome: 'rejected', error: { code: 'policy_denied', details: { reasonCode: 'evidence_required' } } });
    expect(state.ledger.executions.filter((e) => e.capabilityId === CAPABILITY_IDS.quoteCreate)).toEqual([]);
    expect(h.domains.quotes.createCalls).toBe(0);
  });

  it('a Quote owner outage before any effect is a receipt-backed failure, not a quote', async () => {
    const { h } = await harness([
      read(CAPABILITY_IDS.productContext, { productKey: 'KB-16' }),
      update([add('KB-16'), destination('Maipú')]),
      proposeQuote({ name: 'Ana Test', email: 'ana@example.test' }),
      respond('No pude emitir la cotización: el servicio no está disponible.'),
      waitForCustomer(),
    ]);
    h.domains.quotes.availability.set({ mode: 'down' });
    const taskId = await h.openConversation();
    await h.say(taskId, 'Cotiza una kettlebell a Maipú.');
    const state = await h.inspect(taskId);
    expect(state.observations.find((o) => o.source.capabilityId === CAPABILITY_IDS.quoteCreate)).toMatchObject({ outcome: 'failed', error: { code: 'write_execution_failure', details: { domainCode: 'quote_service_unavailable' } } });
    expect(state.ledger.receipts.find((r) => r.capabilityId === CAPABILITY_IDS.quoteCreate)).toMatchObject({ status: 'failed' });
    expect(h.domains.quotes.issued).toHaveLength(0);
    expect(state.quoteReferences).toEqual([]);
  });

  it('an unknown quote outcome is never guessed: the task blocks until reconciliation by key establishes it', async () => {
    const { h } = await harness([
      read(CAPABILITY_IDS.productContext, { productKey: 'KB-16' }),
      update([add('KB-16'), destination('Maipú')]),
      proposeQuote({ name: 'Ana Test', email: 'ana@example.test' }),
      // Only reached after reconciliation, in a new run.
      respond((v) => `Cotización ${observedQuote(v).quoteNumber} emitida.`),
      waitForCustomer(),
    ]);
    h.domains.quotes.faults.afterIssue = () => 'connection_lost';
    let lookupsDown = true;
    h.domains.quotes.faults.lookup = () => (lookupsDown ? 'timeout' : 'answer');
    const taskId = await h.openConversation();
    await h.say(taskId, 'Cotiza una kettlebell a Maipú.');
    let state = await h.inspect(taskId);
    const execution = state.ledger.executions.find((e) => e.capabilityId === CAPABILITY_IDS.quoteCreate)!;
    expect(execution.status).toBe('needs_reconciliation');
    expect(state.task.status).toBe('blocked');
    expect(state.observations.filter((o) => o.source.capabilityId === CAPABILITY_IDS.quoteCreate)).toEqual([]);
    expect(state.runs.flatMap((r) => r.steps).filter((s) => s.decision?.type === 'respond')).toEqual([]);
    expect(h.domains.quotes.issued).toHaveLength(1);

    // The scheduler dispatches the durable reconciliation work; the worker settles it with the same key.
    lookupsDown = false;
    const { scheduler } = testScheduler(pool, { policy: { maxAttempts: 3, initialBackoffMs: 0, maxBackoffMs: 0, deadlineMs: 86_400_000 } });
    expect(await drain(scheduler)).toBeGreaterThan(0);
    await h.runUntilIdle();
    state = await h.inspect(taskId);
    const receipt = state.ledger.receipts.find((r) => r.executionId === execution.executionId)!;
    expect(receipt).toMatchObject({ status: 'succeeded', executionKey: execution.executionKey, evidence: { obtainedVia: 'reconcile' } });
    expect(h.domains.quotes.issued).toHaveLength(1);
    expect(h.domains.quotes.createCalls).toBe(1);
    expect(state.task.status).toBe('waiting');
    expect(state.runs.flatMap((r) => r.steps).find((s) => s.decision?.type === 'respond')?.decision).toMatchObject({ content: 'Cotización COT-100001 emitida.' });
  });

  it('a worker that dies after the quote was issued leaves one logical quote and one effective receipt', async () => {
    const { h } = await harness(
      [read(CAPABILITY_IDS.productContext, { productKey: 'KB-16' }), update([add('KB-16'), destination('Maipú')]), proposeQuote({ name: 'Ana Test', email: 'ana@example.test' }), respond((v) => `Cotización ${observedQuote(v).quoteNumber}.`), waitForCustomer()],
      { leaseDurationMs: 1_500, heartbeatIntervalMs: 300 },
    );
    let hang = true;
    h.domains.quotes.faults.afterIssue = () => (hang ? ((hang = false), 'hang') : 'answer');
    const taskId = await h.openConversation();
    await h.sayThroughWorkerDeath(taskId, 'Cotiza una kettlebell a Maipú.', () => h.domains.quotes.issued.length === 1);
    const state = await h.inspect(taskId);
    const execution = state.ledger.executions.find((e) => e.capabilityId === CAPABILITY_IDS.quoteCreate)!;
    const attempts = state.ledger.attempts.filter((a) => a.executionId === execution.executionId);
    expect(attempts.map((a) => [a.kind, a.outcome])).toEqual([['execute', null], ['reconcile', 'applied']]);
    expect(state.ledger.receipts.filter((r) => r.executionId === execution.executionId)).toHaveLength(1);
    expect(h.domains.quotes.issued).toHaveLength(1);
    expect(h.domains.quotes.createCalls).toBe(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]!.run.recoveries).toBe(1);
  });

  it('the Sales workspace survives a worker restart and reaches the next run as AUTHORITATIVE state', async () => {
    const { h, provider } = await harness([update([fact('budget', { amount: 500_000, currency: 'CLP' })]), respond('Anotado.'), waitForCustomer(), respond('Sigo con tu presupuesto.'), waitForCustomer()]);
    const taskId = await h.openConversation();
    await h.say(taskId, 'Tengo 500 mil.');
    await h.restartWorker();
    await h.say(taskId, '¿Qué me recomiendas?');
    const lastContext = provider.requests.at(-2)!.context!;
    expect(lastContext.sections.authoritativeState).toEqual([expect.objectContaining({ itemId: `sales_workspace:${taskId}`, sourceId: 'sales.workspace', authority: 'AUTHORITATIVE', content: expect.objectContaining({ workspaceVersion: 1, facts: { budget: { value: { amount: 500_000, currency: 'CLP' }, statedBy: 'customer', sinceVersion: 1 } } }) })]);
    // The earlier run's question and the new customer message are both in that context (cross-run continuity).
    const turns = lastContext.sections.conversation.map((i) => (i.content as { text: string }).text);
    expect(turns).toEqual(expect.arrayContaining(['Anotado.', 'Tengo 500 mil.', '¿Qué me recomiendas?']));
  });

  it('an unauthenticated requester cannot get a quote issued (identity below the capability requirement)', async () => {
    const { h } = await harness([read(CAPABILITY_IDS.productContext, { productKey: 'KB-16' }), update([add('KB-16'), destination('Maipú')]), proposeQuote({ name: 'Ana Test', email: 'ana@example.test' }), respond('No puedo emitirla desde este canal.'), waitForCustomer()]);
    const { view } = await h.api.tasks.createTask({ request: { taskType: 'sales.conversation', agentId: 'sales', goal: { description: 'anonymous channel' } }, requestedBy: { kind: 'unauthenticated', ref: 'anonymous' }, correlationId: 'anon' });
    await h.store.bindConversation({ taskId: view.task.taskId, customerRef: null, channelRef: 'anon' });
    await h.say(view.task.taskId, 'Cotiza una kettlebell.');
    const state = await h.inspect(view.task.taskId);
    expect(state.observations.find((o) => o.source.capabilityId === CAPABILITY_IDS.quoteCreate)).toMatchObject({ outcome: 'rejected', error: { code: 'policy_denied', details: { reasonCode: 'identity_requirement_unmet' } } });
    expect(h.domains.quotes.createCalls).toBe(0);
  });
});

describe('first real ModelProvider adapter inside the Sales runtime', () => {
  const KEY = 'sk-live-looking-SECRET-4f1c2e9a7b';
  const config = { profile: 'it', baseUrl: 'https://llm.example.test/v1', apiKey: KEY, model: 'm', timeoutMs: 5_000, contextWindowTokens: 200_000, maxOutputTokens: 1_000, responseFormat: 'json_object' as const, temperature: null, extraBody: {} };

  it('runs a turn through OpenAICompatibleModelProvider and persists no secret anywhere', async () => {
    const answers = ['{"type":"respond","content":"Hola, ¿en qué te ayudo?"}', '{"type":"wait","condition":{"kind":"WAIT_FOR_INPUT"}}'];
    const seen: string[] = [];
    const fetch: FetchLike = (_url, init) => {
      seen.push(init.headers.authorization ?? '');
      const content = answers.shift() ?? '{"type":"wait","condition":{"kind":"WAIT_FOR_INPUT"}}';
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({ id: 'x', model: 'm-1', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } })) });
    };
    const h = await SalesHarness.start({ databaseUrl: db.url, modelProvider: new OpenAICompatibleModelProvider(config, { fetch }), captureTelemetry: true });
    harnesses.push(h);
    const taskId = await h.openConversation();
    await h.say(taskId, 'Hola');
    const state = await h.inspect(taskId);
    expect(state.task.status).toBe('waiting');
    expect(state.runs[0]!.steps.map((s) => [s.decision?.type, s.usage])).toEqual([['respond', { inputTokens: 50, outputTokens: 5 }], ['wait', { inputTokens: 50, outputTokens: 5 }]]);
    expect(seen.every((h) => h === `Bearer ${KEY}`)).toBe(true);
    expect(h.telemetry.find((e) => e.event === 'model.call.completed')).toMatchObject({ providerId: 'openai-compatible.it', modelId: 'm-1', inputTokens: 50 });
    // Nothing durable or logged contains the key or the header.
    const dump = await pool.query<{ t: string }>(`
      select string_agg(t, ' ') as t from (
        select row_to_json(x)::text as t from context_snapshots x union all
        select row_to_json(x)::text from agent_run_steps x union all
        select row_to_json(x)::text from agent_runs x union all
        select row_to_json(x)::text from observations x union all
        select row_to_json(x)::text from memory_entries x union all
        select row_to_json(x)::text from temporal_events x union all
        select row_to_json(x)::text from action_receipts x union all
        select row_to_json(x)::text from sales.workspace_transitions x) all_rows`);
    expect(dump.rows[0]!.t.length).toBeGreaterThan(1_000);
    expect(dump.rows[0]!.t).not.toContain(KEY);
    expect(dump.rows[0]!.t.toLowerCase()).not.toContain('bearer');
    expect(JSON.stringify(h.telemetry)).not.toContain(KEY);
  });

  it('an adapter transport timeout ends the run as a classified model failure (timeout), never a guess', async () => {
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const h = await SalesHarness.start({ databaseUrl: db.url, modelProvider: new OpenAICompatibleModelProvider({ ...config, timeoutMs: 50 }, { fetch: hang }), execution: { modelCallTimeoutMs: 5_000 } });
    harnesses.push(h);
    const taskId = await h.openConversation();
    await h.say(taskId, 'Hola');
    const state = await h.inspect(taskId);
    expect(state.runs[0]!.run.termination).toMatchObject({ reason: 'model_failure', code: 'timeout' });
    expect(state.runs[0]!.steps).toEqual([expect.objectContaining({ outcome: 'model_failed', error: expect.objectContaining({ code: 'timeout' }) })]);
  });
});
