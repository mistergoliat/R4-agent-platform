import { join, resolve } from 'node:path';
import { benchmarkArtifacts } from '@r4/evaluation';
import { gitState, secretsFromEnv, writeArtifacts } from '@r4/evaluator';
import { runFixtureExperiment } from '../evaluations/run.js';
import { loadLocalEnv, option, print } from './common.js';

/**
 * `npm run experiment:sales` — offline demonstration of a controlled
 * experiment: the live-gate-representative fixture corpus (baseline) against
 * a candidate that no longer makes the unsupported claims, N repetitions
 * each, every other axis constant. The report shows vectors and deltas; it
 * never declares a winner.
 *
 *   --repetitions N   default 3
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const git = gitState();
  const secrets = secretsFromEnv(process.env);
  const { baseline, candidate, comparison, files } = await runFixtureExperiment({ repetitions: Number(option('repetitions') ?? '3'), repro: { gitSha: git.sha, gitDirty: git.dirty } });
  const dir = join(resolve(process.env.R4_EXPERIMENT_ARTIFACTS_DIR ?? 'artifacts/experiments'), `${comparison.experiment.experimentId}_${new Date().toISOString().replace(/[:.]/g, '-')}`);
  writeArtifacts(join(dir, 'experiment'), files, { secrets });
  writeArtifacts(join(dir, 'baseline'), benchmarkArtifacts(baseline, { secrets }), { secrets });
  writeArtifacts(join(dir, 'candidate'), benchmarkArtifacts(candidate, { secrets }), { secrets });
  print(`experiment ${comparison.experiment.experimentId} (${comparison.experiment.dimensionChanged}${comparison.experiment.configurationKey ? `: ${comparison.experiment.configurationKey}` : ''})`);
  print(`warnings: ${comparison.warnings.join('; ') || 'none'}`);
  print(`technical completion ${comparison.technicalCompletion.baseline} → ${comparison.technicalCompletion.candidate}; protocol adherence ${comparison.protocolAdherence.baseline} → ${comparison.protocolAdherence.candidate}`);
  for (const f of comparison.findings) print(`  ${f.code}: ${f.baseline} → ${f.candidate} (${f.delta > 0 ? '+' : ''}${f.delta})`);
  print(comparison.note);
  print(`artifacts: ${dir}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`experiment:sales failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
