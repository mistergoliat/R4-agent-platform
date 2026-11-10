// (sales-production@19, owner decision 2026-11-10) Mutation checks of the acceptance interpreted in natural language:
// each mutation removes one guarantee (the guard refuses questions and negations, only @19 interprets, @19 really uses
// the intent judge and offer template v2, @18 keeps the closed grammar) and EVERY test listed for it must FAIL.
// Sources are restored byte for byte. The tests use the local PostgreSQL.
//
//   npm run test:mutation:intent-acceptance
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = { project: 'unit', file: 'tests/unit/sales/intent-guard.test.ts' };
const IT = { project: 'integration', file: 'tests/integration/sales-intent-acceptance.test.ts' };
const GRAMMAR = 'agents/sales/src/capabilities/confirmation-grammar.ts';
const CREATE = 'agents/sales/src/capabilities/quote-v5.ts';
const PREVIEW = 'agents/sales/src/capabilities/quote-preview.ts';
const SALES = 'agents/sales/src/production/composition.ts';
const SNAPSHOT = 'agents/sales/src/capabilities/commercial-snapshot.ts';
const ELIGIBILITY = { project: 'unit', file: 'tests/unit/sales/commercial-eligibility.test.ts' };

const MUTATIONS = [
  {
    name: 'IA-M1 the guard ignores question marks and negative emojis',
    edits: [{ file: GRAMMAR, from: "  if (/[?¿？]/u.test(text) || NEGATIVE_EMOJI.test(text)) return { confirmed: false, reason: 'disqualified' };", to: '' }],
    tests: [[UNIT, 'never takes']],
  },
  {
    name: 'IA-M2 the guard ignores negations, hesitations and change requests',
    edits: [{ file: GRAMMAR, from: '  if (INTENT_DISQUALIFIERS.test(normalized)) return', to: '  if (false) return' }],
    tests: [[UNIT, 'never takes']],
  },
  {
    name: 'IA-M3 @19 still requires the closed grammar (the natural replies of the first canary are refused)',
    edits: [{ file: CREATE, from: '  const judge = deps.naturalAcceptance === true ? INTENT_GUARD_JUDGE : CLOSED_GRAMMAR_JUDGE;', to: '  const judge = CLOSED_GRAMMAR_JUDGE;' }],
    tests: [[IT, '@19 issues exactly one quote']],
  },
  {
    name: 'IA-M4 every profile interprets acceptance (the closed grammar of @18 is lost)',
    edits: [{ file: SALES, from: 'naturalAcceptance: SALES_INTENT_ACCEPTANCE_PROFILES.has(profileLabel(profile)) }));', to: 'naturalAcceptance: true }));' }],
    tests: [[IT, '@18 keeps the closed grammar']],
  },
  {
    name: 'IA-M5 @19 previews with template v1 while issuance expects v2 (the offer is never accepted)',
    edits: [{ file: PREVIEW, from: '  const v4 = deps.naturalAcceptance === true;', to: '  const v4 = false;' }],
    tests: [[IT, '@19 issues exactly one quote']],
  },
  {
    name: 'IA-M6 @19 keeps the v1 policy (delivery blocked although the owner allowed it)',
    edits: [{ file: SALES, from: '  return SALES_F1_SHIPPING_PROFILES.has(profileLabel(profile)) ? { policyVersion: F1_COMMERCIAL_POLICY_V2_VERSION, shippingAllowed: true } : { policyVersion: F1_COMMERCIAL_POLICY_VERSION };', to: '  return { policyVersion: F1_COMMERCIAL_POLICY_VERSION };' }],
    tests: [[IT, 'issues a quote with the delivery offer the customer chose'], [ELIGIBILITY, 'F1-COMMERCIAL-POLICY-v2']],
  },
  {
    name: 'IA-M7 the v1 policy (@17, @18) lets a delivery through',
    edits: [{ file: SNAPSHOT, from: '  if (deps.eligibility && delivery && deps.eligibility.shippingAllowed !== true) {', to: '  if (deps.eligibility && delivery && false) {' }],
    tests: [[ELIGIBILITY, 'a delivery destination is refused before pricing any shipping']],
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
