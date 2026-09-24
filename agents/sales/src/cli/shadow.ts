import { join, resolve } from 'node:path';
import { DefaultModelGateway } from '@r4/model-gateway';
import { createLogger } from '@r4/observability';
import { assertArtifactSafe, benchmarkArtifacts, evaluationArtifacts, stableJson, type ModelProfile, type SemanticJudge } from '@r4/evaluation';
import { ModelGatewayJudge, gitState, secretsFromEnv, writeArtifacts } from '@r4/evaluator';
import { loadShadowExecutionConfig, planShadowSuite, runShadowSuite, shadowSuiteArtifacts, type CostGuard } from '@r4/shadow';
import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { SCRIPTED_MODEL_PROFILE, modelProfileFromDescription, salesEvaluationDefinition } from '../evaluations/index.js';
import { adminDatabaseUrl } from '../harness/database.js';
import { configuredModelProvider } from '../model.js';
import { H_REFERENCE_CASE_IDS, REPEATED_BASELINE_CASE_IDS, REVIEWED_GAP_CANDIDATES, SALES_SHADOW_CORPUS, SALES_SHADOW_CORPUS_LOCK, SMOKE_CASE_IDS, SalesShadowExecutor } from '../shadow/index.js';
import { flag, loadLocalEnv, option, print } from './common.js';

/**
 * `npm run shadow:sales` — R4-H shadow suite of the Sales Agent.
 *
 *   (default)                offline controlled shadow: scripted stand-in model,
 *                            fixture/shadow owners, the full corpus, N=1.
 *                            Needs the local PostgreSQL; never the network.
 *   --live                   (`shadow:sales:live`) the configured real model.
 *                            Requires R4_SHADOW_ALLOW_LIVE_MODEL=true and R4_MODEL_*;
 *                            without them it says so and does nothing.
 *   --smoke                  (`shadow:sales:smoke`) live, SMOKE cases, N=1
 *   --plan                   print the plan (cases, repetitions, model profile,
 *                            bindings, write bindings, max calls, outbound
 *                            disabled) and exit without executing
 *   --cases ID[,ID]          explicit cases; --set h-reference|repeated|all
 *   --repetitions N          default 1 (live above 3 needs --allow-large)
 *   --concurrency N          default 1 (max 8)
 *   --max-model-calls N      cost guard (default 6000 offline, 1500 live)
 *   --max-input-tokens N / --max-output-tokens N
 *   --no-judge               skip semantic evaluators in live runs
 *   --execution-mode shadow  the explicit shadow declaration (the npm scripts pass it)
 *
 * Artifacts: artifacts/shadow/<suiteRunId>/ with the shadow files, benchmark/
 * (R4-G BenchmarkRun) and evaluations/<evaluationRunId>/ — git-ignored,
 * immutable, privacy-gated. No outbound message is ever delivered.
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadShadowExecutionConfig(process.env, option('execution-mode'));
  const live = flag('live') || flag('smoke');
  const git = gitState();
  const secrets = secretsFromEnv(process.env);

  let executor: SalesShadowExecutor;
  let modelProfile: ModelProfile;
  let judge: SemanticJudge | null = null;
  let judgeProfile: ModelProfile | null = null;
  if (live) {
    const configured = configuredModelProvider(process.env);
    if (!configured) {
      print('live shadow suite not executed: model credentials unavailable (set R4_MODEL_PROVIDER=openai_compatible and R4_MODEL_*; see .env.example)');
      return;
    }
    if (!config.allowLiveModel) {
      print('live shadow suite not executed: R4_SHADOW_ALLOW_LIVE_MODEL is not "true" (explicit opt-in required for real model calls)');
      return;
    }
    modelProfile = modelProfileFromDescription(configured.description);
    executor = new SalesShadowExecutor({ adminDatabaseUrl: adminDatabaseUrl(process.env), mode: 'live', modelProvider: configured.provider, modelProfile });
    if (!flag('no-judge')) ({ judge, profile: judgeProfile } = liveJudge());
  } else {
    modelProfile = SCRIPTED_MODEL_PROFILE;
    executor = new SalesShadowExecutor({ adminDatabaseUrl: adminDatabaseUrl(process.env), mode: 'scripted', modelProfile });
  }

  const set = option('set') ?? (flag('smoke') ? 'smoke' : 'all');
  const caseIds = option('cases')?.split(',').map((s) => s.trim()) ?? (set === 'h-reference' ? H_REFERENCE_CASE_IDS : set === 'repeated' ? REPEATED_BASELINE_CASE_IDS : set === 'smoke' ? SMOKE_CASE_IDS : SALES_SHADOW_CORPUS.cases.map((c) => c.id));
  const repetitions = Number(option('repetitions') ?? '1');
  const costGuard: CostGuard = {
    maxModelCalls: Number(option('max-model-calls') ?? (live ? 1_500 : 6_000)),
    maxInputTokens: option('max-input-tokens') ? Number(option('max-input-tokens')) : null,
    maxOutputTokens: option('max-output-tokens') ? Number(option('max-output-tokens')) : null,
    maxCases: SALES_SHADOW_CORPUS.cases.length,
    maxRepetitions: 10,
  };
  const label = `Sales shadow suite (${live ? 'live model' : 'scripted stand-in'}, ${set}${option('cases') ? ' explicit cases' : ''}, N=${repetitions})`;
  const base = { label, config, corpus: SALES_SHADOW_CORPUS, corpusLock: SALES_SHADOW_CORPUS_LOCK, caseIds, repetitions, executor, costGuard, concurrency: Number(option('concurrency') ?? '1'), allowLarge: flag('allow-large') };

  const { plan } = planShadowSuite(base);
  print(`suite ${plan.suiteRunId}`);
  print(`execution: ${plan.execution.mode} (${plan.execution.suiteMode}; declared by ${plan.execution.declaredBy}; live model ${plan.execution.allowLiveModel}; live read ${plan.execution.allowLiveRead})`);
  print(`cases (${plan.cases.length}): ${plan.cases.map((c) => `${c.id}@${c.version}`).join(' ')}`);
  print(`repetitions ${plan.repetitions} · executions ${plan.executionsPlanned} · concurrency ${plan.concurrency} · max model calls ${plan.estimatedMaxModelCalls}`);
  print(`model: ${plan.modelProfile ? `${plan.modelProfile.provider} ${plan.modelProfile.model} max_out=${plan.modelProfile.maxOutputTokens ?? '-'} ctx=${plan.modelProfile.contextWindowTokens ?? '-'} format=${plan.modelProfile.responseFormat ?? '-'} extras=${JSON.stringify(plan.modelProfile.extras)} fp=${plan.modelProfile.fingerprint.slice(0, 12)}` : 'none'}`);
  print(`judge: ${judgeProfile ? `${judgeProfile.provider} ${judgeProfile.model}` : 'none (semantic evaluators skipped)'}`);
  for (const b of plan.bindings) print(`binding ${b.label} ${JSON.stringify(b.classifications)}`);
  print(`write bindings: ${plan.writeBindings.join(' | ') || 'none'}`);
  print(`outbound: ${plan.outbound.kind}:${plan.outbound.bindingId} — actual outbound = ${plan.actualOutboundDelivery}`);
  if (flag('plan')) {
    print(stableJson(plan));
    return;
  }

  const { suite, evaluations, details } = await runShadowSuite({
    ...base,
    suiteRunId: plan.suiteRunId,
    definition: salesEvaluationDefinition(),
    judge,
    judgeProfile,
    gitSha: git.sha,
    gitDirty: git.dirty,
    leakCheck: (text) => assertArtifactSafe(text, secrets),
    onRun: (run) => {
      const failed = run.caseInvariants.filter((i) => i.exercised && !i.passed).map((i) => `${i.class}:${i.kind}`);
      const unsafe = run.safety.filter((c) => !c.passed && c.severity !== 'warning').map((c) => c.code);
      print(`${run.case.id}.r${run.repetition} ${run.status} calls=${run.operational?.modelCalls.total ?? '-'} tokens=${run.operational ? `${run.operational.tokens.input}/${run.operational.tokens.output}` : '-'} writes=${run.sideEffects?.shadowEffectsExecuted ?? '-'} outbound=${run.sideEffects?.outboundWouldDeliver ?? '-'} ${unsafe.length ? `UNSAFE ${unsafe.join(',')}` : 'safe'}${failed.length ? ` failed: ${failed.join(', ')}` : ''}${run.error ? ` (${run.error})` : ''}`);
    },
  });

  const dir = join(resolve(process.env.R4_SHADOW_ARTIFACTS_DIR ?? 'artifacts/shadow'), suite.suiteRunId);
  writeArtifacts(dir, shadowSuiteArtifacts(suite, details, { reviewedGaps: REVIEWED_GAP_CANDIDATES, secrets }), { secrets });
  if (suite.benchmark) writeArtifacts(join(dir, 'benchmark'), benchmarkArtifacts(suite.benchmark, { secrets }), { secrets });
  for (const e of evaluations) {
    const subject = details.find((d) => d.shadowRunId === e.evaluationRunId)?.subject ?? null;
    writeArtifacts(join(dir, 'evaluations', e.evaluationRunId), evaluationArtifacts(e, { subject, secrets }), { secrets });
  }
  const a = suite.aggregates;
  print(`\nexecuted ${suite.counts.executed}/${suite.counts.planned} · failed ${suite.counts.executionFailed} · not run (budget) ${suite.counts.notRunDueToBudget} · not run (stop) ${suite.counts.notRunDueToStopCondition}${suite.stop.stopped ? ` · STOPPED: ${suite.stop.reason}` : ''}`);
  print(`production effects ${a.safety.productionEffects} · real outbound deliveries ${a.safety.realOutboundDeliveries} · would-deliver ${a.safety.outboundWouldDeliver} · shadow effects ${a.safety.shadowEffectsExecuted} · failed safety checks ${JSON.stringify(a.safety.failedChecks)}`);
  print(`protocol adherence ${a.protocol.adherence.numerator}/${a.protocol.adherence.denominator} (excl. injected ${a.protocol.adherenceExcludingInjectedFaults.numerator}/${a.protocol.adherenceExcludingInjectedFaults.denominator}) · legitimate stops ${a.technical.legitimateStop.numerator}/${a.technical.legitimateStop.denominator}`);
  print(`invariants: safety ${a.invariants.byClass.safety.passed}/${a.invariants.byClass.safety.total} · technical ${a.invariants.byClass.technical.passed}/${a.invariants.byClass.technical.total} · behavioral ${a.invariants.byClass.behavioral.passed}/${a.invariants.byClass.behavioral.total}`);
  print(`findings: ${Object.entries(a.quality?.findingsByCode ?? {}).map(([c, v]) => `${c}×${v.occurrences}`).join(', ') || 'none'}`);
  print(`semantic: requested ${a.semantic.requested}, completed ${a.semantic.completed}, inconclusive ${a.semantic.inconclusive}, skipped ${a.semantic.skipped}`);
  print(`artifacts: ${dir}`);
  const unsafe = a.safety.productionEffects + a.safety.realOutboundDeliveries + a.invariants.byClass.safety.total - a.invariants.byClass.safety.passed;
  if (unsafe > 0 || suite.stop.stopped) process.exitCode = 1;
}

/** Semantic judge for live runs: R4_EVAL_MODEL_* when set (judge ≠ model under test), else the configured model. */
function liveJudge(): { judge: SemanticJudge | null; profile: ModelProfile | null } {
  const evalEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('R4_EVAL_MODEL_')).map(([k, v]) => [k.replace('R4_EVAL_MODEL_', 'R4_MODEL_'), v]));
  const config = loadOpenAICompatibleConfig(evalEnv.R4_MODEL_PROVIDER ? evalEnv : process.env);
  if (!config) return { judge: null, profile: null };
  const profile = modelProfileFromDescription(describeModelConfig(config), 'evaluator');
  const gateway = new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(config), logger: createLogger({ service: 'shadow-judge', level: 'silent' }) });
  return { judge: new ModelGatewayJudge({ gateway, profile, timeoutMs: config.timeoutMs }), profile };
}

main().catch((error: unknown) => {
  process.stderr.write(`shadow:sales failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
