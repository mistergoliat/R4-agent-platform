// R4-G mutation checks: each mutation weakens one critical Quality invariant;
// the listed tests must FAIL against it. The source file is always restored
// (finally), and the script verifies the restoration byte for byte.
//
//   npm run test:mutation:evaluation
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MUTATIONS = [
  {
    name: 'remove Receipt requirement for claimed effects',
    file: 'packages/evaluation/src/evaluators/governance.ts',
    from: '        if (receipt) backed += 1;',
    to: '        if (receipt || claims > 0) backed += 1;',
    tests: ['--project', 'unit', 'tests/unit/sales/evaluation/corpus.test.ts', 'tests/unit/sales/evaluation/evaluators.test.ts'],
  },
  {
    name: 'ignore invalid protocol decisions',
    file: 'packages/evaluation/src/evaluators/protocol.ts',
    from: "      if (step.outcome !== 'invalid') {",
    to: "      if (step.outcome !== 'invalid' || step.error !== null) {",
    tests: ['--project', 'unit', 'tests/unit/sales/evaluation/corpus.test.ts', 'tests/unit/evaluation/benchmark-experiment.test.ts'],
  },
  {
    name: 'drop the unsupported-relationship finding',
    file: 'packages/evaluation/src/evaluators/semantic.ts',
    from: "UNSUPPORTED_RELATIONSHIP: 'unsupported_relationship', ",
    to: '',
    tests: ['--project', 'unit', 'tests/unit/sales/evaluation/corpus.test.ts', 'tests/unit/evaluation/semantic-and-pipeline.test.ts'],
  },
  {
    name: 'erase one benchmark repetition',
    file: 'packages/evaluation/src/benchmark.ts',
    from: '      results.push(result);',
    to: '      if (repetition !== 2) results.push(result);',
    tests: ['--project', 'unit', 'tests/unit/evaluation/benchmark-experiment.test.ts', 'tests/unit/sales/evaluation/reference.test.ts'],
  },
  {
    name: 'merge technical and quality status',
    file: 'packages/evaluation/src/outcome.ts',
    from: '    technical: technicalOutcome(input.subject),',
    to: '    technical: { ...technicalOutcome(input.subject), valid: technicalOutcome(input.subject).valid && quality.length === 0 },',
    tests: ['--project', 'unit', 'tests/unit/evaluation/outcome-metrics-profile.test.ts', 'tests/unit/sales/evaluation/corpus.test.ts'],
  },
  {
    name: 'persist evaluator reasoning text',
    file: 'packages/evaluation/src/finding.ts',
    from: '    details: draft.details ?? null,',
    to: '    details: { ...(draft.details ?? {}), reasoning: draft.rationale ?? draft.description },',
    tests: ['--project', 'unit', 'tests/unit/evaluation/privacy-regression.test.ts', 'tests/unit/sales/evaluation/corpus.test.ts'],
  },
];

function vitest(args) {
  const r = spawnSync('npx', ['vitest', 'run', ...args], { shell: true, encoding: 'utf8' });
  return r.status;
}

let failures = 0;
process.stdout.write(`baseline: ${vitest(['--project', 'unit', 'tests/unit/evaluation', 'tests/unit/sales/evaluation']) === 0 ? 'green' : 'RED'}\n`);
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    process.stdout.write(`SKIPPED (anchor not found — update the mutation): ${m.name}\n`);
    failures += 1;
    continue;
  }
  let status;
  try {
    writeFileSync(m.file, original.replace(m.from, m.to));
    status = vitest(m.tests);
  } finally {
    writeFileSync(m.file, original);
  }
  if (readFileSync(m.file, 'utf8') !== original) throw new Error(`${m.file} was not restored`);
  const detected = status !== 0;
  if (!detected) failures += 1;
  process.stdout.write(`${detected ? 'DETECTED' : 'SURVIVED'}: ${m.name} (${m.file})\n`);
}
process.stdout.write(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected; all sources restored\n`);
process.exit(failures === 0 ? 0 : 1);
