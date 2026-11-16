// (M3, quote recovery) Mutation checks: each mutation removes one guarantee of the conversation's earlier quotes in
// the context (only this conversation's lineage, earlier tasks included, the owner's CURRENT state, no guessed
// validity, bounded, one owner read per quote per run and never across runs, off unless enabled) and EVERY test listed
// for it must FAIL (each test is run alone, by name). Sources are restored byte for byte. The tests use the local
// PostgreSQL.
//
//   npm run test:mutation:quote-recovery
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = { project: 'unit', file: 'tests/unit/sales/quote-recovery-source.test.ts' };
const IT = { project: 'integration', file: 'tests/integration/sales-quote-recovery.test.ts' };
const SOURCE = 'agents/sales/src/workspace/quote-recovery-source.ts';
const STORE = 'packages/persistence-postgres/src/production-store.ts';
const SALES = 'agents/sales/src/production/composition.ts';
const MAIN = 'a returning customer sees the quote';

const MUTATIONS = [
  {
    name: 'QR-M1 another conversation of the channel leaks into the lineage (another contact\'s quote is shown)',
    edits: [{ file: STORE, from: 'e.conversation_key = cur.conversation_key and e.created_at < cur.created_at and e.task_id is not null\n        order by e.created_at desc, e.binding_id desc limit $2', to: 'e.created_at < cur.created_at and e.task_id is not null\n        order by e.created_at desc, e.binding_id desc limit $2' }],
    tests: [[IT, MAIN]],
  },
  {
    name: 'QR-M2 earlier tasks of the conversation are not searched',
    edits: [{ file: SOURCE, from: 'conversationQuotes([task.taskId, ...earlier]', to: 'conversationQuotes([task.taskId]' }],
    tests: [[UNIT, 'shows an issued quote'], [IT, MAIN]],
  },
  {
    name: 'QR-M3 an expired quote is shown as still valid',
    edits: [{ file: SOURCE, from: "stillValid: quote ? quote.status === 'issued'", to: "stillValid: quote ? quote.status !== 'cancelled'" }],
    tests: [[UNIT, 'after the validity ends'], [IT, MAIN]],
  },
  {
    name: 'QR-M4 an unreachable owner is guessed valid',
    edits: [{ file: SOURCE, from: ': pastValidity ? false : null,', to: ': pastValidity ? false : true,' }],
    tests: [[UNIT, 'an unreachable owner degrades']],
  },
  {
    name: 'QR-M5 not bounded: every quote of the conversation is shown',
    edits: [{ file: SOURCE, from: 'const shown = records.slice(0, maxQuotes);', to: 'const shown = records;' }],
    tests: [[UNIT, 'is bounded to the 3 newest']],
  },
  {
    name: 'QR-M6 the owner is read again on every iteration',
    edits: [{ file: SOURCE, from: 'let read = this.#reads.get(key);', to: 'let read: Promise<OwnerRead> | undefined;' }],
    tests: [[UNIT, 'reads the owner once per quote per run']],
  },
  {
    name: 'QR-M7 an owner answer outlives its run (a later run sees a stale state)',
    edits: [{ file: SOURCE, from: 'const key = `${runId}|${quoteId}`;', to: 'const key = quoteId;' }],
    tests: [[UNIT, 'after the validity ends'], [UNIT, 'reads the owner once per quote per run']],
  },
  {
    name: 'QR-M8 composed without R4_SALES_QUOTE_RECOVERY=enabled',
    edits: [{ file: SALES, from: 'options.quoteRecovery === true && quoteReal', to: 'quoteReal' }],
    tests: [[IT, 'is off by default']],
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
