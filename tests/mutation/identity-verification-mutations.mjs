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
    name: 'M10 six-digit windows of long strong runs are not redacted (482913 1234, 482 913 1234)',
    edits: [{ file: CLASSIFIER, from: '    else if (length > CANDIDATE_MAX_DIGITS) spans.push(...sixDigitWindows(run.groups));', to: '' }],
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
    name: 'M15 (close 04) no weak links: split or mixed fragments are not joined',
    edits: [{ file: CLASSIFIER, from: "  return word === undefined || (more.length === 0 && word.length <= MAX_LINK_WORD) ? 'weak' : 'none';", to: "  return 'none';" }],
    tests: [UNIT],
  },
  {
    name: 'M16 (close 04) a short word does not link two groups (482 y 913)',
    edits: [{ file: CLASSIFIER, from: "  return word === undefined || (more.length === 0 && word.length <= MAX_LINK_WORD) ? 'weak' : 'none';", to: "  return word === undefined ? 'weak' : 'none';" }],
    tests: [UNIT],
  },
  {
    name: 'M17 (close 04) long separator gaps are not joined (482----913, 482    913)',
    edits: [{ file: CLASSIFIER, from: 'const MAX_WEAK_GAP = 8;', to: 'const MAX_WEAK_GAP = 3;' }],
    tests: [UNIT],
  },
  {
    name: 'M18 (close 04) weakly linked clusters are not redacted',
    edits: [{ file: CLASSIFIER, from: "    if (!cluster.links.includes('weak')) continue;", to: '    continue;' }],
    tests: [UNIT],
  },
  {
    name: 'M19 (close 04) six-digit windows of long weak clusters are not redacted',
    edits: [{ file: CLASSIFIER, from: '    else if (length > CANDIDATE_MAX_DIGITS) spans.push(...sixDigitWindows(cluster.groups));', to: '' }],
    tests: [UNIT],
  },
  {
    name: 'M20 (close 04) an ambiguous span is submitted',
    edits: [{ file: CLASSIFIER, from: "  if (!only.submittable) return withheld('ambiguous_digits');", to: '' }],
    tests: [UNIT],
  },
  {
    name: 'M21 (close 04) a weakly linked cluster is marked submittable',
    edits: [{ file: CLASSIFIER, from: 'spans.push(candidateOf(cluster.groups, false));', to: 'spans.push(candidateOf(cluster.groups, true));' }],
    tests: [UNIT],
  },
  {
    name: 'M22 (close 04) overlapping spans are not merged',
    edits: [{ file: CLASSIFIER, from: '    if (previous && span.first <= previous.last) {', to: '    if (previous && span.first < 0) {' }],
    tests: [UNIT],
  },
  {
    name: 'M23 (close 04) a redacted span ends one grapheme early (positions)',
    edits: [{ file: CLASSIFIER, from: '  return { start: first.start, end: last.end, replacement };', to: '  return { start: first.start, end: last.start, replacement };' }],
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
