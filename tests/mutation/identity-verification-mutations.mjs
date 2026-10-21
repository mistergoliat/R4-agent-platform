// SEC-S1 identity-verification classifier mutation checks: each mutation weakens one
// guarantee of the pure classifier (redaction, submission, neutralization, fail-closed);
// the listed tests must FAIL against it. Every edited source is always restored (finally),
// and the script verifies the restoration byte for byte. Offline: no database, no network.
// Run sequentially (never alongside another mutation suite: they edit shared sources).
//
//   npm run test:mutation:identity-verification
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = ['--project', 'unit', 'tests/unit/identity-verification/classifier.test.ts'];
const CONTRACT = ['--project', 'contract', 'tests/contract/identity-verification-boundaries.test.ts'];

const CLASSIFIER = 'adapters/domains/identity/verification/src/classifier.ts';

const MUTATIONS = [
  {
    name: 'M1 (plan) Unicode compatibility normalization removed (no NFKC)',
    edits: [{ file: CLASSIFIER, from: "segment.normalize('NFKC')", to: 'segment' }],
    tests: [UNIT],
  },
  {
    name: 'M2 (plan) only ASCII digits are digits (no \\p{Nd} mapping)',
    edits: [{ file: CLASSIFIER, from: '  return String((code - first) % 10);', to: "  return /^[0-9]$/.test(char) ? char : null;" }],
    tests: [UNIT],
  },
  {
    name: 'M3 (plan) a message with two candidates may submit one',
    edits: [{ file: CLASSIFIER, from: 'if (!only || others.length > 0) return', to: 'if (!only) return' }],
    tests: [UNIT],
  },
  {
    name: 'M4 (plan) a word outside CODE_CONTEXT is tolerated around the code',
    edits: [{ file: CLASSIFIER, from: "      if (!CODE_CONTEXT.has(token)) return false;", to: "      if (!CODE_CONTEXT.has(token) && token !== 'pedido') return false;" }],
    tests: [UNIT],
  },
  {
    name: 'M5 the allowlist is widened in place',
    edits: [{ file: CLASSIFIER, from: "'este', 'ese',", to: "'este', 'ese', 'numero', 'número'," }],
    tests: [UNIT],
  },
  {
    name: 'M6 a non-six-digit candidate is submitted',
    edits: [{ file: CLASSIFIER, from: 'if (only.digits.length !== CODE_DIGITS) return', to: 'if (only.digits.length < CANDIDATE_MIN_DIGITS) return' }],
    tests: [UNIT],
  },
  {
    name: 'M7 the code is submitted without a valid expectation',
    edits: [{ file: CLASSIFIER, from: "  if (!context.expectationAcceptsCode) return withheld('expectation_not_accepting');\n", to: '' }],
    tests: [UNIT],
  },
  {
    name: 'M8 the code is submitted without the adapter attestation of a direct subject',
    edits: [{ file: CLASSIFIER, from: "  if (!context.directSubjectAttested) return withheld('subject_not_attested');\n", to: '' }],
    tests: [UNIT],
  },
  {
    name: 'M9 candidates are not redacted when they cannot be submitted (grace period leaks)',
    edits: [{ file: CLASSIFIER, from: "  if (!context.expectationAcceptsCode) return withheld('expectation_not_accepting');", to: '  if (!context.expectationAcceptsCode) return unchanged;' }],
    tests: [UNIT],
  },
  {
    name: 'M10 a code written next to other digits is not redacted (long runs ignored)',
    edits: [{ file: CLASSIFIER, from: '    else if (digits.length > CANDIDATE_MAX_DIGITS) candidates.push(...groups.filter((g) => g.digits.length === CODE_DIGITS));\n', to: '' }],
    tests: [UNIT],
  },
  {
    name: 'M11 forged platform markers are kept',
    edits: [{ file: CLASSIFIER, from: '  const neutralized = neutralizeMarkers(original);', to: '  const neutralized = original;' }],
    tests: [UNIT],
  },
  {
    name: 'M12 fail-open: an internal failure lets the original text through',
    edits: [{ file: CLASSIFIER, from: "    return { kind: 'replace', text: PLATFORM_MARKERS.messageWithheld, reason: 'fail_closed', submission: null };", to: "    return { kind: 'pass' };" }],
    tests: [UNIT],
  },
  {
    name: 'M13 zero-width characters are not removed (they split the code)',
    edits: [{ file: CLASSIFIER, from: 'const INVISIBLE = /[\\p{Cf}\\uFE0E\\uFE0F\\u20E3]/gu;', to: 'const INVISIBLE = /[\\uFE0E\\uFE0F\\u20E3]/gu;' }],
    tests: [UNIT],
  },
  {
    name: 'M14 the package reaches the environment (purity boundary)',
    edits: [{ file: CLASSIFIER, from: 'export const CODE_DIGITS = 6;', to: "export const CODE_DIGITS = Number(process.env.R4_CODE_DIGITS ?? '6');" }],
    tests: [CONTRACT],
  },
];

function vitest(args, reportFailure = false) {
  const r = spawnSync('npx', ['vitest', 'run', ...args.map((a) => (a.includes(' ') ? `"${a}"` : a))], { shell: true, encoding: 'utf8' });
  if (r.status !== 0 && reportFailure) process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status;
}

let failures = 0;
const baselines = [
  ['unit', UNIT],
  ['contract', CONTRACT],
].map(([name, args]) => {
  const green = vitest(args, true) === 0;
  process.stdout.write(`baseline ${name}: ${green ? 'green' : 'RED'}\n`);
  return green;
});
const baseline = baselines.every(Boolean);
process.stdout.write(`baseline: ${baseline ? 'green' : 'RED'}\n`);
if (!baseline) {
  process.exitCode = 1;
  process.exit();
}
for (const m of MUTATIONS) {
  const originals = new Map();
  for (const e of m.edits) if (!originals.has(e.file)) originals.set(e.file, readFileSync(e.file, 'utf8'));
  const missing = m.edits.filter((e) => !originals.get(e.file).includes(e.from));
  if (missing.length > 0) {
    process.stdout.write(`SKIPPED (anchor not found — update the mutation): ${m.name}\n`);
    failures += 1;
    continue;
  }
  let detected = false;
  try {
    const mutated = new Map(originals);
    for (const e of m.edits) mutated.set(e.file, mutated.get(e.file).replace(e.from, e.to));
    for (const [file, content] of mutated) writeFileSync(file, content);
    for (const args of m.tests) {
      if (vitest(args) !== 0) {
        detected = true;
        break;
      }
    }
  } finally {
    for (const [file, content] of originals) writeFileSync(file, content);
  }
  for (const [file, content] of originals) if (readFileSync(file, 'utf8') !== content) throw new Error(`${file} was not restored`);
  if (!detected) failures += 1;
  process.stdout.write(`${detected ? 'DETECTED' : 'SURVIVED'}: ${m.name}\n`);
}
process.stdout.write(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected; all sources restored\n`);
if (failures > 0) process.exitCode = 1;
