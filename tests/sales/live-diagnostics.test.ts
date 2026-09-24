import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@r4/model-gateway';
import { CAPABILITY_IDS, RecordingModelProvider, fact, migrateSales, respond, runScenario, scriptedAgent, shapeOf, traceDecisions, traceGovernance, update, waitForCustomer, type ScriptedStep, type SalesScenario } from '@r4-sales/agent';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-F live validation, offline: the first DeepSeek runs of S02 ended with
 * `invalid_decision / unknown_evidence`, and the live harness could neither
 * say which reference was refused (a rejected decision is recorded without
 * its content) nor keep going to write its artifact when the task failed
 * before the last turn. This replays the exact live mistake — a workspace
 * update citing the customer's own conversation turn as evidence — through
 * the live path with a stand-in provider.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  const pool = openPool(db.url);
  try {
    await migrateSales(pool);
  } finally {
    await pool.end();
  }
});

afterAll(async () => {
  await db?.drop();
});

/** What the model did live: the id of the customer's message (a `memory:<entryId>` item) as evidence. */
const citeTheCustomerTurn: ScriptedStep = (v) => {
  const turn = v.context.sections.conversation.find((i) => i.itemId.startsWith('memory:'));
  if (!turn) throw new Error('no customer turn in context');
  return {
    type: 'propose_action',
    capabilityId: CAPABILITY_IDS.workspaceUpdate,
    arguments: { expectedVersion: 0, operations: [fact('presupuesto_clp', 800_000), fact('objetivo', 'armar un gym para la casa')] },
    evidenceRefs: [turn.provenance.recordId],
  };
};

const S02_LIKE: SalesScenario = {
  id: 'LIVE-S02-REPLAY',
  title: 'conversation turn cited as evidence',
  turns: [
    { customer: 'Tengo $800.000 y quiero armar un gym para la casa.', agent: [] },
    { customer: 'Tengo 3 x 3 metros en la cochera, 2,4 m de alto.', agent: [] },
  ],
  invariants: [{ kind: 'root_goal_active' }],
};

describe('live harness diagnostics (unknown_evidence replay)', () => {
  it('records the refused decision, classifies the cited ref and reports the task handed over instead of failed (ADR-028)', async () => {
    const recorder = new RecordingModelProvider(new FakeModelProvider(scriptedAgent([citeTheCustomerTurn])));
    const run = await runScenario(S02_LIKE, { databaseUrl: db.url, mode: 'live', modelProvider: recorder });

    // The platform still refuses it: nothing was weakened.
    // ADR-028: run 1 fails as before; the stand-in has nothing left for the recovery run (non-retryable) → a human decides.
    expect(run.report.finalTaskStatus).toBe('blocked');
    expect(run.report.runs[0]).toMatchObject({ termination: { reason: 'invalid_decision', code: 'unknown_evidence' } });
    expect(run.report.workspace.version).toBe(0);
    // The second turn is accepted durably (the task is not terminal); it waits for the human who owns the next step.
    expect(run.undeliveredTurns).toEqual([]);

    const [trace, recovery, ...rest] = traceDecisions(run.state, recorder.calls);
    expect(rest).toHaveLength(0);
    // The recovery run (new run, fresh context) found no scripted step: a non-retryable provider failure.
    expect(recovery).toMatchObject({ runSequence: 2, iteration: 1, outcome: 'model_failed' });
    const turnRef = (trace!.rejectedDecision as { evidenceRefs: string[] }).evidenceRefs[0]!;
    expect(trace).toMatchObject({ runSequence: 1, iteration: 1, outcome: 'invalid', errorCode: 'unknown_evidence', decisionType: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate });
    expect(trace!.citedRefs).toEqual([{ ref: turnRef, kind: 'context_item_record_id', acceptable: false, inContext: true, section: 'conversation', matchedItemId: `memory:${turnRef}` }]);
  });
});

describe('live harness governance trace', () => {
  it('joins each governed write from proposal to receipt', async () => {
    const recorder = new RecordingModelProvider(new FakeModelProvider(scriptedAgent([update([fact('presupuesto_clp', 800_000)]), respond('Anotado.'), waitForCustomer()])));
    const run = await runScenario({ id: 'LIVE-GOV', title: 'one governed write', turns: [{ customer: 'Tengo 800 mil.', agent: [] }], invariants: [] }, { databaseUrl: db.url, mode: 'live', modelProvider: recorder });
    const [write, ...rest] = traceGovernance(run.state);
    expect(rest).toHaveLength(0);
    expect(write).toMatchObject({ capabilityId: CAPABILITY_IDS.workspaceUpdate, iteration: 1, evidenceRefs: [], policy: { outcome: 'allow' }, command: { status: 'succeeded' }, receipt: { status: 'succeeded' } });
    expect(write!.receipt!.receiptId).toBe(run.state.ledger.receipts[0]!.receiptId);
  });
});

/**
 * R4-F live validation (S11, reasoning enabled): the model returned one JSON
 * decision followed by prose narrating its plan. The platform rejects it
 * (`invalid_structured_output`, no repair); the harness keeps only the
 * structure of such output, never its text.
 */
describe('unparseable model output is described, never kept', () => {
  it('reports JSON documents and the amount of other text without any of it', () => {
    const narration = 'Wait — one decision per turn; I will search first.';
    const shape = shapeOf(`{"type":"read_capability","capabilityId":"catalog.search","arguments":{"text":"a } b"}}\n\n${narration}`);
    expect(shape).toEqual({ chars: expect.any(Number) as number, jsonDocuments: ['read_capability'], otherTextChars: narration.replace(/\s/g, '').length });
    expect(JSON.stringify(shape)).not.toContain('Wait');
    expect(shapeOf('{"type":"respond","content":"a"}\n{"type":"wait","condition":{"kind":"WAIT_FOR_INPUT"}}')).toMatchObject({ jsonDocuments: ['respond', 'wait'], otherTextChars: 0 });
  });

  it('records a rejected unparseable answer by shape through the live path', async () => {
    const recorder = new RecordingModelProvider(new FakeModelProvider(() => ({ type: 'text', content: '{"type":"respond","content":"hola"}\nLet me also think about the discs.' })));
    const run = await runScenario({ id: 'LIVE-PROSE', title: 'decision followed by prose', turns: [{ customer: 'Hola', agent: [] }], invariants: [] }, { databaseUrl: db.url, mode: 'live', modelProvider: recorder });
    const [trace] = traceDecisions(run.state, recorder.calls);
    expect(trace).toMatchObject({ errorCode: 'invalid_structured_output', rejectedDecision: { jsonDocuments: ['respond'], otherTextChars: 'Let me also think about the discs.'.replace(/\s/g, '').length } });
    expect(JSON.stringify(recorder.calls)).not.toContain('discs');
  });
});
