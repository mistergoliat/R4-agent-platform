// R4-I (governed production) mutation checks: each mutation weakens one
// production guarantee; the listed tests must FAIL against it. Every edited
// source is always restored (finally), and the script verifies the
// restoration byte for byte. Offline: real PostgreSQL, local fake provider.
//
//   npm run test:mutation:production
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = ['--project', 'unit', 'tests/unit/live-ops'];
const REFERENCE = ['--project', 'integration', 'tests/integration/live-ops-reference.test.ts'];
const HARDENING = ['--project', 'integration', 'tests/integration/live-ops-hardening.test.ts'];
const CONTRACT = ['--project', 'contract', 'tests/contract/live-ops-boundaries.test.ts'];

const STORE = 'packages/persistence-postgres/src/production-store.ts';
const MIGRATION = 'packages/persistence-postgres/migrations/0007_governed_production.sql';
const DELIVERY = 'packages/live-ops/src/delivery.ts';
const AUTONOMY = 'packages/live-ops/src/autonomy.ts';
const PROFILE = 'packages/live-ops/src/profile.ts';
const INBOUND = 'adapters/channels/whatsapp-cloud/src/inbound.ts';
const GATEWAY = 'apps/channel-gateway/src/platform.ts';
const WORKER = 'apps/worker/src/worker.ts';

const MUTATIONS = [
  {
    name: 'disable inbound uniqueness (no unique provider event identity)',
    edits: [
      { file: MIGRATION, from: '  unique (channel, provider_event_id),\n', to: '' },
      { file: STORE, from: 'on conflict (channel, provider_event_id) do update set duplicate_deliveries = inbound_events.duplicate_deliveries + 1', to: 'on conflict do nothing' },
    ],
    tests: [HARDENING],
  },
  {
    name: 'allow duplicate outbound dispatch (already submitted messages are claimable again)',
    edits: [{ file: STORE, from: "select * from outbound_messages where status = 'pending' and (next_attempt_at is null", to: "select * from outbound_messages where status in ('pending', 'accepted', 'delivered', 'read') and (next_attempt_at is null" }],
    tests: [REFERENCE, HARDENING],
  },
  {
    name: 'retry an unknown delivery blindly',
    edits: [{ file: DELIVERY, from: "    case 'unknown':\n      return { status: 'unknown' };", to: "    case 'unknown':\n      return attempt < policy.maxAttempts ? { status: 'pending', retryInMs: 0 } : { status: 'unknown' };" }],
    tests: [UNIT, HARDENING],
  },
  {
    name: 'allow a fixture owner in a production profile',
    edits: [{ file: PROFILE, from: "    if (binding.status === 'FIXTURE' || binding.status === 'SHADOW') problems.push(", to: "    if (binding.status === 'SHADOW') problems.push(" }],
    tests: [UNIT, CONTRACT],
  },
  {
    name: 'ignore the kill switch (inbound and delivery)',
    edits: [
      { file: AUTONOMY, from: '  if (!control.enabled) return { kind: \'hold\', reason: HOLD_REASONS.killSwitch,', to: '  if (control.enabled === null) return { kind: \'hold\', reason: HOLD_REASONS.killSwitch,' },
      { file: DELIVERY, from: "  if (!autonomyEnabledFor(f.controls, f.channel).enabled) return { kind: 'hold', reason: DISPATCH_HOLD_REASONS.killSwitch };", to: '' },
    ],
    tests: [UNIT, REFERENCE],
  },
  {
    name: 'ignore the kill switch at worker admission (new cognition claims)',
    edits: [{ file: WORKER, from: "    if (!(await this.#admitted())) return { kind: 'idle' };\n", to: '' }],
    tests: [REFERENCE, CONTRACT],
  },
  {
    name: 'ignore human ownership at delivery',
    edits: [{ file: DELIVERY, from: '  if (f.task.humanOwned) return { kind: \'cancel\', reason: CANCEL_REASONS.supersededByOperator };\n', to: '' }],
    tests: [UNIT, REFERENCE, HARDENING],
  },
  {
    name: 'treat respond as delivered (materialized outbound born delivered)',
    edits: [{ file: STORE, from: "live ? 'cancelled' : 'pending'", to: "live ? 'cancelled' : 'delivered'" }],
    tests: [REFERENCE, CONTRACT],
  },
  {
    name: 'allow a shadow/fake outbound binding in production',
    edits: [{ file: GATEWAY, from: "  else if (outbound.bindingKind !== (profile.channel.status === 'REAL' ? 'real' : 'sandbox')) problems.push(", to: "  else if (outbound.bindingKind === 'never') problems.push(" }],
    tests: [HARDENING],
  },
  {
    name: 'drop webhook signature verification',
    edits: [{ file: INBOUND, from: "    const header = headers['x-hub-signature-256'];\n    if (!header) return { ok: false as const, reason: 'missing_signature' };", to: "    const header = headers['x-hub-signature-256'];\n    return { ok: true as const };\n    if (!header) return { ok: false as const, reason: 'missing_signature' };" }],
    tests: [UNIT, HARDENING],
  },
  {
    name: 'roll delivered status back to accepted (non-monotonic evidence)',
    edits: [{ file: DELIVERY, from: '  return RANK[evidence] > RANK[current] ? evidence : null;', to: '  return RANK[evidence] !== RANK[current] ? evidence : null;' }],
    tests: [UNIT, HARDENING],
  },
  {
    name: 'send a stale response after newer customer input',
    edits: [{ file: DELIVERY, from: "  if (f.supersededByNewerInput) return { kind: 'cancel', reason: CANCEL_REASONS.supersededByNewerInput };\n", to: '' }],
    tests: [UNIT, HARDENING],
  },
  {
    name: 'ADR-028 recovery repeats an identical live response (no duplicate-content guard)',
    edits: [{ file: STORE, from: "and content_sha256 = $2 and status not in ('cancelled', 'failed')", to: "and content_sha256 = $2 and status = 'never'" }],
    tests: [REFERENCE],
  },
  {
    name: 'rollout defaults open (excluded conversations get autonomy)',
    edits: [{ file: AUTONOMY, from: "  if (!f.bindingAutonomous) return { kind: 'hold', reason: HOLD_REASONS.rolloutExcluded,", to: "  if (f.bindingAutonomous === null) return { kind: 'hold', reason: HOLD_REASONS.rolloutExcluded," }],
    tests: [UNIT, REFERENCE],
  },
];

function vitest(args) {
  const r = spawnSync('npx', ['vitest', 'run', ...args], { shell: true, encoding: 'utf8' });
  return r.status;
}

let failures = 0;
const baseline = [UNIT, REFERENCE, HARDENING, CONTRACT].every((args) => vitest(args) === 0);
process.stdout.write(`baseline: ${baseline ? 'green' : 'RED'}\n`);
if (!baseline) process.exitCode = 1;
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
