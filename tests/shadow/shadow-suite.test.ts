import { describe, expect, it } from 'vitest';
import { loadShadowExecutionConfig, runShadowSuite, shadowSuiteArtifacts, type ShadowSuiteRun } from '@r4/shadow';
import { SCRIPTED_MODEL_PROFILE, salesEvaluationDefinition } from '@r4-sales/agent/evaluations';
import { H_REFERENCE_CASE_IDS, SALES_SHADOW_CORPUS, SALES_SHADOW_CORPUS_LOCK, SalesShadowExecutor, workloadById } from '@r4-sales/agent/shadow';
import { testAdminDatabaseUrl } from '../support/env.js';

/**
 * R4-H offline shadow suite: the whole Sales workload corpus through the
 * real runtime (API composition, worker, kernel, context compiler, action
 * runtime + policy, scheduler composition) on real PostgreSQL, with the
 * scripted stand-in model and fixture/shadow owners. No network, no
 * credentials. It proves mechanism and safety — never model quality.
 */
const config = loadShadowExecutionConfig({}, 'shadow');
const executor = () => new SalesShadowExecutor({ adminDatabaseUrl: testAdminDatabaseUrl(), mode: 'scripted', modelProfile: SCRIPTED_MODEL_PROFILE });

describe('offline controlled-shadow suite (full corpus, scripted stand-in)', () => {
  let suite: ShadowSuiteRun;
  let details: Awaited<ReturnType<typeof runShadowSuite>>['details'];

  it('executes every workload, evaluates every trajectory with R4-G, and stays inside the shadow boundary', async () => {
    const result = await runShadowSuite({
      label: 'offline shadow suite (test)',
      config,
      corpus: SALES_SHADOW_CORPUS,
      corpusLock: SALES_SHADOW_CORPUS_LOCK,
      repetitions: 1,
      executor: executor(),
      definition: salesEvaluationDefinition(),
      judge: null,
      gitSha: 'unknown',
      gitDirty: null,
      costGuard: { maxModelCalls: 6_000, maxInputTokens: null, maxOutputTokens: null, maxCases: 40, maxRepetitions: 3 },
      concurrency: 2,
    });
    suite = result.suite;
    details = result.details;
    expect(suite.counts).toEqual({ planned: SALES_SHADOW_CORPUS.cases.length, executed: SALES_SHADOW_CORPUS.cases.length, executionFailed: 0, notRunDueToBudget: 0, notRunDueToStopCondition: 0 });
    expect(suite.stop.stopped).toBe(false);
    // Shadow safety: zero production effects, zero real deliveries, every safety check green.
    expect(suite.aggregates.safety).toMatchObject({ productionEffects: 0, realOutboundDeliveries: 0, blockedCalls: 0, failedChecks: {} });
    expect(suite.aggregates.safety.outboundWouldDeliver).toBeGreaterThan(50);
    expect(suite.aggregates.safety.shadowEffectsExecuted).toBeGreaterThanOrEqual(7);
    // Every executed trajectory was evaluated by R4-G.
    expect(suite.runs.every((r) => r.evaluationRunId !== null)).toBe(true);
    expect(suite.benchmark?.results.every((r) => r.status === 'evaluated')).toBe(true);
    // Mechanism: every exercised safety and technical property holds (behavioral ones are the stand-in's, reported only).
    expect(suite.aggregates.invariants.failed.filter((f) => f.class !== 'behavioral')).toEqual([]);
    expect(suite.aggregates.invariants.byClass.safety.total).toBeGreaterThanOrEqual(SALES_SHADOW_CORPUS.cases.length * 2);
    // Every stop is acceptable for its case (waiting for input is a legitimate stop; fault cases may fail by design).
    expect(suite.aggregates.technical.acceptableStopForCase.numerator).toBe(suite.aggregates.technical.acceptableStopForCase.denominator);
  }, 600_000);

  it('exercises every H reference behavior at least once (not merely "not exercised")', () => {
    const exercised = (kind: string) => suite.runs.flatMap((r) => r.caseInvariants.filter((i) => i.kind === kind && i.exercised).map((i) => `${r.case.id}:${i.passed}`));
    expect(exercised('shadow.reconciled_via_scheduler')).toEqual(['H08I:true', 'H09:true']);
    expect(exercised('shadow.approval_reevaluated')).toEqual(['H10:true']);
    expect(exercised('shadow.no_autonomous_run_during_handoff')).toEqual(['H08C:true', 'H08F:true', 'H11:true']);
    expect(exercised('shadow.resumed_after_release')).toEqual(['H08C:true', 'H08F:true', 'H11:true']);
    expect(exercised('shadow.cancel_deferred_until_reconciled')).toEqual(['H12B:true']);
    // ADR-028: a failed run no longer makes the conversation terminal; only a cancelled task refuses input.
    expect(exercised('shadow.input_rejected_after_terminal')).toEqual(['H12:true']);
    expect(exercised('shadow.model_failure_classified')).toEqual(['H08A:true', 'H08D:true']);
    expect(exercised('shadow.no_retry_after_model_failure')).toEqual(['H08A:true', 'H08D:true']);
    expect(exercised('shadow.protocol_failure_recorded')).toEqual(['H08B:true', 'H08C:true', 'H08E:true', 'H08G:true', 'H08H:true', 'H08I:true']);
    // ADR-028 run-level recovery (GAP-H-001).
    expect(exercised('shadow.run_failure_recovered')).toEqual(['H08A:true', 'H08B:true', 'H08C:true', 'H08E:true', 'H08F:true', 'H08G:true', 'H08H:true', 'H08I:true']);
    expect(exercised('shadow.run_failure_recovery_exhausted')).toEqual(['H08C:true']);
    expect(exercised('shadow.non_retryable_handed_off')).toEqual(['H08D:true']);
    expect(exercised('shadow.recovery_context_includes_new_input')).toEqual(['H08E:true']);
    expect(exercised('shadow.read_before_failure_preserved')).toEqual(['H08G:true']);
    expect(exercised('shadow.write_before_failure_not_replayed')).toEqual(['H08H:true']);
    expect(exercised('shadow.no_cognition_while_uncertain')).toEqual(['H08I:true']);
    expect(exercised('shadow.expired_evidence_in_history')).toEqual(expect.arrayContaining(['H06:true']));
    expect(exercised('sales.waited_and_resumed')).toEqual(expect.arrayContaining(['H05:true', 'H13:true', 'H14:true']));
    const long = suite.runs.find((r) => r.case.id === 'H13')!;
    expect(long.operational!.inputTurns).toBe(12);
    const restart = suite.runs.find((r) => r.case.id === 'H05')!;
    expect(restart.events.map((e) => e.note)).toContain('worker restart');
    const outage = suite.runs.find((r) => r.case.id === 'H07')!;
    expect(outage.sideEffects!.readsPerformed.failuresByCategory).toMatchObject({ temporarily_unavailable: 1 });
    expect(H_REFERENCE_CASE_IDS.every((id) => suite.runs.some((r) => r.case.id === id && r.status === 'executed'))).toBe(true);
  });

  it('provider and protocol failures are measured separately, and injected ones are labeled', () => {
    expect(suite.aggregates.reliability.injectedFaults).toMatchObject({ timeout: 1 });
    expect(suite.aggregates.reliability.providerErrorsByKind).toEqual({});
    expect(suite.aggregates.protocol.adherenceExcludingInjectedFaults.numerator).toBe(suite.aggregates.protocol.adherenceExcludingInjectedFaults.denominator);
    // Every invalid decision is an injected fault (H08B 1, H08C 3, H08E/F/G/H/I 1 each), recovered or handed over — never retried in its run.
    expect(suite.aggregates.protocol.invalidDecisionAttempts).toBe(9);
    expect(suite.aggregates.quality?.findingsByCode).toHaveProperty('trailing_non_protocol_output');
  });

  it('records reproducibility and binding identity on every run; produces privacy-safe artifacts', () => {
    for (const run of suite.runs) {
      expect(run.bindings.map((b) => b.label), run.shadowRunId).toEqual(['customer=fixture:fixture-customer@1', 'catalog=fixture:fixture-catalog@1', 'shipping=fixture:fixture-shipping@1', 'quote=shadow:shadow-quote-owner@1']);
      expect(run.reproducibility.modelProfile).toMatchObject({ provider: 'scripted', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(run.reproducibility.agent.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(run.execution).toMatchObject({ mode: 'shadow', suiteMode: 'controlled-shadow', declaredBy: 'command' });
    }
    expect(suite.runs.find((r) => r.case.id === 'H10')!.policyProfile).toMatchObject({ name: 'sales-shadow-approval', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const files = shadowSuiteArtifacts(suite, details);
    expect(files['report.md']).toContain('production effects: **0**');
    expect(files['outbound.jsonl']).not.toMatch(/example\.test|\+569/);
    expect(files['model-calls.jsonl']).not.toMatch(/"content"/);
  });
});

describe('canonical ingress and response capture (read back from durable state)', () => {
  it('inputs are durable canonical inputs; every respond is captured by the sink exactly once; the quote effect is receipt-backed', async () => {
    const workload = workloadById('H04');
    const execution = await executor().execute(workload, { suiteRunId: 'ingress', shadowRunId: 'ingress.H04.r1', repetition: 1, config, salt: 'ingress' });
    const inputs = workload.events.flatMap((e) => (e.kind === 'input' ? [e.text] : []));
    // The platform's own durable input records (what the canonical reader rebuilds turns from).
    expect(execution.subject.turns.filter((t) => t.kind === 'input').map((t) => t.text)).toEqual(inputs);
    expect(execution.subject.task).toMatchObject({ agentId: 'sales', taskType: 'sales.conversation', status: 'waiting' });
    // Responses: the same `respond` decisions the step log holds, captured once each, never delivered.
    expect(execution.outbound.map((o) => o.responseRef).sort()).toEqual(execution.subject.responses.map((r) => r.responseId).sort());
    expect(execution.outbound.every((o) => o.wouldDeliver && !o.actualDelivery && o.recipientRef.startsWith('pseud_'))).toBe(true);
    // The governed write: proposal → ALLOW → command → shadow owner (key = execution key) → receipt → observation.
    const quote = execution.subject.actions.executions.find((e) => e.capabilityId === 'quote.create')!;
    expect(execution.subject.actions.policyDecisions.find((d) => d.decisionId === quote.policyDecisionId)?.outcome).toBe('allow');
    expect(execution.records.filter((r) => r.operation === 'create')).toEqual([expect.objectContaining({ bindingKind: 'shadow', classification: 'SHADOW_WRITE', idempotencyKey: quote.executionKey, production: false })]);
    const receipt = execution.subject.actions.receipts.find((r) => r.executionId === quote.executionId)!;
    expect(receipt).toMatchObject({ status: 'succeeded', externalOperationRef: expect.stringMatching(/^COT-9\d{5}$/) });
    expect(execution.subject.observations.some((o) => o.source.kind === 'action' && o.source.receiptId === receipt.receiptId)).toBe(true);
    expect((receipt.result as { documentRef: string }).documentRef).toMatch(/^shadow-record:/);
  }, 120_000);
});
