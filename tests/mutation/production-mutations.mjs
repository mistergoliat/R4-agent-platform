// R4-I (governed production) mutation checks: each mutation weakens one
// production guarantee; the listed tests must FAIL against it. Every edited
// source is always restored (finally), and the script verifies the
// restoration byte for byte. Offline: real PostgreSQL, local fake provider.
//
//   npm run test:mutation:production
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = ['--project', 'unit', 'tests/unit/live-ops'];
// Run reference cases by a plain title fragment. The two known unrelated
// human-attention failures stay outside this production mutation baseline.
const REFERENCE_FILE = ['--project', 'integration', 'tests/integration/live-ops-reference.test.ts'];
const REFERENCE = [...REFERENCE_FILE, '-t', 'runs end to end'];
const REFERENCE_KILL_SWITCH = [...REFERENCE_FILE, '-t', 'defaults safe'];
const REFERENCE_CONCURRENT_OWNERSHIP = [...REFERENCE_FILE, '-t', 'serializes inbound, operator takeover'];
const REFERENCE_REPLAY = [...REFERENCE_FILE, '-t', 'suppresses an ADR-028 recovery replay'];
const REFERENCE_LATER_TURN = [...REFERENCE_FILE, '-t', 'allows identical text on a later customer turn'];
const REFERENCE_DIFFERENT_TASK = [...REFERENCE_FILE, '-t', 'allows identical text in different Tasks'];
const REFERENCE_DURABLE = [...REFERENCE_FILE, '-t', 'keeps a prior'];
const REFERENCE_OPERATOR = [...REFERENCE_FILE, '-t', 'input durable and visible'];
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
const TEMPORAL_RUNTIME = 'packages/task-runtime/src/temporal-runtime.ts';

const MUTATIONS = [
  {
    name: 'omit the durable HumanRequest for a platform hold',
    edits: [{
      file: TEMPORAL_RUNTIME,
      from: "    await p.insertHuman(request);\n    await this.event(uow, task, request.requestId, 'handoff.requested', now, events, { initiatedBy: 'platform', reason: hold.reason });",
      to: "    await this.event(uow, task, request.requestId, 'handoff.requested', now, events, { initiatedBy: 'platform', reason: hold.reason });",
    }],
    tests: [REFERENCE_KILL_SWITCH, REFERENCE_CONCURRENT_OWNERSHIP],
  },
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
    name: 'remove response_step_id uniqueness protection',
    edits: [{ file: MIGRATION, from: 'response_step_id    uuid        unique references agent_run_steps (step_id),', to: 'response_step_id    uuid        references agent_run_steps (step_id),' }],
    tests: [REFERENCE],
  },
  {
    name: 'allow the same response step to create multiple outbound rows',
    edits: [
      { file: MIGRATION, from: 'response_step_id    uuid        unique references agent_run_steps (step_id),', to: 'response_step_id    uuid        references agent_run_steps (step_id),' },
      { file: STORE, from: 'where not exists (select 1 from outbound_messages o where o.response_step_id = s.step_id)', to: 'where true' },
      { file: STORE, from: 'on conflict (response_step_id) do nothing returning *', to: 'returning *' },
    ],
    tests: [REFERENCE],
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
    name: 'rewrite a delivered agent outbound during operator takeover',
    edits: [{ file: STORE, from: "and origin = 'agent' and status = 'pending'`, [taskId, reason]", to: "and origin = 'agent' and status <> 'cancelled'`, [taskId, reason]" }],
    tests: [HARDENING],
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
    name: 'dedupe every matching text inside the same Task, across independent turns',
    edits: [{ file: STORE, from: 'previous_input.input_id = frontier.input_id', to: 'previous_input.input_id = previous_input.input_id' }],
    tests: [REFERENCE_LATER_TURN],
  },
  {
    name: 'dedupe matching text across different Tasks',
    edits: [
      {
        file: STORE,
        from: 'const live = (await c.query<Row>(',
        to: `const crossTaskMatch = (await c.query<Row>(
          "select outbound_id from outbound_messages where task_id <> $1 and origin = 'agent' and content_sha256 = $2 and status not in ('cancelled', 'failed') limit 1",
          [s.task_id, sha])).rows[0];
        const live = crossTaskMatch ?? (await c.query<Row>(`,
      },
    ],
    tests: [REFERENCE_DIFFERENT_TASK],
  },
  {
    name: 'suppress an operator message because its text matches an agent message',
    edits: [{
      file: STORE,
      from: '      const sha = sha256Hex(command.text);',
      to: `      const sha = sha256Hex(command.text);\n      if ((await c.query("select 1 from outbound_messages where task_id = $1 and origin = 'agent' and content_sha256 = $2 limit 1", [command.taskId, sha])).rowCount) throw new PlatformError('conflict', 'duplicate_content', 'matching message already exists');`,
    }],
    tests: [REFERENCE_OPERATOR],
  },
  {
    name: 'allow ADR-028 replay of the same causal response episode',
    edits: [{ file: STORE, from: 'previous_input.input_id = frontier.input_id', to: 'previous_input.input_id <> frontier.input_id' }],
    tests: [REFERENCE_REPLAY],
  },
  {
    name: 'treat unknown delivery as no evidence when checking duplicate episodes',
    edits: [{
      file: STORE,
      from: "and o.status <> 'cancelled'\n              and (o.status <> 'failed' or o.provider_message_id is not null)",
      to: "and o.status <> 'cancelled'\n              and o.status <> 'unknown'\n              and (o.status <> 'failed' or o.provider_message_id is not null)",
    }],
    tests: [REFERENCE_DURABLE],
  },
  {
    name: 'drop provider-confirmed failed outbound from causal evidence',
    edits: [{ file: STORE, from: "and (o.status <> 'failed' or o.provider_message_id is not null)", to: "and o.status <> 'failed'" }],
    tests: [REFERENCE_DURABLE],
  },
  {
    name: 'rollout defaults open (excluded conversations get autonomy)',
    edits: [{ file: AUTONOMY, from: "  if (!f.bindingAutonomous) return { kind: 'hold', reason: HOLD_REASONS.rolloutExcluded,", to: "  if (f.bindingAutonomous === null) return { kind: 'hold', reason: HOLD_REASONS.rolloutExcluded," }],
    tests: [UNIT, REFERENCE],
  },
];

function vitest(args, reportFailure = false) {
  const r = spawnSync('npx', ['vitest', 'run', ...args], { shell: true, encoding: 'utf8' });
  if (r.status !== 0 && reportFailure) process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status;
}

let failures = 0;
const baselines = [
  ['unit', UNIT],
  ['reference', REFERENCE],
  ['hardening', HARDENING],
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
