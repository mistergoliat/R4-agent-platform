// R4-J4-R7-4 mutation checks of cross-task continuity: each mutation removes one guarantee (only the SAME
// conversation, only EARLIER tasks, conversation turns only, the newest turns kept, the delivery truth, the
// source composed by Sales) and EVERY test listed for it must FAIL (each test is run alone, by name). Sources are
// restored byte for byte. The tests use the local PostgreSQL.
//
//   npm run test:mutation:prior-conversation
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = { project: 'unit', file: 'tests/unit/live-ops/prior-conversation.test.ts' };
const IT = { project: 'integration', file: 'tests/integration/cross-task-continuity.test.ts' };
const SOURCE = 'packages/live-ops/src/context-source.ts';
const STORE = 'packages/persistence-postgres/src/production-store.ts';
const SALES = 'agents/sales/src/production/composition.ts';

const MUTATIONS = [
  {
    name: 'PC-M1 another conversation of the channel leaks into the context',
    edits: [{ file: STORE, from: 'e.channel = c.channel and e.conversation_key = c.conversation_key and', to: 'e.channel = c.channel and' }],
    tests: [[IT, 'R74-2']],
  },
  {
    name: 'PC-M2 the current task counts as its own earlier task (its inputs are duplicated)',
    edits: [{ file: STORE, from: 'and e.created_at < c.created_at and', to: 'and e.created_at <= c.created_at and' }],
    tests: [[IT, 'R74-1'], [IT, 'R74-7']],
  },
  {
    name: 'PC-M3 platform events of the thread enter as conversation turns',
    edits: [{ file: SOURCE, from: ".filter((e) => e.kind !== 'event' && e.text !== null)", to: '.filter((e) => e.kind !== null)' }],
    tests: [[UNIT, 'projects what was said']],
  },
  {
    name: 'PC-M4 the oldest turns are kept instead of the newest',
    edits: [{ file: SOURCE, from: 'const shown = said.slice(-this.#maxTurns);', to: 'const shown = said.slice(0, this.#maxTurns);' }],
    tests: [[UNIT, 'keeps the newest maxTurns']],
  },
  {
    name: 'PC-M5 an earlier reply is shown without its delivery truth',
    edits: [{ file: SOURCE, from: "      ...(e.kind === 'contact' ? {} : { delivery:", to: "      ...(true ? {} : { delivery:" }],
    tests: [[UNIT, 'says honestly'], [IT, 'R74-7']],
  },
  {
    name: 'PC-M6 Sales does not compose the source (no continuity in production)',
    edits: [{ file: SALES, from: ', new PriorConversationContextSource(options.store)]', to: ']' }],
    tests: [[IT, 'R74-1'], [IT, 'R74-5']],
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
