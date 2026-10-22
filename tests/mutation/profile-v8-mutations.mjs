// R4-J4-R4 mutation checks of sales-production@8: each mutation removes one fail-closed rule of the profile, its
// composition, its policy or the gateway guard, and EVERY test listed for it must FAIL (each test is run alone, by
// name). The edited source is always restored (finally), and the script verifies the restoration byte for byte.
// Contract tests (no database), except M7, which runs the integration test of the gateway guard (PostgreSQL).
//
//   npm run test:mutation:profile-v8
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CONTRACT = { project: 'contract', file: 'tests/contract/sales-profile-v8.test.ts' };
const BOUNDARIES = { project: 'contract', file: 'tests/contract/identity-verification-boundaries.test.ts' };
const INTEGRATION = { project: 'integration', file: 'tests/integration/sales-profile-v8.test.ts' };
const COMPOSITION = 'agents/sales/src/production/composition.ts';
const PROFILE = 'agents/sales/src/production/profile-v8.ts';
const GUARD = 'apps/channel-gateway/src/inspection.ts';

const MUTATIONS = [
  {
    name: 'PV8-M1 the worker accepts the gateway-only credentials',
    edits: [{ file: COMPOSITION, from: '  if (leaked.length > 0) throw refuse(', to: '  if (leaked.length < 0) throw refuse(' }],
    tests: [[CONTRACT, 'refuses the gateway confirm credential in the worker'], [CONTRACT, 'refuses the gateway code keyring in the worker']],
  },
  {
    name: 'PV8-M2 @8 composes without a Customer configuration check',
    edits: [{ file: COMPOSITION, from: "  if (!options.customer) throw refuse('composes Customer and identity verification but no R4_CUSTOMER_* configuration was provided');\n", to: '' }],
    tests: [[CONTRACT, 'refuses no Customer configuration']],
  },
  {
    name: 'PV8-M3 the @8 policy loses the OA-05 rule (start falls back to EXTERNAL_COMMUNICATION approval)',
    edits: [{ file: PROFILE, from: "    [IDENTITY_VERIFICATION_CAPABILITY_IDS.start]: { autonomy: 'allow' },\n  },\n} satisfies ActionPolicyConfigurationInput);", to: "  },\n} satisfies ActionPolicyConfigurationInput);" }],
    tests: [[CONTRACT, 'only identity.start_verification is allowed autonomously']],
  },
  {
    name: 'PV8-M4 @7 composes Customer and identity too',
    edits: [{ file: PROFILE, from: "new Set(['sales-production@8'])", to: "new Set(['sales-production@7', 'sales-production@8'])" }],
    tests: [[CONTRACT, '@1–@7 never compose Customer or identity'], [CONTRACT, 'only identity.start_verification is allowed autonomously']],
  },
  {
    name: 'PV8-M5 the @8 gateway composes no inspector',
    edits: [{ file: COMPOSITION, from: '      ...(isCustomerIdentityProfile(profile) ? { inspection: salesGatewayInspection(profile, options.env, options.identityFetch) } : {}),\n', to: '' }],
    tests: [[CONTRACT, 'composes the inspection factory with a complete gateway configuration'], [CONTRACT, 'refuses no code keyring']],
  },
  {
    name: 'PV8-M6 the v8 schema prerequisite is not checked',
    edits: [{ file: COMPOSITION, from: '  if (!(await identityVerificationSchemaIsCurrent(pool))) throw', to: '  if (false && !(await identityVerificationSchemaIsCurrent(pool))) throw' }],
    tests: [[CONTRACT, 'the worker composition never composes the gateway inspection']],
  },
  {
    name: 'PV8-M7 a gateway without the inspector starts while the component mode is full',
    edits: [{ file: GUARD, from: "  if (full.rows[0]?.full === true) {", to: '  if (false) {' }],
    tests: [[BOUNDARIES, 'the gateway offers no override of the protection guard'], [INTEGRATION, 'a gateway without the inspector refuses to start while the component mode is full']],
  },
  {
    name: 'PV8-M8 @8 composes Customer and identity with the domains UNAVAILABLE',
    edits: [{ file: PROFILE, from: "    [SALES_DOMAINS.identity]: { status: 'REAL',", to: "    [SALES_DOMAINS.identity]: { status: 'UNAVAILABLE'," }],
    tests: [[CONTRACT, 'composes exactly the profile']],
  },
];

/** Runs the tests whose name matches `pattern`; returns the passed/failed counts vitest reports. */
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
