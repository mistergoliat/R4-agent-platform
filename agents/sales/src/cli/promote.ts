import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluationRunSchema, findingSchema, proposeRegressionCase, regressionCaseHash, stableJson } from '@r4/evaluation';
import { writeArtifacts } from '@r4/evaluator';
import { option, print } from './common.js';

/**
 * `npm run regression:promote -- --evaluation <artifact dir> --finding <findingId> --id REG-00NN --title "…" --fixture <fixture id>`
 *
 * The promotion seam of R4-G learning: finding → human review → RegressionCase.
 * It writes a PROPOSED case (and its hash) under artifacts/regression-proposals/
 * for a person to review. Nothing is added to the corpus automatically: to
 * accept it, a person adds it to agents/sales/src/evaluations/regressions.ts
 * with a review record, points it at a reproducible fixture trajectory and
 * records its hash in SALES_REGRESSION_LOCK. This command never touches the
 * agent's definition, prompt, policy or deployment.
 */
function main(): void {
  const dir = option('evaluation');
  const findingId = option('finding');
  const id = option('id');
  const title = option('title');
  const fixture = option('fixture');
  if (!dir || !findingId || !id || !title || !fixture) {
    print('usage: npm run regression:promote -- --evaluation <artifact dir> --finding <findingId> --id REG-00NN --title "<title>" --fixture <fixture id>');
    process.exit(2);
  }
  const manifestPath = join(resolve(dir), 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} not found`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { evaluationRunId: string; startedAt: string; subject: unknown };
  const run = evaluationRunSchema.shape.subject.parse(manifest.subject);
  const finding = readFileSync(join(resolve(dir), 'findings.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => findingSchema.parse(JSON.parse(l)))
    .find((f) => f.findingId === findingId);
  if (!finding) throw new Error(`finding ${findingId} not in ${dir}`);
  const proposal = proposeRegressionCase({ id, title, finding, run: { evaluationRunId: manifest.evaluationRunId, startedAt: manifest.startedAt, subject: run }, fixture: { kind: 'trajectory', ref: fixture } });
  const out = resolve('artifacts/regression-proposals', `${id}.v${proposal.version}`);
  writeArtifacts(out, { 'case.json': stableJson(proposal), 'hash.txt': `${regressionCaseHash(proposal)}\n` });
  print(`proposed ${id} (status: proposed) → ${out}\nreview it, then add it to agents/sales/src/evaluations/regressions.ts with a review record and its hash in SALES_REGRESSION_LOCK.`);
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`regression:promote failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
