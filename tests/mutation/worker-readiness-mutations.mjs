// R4-I worker readiness mutation checks: each mutation weakens one guarantee
// of worker presence / `/ready/r4`; the listed tests must FAIL against it.
// Every edited source is always restored (finally), and the script verifies
// the restoration byte for byte. Offline: real PostgreSQL, local fake
// provider, scripted model. Run sequentially (never alongside another
// mutation suite: they edit shared sources).
//
//   npm run test:mutation:worker-readiness
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = ['--project', 'integration', 'tests/integration/worker-readiness.test.ts'];
const it = (title) => [...FILE, '-t', title];
const UNIT_STATUS = ['--project', 'unit', 'tests/unit/task-runtime/worker-presence.test.ts'];
const UNIT_PRESENCE = ['--project', 'unit', 'tests/unit/worker/presence.test.ts'];
const CONTRACT = ['--project', 'contract', 'tests/contract/worker-presence-boundaries.test.ts'];

const STATUS = 'packages/task-runtime/src/worker-presence.ts';
const STORE = 'packages/persistence-postgres/src/worker-presence-store.ts';
const PRESENCE = 'apps/worker/src/presence.ts';
const WORKER = 'apps/worker/src/worker.ts';
const PLATFORM = 'apps/worker/src/platform.ts';
const GATEWAY = 'apps/channel-gateway/src/platform.ts';

const READY_FILTER = "count(*) filter (where fresh and same_mode and compatible and state = 'ready')::int as ready";

const MUTATIONS = [
  {
    name: 'M1 no worker reports execution ready',
    edits: [{ file: STATUS, from: 'if (summary.ready > 0) return', to: 'if (summary.ready >= 0) return' }],
    tests: [UNIT_STATUS, it('gateway, database and schema healthy but no worker')],
  },
  {
    name: 'M2 a stale (expired) worker still counts as ready',
    edits: [{ file: STORE, from: READY_FILTER, to: READY_FILTER.replace('fresh and ', '') }],
    tests: [it('a live process whose loop is stuck'), it('multiple workers')],
  },
  {
    name: 'M3 a shadow (or test) worker satisfies production readiness',
    edits: [{ file: STORE, from: READY_FILTER, to: READY_FILTER.replace('same_mode and ', '') }],
    tests: [it('a fresh READY shadow worker')],
  },
  {
    name: 'M4 a worker with another execution contract satisfies readiness',
    edits: [{ file: STORE, from: READY_FILTER, to: READY_FILTER.replace('compatible and ', '') }],
    tests: [it('a fresh production worker with another execution contract')],
  },
  {
    name: 'M5 the kill switch (refused admission) makes a healthy worker unready',
    edits: [{ file: WORKER, from: "    if (!(await this.#admitted())) return { kind: 'idle' };", to: "    if (!(await this.#admitted())) throw new Error('admission refused');" }],
    tests: [it('kill switch OFF or ON'), it('an idle worker')],
  },
  {
    name: 'M6a graceful shutdown does not stop advertising (stopping is never persisted)',
    edits: [{ file: STORE, from: "`update worker_presence set state = 'stopping', reason = 'shutting_down',", to: '`update worker_presence set' }],
    tests: [it('graceful shutdown stops advertising first'), it('multiple workers')],
  },
  {
    name: 'M6b a late renewal returns a stopping worker to ready',
    edits: [{ file: STORE, from: "        where worker_id = $1 and state <> 'stopping'`,", to: '        where worker_id = $1`,' }],
    tests: [it('graceful shutdown stops advertising first')],
  },
  {
    name: 'M7 an idle worker expires despite healthy polling (registered once, never renewed)',
    edits: [{ file: PRESENCE, from: "if (this.#registered && this.#state === 'ready' && this.#lastPublishedAt + this.#options.heartbeatIntervalMs > this.#lastProgressAt) return", to: "if (this.#registered && this.#state === 'ready') return" }],
    tests: [UNIT_PRESENCE, it('an idle worker')],
  },
  {
    name: 'M8 readiness creates customer work (the aggregate probe runs a delivery pass)',
    edits: [{ file: GATEWAY, from: "      const [channel, execution] = await Promise.all([channelReadiness(), executionReadiness()]);", to: "      await delivery.tick();\n      const [channel, execution] = await Promise.all([channelReadiness(), executionReadiness()]);" }],
    tests: [it('repeated')],
  },
  {
    name: 'M9a database/schema failure still reports the aggregate ready',
    edits: [{ file: GATEWAY, from: '      const ready = channel.ready && execution.ok;', to: '      const ready = execution.ok;' }],
    tests: [it('schema not current')],
  },
  {
    name: 'M9b unreadable worker presence is treated as ready (UNKNOWN → READY)',
    edits: [{ file: GATEWAY, from: "        return { ok: false, status: 'unavailable' as const,", to: "        return { ok: true, status: 'unavailable' as const," }],
    tests: [it('presence unreadable')],
  },
  {
    name: 'M10 an independent timer keeps a stuck loop green',
    edits: [{ file: WORKER, from: '    this.#stopping = false;\n', to: '    this.#stopping = false;\n    const beat = setInterval(() => (this.#stopping ? clearInterval(beat) : void this.#options.presence?.progressed()), this.#options.heartbeatIntervalMs);\n' }],
    tests: [it('a live process whose loop is stuck')],
  },
  {
    name: 'M11 channel /ready depends on workers (an execution outage takes ingress out of rotation)',
    edits: [{ file: GATEWAY, from: "      return reply.status(channel.ready ? 200 : 503).send(", to: "      const workers = await executionReadiness();\n      return reply.status(channel.ready && workers.ok ? 200 : 503).send(" }],
    tests: [it('gateway, database and schema healthy but no worker'), it('no worker: inbound is still durably accepted')],
  },
  {
    name: 'M12 the worker advertises READY at composition, before its loop ran',
    edits: [{ file: PLATFORM, from: '    const worker = new Worker({', to: '    await presence.progressed();\n    const worker = new Worker({' }],
    tests: [it('publishes nothing before the loop runs')],
  },
];

function vitest(args, reportFailure = false) {
  const r = spawnSync('npx', ['vitest', 'run', ...args.map((a) => (a.includes(' ') ? `"${a}"` : a))], { shell: true, encoding: 'utf8' });
  if (r.status !== 0 && reportFailure) process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status;
}

let failures = 0;
const baselines = [
  ['unit status', UNIT_STATUS],
  ['unit presence', UNIT_PRESENCE],
  ['integration', FILE],
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
