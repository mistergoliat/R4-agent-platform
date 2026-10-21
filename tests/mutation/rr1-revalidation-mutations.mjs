// SEC-S6 RR-1 revalidation mutation checks (R4_J4_RR1_BINDING_RACE_ANALYSIS.md §6): each mutation
// removes one check of V(taskId, b₀) from customer.get_context@3 / customer.get_purchase_history@2,
// and EVERY test listed for it must FAIL (each test is run alone, by name). The edited source is
// always restored (finally), and the script verifies the restoration byte for byte.
// Unit tests only (no database). The dispatcher mutation (RR1-T07) belongs to SEC-S4/S5.
//
//   npm run test:mutation:rr1
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'tests/unit/sales/customer-v3-capabilities.test.ts';
const V3 = 'agents/sales/src/capabilities/customer-v3.ts';

const MUTATIONS = [
  {
    name: "RR1-M1 remove T2' (no revalidation between the CIA and Customer Profile)",
    edits: [{ file: V3, from: "  if (!(await associationValid(deps.bindings, taskId, binding.bindingId))) return ANONYMOUS; // T2'\n", to: '' }],
    tests: ['RR1-T01', 'RR1-T02'],
  },
  {
    name: 'RR1-M2 remove the taskState check (V reads only the binding)',
    edits: [{ file: V3, from: '  if (task === null || TERMINAL.has(task.status) || task.terminalIntent) return false;\n', to: '' }],
    tests: ['RR1-T02', 'RR1-T04'],
  },
  {
    name: "RR1-M3 remove T4' (Customer Profile data returned after the association ended)",
    edits: [{ file: V3, from: "  if (!(await associationValid(deps.bindings, taskId, binding.bindingId))) return ANONYMOUS; // T4'\n", to: '' }],
    tests: ['RR1-T03'],
  },
  {
    name: 'RR1-M4 remove the humanOwned check (OA-09)',
    edits: [{ file: V3, from: '  if (task.humanOwned) return false;\n', to: '' }],
    tests: ['humanOwned at T1', 'humanOwned at T2', 'humanOwned at T4'],
  },
  {
    name: "RR1-M5 remove T1's V (only the @2 binding status check remains before the CIA)",
    edits: [{ file: V3, from: '  if (!(await associationValid(deps.bindings, taskId, binding.bindingId))) return ANONYMOUS; // T1\n', to: '' }],
    tests: ['RR1-T04'],
  },
];

/** Runs the tests whose name matches `pattern`; returns the passed/failed counts vitest reports. */
function vitest(pattern) {
  const r = spawnSync('npx', ['vitest', 'run', '--project', 'unit', FILE, '-t', `"${pattern}"`], { shell: true, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
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
  const missing = m.edits.filter((e) => !originals.get(e.file).includes(e.from));
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
