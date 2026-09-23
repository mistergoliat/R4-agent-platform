import { join, resolve } from 'node:path';
import { benchmarkArtifacts, evaluationArtifacts } from '@r4/evaluation';
import { gitState, secretsFromEnv, writeArtifacts } from '@r4/evaluator';
import { adminDatabaseUrl } from '../harness/database.js';
import { FixtureTrajectoryProducer, HarnessTrajectoryProducer, SCRIPTED_MODEL_PROFILE, modelProfileFromDescription, type FixtureTrajectorySet } from '../evaluations/corpus.js';
import { runSalesBenchmark } from '../evaluations/run.js';
import { configuredModelProvider } from '../model.js';
import { loadLocalEnv, option, print } from './common.js';

/**
 * `npm run benchmark:sales` — the Sales reference corpus (S02, S03, S04,
 * S11, CENTRAL) × N repetitions, every repetition evaluated and kept.
 *
 *   --source fixture|scripted|live   default fixture (offline, deterministic)
 *   --repetitions N                  default 3 (a caller's choice, not a policy)
 *   --scenario ID[,ID]               a subset of the corpus
 *   --set live-gate-representative|candidate-grounded   fixture set (fixture source)
 *
 * `live` needs credentials and runs N × scenarios real conversations: keep N
 * small (the command refuses N > 3 for live unless --allow-large is given).
 * Semantic evaluators run with the fixture judge offline; for scripted/live
 * they are skipped (use `eval:sales:live` for a judged live smoke).
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const source = option('source') ?? 'fixture';
  const repetitions = Number(option('repetitions') ?? '3');
  const scenarios = option('scenario')?.split(',').map((s) => s.trim());
  const git = gitState();
  const secrets = secretsFromEnv(process.env);
  let producer;
  let judge = null;
  let modelProfile;
  let configuration: Record<string, string> = {};
  if (source === 'fixture') {
    const set = (option('set') ?? 'live-gate-representative') as FixtureTrajectorySet;
    const fixture = new FixtureTrajectoryProducer(set);
    producer = fixture;
    judge = fixture.judge;
    modelProfile = FixtureTrajectoryProducer.modelProfile();
    configuration = { trajectorySet: set };
  } else if (source === 'scripted') {
    producer = new HarnessTrajectoryProducer({ adminDatabaseUrl: adminDatabaseUrl(process.env), mode: 'scripted' });
    modelProfile = SCRIPTED_MODEL_PROFILE;
  } else if (source === 'live') {
    const configured = configuredModelProvider(process.env);
    if (!configured) {
      print('live benchmark not executed: credentials unavailable (set R4_MODEL_PROVIDER=openai_compatible and R4_MODEL_*; see .env.example)');
      return;
    }
    if (repetitions > 3 && !process.argv.includes('--allow-large')) throw new Error('live benchmarks above 3 repetitions need --allow-large (cost awareness)');
    producer = new HarnessTrajectoryProducer({ adminDatabaseUrl: adminDatabaseUrl(process.env), mode: 'live', modelProvider: configured.provider, modelDescription: configured.description });
    modelProfile = modelProfileFromDescription(configured.description);
  } else throw new Error(`unknown --source ${source}`);

  const outRoot = resolve(process.env.R4_BENCHMARK_ARTIFACTS_DIR ?? 'artifacts/benchmarks');
  const benchmarkRunId = `bmr_${source}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = join(outRoot, benchmarkRunId);
  const { benchmark, evaluations } = await runSalesBenchmark({
    producer,
    judge,
    repetitions,
    modelProfile,
    repro: { gitSha: git.sha, gitDirty: git.dirty },
    ...(scenarios ? { scenarios } : {}),
    label: `Sales reference corpus (${source})`,
    configuration: { source, ...configuration },
    benchmarkRunId,
    onResult: (r) => print(`${r.scenarioId} r${r.repetition}: ${r.status}${r.outcome ? ` technical=${r.outcome.technicalStatus} quality=${r.outcome.qualityStatus}` : ` (${r.error ?? ''})`} ${Object.keys(r.findingCodes).join(', ')}`),
  });
  for (const e of evaluations) writeArtifacts(join(dir, 'evaluations', e.evaluationRunId), evaluationArtifacts(e, { secrets }), { secrets });
  writeArtifacts(join(dir, 'benchmark'), benchmarkArtifacts(benchmark, { secrets }), { secrets });
  const a = benchmark.aggregate.overall;
  print(`\ntechnical completion ${a.technicalCompletion.numerator}/${a.technicalCompletion.denominator} · protocol adherence ${a.protocolAdherence.numerator}/${a.protocolAdherence.denominator} · governance violations ${a.governanceViolations}`);
  print(`findings: ${Object.entries(a.findingsByCode).map(([c, n]) => `${c}×${n.occurrences}`).join(', ') || 'none'}`);
  print(`artifacts: ${dir}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`benchmark:sales failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
