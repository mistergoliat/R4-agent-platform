// SEC-S2 identity-verification state and encryption mutation checks: each mutation weakens one
// guarantee (authenticated encryption, sealed-material lifecycle, state machine, protection, fencing,
// ordering, sanitized errors); the listed tests must FAIL against it. Every edited source is always
// restored (finally), and the script verifies the restoration byte for byte. Needs the local test
// PostgreSQL (npm run db:up). Run sequentially (never alongside another mutation suite).
//
//   npm run test:mutation:identity-verification-state
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = ['--project', 'unit', 'tests/unit/identity-verification/secret-box.test.ts'];
const INTEGRATION = ['--project', 'integration', 'tests/integration/identity-verification-state.test.ts'];
const CONTRACT = ['--project', 'contract', 'tests/contract/identity-verification-boundaries.test.ts'];

const BOX = 'adapters/domains/identity/verification/src/secret-box.ts';
const STORE = 'adapters/domains/identity/verification/src/state-store.ts';
const SQL = 'adapters/domains/identity/verification/migrations/0011_identity_verification_state.sql';

const MUTATIONS = [
  {
    name: 'S2-M1 a constant IV (nonce reuse)',
    edits: [{ file: BOX, from: '    const iv = randomBytes(12);', to: '    const iv = Buffer.alloc(12);' }],
    tests: [UNIT],
  },
  {
    name: 'S2-M2 the AAD ignores the response identity',
    edits: [{ file: BOX, from: 'JSON.stringify([AAD_DOMAIN, binding.responseId, binding.expectationId,', to: 'JSON.stringify([AAD_DOMAIN, binding.expectationId,' }],
    tests: [UNIT],
  },
  {
    name: 'S2-M3 the keyring serializes key material',
    edits: [{ file: BOX, from: '    return { keyIds: this.keyIds };', to: "    return { keyIds: this.keyIds, keys: [...this.#keys.values()].map((k) => k.toString('base64')) } as { keyIds: readonly string[] };" }],
    tests: [UNIT],
  },
  {
    name: 'S2-M4 a terminal response may keep its ciphertext (secret_only_while_open dropped)',
    edits: [{ file: SQL, from: "  constraint secret_only_while_open check ((state in ('pending', 'dispatching')) = (code_ciphertext is not null)),", to: '' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M5 closing or superseding an expectation keeps its pending sealed codes',
    edits: [{ file: SQL, from: "  if new.state in ('confirmed', 'rejected', 'expired', 'cancelled') and old.state not in ('confirmed', 'rejected', 'expired', 'cancelled') then", to: '  if false then' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M6 a live or still-protected expectation can be deleted',
    edits: [{ file: SQL, from: "    if old.state in ('created', 'awaiting_code', 'processing') or old.protect_until > clock_timestamp() then", to: '    if false then' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M7 protect_until may shrink',
    edits: [{ file: SQL, from: '  if new.protect_until < old.protect_until then', to: '  if false then' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M8 a terminal expectation is mutable',
    edits: [{ file: SQL, from: "    raise exception 'identity_verification: expectation_terminal_immutable' using errcode = 'P0001';", to: '    null;' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M9 a code can be captured under a closed expectation',
    edits: [{ file: SQL, from: "    if owner_state is null or owner_state not in ('created', 'awaiting_code', 'processing') then", to: '    if false then' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M10 no fencing: a stale lease owner can settle a claim',
    edits: [{ file: STORE, from: "and lease_owner = $2 and lease_generation = $3::bigint`,", to: "and $2::text is not null and $3::bigint is not null`," }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M11 the newest response is dispatched first (arrival order lost)',
    edits: [
      { file: STORE, from: "                                 order by r.received_seq limit 1) o", to: "                                 order by r.received_seq desc limit 1) o" },
      { file: STORE, from: '            order by received_seq limit 1 for update`,', to: '            order by received_seq desc limit 1 for update`,' },
    ],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M12 a new start does not supersede the live expectation',
    edits: [{ file: STORE, from: "set state = 'cancelled', closed_at = clock_timestamp(), closed_reason = 'superseded'", to: "set state = state, closed_at = closed_at, closed_reason = 'superseded'" }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M13 issuing the challenge does not extend the protection window',
    edits: [{ file: STORE, from: '                  protect_until = greatest(protect_until, $3::timestamptz + make_interval(secs => $4::double precision / 1000)),', to: '                  protect_until = protect_until,' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M14 purge ignores the protection window',
    edits: [{ file: STORE, from: '            and e.protect_until + make_interval(secs => $1::double precision / 1000) <= clock_timestamp()', to: '            and $1::double precision >= 0' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M15 raw database errors (with row values) escape the store',
    edits: [{ file: STORE, from: '  if (error instanceof IdentityVerificationError) return error;', to: '  if (error instanceof Error) return error;' }],
    tests: [INTEGRATION],
  },
  {
    name: 'S2-M16 a second module decrypts (boundary)',
    edits: [{ file: STORE, from: "import type { SealedCode } from './secret-box.js';", to: "import type { SealedCode } from './secret-box.js';\nexport const leak = 'createDecipheriv';" }],
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
  ['integration', INTEGRATION],
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
