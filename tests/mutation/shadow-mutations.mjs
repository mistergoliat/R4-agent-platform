// R4-H mutation checks: each mutation weakens one shadow-safety guarantee;
// the listed tests must FAIL against it. The source file is always restored
// (finally), and the script verifies the restoration byte for byte.
//
//   npm run test:mutation:shadow
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = ['--project', 'unit', 'tests/unit/shadow'];
const CONTRACT = ['--project', 'contract', 'tests/contract/shadow-boundaries.test.ts'];

const MUTATIONS = [
  {
    name: 'allow a production write binding in shadow',
    file: 'packages/shadow/src/bindings.ts',
    from: "        return { classification: 'BLOCKED', reason: `production_binding: ${binding.bindingId} is a production binding; shadow never calls one` };",
    to: "        return effect === 'read' ? { classification: 'READ_ALLOWED', reason: 'production read' } : { classification: 'SHADOW_WRITE', reason: 'production write' };",
    tests: [UNIT, CONTRACT],
  },
  {
    name: 'deliver outbound in shadow (production delivery accepted)',
    file: 'packages/shadow/src/bindings.ts',
    from: "    return binding.kind === 'shadow-sink' ? { classification: 'SHADOW_WRITE', reason: 'recorded, never delivered' } : { classification: 'BLOCKED', reason: `production_delivery: ${binding.bindingId} would deliver to a real recipient` };",
    to: "    return { classification: 'SHADOW_WRITE', reason: 'delivered' };",
    tests: [UNIT, CONTRACT],
  },
  {
    name: 'omit write entries from the side-effect manifest',
    file: 'packages/shadow/src/effects.ts',
    from: '          recorder.record({ ...base, outcome, errorCategory: outcome === \'ok\' ? null : categoryOf(error), latencyMs: Math.max(0, Date.now() - started), production });',
    to: "          if (base.effect === 'read') recorder.record({ ...base, outcome, errorCategory: outcome === 'ok' ? null : categoryOf(error), latencyMs: Math.max(0, Date.now() - started), production });",
    tests: [UNIT],
  },
  {
    name: 'mark the fixture Catalog as live-read',
    file: 'agents/sales/src/shadow/bindings.ts',
    from: "  { domain: 'catalog', bindingId: 'fixture-catalog', kind: 'fixture',",
    to: "  { domain: 'catalog', bindingId: 'fixture-catalog', kind: 'live-read',",
    tests: [CONTRACT, UNIT],
  },
  {
    name: 'accept a descriptor that disagrees with its implementation',
    file: 'packages/shadow/src/effects.ts',
    from: '  if (implementationKind !== descriptor.kind) {',
    to: '  if (implementationKind !== descriptor.kind && false) {',
    tests: [UNIT],
  },
  {
    name: 'drop shadow binding metadata from executed runs',
    file: 'packages/shadow/src/suite.ts',
    from: '      bindings: compositionEntries(execution.composition),',
    to: '      bindings: [],',
    tests: [UNIT],
  },
  {
    name: 'no stop condition after a production side effect',
    file: 'packages/shadow/src/suite.ts',
    from: "export const STOP_CONDITION_CHECKS: readonly SafetyCheckCode[] = ['production_effects_zero', ",
    to: "export const STOP_CONDITION_CHECKS: readonly SafetyCheckCode[] = [",
    tests: [UNIT],
  },
  {
    name: 'ignore the cost guard',
    file: 'packages/shadow/src/cost.ts',
    from: '    if (u.modelCalls >= g.maxModelCalls) return',
    to: '    if (false) return',
    tests: [UNIT],
  },
  {
    name: 'count an ungoverned write effect as approved',
    file: 'packages/shadow/src/manifest.ts',
    from: "  const unapprovedEffects = manifest.writeEffects.filter((e) => e.policyOutcome !== 'allow');",
    to: "  const unapprovedEffects = manifest.writeEffects.filter((e) => e.policyOutcome === 'deny');",
    tests: [UNIT],
  },
];

function vitest(args) {
  const r = spawnSync('npx', ['vitest', 'run', ...args], { shell: true, encoding: 'utf8' });
  return r.status;
}

let failures = 0;
process.stdout.write(`baseline: ${vitest(UNIT) === 0 && vitest(CONTRACT) === 0 ? 'green' : 'RED'}\n`);
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    process.stdout.write(`SKIPPED (anchor not found — update the mutation): ${m.name}\n`);
    failures += 1;
    continue;
  }
  let detected = false;
  try {
    writeFileSync(m.file, original.replace(m.from, m.to));
    for (const args of m.tests) if (vitest(args) !== 0) detected = true;
  } finally {
    writeFileSync(m.file, original);
  }
  if (readFileSync(m.file, 'utf8') !== original) throw new Error(`${m.file} was not restored`);
  if (!detected) failures += 1;
  process.stdout.write(`${detected ? 'DETECTED' : 'SURVIVED'}: ${m.name} (${m.file})\n`);
}
process.stdout.write(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected; all sources restored\n`);
if (failures > 0) process.exitCode = 1;
