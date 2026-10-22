// SEC-S5 commercial-layer mutation checks: each mutation weakens one guarantee of identity.start_verification@1,
// identity.verification_status@1, the commercial mapping or the start client (decision rev. 02 §7.3; OA-05;
// RR1-T09); the listed tests must FAIL against it. Every edited source is always restored (finally), and the
// script verifies the restoration byte for byte. Needs the local test PostgreSQL. Run sequentially.
//
//   npm run test:mutation:identity-verification-commercial
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const COMMERCIAL = ['--project', 'integration', 'tests/integration/identity-verification-commercial.test.ts'];
const STATUS = ['--project', 'unit', 'tests/unit/sales/identity-verification-status.test.ts'];
const START = ['--project', 'unit', 'tests/unit/customer-identity/start-client.test.ts'];

const CAPABILITY = 'agents/sales/src/capabilities/identity-verification.ts';
const INSPECTOR = 'adapters/domains/identity/verification/src/inspector.ts';
const CLIENT = 'adapters/domains/identity/http/src/start.ts';

const MUTATIONS = [
  {
    name: 'S5-M1 an ineligible account is offered onboarding (onboarding_required from something else than no_eligible_account)',
    edits: [{ file: CAPABILITY, from: "          return { status: 'account_not_eligible' };", to: "          return { status: 'onboarding_required', onboarding: { available: ONBOARDING_AVAILABLE } };" }],
    tests: [STATUS],
  },
  {
    name: 'S5-M2 a start with an e-mail the customer did not declare (preventive e-mails, OA-05)',
    edits: [{ file: CAPABILITY, from: "  if (!(await declaredByCustomer(deps, taskId, input.email))) return rejected(", to: "  if (false) return rejected(" }],
    tests: [COMMERCIAL],
  },
  {
    name: 'S5-M3 V reads only the binding, not the task state (a cancelled or human-owned task still e-mails a code)',
    edits: [{ file: CAPABILITY, from: "  if (!binding || binding.status !== 'open' || !state || TERMINAL_TASK.includes(state.status) || state.terminalIntent || state.humanOwned) return null;", to: "  if (!binding || binding.status !== 'open') return null;" }],
    tests: [COMMERCIAL],
  },
  {
    name: 'S5-M4 no V after the 202 (an ended session gets the challenge)',
    edits: [{ file: CAPABILITY, from: "  if (!(await stillCurrent(deps, taskId, b0))) return close(deps, expectationId, 'binding_not_current', rejected('binding_not_current', 'the conversation ended while", to: "  if (false) return close(deps, expectationId, 'binding_not_current', rejected('binding_not_current', 'the conversation ended while" }],
    tests: [COMMERCIAL],
  },
  {
    name: 'S5-M5 no resend guard (a refused restart supersedes a fresh challenge)',
    edits: [{ file: CAPABILITY, from: '  if (live && live.expectationId !== expectationId && now - Date.parse(live.createdAt)', to: '  if (false && live && live.expectationId !== expectationId && now - Date.parse(live.createdAt)' }],
    tests: [COMMERCIAL],
  },
  {
    name: 'S5-M6 (RR1-T09) the status is returned without revalidating V after the read',
    edits: [{ file: CAPABILITY, from: "      return (await stillCurrent(deps, taskId, b0)) ? status : { status: 'none' };", to: '      return status;' }],
    tests: [COMMERCIAL],
  },
  {
    name: 'S5-M7 the start requires a human approval (OA-05 autonomy lost)',
    edits: [{ file: CAPABILITY, from: "  capabilities: { [IDENTITY_VERIFICATION_CAPABILITY_IDS.start]: { autonomy: 'allow' } },", to: "  capabilities: { [IDENTITY_VERIFICATION_CAPABILITY_IDS.start]: { autonomy: 'require_approval' } }," }],
    tests: [COMMERCIAL],
  },
  {
    name: 'S5-M8 a withheld number under an accepting challenge is not recorded (code_needed never appears)',
    edits: [{ file: INSPECTOR, from: '        await store.recordWithheld(tx, {', to: '        if (false) await store.recordWithheld(tx, {' }],
    tests: [COMMERCIAL],
  },
  {
    name: 'S5-M9 the start telemetry carries the e-mail',
    edits: [{ file: CLIENT, from: "        kind: 'owner_call', owner: 'customer-identity', operation: 'verification_start', outcome, httpStatus, errorCode,", to: "        kind: 'owner_call', owner: 'customer-identity', operation: 'verification_start', outcome, httpStatus, errorCode, email: request.email," }],
    tests: [START],
  },
];

function vitest(args, reportFailure = false) {
  const r = spawnSync('npx', ['vitest', 'run', ...args.map((a) => (a.includes(' ') ? `"${a}"` : a))], { shell: true, encoding: 'utf8' });
  if (r.status !== 0 && reportFailure) process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status;
}

let failures = 0;
const baselines = [
  ['integration', COMMERCIAL],
  ['unit status', STATUS],
  ['unit start', START],
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
  let detected = false;
  let skipped = false;
  try {
    const mutated = new Map(originals);
    for (const e of m.edits) {
      const before = mutated.get(e.file);
      if (!before.includes(e.from)) skipped = true;
      mutated.set(e.file, before.replace(e.from, e.to));
    }
    if (!skipped) {
      for (const [file, content] of mutated) writeFileSync(file, content);
      for (const args of m.tests) {
        if (vitest(args) !== 0) {
          detected = true;
          break;
        }
      }
    }
  } finally {
    for (const [file, content] of originals) writeFileSync(file, content);
  }
  for (const [file, content] of originals) if (readFileSync(file, 'utf8') !== content) throw new Error(`${file} was not restored`);
  if (!detected) failures += 1;
  process.stdout.write(`${skipped ? 'SKIPPED (anchor not found — update the mutation)' : detected ? 'DETECTED' : 'SURVIVED'}: ${m.name}\n`);
}
process.stdout.write(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected; all sources restored\n`);
if (failures > 0) process.exitCode = 1;
