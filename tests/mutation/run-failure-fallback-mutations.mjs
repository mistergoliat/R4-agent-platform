// R4-J5 P0 / ADR-041 mutation checks of the run-failure fallback: each mutation removes one guarantee (the
// fallback is materialized, sent although the task is human-owned, superseded by an operator, held by the kill
// switch, composed by Sales) and EVERY test listed for it must FAIL (each test is run alone, by name). Sources are
// restored byte for byte. The tests use the local PostgreSQL.
//
//   npm run test:mutation:run-failure-fallback
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = { project: 'unit', file: 'tests/unit/live-ops/delivery.test.ts' };
const IT = { project: 'integration', file: 'tests/integration/run-failure-fallback.test.ts' };
const OUTBOUND = 'packages/live-ops/src/outbound.ts';
const GATE = 'packages/live-ops/src/delivery.ts';
const STORE = 'packages/persistence-postgres/src/production-store.ts';
const SALES = 'agents/sales/src/production/composition.ts';

const MUTATIONS = [
  {
    name: 'RFF-M1 the delivery runtime never materializes the fallback',
    edits: [{ file: OUTBOUND, from: '    if (fallback) created.push(', to: '    if (false) created.push(' }],
    tests: [[IT, 'two consecutive failures'], [IT, 'a non-retryable model failure hands off at once']],
  },
  {
    name: 'RFF-M2 the gate treats the fallback as agent output (a human-owned task cancels it)',
    edits: [{ file: GATE, from: "  if (f.origin === 'platform') return decidePlatformDispatch(f, policy);", to: '' }],
    tests: [[UNIT, 'is sent while its handoff is still requested'], [IT, 'two consecutive failures']],
  },
  {
    name: 'RFF-M3 the gate ignores whether the handoff is still pending',
    edits: [{ file: GATE, from: '  if (f.handoffPending !== true) return', to: '  if (false) return' }],
    tests: [[UNIT, 'is cancelled once a human took the task'], [IT, 'an operator who takes the conversation before the dispatch']],
  },
  {
    name: 'RFF-M4 the store reports every fallback handoff as pending',
    edits: [{ file: STORE, from: "  const handoffPending = outbound.origin === 'platform'", to: "  const handoffPending = outbound.origin === 'platform' ? true : outbound.origin === 'never'" }],
    tests: [[IT, 'an operator who takes the conversation before the dispatch']],
  },
  {
    name: 'RFF-M5 the fallback bypasses the kill switch',
    edits: [{ file: GATE, from: '  if (!autonomyEnabledFor(f.controls, f.channel).enabled) return { kind: \'hold\', reason: DISPATCH_HOLD_REASONS.killSwitch };\n  if (f.binding.deniedNow) return { kind: \'hold\', reason: DISPATCH_HOLD_REASONS.denied };\n  if (!f.binding.autonomous) return { kind: \'hold\', reason: DISPATCH_HOLD_REASONS.rolloutExcluded };\n  if (f.handoffPending', to: "  if (f.binding.deniedNow) return { kind: 'hold', reason: DISPATCH_HOLD_REASONS.denied };\n  if (!f.binding.autonomous) return { kind: 'hold', reason: DISPATCH_HOLD_REASONS.rolloutExcluded };\n  if (f.handoffPending" }],
    tests: [[UNIT, 'obeys the kill switch, deny and rollout'], [IT, 'the kill switch holds the fallback']],
  },
  {
    name: 'RFF-M6 the Sales gateway composes no fallback text',
    edits: [{ file: SALES, from: '      runFailureFallback: { text: SALES_RUN_FAILURE_FALLBACK_TEXT },\n', to: '' }],
    tests: [[IT, 'two consecutive failures'], [IT, 'a worker restart during recovery']],
  },
];

function vitest({ project, file }, pattern) {
  const r = spawnSync('npx', ['vitest', 'run', '--project', project, file, '-t', `"${pattern}"`], { shell: true, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const count = (word) => Number(out.match(new RegExp(`Tests\\s+[^\\n]*?(\\d+) ${word}`))?.[1] ?? 0);
  return { status: r.status, passed: count('passed'), failed: count('failed'), out };
}

const key = ([target, pattern]) => `${target.file} :: ${pattern}`;
const unique = [...new Map(MUTATIONS.flatMap((m) => m.tests).map((t) => [key(t), t])).values()];
let baseline = true;
for (const t of unique) {
  const r = vitest(...t);
  const green = r.status === 0 && r.passed > 0 && r.failed === 0;
  if (!green) process.stdout.write(r.out);
  process.stdout.write(`baseline "${key(t)}": ${green ? `green (${r.passed} passed)` : 'RED'}\n`);
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
  const missing = m.edits.filter((e) => !originals.get(e.file).replace(/\r\n/g, '\n').includes(e.from));
  if (missing.length > 0) {
    process.stdout.write(`SKIPPED (anchor not found — update the mutation): ${m.name}\n`);
    failures += 1;
    continue;
  }
  const results = [];
  try {
    const mutated = new Map(originals);
    for (const e of m.edits) {
      const text = mutated.get(e.file);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      mutated.set(e.file, text.replace(/\r\n/g, '\n').replace(e.from, e.to).replace(/\n/g, eol));
    }
    for (const [file, content] of mutated) writeFileSync(file, content);
    for (const t of m.tests) {
      const r = vitest(...t);
      results.push(`${t[1]}: ${r.status !== 0 && r.failed > 0 ? `failed (${r.failed})` : 'PASSED'}`);
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
