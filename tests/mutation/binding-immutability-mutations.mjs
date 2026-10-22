// RR-1 R-4 mutation checks (R4_J4_RR1_BINDING_RACE_ANALYSIS.md §8 R-4): each mutation removes one
// rule of the binding identity trigger (migration 0011_binding_identity_immutability), and EVERY test
// listed for it must FAIL (each test is run alone, by name). The edited migration is always restored
// (finally), and the script verifies the restoration byte for byte. Every test creates a fresh
// database, so the mutated migration (a new checksum) is the one applied.
//
//   npm run test:mutation:binding-immutability
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'tests/integration/binding-identity-immutability.test.ts';
const SQL = 'packages/persistence-postgres/migrations/0011_binding_identity_immutability.sql';
/** The whole line (with its line ending) of the rule that starts with `if <condition>`; '' when absent. */
const rule = (condition) => readFileSync(SQL, 'utf8').match(new RegExp(`^  if ${condition}.*\\r?\\n`, 'm'))?.[0] ?? '';

const MUTATIONS = [
  { name: 'R4-M1 channel is no longer frozen', edits: [{ file: SQL, from: rule('new.channel '), to: '' }], tests: ['R4-T01 channel:'] },
  { name: 'R4-M2 conversation_key is no longer frozen', edits: [{ file: SQL, from: rule('new.conversation_key '), to: '' }], tests: ['R4-T01 conversation_key:'] },
  { name: 'R4-M3 account_ref is no longer frozen', edits: [{ file: SQL, from: rule('new.account_ref '), to: '' }], tests: ['R4-T01 account_ref:', 'R4-T04', 'R4-T05'] },
  { name: 'R4-M4 recipient_ref is no longer frozen', edits: [{ file: SQL, from: rule('new.recipient_ref '), to: '' }], tests: ['R4-T01 recipient_ref:', 'R4-T04', 'R4-T05', 'R4-T06'] },
  { name: 'R4-M5 task_id may be reassigned', edits: [{ file: SQL, from: rule('old.task_id '), to: '' }], tests: ['R4-T01 task_id:', 'R4-T02', 'R4-T06'] },
];

/** Runs the tests whose name matches `pattern`; returns the passed/failed counts vitest reports. */
function vitest(pattern) {
  const r = spawnSync('npx', ['vitest', 'run', '--project', 'integration', FILE, '-t', `"${pattern}"`], { shell: true, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const count = (word) => Number(out.match(new RegExp(`Tests\\s+[^\\n]*?(\\d+) ${word}`))?.[1] ?? 0);
  return { status: r.status, passed: count('passed'), failed: count('failed'), out };
}

const patterns = [...new Set(MUTATIONS.flatMap((m) => m.tests))];
let baseline = true;
for (const pattern of patterns) {
  const r = vitest(pattern);
  const green = r.status === 0 && r.passed > 0 && r.failed === 0;
  if (!green) process.stdout.write(r.out);
  process.stdout.write(`baseline "${pattern}": ${green ? `green (${r.passed} passed)` : 'RED'}\n`);
  baseline &&= green;
}
if (!baseline) {
  process.exitCode = 1;
  process.exit();
}

let failures = 0;
for (const m of MUTATIONS) {
  const originals = new Map();
  for (const e of m.edits) if (!originals.has(e.file)) originals.set(e.file, readFileSync(e.file, 'utf8'));
  const missing = m.edits.filter((e) => e.from === '' ||!originals.get(e.file).includes(e.from));
  if (missing.length > 0) {
    process.stdout.write(`SKIPPED (anchor not found — update the mutation): ${m.name}\n`);
    failures += 1;
    continue;
  }
  const results = [];
  try {
    const mutated = new Map(originals);
    for (const e of m.edits) mutated.set(e.file, mutated.get(e.file).replace(e.from, e.to));
    for (const [file, content] of mutated) writeFileSync(file, content);
    for (const pattern of m.tests) {
      const r = vitest(pattern);
      results.push(`${pattern}: ${r.status !== 0 && r.failed > 0 ? `failed (${r.failed})` : 'PASSED'}`);
    }
  } finally {
    for (const [file, content] of originals) writeFileSync(file, content);
  }
  for (const [file, content] of originals) if (readFileSync(file, 'utf8') !== content) throw new Error(`${file} was not restored`);
  const detected = results.every((r) => !r.endsWith('PASSED'));
  if (!detected) failures += 1;
  process.stdout.write(`${detected ? 'DETECTED' : 'SURVIVED'}: ${m.name} [${results.join('; ')}]\n`);
}
process.stdout.write(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected; all sources restored\n`);
if (failures > 0) process.exitCode = 1;
