// SEC-S3 ingress-protection mutation checks: each mutation weakens one guarantee of R4-I.1 (ADR-040)
// or of the identity-verification inspector; the listed tests must FAIL against it. Every edited source
// is always restored (finally), and the script verifies the restoration byte for byte. Needs the local
// test PostgreSQL (npm run db:up). Run sequentially (never alongside another mutation suite).
//
//   npm run test:mutation:identity-verification-ingress
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const INGRESS = ['--project', 'integration', 'tests/integration/identity-verification-ingress.test.ts'];
const CONTRACT = ['--project', 'contract', 'tests/contract/identity-verification-boundaries.test.ts'];
const UNIT = ['--project', 'unit', 'tests/unit/identity-verification/secret-box.test.ts'];

const STORE = 'packages/persistence-postgres/src/production-store.ts';
const PORT = 'packages/live-ops/src/inspection.ts';
const INSPECTOR = 'adapters/domains/identity/verification/src/inspector.ts';
const STATE = 'adapters/domains/identity/verification/src/state-store.ts';
const GUARD = 'apps/channel-gateway/src/inspection.ts';
const GATEWAY = 'adapters/domains/identity/verification/src/gateway.ts';

const MUTATIONS = [
  {
    name: 'S3-M1 the original text is persisted and hashed whatever the inspector decides',
    edits: [{ file: STORE, from: "const text = decision.kind === 'replace' ? decision.text : content;", to: 'const text = content;' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M2 a re-delivery is inspected again (no duplicate check before the inspector)',
    edits: [{ file: STORE, from: '      if (duplicate) return { record: inboundFromRow(duplicate), created: false };', to: '' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M3 the inbound transaction does not take the conversation lock',
    edits: [{ file: STORE, from: "      await c.query('select pg_advisory_xact_lock($1::bigint)', [conversationLockKey(e.channel, conversationKey)]);", to: '' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M4 the lock key of the ingress differs from the one of the component',
    edits: [{ file: PORT, from: '`r4.conversation\\u0000${channel}\\u0000${conversationKey}`', to: '`r4.inbound\\u0000${channel}\\u0000${conversationKey}`' }],
    tests: [UNIT],
  },
  {
    name: 'S3-M5 an inspector failure with protection known persists the message untreated',
    edits: [{ file: INSPECTOR, from: "      return { kind: 'replace', text: PLATFORM_MARKERS.messageWithheld };", to: "      return { kind: 'pass' };" }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M6 a live expectation of another binding or a terminal task still accepts a code',
    edits: [{ file: INSPECTOR, from: '  return binding !== null && binding.bindingId === live.bindingId && binding.taskId === live.taskId && binding.taskAcceptsInput;', to: '  return binding !== null;' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M7 a code is captured after the challenge expired',
    edits: [{ file: INSPECTOR, from: '  return live.challengeExpiresAt !== null && Date.parse(now) < Date.parse(live.challengeExpiresAt);', to: '  return true;' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M8 a non-attested sender is treated as the binding subject',
    edits: [{ file: INSPECTOR, from: 'directSubjectAttested: context.direct && context.binding !== null && context.senderRef === context.binding.recipientRef,', to: 'directSubjectAttested: true,' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M9 a human-owned conversation still captures (OA-09 ignored)',
    edits: [{ file: INSPECTOR, from: ' && context.binding?.humanOwned === false;', to: ';' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M10 the gateway starts without the inspector while protection is open',
    edits: [{ file: GUARD, from: '  if (open.rows[0]?.active === true) {', to: '  if (false) {' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M11 full without a keyring fails to start instead of degrading to protect_only',
    edits: [{ file: GATEWAY, from: "        degradedReason = 'code_keys_unavailable';", to: "        throw new Error('no keyring');" }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M12 entering protect_only keeps the pending sealed codes',
    edits: [{ file: STATE, from: "        if (mode !== 'protect_only') return { responsesCancelled: 0 };", to: '        return { responsesCancelled: 0 };' }],
    tests: [INGRESS],
  },
  {
    name: 'S3-M13 live-ops learns a verification concept',
    edits: [{ file: PORT, from: '/** Only text is inspected;', to: '/** verificationId: only text is inspected;' }],
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
  ['integration', INGRESS],
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
