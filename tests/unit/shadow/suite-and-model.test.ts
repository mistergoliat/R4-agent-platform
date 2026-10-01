import { describe, expect, it } from 'vitest';
import { FakeModelProvider, ModelProviderError, type ModelRequest } from '@r4/model-gateway';
import {
  ShadowRecordingModelProvider,
  SideEffectRecorder,
  WORKLOAD_CASE_SCHEMA_VERSION,
  assertShadowComposition,
  loadShadowExecutionConfig,
  parseWorkloadCase,
  planShadowSuite,
  runShadowSuite,
  shadowSuiteArtifacts,
  toModelCallRecord,
  type ShadowModelCall,
  type WorkloadCase,
  type WorkloadExecution,
  type WorkloadExecutor,
} from '@r4/shadow';
import { SCRIPTED_MODEL_PROFILE, SalesFixture, salesEvaluationDefinition } from '@r4-sales/agent/evaluations';
import { SALES_EXTERNAL_WRITE_CAPABILITIES, SALES_SHADOW_BINDINGS, SALES_SHADOW_OUTBOUND } from '@r4-sales/agent/shadow';

const config = loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow' });
const request = { correlation: { correlationId: 'c', runId: '0190a0a0-0000-7000-8000-0000000000bb' }, messages: [], outputContract: { kind: 'json', name: 'd', schema: {} }, limits: { timeoutMs: 1000 } } as unknown as ModelRequest;

describe('ShadowRecordingModelProvider', () => {
  it('records metadata of every call — never the output text', async () => {
    const recorder = new ShadowRecordingModelProvider(new FakeModelProvider([{ type: 'structured', data: { type: 'respond', content: 'secreto del cliente' } }, { type: 'text', content: '{"type":"respond","content":"x"} y además texto' }]));
    await recorder.invoke(request, new AbortController().signal);
    await recorder.invoke(request, new AbortController().signal);
    expect(recorder.calls).toMatchObject([
      { index: 1, outcome: 'decision', injected: false, errorKind: null, unparsedShape: null },
      { index: 2, outcome: 'unparsed', unparsedShape: { jsonDocuments: ['respond'], otherTextChars: expect.any(Number) } },
    ]);
    expect(JSON.stringify(recorder.calls)).not.toMatch(/secreto|además/);
    expect(Object.keys(recorder.calls[0]!)).not.toContain('content');
  });

  it('an injected fault replaces exactly the next call, is labeled, is classified, and is never retried here', async () => {
    const inner = new FakeModelProvider([{ type: 'structured', data: { type: 'respond', content: 'ok' } }]);
    const recorder = new ShadowRecordingModelProvider(inner);
    recorder.injectNext('timeout');
    await expect(recorder.invoke(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'timeout' });
    expect(inner.callCount).toBe(0);
    expect(recorder.pendingFault).toBeNull();
    await recorder.invoke(request, new AbortController().signal);
    expect(inner.callCount).toBe(1);
    expect(recorder.calls.map((c) => [c.outcome, c.errorKind, c.injected])).toEqual([
      ['error', 'timeout', true],
      ['decision', null, false],
    ]);
    expect(toModelCallRecord(recorder.calls[0]!).error).toBe('injected timeout');
  });

  it('trailing prose is returned as unparsed content (ADR-008: never rescued), and a real provider error keeps its kind', async () => {
    const recorder = new ShadowRecordingModelProvider(new FakeModelProvider([{ type: 'provider_error', kind: 'rate_limited', message: '429' }]));
    recorder.injectNext('trailing_prose');
    const raw = (await recorder.invoke(request, new AbortController().signal)) as { structuredData?: unknown; content: string };
    expect(raw.structuredData).toBeUndefined();
    expect(raw.content).toMatch(/\}\s+\S/);
    await expect(recorder.invoke(request, new AbortController().signal)).rejects.toBeInstanceOf(ModelProviderError);
    expect(recorder.calls.at(-1)).toMatchObject({ outcome: 'error', errorKind: 'rate_limited', injected: false });
  });
});

const workload = (id: string): WorkloadCase => parseWorkloadCase({ schemaVersion: WORKLOAD_CASE_SCHEMA_VERSION, id, version: 1, title: id, sourceType: 'synthetic', source: { ref: 'unit' }, initialContext: { subjectRef: 'cust-demo-001' }, events: [{ kind: 'input', text: 'hola' }], expectations: { acceptableStops: ['awaiting_input'], invariants: [] }, privacy: { classification: 'synthetic', sanitized: false } });
const corpus = { id: 'unit.corpus', version: 1, cases: ['U01', 'U02', 'U03'].map(workload) };

/** A pack-free executor returning finished R4-G fixture trajectories, misbehaving on request. */
function fakeExecutor(options: { productionIn?: string; failIn?: string; callsPerRun?: number; live?: boolean } = {}): WorkloadExecutor & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    describe: () => ({ agent: { agentId: 'sales', version: 1, contentHash: null }, protocolVersion: 'r4.agent_decision.v5', modelProfile: SCRIPTED_MODEL_PROFILE, liveModel: options.live ?? false, suiteMode: 'controlled-shadow', bindings: SALES_SHADOW_BINDINGS, outbound: SALES_SHADOW_OUTBOUND, externalWriteCapabilities: SALES_EXTERNAL_WRITE_CAPABILITIES }),
    execute: (w, context): Promise<WorkloadExecution> => {
      executed.push(`${w.id}.r${context.repetition}`);
      if (options.failIn === w.id) return Promise.reject(new Error('database unreachable'));
      const f = new SalesFixture({ id: `${w.id}-${context.repetition}`, customerRef: 'cust-demo-001' });
      f.turn('hola');
      f.respond('hola, ¿en qué te ayudo?');
      f.wait();
      const subject = f.build();
      const recorder = new SideEffectRecorder();
      if (options.productionIn === w.id) recorder.record({ domain: 'catalog', bindingId: 'fixture-catalog', bindingKind: 'production', operation: 'search', effect: 'read', classification: 'BLOCKED', outcome: 'ok', errorCategory: null, latencyMs: 1, idempotencyKey: null, production: true });
      const calls: ShadowModelCall[] = Array.from({ length: options.callsPerRun ?? 2 }, (_, i) => ({ index: i + 1, runId: null, outcome: 'decision', errorKind: null, injected: false, finishReason: 'stop', inputTokens: 100, outputTokens: 10, reasoningTokens: null, latencyMs: 5, unparsedShape: null }));
      return Promise.resolve({
        taskId: subject.task.taskId,
        subject,
        composition: assertShadowComposition(context.config, SALES_SHADOW_BINDINGS, SALES_SHADOW_OUTBOUND),
        records: recorder.records,
        outbound: [],
        modelCalls: calls,
        turns: [{ index: 1, kind: 'input', submittedAt: '2026-01-01T00:00:00.000Z', wallClockMs: 20, userPerceivedMs: 15, runsExecuted: 1 }],
        caseInvariants: [],
        events: [{ index: 0, kind: 'input', applied: true, note: 'turn 1' }],
        policyProfile: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
      });
    },
  };
}

const guard = { maxModelCalls: 1_000, maxInputTokens: null, maxOutputTokens: null, maxCases: 10, maxRepetitions: 5 };
const suite = (executor: WorkloadExecutor, extra: Partial<Parameters<typeof runShadowSuite>[0]> = {}) =>
  runShadowSuite({ label: 'unit', config, corpus, repetitions: 2, executor, definition: salesEvaluationDefinition(), judge: null, gitSha: 'unknown', gitDirty: null, costGuard: guard, concurrency: 1, ...extra });

describe('ShadowSuiteRun', () => {
  it('executes corpus × repetitions, evaluates every executed trajectory with R4-G, and keeps every run', async () => {
    const { suite: s, evaluations } = await suite(fakeExecutor());
    expect(s.counts).toEqual({ planned: 6, executed: 6, executionFailed: 0, notRunDueToBudget: 0, notRunDueToStopCondition: 0 });
    expect(evaluations).toHaveLength(6);
    expect(s.runs.every((r) => r.evaluationRunId !== null && r.evaluationRunId === r.shadowRunId)).toBe(true);
    expect(s.benchmark?.results).toHaveLength(6);
    expect(s.benchmark?.aggregate.byScenario).toHaveProperty('U02');
    expect(s.runs[0]!.bindings.map((b) => b.label)).toEqual(['customer=fixture:fixture-customer@1', 'catalog=fixture:fixture-catalog@1', 'shipping=fixture:fixture-shipping@1', 'quote=shadow:shadow-quote-owner@1']);
    expect(s.aggregates.safety).toMatchObject({ productionEffects: 0, realOutboundDeliveries: 0 });
  });

  it('cost guard: stops cleanly between executions and records the rest as not_run_due_to_budget', async () => {
    const executor = fakeExecutor({ callsPerRun: 4 });
    const { suite: s } = await suite(executor, { costGuard: { ...guard, maxModelCalls: 10 } });
    expect(executor.executed).toEqual(['U01.r1', 'U01.r2', 'U02.r1']);
    expect(s.counts).toMatchObject({ executed: 3, notRunDueToBudget: 3 });
    expect(s.budget.exhausted).toMatch(/maxModelCalls/);
    expect(s.runs.filter((r) => r.status === 'not_run_due_to_budget').map((r) => `${r.case.id}.r${r.repetition}`)).toEqual(['U02.r2', 'U03.r1', 'U03.r2']);
  });

  it('a production side effect is a stop condition: no new execution starts', async () => {
    const executor = fakeExecutor({ productionIn: 'U01' });
    const { suite: s } = await suite(executor);
    expect(executor.executed).toEqual(['U01.r1']);
    expect(s.stop).toMatchObject({ stopped: true, reason: expect.stringContaining('production_effects_zero') });
    expect(s.counts.notRunDueToStopCondition).toBe(5);
    expect(s.aggregates.safety.productionEffects).toBe(1);
  });

  it('secret leakage in what a run produced is a stop condition', async () => {
    const executor = fakeExecutor();
    const { suite: stopped } = await suite(executor, { leakCheck: (text) => { if (text.includes('U01')) throw new Error('secret found'); } });
    expect(stopped.stop.reason).toMatch(/secret leakage/);
    expect(executor.executed).toEqual(['U01.r1']);
  });

  it('an infrastructure failure is recorded as execution_failed (not an agent failure) and the suite continues', async () => {
    const { suite: s } = await suite(fakeExecutor({ failIn: 'U02' }));
    expect(s.counts).toMatchObject({ executed: 4, executionFailed: 2 });
    expect(s.runs.find((r) => r.case.id === 'U02')).toMatchObject({ status: 'execution_failed', error: 'database unreachable' });
    expect(s.benchmark?.results.filter((r) => r.status === 'production_failed')).toHaveLength(2);
  });

  it('refuses to plan a real-model executor without the explicit opt-in, and bounds concurrency', () => {
    expect(() => planShadowSuite({ label: 'x', config, corpus, repetitions: 1, executor: fakeExecutor({ live: true }), costGuard: guard, concurrency: 1 })).toThrow(/R4_SHADOW_ALLOW_LIVE_MODEL/);
    expect(() => planShadowSuite({ label: 'x', config, corpus, repetitions: 1, executor: fakeExecutor(), costGuard: guard, concurrency: 50 })).toThrow(/concurrency/);
    const { plan } = planShadowSuite({ label: 'x', config, corpus, repetitions: 2, executor: fakeExecutor(), costGuard: guard, concurrency: 2 });
    expect(plan).toMatchObject({ executionsPlanned: 6, actualOutboundDelivery: 'disabled', writeBindings: ['quote=shadow:shadow-quote-owner@1 → create:SHADOW_WRITE'] });
  });

  it('runs executions concurrently when asked, and the artifacts pass the privacy gates', async () => {
    const { suite: s, details } = await suite(fakeExecutor(), { concurrency: 3 });
    expect(s.counts.executed).toBe(6);
    const files = shadowSuiteArtifacts(s, details, { secrets: ['super-secret-value'] });
    expect(Object.keys(files).sort()).toEqual(['aggregates.json', 'architecture-gap-candidates.jsonl', 'evaluation-summary.json', 'manifest.json', 'model-calls.jsonl', 'outbound.jsonl', 'plan.json', 'report.md', 'side-effects.jsonl', 'workload-results.jsonl']);
    expect(files['report.md']).toMatch(/## 6\. Shadow safety/);
    expect(files['report.md']).not.toMatch(/readiness score|\/100/i);
    const leaked = { ...s, label: 'contains super-secret-value' };
    expect(() => shadowSuiteArtifacts(leaked, details, { secrets: ['super-secret-value'] })).toThrow(/configured secret/);
  });
});
