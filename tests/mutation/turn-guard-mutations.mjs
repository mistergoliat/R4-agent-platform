// R4-J4-R7-2 mutation checks of the Turn Completion Guard and durable steering: each mutation removes one guarantee
// and EVERY test listed for it must FAIL (each test is run alone, by name). Sources are restored byte for byte. The
// tests use the local PostgreSQL.
//
//   npm run test:mutation:turn-guard
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const IT = { project: 'integration', file: 'tests/integration/turn-completion-guard.test.ts' };
const UNIT_SOURCES = { project: 'unit', file: 'tests/unit/context-compiler/temporal-sources.test.ts' };
const EXECUTION = 'packages/task-runtime/src/execution-runtime.ts';
const TEMPORAL = 'packages/task-runtime/src/temporal-runtime.ts';
const STORE = 'packages/persistence-postgres/src/temporal-store.ts';
const SOURCES = 'packages/context-compiler/src/sources/platform.ts';

const MUTATIONS = [
  {
    name: 'TG-M1 complete is unguarded again (an input is orphaned in a completed task)',
    edits: [{ file: EXECUTION, from: "const guarded = reason === 'completed'", to: "const guarded = false && reason === 'completed'" }],
    tests: [[IT, 'S20 + S29 + S36'], [IT, 'S22: complete with an input'], [IT, 'S31 + S75']],
  },
  {
    name: 'TG-M2 a deferral completes the task anyway',
    edits: [{ file: EXECUTION, from: '      if (deferred) {\n        // R4-J4-R7-2', to: '      if (false) {\n        // R4-J4-R7-2' }],
    tests: [[IT, 'S20 + S29 + S36'], [IT, 'S22: complete with an input']],
  },
  {
    name: 'TG-M3 UNSEEN is ignored (an input the deciding call never saw is treated as seen)',
    edits: [{ file: TEMPORAL, from: "    if (o.unseen) return { kind: 'unseen', input: o.unseen };\n", to: '' }],
    tests: [[IT, 'S22: complete with an input'], [IT, 'S35: an input arriving between']],
  },
  {
    name: 'TG-M4 an agent wait is never guarded',
    edits: [{ file: TEMPORAL, from: "decision.condition.kind === 'WAIT_FOR_INPUT' && command.origin !== 'platform';", to: "decision.condition.kind === 'WAIT_FOR_INPUT' && command.origin === 'platform';" }],
    tests: [[IT, 'S23: «Ok, gracias»'], [IT, 'S27 (invalid wait)']],
  },
  {
    name: 'TG-M4b a temporal wait (WAIT_UNTIL) is treated as a closing',
    edits: [{ file: TEMPORAL, from: "decision.type === 'wait' && decision.condition.kind === 'WAIT_FOR_INPUT' && command.origin", to: "decision.type === 'wait' && command.origin" }],
    tests: [[IT, 'temporal wait: WAIT_UNTIL is not a closing']],
  },
  {
    name: 'TG-M5 the reconsideration is not tied to the frontier (an old ratification covers a new input)',
    edits: [{ file: STORE, from: "and e.event_type = 'turn.closure.reconsider' and e.entity_id = $2", to: "and e.event_type = 'turn.closure.reconsider' and $2::uuid is not null" }],
    tests: [[IT, 'S26: a new frontier'], [IT, 'S35: an input arriving between']],
  },
  {
    name: 'TG-M6 a reply never covers its input',
    edits: [{ file: STORE, from: '(frontier.replied === true || frontier.closed === true)', to: 'frontier.closed === true' }],
    tests: [[IT, 'S33: the identity marker']],
  },
  {
    name: 'TG-M7 a discarded reply still covers its input (INV-D4)',
    edits: [{ file: STORE, from: "and (o.outbound_id is null or o.status not in ('failed', 'cancelled') or o.cancel_reason = 'duplicate_content')) as replied", to: ') as replied' }],
    tests: [[IT, 'INV-D4']],
  },
  {
    name: 'TG-M8 the identity marker (a system input) creates an obligation',
    edits: [{ file: STORE, from: "from task_inputs c where c.task_id = $1 and c.actor_kind = 'user'", to: 'from task_inputs c where c.task_id = $1' }],
    tests: [[IT, 'S33: the identity marker']],
  },
  {
    name: 'TG-M9 the reconsideration episode is not shown to the model',
    edits: [{ file: SOURCES, from: '  for (const e of interactions.closures ?? []) {', to: '  for (const e of []) {' }],
    tests: [[IT, 'S20 + S29 + S36'], [IT, 'S21 + S37'], [UNIT_SOURCES, 'shows a reconsideration']],
  },
  {
    name: 'TG-M10 the ratification is labelled as a verification',
    edits: [{ file: TEMPORAL, from: "basis: 'model_ratification', decision,", to: "basis: 'verified', decision," }],
    tests: [[IT, 'S21 + S37'], [IT, 'S23: «Ok, gracias»']],
  },
  {
    name: 'TG-M11 an open human request no longer refuses the completion (P-2)',
    edits: [{ file: TEMPORAL, from: '    if (blocked) throw new PlatformError', to: '    if (blocked && false) throw new PlatformError' }],
    tests: [[IT, 'S28: an open human request']],
  },
  {
    name: 'TG-M12 observe mode enforces',
    edits: [{ file: TEMPORAL, from: "    if (this.#options.turnGuard === 'observe') {\n      const code = blocked", to: "    if (false) {\n      const code = blocked" }],
    tests: [[IT, 'S32: records what it would do']],
  },
];

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
