// R4-J4-R7-4 mutation checks of cross-task continuity: each mutation removes one guarantee (only the SAME
// conversation, only EARLIER tasks, the time window, the newest turns kept, the delivery truth, the source composed
// by Sales, the framing episode) and EVERY test listed for it must FAIL (each test is run alone, by name). Sources
// are restored byte for byte. The tests use the local PostgreSQL.
//
// R74-5b (recovery) runs its workers in child processes that load `dist`, not `src`. So a mutation listing a test that
// consumes `dist` is compiled (`npm run build`) before its tests run, and after the sources are restored it is compiled
// again. The suite then checks that the `dist` of the mutated packages is byte-identical to the one built from the
// unmutated tree at the start. A failed build is never counted as a detection. Sources (and `dist`) are also restored
// on SIGINT/SIGTERM.
//
//   npm run test:mutation:prior-conversation
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UNIT = { project: 'unit', file: 'tests/unit/live-ops/prior-conversation.test.ts' };
const IT = { project: 'integration', file: 'tests/integration/cross-task-continuity.test.ts' };
const REC = { project: 'recovery', file: 'tests/recovery/cross-task-continuity-process.test.ts', dist: true };
const SOURCE = 'packages/live-ops/src/context-source.ts';
const STORE = 'packages/persistence-postgres/src/production-store.ts';
const SALES = 'agents/sales/src/production/composition.ts';

const MUTATIONS = [
  {
    name: 'PC-M1 another conversation of the channel leaks into the context',
    edits: [{ file: STORE, from: 'e.channel = cur.channel and e.conversation_key = cur.conversation_key and', to: 'e.channel = cur.channel and' }],
    tests: [[IT, 'R74-2'], [IT, 'R74-8']],
  },
  {
    name: 'PC-M2 the current task counts as its own earlier task (its inputs are duplicated)',
    edits: [{ file: STORE, from: 'and e.created_at < cur.created_at and', to: 'and e.created_at <= cur.created_at and' }],
    tests: [[IT, 'R74-1'], [IT, 'R74-7']],
  },
  {
    name: 'PC-M3 a contact turn before the window still enters (R-2)',
    edits: [{ file: STORE, from: ' and i.received_at >= $2', to: '' }],
    tests: [[IT, 'R74-8']],
  },
  {
    name: 'PC-M4 the source keeps the oldest turns instead of the newest',
    edits: [{ file: SOURCE, from: 'const shown = turns.slice(-this.#maxTurns);', to: 'const shown = turns.slice(0, this.#maxTurns);' }],
    tests: [[UNIT, 'keeps the newest maxTurns']],
  },
  {
    name: 'PC-M8 the statement keeps the oldest turns instead of the newest (R-8)',
    edits: [{ file: STORE, from: 'order by t.at desc, t.id desc limit $3', to: 'order by t.at asc, t.id asc limit $3' }],
    tests: [[IT, 'R74-8']],
  },
  {
    name: 'PC-M9 the window is ignored: everything since the epoch enters (R-2)',
    edits: [{ file: SOURCE, from: 'const since = new Date(request.now.getTime() - this.#windowMs).toISOString();', to: 'const since = new Date(0).toISOString();' }],
    tests: [[UNIT, 'the window is 30 days']],
  },
  {
    name: 'PC-M10 the default window is not 30 days (R-2)',
    edits: [{ file: SOURCE, from: 'this.#windowMs = (options.windowDays ?? 30) * 86_400_000;', to: 'this.#windowMs = (options.windowDays ?? 300) * 86_400_000;' }],
    tests: [[UNIT, 'the window is 30 days']],
  },
  {
    name: 'PC-M5 an earlier reply is shown without its delivery truth',
    edits: [{ file: SOURCE, from: "      ...(e.kind === 'contact' ? {} : { delivery:", to: "      ...(true ? {} : { delivery:" }],
    tests: [[UNIT, 'says honestly'], [IT, 'R74-7']],
  },
  {
    name: 'PC-M6 Sales does not compose the source (no continuity in production)',
    edits: [{ file: SALES, from: ', new PriorConversationContextSource(options.store, { windowDays: config.priorConversationDays })]', to: ']' }],
    tests: [[IT, 'R74-1'], [IT, 'R74-5:'], [REC, 'R74-5b']],
  },
  {
    name: 'PC-M7 the framing episode is droppable',
    edits: [{ file: SOURCE, from: '        taskId,\n        required: true,\n', to: '        taskId,\n' }],
    tests: [[UNIT, 'frames the turns']],
  },
];

function vitest({ project, file }, pattern) {
  const r = spawnSync('npx', ['vitest', 'run', '--project', project, file, '-t', `"${pattern}"`], { shell: true, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const count = (word) => Number(out.match(new RegExp(`Tests\\s+[^\\n]*?(\\d+) ${word}`))?.[1] ?? 0);
  return { status: r.status, passed: count('passed'), failed: count('failed'), out };
}

// The compiled output of every package a mutation edits (tsbuildinfo excluded: it is build bookkeeping, not code).
const DIST_DIRS = ['packages/live-ops/dist', 'packages/persistence-postgres/dist', 'agents/sales/dist'];
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith('.tsbuildinfo') ? [] : [path];
  });
}
function distHash() {
  const h = createHash('sha256');
  for (const f of DIST_DIRS.flatMap(files).sort()) h.update(f.replace(/\\/g, '/')).update('\0').update(readFileSync(f)).update('\0');
  return h.digest('hex');
}
function build() {
  const r = spawnSync('npm', ['run', 'build'], { shell: true, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const consumesDist = (m) => m.tests.some(([target]) => target.dist);

// What must be put back if the run is interrupted: original sources, and whether `dist` must be rebuilt.
const pending = { originals: null, rebuild: false };
function restorePending() {
  if (pending.originals) for (const [file, content] of pending.originals) writeFileSync(file, content);
  if (pending.rebuild) build();
  pending.originals = null;
  pending.rebuild = false;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restorePending();
    process.stdout.write(`\ninterrupted (${signal}): sources restored${MUTATIONS.some(consumesDist) ? ' and dist rebuilt' : ''}\n`);
    process.exit(130);
  });
}

// `dist` must match the unmutated tree before the first run, or a dist-consuming baseline would test stale code.
let cleanDist = null;
if (MUTATIONS.some(consumesDist)) {
  const b = build();
  if (!b.ok) {
    process.stdout.write(`${b.out}\nbaseline build FAILED: no mutation can be evaluated\n`);
    process.exitCode = 1;
    process.exit();
  }
  cleanDist = distHash();
  process.stdout.write(`baseline build ok; dist ${cleanDist.slice(0, 12)}\n`);
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
  const dist = consumesDist(m);
  let rebuilt = null;
  try {
    const mutated = new Map(originals);
    for (const e of m.edits) {
      const text = mutated.get(e.file);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      mutated.set(e.file, text.replace(/\r\n/g, '\n').replace(e.from, e.to).replace(/\n/g, eol));
    }
    pending.originals = originals;
    for (const [file, content] of mutated) writeFileSync(file, content);
    let built = true;
    if (dist) {
      pending.rebuild = true;
      const b = build();
      built = b.ok;
      // A mutation that does not compile proves nothing about the tests: it is a failure of the suite, not a detection.
      if (!built) results.push(`build: FAILED (not a detection)\n${b.out}`);
    }
    if (built) {
      for (const t of m.tests) {
        const r = vitest(...t);
        results.push(`${t[1]}: ${r.status !== 0 && r.failed > 0 ? `failed (${r.failed})` : 'PASSED'}`);
      }
    }
  } finally {
    for (const [file, content] of originals) writeFileSync(file, content);
    pending.originals = null;
    if (dist) {
      rebuilt = build();
      pending.rebuild = false;
    }
  }
  if (rebuilt && !rebuilt.ok) throw new Error(`rebuilding the restored sources failed after "${m.name}":\n${rebuilt.out}`);
  for (const [file, content] of originals) if (readFileSync(file, 'utf8') !== content) throw new Error(`${file} was not restored`);
  if (dist && distHash() !== cleanDist) throw new Error(`dist does not match the unmutated tree after "${m.name}"`);
  const detected = results.length > 0 && results.every((r) => !r.endsWith('PASSED') && !r.startsWith('build: FAILED'));
  if (!detected) failures += 1;
  process.stdout.write(`${detected ? 'DETECTED' : 'SURVIVED'}: ${m.name} [${results.join('; ')}]\n`);
}
process.stdout.write(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected; all sources restored${cleanDist ? `; dist identical to the unmutated build (${cleanDist.slice(0, 12)})` : ''}\n`);
if (failures > 0) process.exitCode = 1;
