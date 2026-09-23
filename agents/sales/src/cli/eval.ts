import { join, resolve } from 'node:path';
import { DefaultModelGateway } from '@r4/model-gateway';
import { createLogger } from '@r4/observability';
import { stableJson, type ModelProfile, type SemanticJudge } from '@r4/evaluation';
import { ModelGatewayJudge, gitState, secretsFromEnv, writeArtifacts } from '@r4/evaluator';
import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { adminDatabaseUrl } from '../harness/database.js';
import { HarnessTrajectoryProducer, SCRIPTED_MODEL_PROFILE, modelProfileFromDescription, referenceScenarioSet } from '../evaluations/corpus.js';
import { evaluateFixtureCorpus, evaluateSalesSubject } from '../evaluations/run.js';
import { configuredModelProvider } from '../model.js';
import { flag, loadLocalEnv, option, print } from './common.js';

/**
 * `npm run eval:sales` — R4-G reference evaluation of the Sales Agent.
 *
 *   (default)          offline: every fixture trajectory of the regression
 *                      corpus, deterministic + semantic evaluators with the
 *                      scripted fixture judge; regression cases checked.
 *                      No credentials, no network. Exit 1 if a case fails.
 *   --scripted         also evaluate the reference scenarios produced by the
 *                      real harness with the scripted stand-in model (needs
 *                      the local PostgreSQL of `npm run db:up`).
 *   --live             (`npm run eval:sales:live`) run a small live smoke —
 *                      default one scenario (S02), once — with the configured
 *                      model, rebuild the trajectory from durable state and
 *                      evaluate it; the judge is R4_EVAL_MODEL_* if set,
 *                      otherwise the same configured model. Without
 *                      credentials it says so and does nothing.
 *   --scenario ID[,ID] scenarios for --scripted / --live
 *   --no-judge         skip semantic evaluators (they are reported as skipped)
 *
 * Artifacts: artifacts/evaluations/<timestamp>/ (git-ignored), one directory
 * per evaluation run plus index.json. Never secrets, never reasoning text.
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const git = gitState();
  const repro = { gitSha: git.sha, gitDirty: git.dirty };
  const secrets = secretsFromEnv(process.env);
  const root = resolve(process.env.R4_EVAL_ARTIFACTS_DIR ?? 'artifacts/evaluations', new Date().toISOString().replace(/[:.]/g, '-'));
  const index: Record<string, unknown>[] = [];
  let failed = 0;

  if (!flag('live')) {
    const corpus = await evaluateFixtureCorpus({ repro });
    for (const r of corpus.results) {
      writeArtifacts(join(root, r.run.evaluationRunId), r.files, { secrets });
      const passed = r.regressions.every((c) => c.passed);
      print(`${passed ? 'PASS' : 'FAIL'} ${r.fixtureId}: ${r.run.result.findings.map((f) => f.code).join(', ') || 'no findings'} [${r.regressions.map((c) => `${c.caseId}:${c.passed ? 'ok' : 'FAIL'}`).join(' ')}]`);
      index.push(entry(r.run, { fixture: r.fixtureId, regressions: r.regressions.map((c) => ({ caseId: c.caseId, passed: c.passed })) }));
    }
    failed += corpus.failedRegressions.length;
    print(`\nregression cases: ${corpus.results.reduce((s, r) => s + r.regressions.length, 0) - corpus.failedRegressions.length} passed, ${corpus.failedRegressions.length} failed`);
  }

  if (flag('scripted') || flag('live')) {
    const live = flag('live');
    const configured = live ? configuredModelProvider(process.env) : null;
    if (live && !configured) {
      print('live evaluation not executed: credentials unavailable (set R4_MODEL_PROVIDER=openai_compatible and R4_MODEL_*; see .env.example)');
    } else {
      const ids = option('scenario')?.split(',').map((s) => s.trim()) ?? (live ? ['S02'] : ['S02', 'S03', 'S04', 'S11', 'CENTRAL']);
      const set = referenceScenarioSet(ids);
      const producer = new HarnessTrajectoryProducer({ adminDatabaseUrl: adminDatabaseUrl(process.env), mode: live ? 'live' : 'scripted', ...(configured ? { modelProvider: configured.provider, modelDescription: configured.description } : {}) });
      const modelUnderTest = configured ? modelProfileFromDescription(configured.description) : SCRIPTED_MODEL_PROFILE;
      const judge = flag('no-judge') || !live ? null : liveJudge();
      if (live) print(`model under test: ${JSON.stringify(configured!.description)}\njudge: ${judge ? JSON.stringify(judge.profile) : 'none (semantic evaluators skipped)'}`);
      for (const scenario of set.scenarios) {
        const { subject } = await producer.produce(scenario);
        const r = await evaluateSalesSubject(subject, { judge, modelUnderTest, repro, scenario, secrets });
        writeArtifacts(join(root, r.run.evaluationRunId), r.files, { secrets });
        print(`${producer.mode} ${scenario.id}: technical ${r.run.result.outcome.technical.status}, quality ${r.run.result.outcome.quality.status}, governance ${r.run.result.outcome.governance.status}; findings: ${r.run.result.findings.map((f) => f.code).join(', ') || 'none'}`);
        index.push(entry(r.run, { scenario: scenario.id, mode: producer.mode }));
      }
    }
  }

  if (index.length > 0) {
    writeArtifacts(join(root, '_index'), { 'index.json': stableJson({ gitSha: git.sha, gitDirty: git.dirty, evaluations: index }) }, { secrets });
    print(`\nartifacts: ${root}`);
  }
  if (failed > 0) process.exit(1);
}

function entry(run: { evaluationRunId: string; status: string; subject: unknown; result: { outcome: unknown; findings: readonly { code: string }[] } }, extra: Record<string, unknown>): Record<string, unknown> {
  return { evaluationRunId: run.evaluationRunId, status: run.status, subject: run.subject, outcome: run.result.outcome, findingCodes: run.result.findings.map((f) => f.code), ...extra };
}

/**
 * The judge for live evaluation. `R4_EVAL_MODEL_*` configures a different
 * evaluator model (same variables as R4_MODEL_*); without it the configured
 * model judges its own trajectory, and both profiles are recorded.
 */
function liveJudge(): SemanticJudge | null {
  const evalEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('R4_EVAL_MODEL_')).map(([k, v]) => [k.replace('R4_EVAL_MODEL_', 'R4_MODEL_'), v]));
  const config = loadOpenAICompatibleConfig(evalEnv.R4_MODEL_PROVIDER ? evalEnv : process.env);
  if (!config) return null;
  const profile: ModelProfile = modelProfileFromDescription(describeModelConfig(config), 'evaluator');
  const gateway = new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(config), logger: createLogger({ service: 'sales-evaluation-judge', level: 'silent' }) });
  return new ModelGatewayJudge({ gateway, profile, timeoutMs: config.timeoutMs });
}

main().catch((error: unknown) => {
  process.stderr.write(`eval:sales failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
