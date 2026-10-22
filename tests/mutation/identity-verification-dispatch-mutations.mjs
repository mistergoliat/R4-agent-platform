// SEC-S4 deferred-confirmation mutation checks: each mutation weakens one guarantee of the confirm
// dispatcher or of the CIA confirm client (plan §4; RR-1 §6, mandatory RR1-T07 mutation); the listed
// tests must FAIL against it. Every edited source is always restored (finally), and the script verifies
// the restoration byte for byte. Needs the local test PostgreSQL. Run sequentially.
//
//   npm run test:mutation:identity-verification-dispatch
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DISPATCH = ['--project', 'integration', 'tests/integration/identity-verification-dispatch.test.ts'];
const CLIENT = ['--project', 'unit', 'tests/unit/customer-identity/confirm-client.test.ts'];

const DISPATCHER = 'adapters/domains/identity/verification/src/dispatcher.ts';
const CONFIRM = 'adapters/domains/identity/http/src/confirm.ts';

const MUTATIONS = [
  {
    name: 'S4-M1 (RR1-T07) the dispatcher does not revalidate V before opening the code',
    edits: [{ file: DISPATCHER, from: "    if (subjectRef === null) return this.#abandoned(claim, await store.abandonClaim(claim, 'cancelled', 'binding_not_current'), 'cancelled_binding_not_current');", to: '' }],
    tests: [DISPATCH],
  },
  {
    name: 'S4-M2 a human-owned task still confirms (OA-09 ignored)',
    edits: [{ file: DISPATCHER, from: ' || state.terminalIntent || state.humanOwned) return null;', to: ' || state.terminalIntent) return null;' }],
    tests: [DISPATCH],
  },
  {
    name: 'S4-M3 a retry that cannot fit before the deadline is still scheduled (a claim is later spent without a CIA attempt)',
    edits: [{ file: DISPATCHER, from: '      if (!(Date.now() + delay < deadline)) return', to: '      if (false) return' }],
    tests: [DISPATCH],
  },
  {
    name: 'S4-M4 the in-flight result of a replaced expectation leaves no trace',
    edits: [{ file: DISPATCHER, from: '        const traced = await store.recordDiscardedOutcome(claim, answer.outcome);', to: '        const traced = false;' }],
    tests: [DISPATCH],
  },
  {
    name: 'S4-M5 the resume input carries something other than the outcome-free marker',
    edits: [{ file: DISPATCHER, from: 'content: PLATFORM_MARKERS.updateAvailable, sourceRef: RESUME_SOURCE', to: "content: 'identity verification linked', sourceRef: RESUME_SOURCE" }],
    tests: [DISPATCH],
  },
  {
    name: 'S4-M6 a retry uses a new idempotency key (the CIA would count a new attempt)',
    edits: [{ file: DISPATCHER, from: '      idempotencyKey: claim.confirmIdempotencyKey,', to: '      idempotencyKey: `${claim.confirmIdempotencyKey}.${claim.attempts}`,' }],
    tests: [DISPATCH],
  },
  {
    name: 'S4-M7 the credential breaker never opens',
    edits: [{ file: DISPATCHER, from: 'const BREAKER_THRESHOLD = 3;', to: 'const BREAKER_THRESHOLD = 1_000;' }],
    tests: [DISPATCH],
  },
  {
    name: 'S4-M8 a resolved response of a terminal task is never settled (re-resumed forever)',
    edits: [{ file: DISPATCHER, from: '      // A terminal task is never woken: the response is settled as notified (nothing to resume).', to: '      return false;' }],
    tests: [DISPATCH],
  },
  {
    name: 'S4-M9 a 401/403 is retried instead of refused',
    edits: [{ file: CONFIRM, from: "    if (status === 401 || status === 403) return { kind: 'refused', code: 'identity_unauthorized', credentialRejected: true };", to: "    if (status === 401 || status === 403) return { kind: 'retry', code: 'identity_unauthorized', retryAfterMs: null };" }],
    tests: [CLIENT],
  },
  {
    name: 'S4-M10 the confirm client follows redirects',
    edits: [{ file: CONFIRM, from: "signal, redirect: 'manual' });", to: "signal, redirect: 'follow' as 'manual' });" }],
    tests: [CLIENT],
  },
  {
    name: 'S4-M11 the confirm telemetry carries the code',
    edits: [{ file: CONFIRM, from: "        kind: 'owner_call', owner: 'customer-identity', operation: 'verification_confirm', answer: answer.kind,", to: "        kind: 'owner_call', owner: 'customer-identity', operation: 'verification_confirm', answer: answer.kind, leaked: request.code,", }],
    tests: [CLIENT],
  },
];

function vitest(args, reportFailure = false) {
  const r = spawnSync('npx', ['vitest', 'run', ...args.map((a) => (a.includes(' ') ? `"${a}"` : a))], { shell: true, encoding: 'utf8' });
  if (r.status !== 0 && reportFailure) process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status;
}

let failures = 0;
const baselines = [
  ['integration', DISPATCH],
  ['unit', CLIENT],
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
