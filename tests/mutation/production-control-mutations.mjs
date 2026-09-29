// R4-I production control (D-5/D-6) mutation checks: each mutation weakens
// one guarantee of `production:sales:control`; the listed tests must FAIL
// against it. Every edited source is always restored (finally), and the
// script verifies the restoration byte for byte. Offline: real PostgreSQL,
// local fake provider, scripted model. Run sequentially (never alongside
// another mutation suite: they edit shared sources).
//
//   npm run test:mutation:production-control
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CONTROL_FILE = ['--project', 'integration', 'tests/integration/production-control.test.ts'];
const control = (title) => [...CONTROL_FILE, '-t', title];
const UNIT = ['--project', 'unit', 'tests/unit/live-ops/administration.test.ts'];
const CONTRACT = ['--project', 'contract', 'tests/contract/live-ops-boundaries.test.ts'];

const STORE = 'packages/persistence-postgres/src/production-store.ts';
const ADMIN = 'packages/live-ops/src/administration.ts';
const DELIVERY = 'packages/live-ops/src/delivery.ts';
const TEMPORAL_RUNTIME = 'packages/task-runtime/src/temporal-runtime.ts';
const CLI = 'agents/sales/src/production/control.ts';

const SET_CONTROL = "    return this.#controls.set({ scope: 'global', autonomyEnabled: enabled, reason: requireReason(reason), changedBy: PRODUCTION_CONTROL_ACTOR, correlationId: this.#correlationId });";

const MUTATIONS = [
  {
    name: 'M1 autonomy OFF is not persisted (the control row keeps its previous state)',
    edits: [{ file: STORE, from: "'update autonomy_controls set autonomy_enabled = $2, reason = $3,", to: "'update autonomy_controls set reason = $3," }],
    tests: [control('off persists')],
  },
  {
    name: 'M2a the administrator reason is omitted from the control audit (a default is recorded)',
    edits: [{ file: ADMIN, from: 'reason: requireReason(reason), changedBy', to: "reason: (requireReason(reason), 'admin action'), changedBy" }],
    tests: [UNIT, control('persists')],
  },
  {
    name: 'M2b the administrator reason is omitted from the hold release evidence',
    edits: [{ file: ADMIN, from: '{ reason: HOLD_REASONS.killSwitch, note, actorRef', to: "{ reason: HOLD_REASONS.killSwitch, note: 'released by production control', actorRef" }],
    tests: [UNIT, control('is refused while autonomy is still disabled')],
  },
  {
    name: 'M3 autonomy ON automatically releases every held task',
    edits: [{
      file: ADMIN,
      from: SET_CONTROL,
      to: `${SET_CONTROL.replace('    return ', '    const record = await ')}\n    if (enabled) for (const hold of await this.holds()) await this.#temporal.releasePlatformHold(hold.taskId, { reason: HOLD_REASONS.killSwitch, note: 'autonomy enabled', actorRef: PRODUCTION_CONTROL_ACTOR, correlationId: this.#correlationId });\n    return record;`,
    }],
    tests: [control('never releases a held task')],
  },
  {
    name: 'M4 release allowed while autonomy is still OFF',
    edits: [{ file: ADMIN, from: "    if (!enabledFor(state, channel)) throw new PlatformError('precondition', 'autonomy_disabled',", to: "    if (false) throw new PlatformError('precondition', 'autonomy_disabled'," }],
    tests: [UNIT, control('is refused while autonomy is still disabled')],
  },
  {
    name: 'M5a an agent-created human handoff is eligible for administrative release',
    edits: [{ file: TEMPORAL_RUNTIME, from: "      if (handoff.payload.initiatedBy !== 'platform' || handoff.payload.reason !== body.reason) {", to: "      if (handoff.payload.initiatedBy === 'operator') {" }],
    tests: [control('MUST NOT release an agent-requested human handoff')],
  },
  {
    name: 'M5b agent handoffs and other causes are listed as releasable autonomy holds',
    edits: [{ file: ADMIN, from: "request.payload.initiatedBy === 'platform' && request.payload.reason === HOLD_REASONS.killSwitch", to: "request.payload.initiatedBy !== 'operator'" }],
    tests: [UNIT, control('lists only open platform holds')],
  },
  {
    name: 'M6 release bypasses the HumanRequest resolution (the task is made runnable directly)',
    edits: [{
      file: TEMPORAL_RUNTIME,
      from: "      await p.updateHuman(updated);\n      await this.event(uow, task, handoff.requestId, 'handoff.cancelled'",
      to: "      await transitionTaskWithin(uow, this.#options.ids, task, 'running', 'temporal_wake', { kind: 'system', ref: PLATFORM_ACTOR }, task.correlationId, now, events);\n      await this.event(uow, task, handoff.requestId, 'handoff.cancelled'",
    }],
    tests: [control('is refused while autonomy is still disabled')],
  },
  {
    name: 'M7 release deletes the inbound history received during the hold',
    edits: [{
      file: TEMPORAL_RUNTIME,
      from: "      if (!handoff) throw new PlatformError('conflict', 'platform_hold_not_open',",
      to: "      if (handoff) {\n        const db = (p as unknown as { client: { query(sql: string, params: unknown[]): Promise<unknown> } }).client;\n        await db.query('delete from inbound_events where task_id = $1 and input_id in (select input_id from task_inputs where task_id = $1 and received_at > $2)', [taskId, handoff.createdAt]);\n        await db.query('delete from task_inputs where task_id = $1 and received_at > $2', [taskId, handoff.createdAt]);\n      }\n      if (!handoff) throw new PlatformError('conflict', 'platform_hold_not_open',",
    }],
    tests: [control('new inputs while held')],
  },
  {
    name: 'M8 release flushes delivery directly (the CLI composes the channel and dispatches)',
    edits: [{
      file: CLI,
      from: '      io.out(JSON.stringify(await execute(admin, command), null, 2));',
      to: "      io.out(JSON.stringify(await execute(admin, command), null, 2));\n      if (command.kind === 'holds-release') {\n        const { composeSalesGateway } = await import('./composition.js');\n        const { OutboundDeliveryRuntime } = await import('@r4/live-ops');\n        const { PostgresProductionStore, createPool } = await import('@r4/persistence-postgres');\n        const pool = createPool({ connectionString: databaseUrl, logger, max: 2 });\n        const production = loadProductionConfig(env);\n        const { bindings } = composeSalesGateway({ pool, production, env });\n        await new OutboundDeliveryRuntime({ store: new PostgresProductionStore(pool), adapters: bindings.outbound, config: production.config, owner: 'production-control', logger }).tick();\n        await pool.end();\n      }",
    }],
    tests: [CONTRACT, control('needs no channel or model credentials')],
  },
  {
    name: 'M9 a stale pending agent response becomes sendable after release',
    edits: [{ file: DELIVERY, from: '  if (f.supersededByNewerInput) return { kind: \'cancel\', reason: CANCEL_REASONS.supersededByNewerInput };\n', to: '' }],
    tests: [control('stale pending agent response')],
  },
  {
    name: 'M10 tasks cancel closes the conversation binding itself (ingress no longer owns it)',
    edits: [{
      file: ADMIN,
      from: '    const binding = await this.#store.bindingByTask(taskId);\n    return {\n      taskId,\n      outcome:',
      to: "    const found = await this.#store.bindingByTask(taskId);\n    if (found) await this.#store.closeBinding(found.bindingId, 'task_cancelled');\n    const binding = await this.#store.bindingByTask(taskId);\n    return {\n      taskId,\n      outcome:",
    }],
    tests: [CONTRACT, control('the incident')],
  },
  {
    name: 'M11 a repeated cancel on a terminal task is reported as a fresh cancellation',
    edits: [{ file: ADMIN, from: "outcome: alreadyTerminal ? 'already_terminal' :", to: "outcome: false ? 'already_terminal' :" }],
    tests: [UNIT, control('repeating the cancel is safe')],
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
  ['control', CONTROL_FILE],
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
