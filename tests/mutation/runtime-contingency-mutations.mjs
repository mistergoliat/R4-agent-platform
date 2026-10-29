// R4-J4-R7-1 mutation checks of the runtime contingency (ADR-028 amendment, ADR-041 generalized, KC-0, KC-2,
// recoverable temporal refusals, attention): each mutation removes one guarantee and EVERY test listed for it must
// FAIL (each test is run alone, by name). Sources are restored byte for byte. The tests use the local PostgreSQL.
//
//   npm run test:mutation:runtime-contingency
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const IT = { project: 'integration', file: 'tests/integration/runtime-contingency.test.ts' };
const RECONCILIATION = { project: 'integration', file: 'tests/integration/reconciliation.test.ts' };
const UNIT_RECOVERY = { project: 'unit', file: 'tests/unit/task-runtime/run-failure-recovery.test.ts' };
const UNIT_KERNEL = { project: 'unit', file: 'tests/unit/agent-kernel/kernel.test.ts' };
const UNIT_ACTIONS = { project: 'unit', file: 'tests/unit/agent-kernel/kernel-actions.test.ts' };
const RUN = 'packages/contracts/src/run.ts';
const EXECUTION = 'packages/task-runtime/src/execution-runtime.ts';
const TEMPORAL = 'packages/task-runtime/src/temporal-runtime.ts';
const KERNEL = 'packages/agent-kernel/src/kernel.ts';
const CONTEXT = 'packages/agent-kernel/src/context.ts';
const STORE = 'packages/persistence-postgres/src/production-store.ts';
const SOURCES = 'packages/context-compiler/src/sources/platform.ts';

const MUTATIONS = [
  {
    name: 'RC-M1 budget, capability and internal failures are terminal again (ADR-028 before the amendment)',
    edits: [{ file: RUN, from: "  return 'human';\n}\n\n/** Task status reason: recoverable", to: "  return 'terminal';\n}\n\n/** Task status reason: recoverable" }],
    tests: [[UNIT_RECOVERY, 'recoverable: invalid_decision and retryable model_failure'], [IT, 'S08 budget_exhausted'], [IT, 'S11 capability_failure'], [IT, 'per-run budget exhausted inside a turn']],
  },
  {
    name: 'RC-M2 a filtered output (content_filter) is retried like any invalid output',
    edits: [{ file: RUN, from: "return details.finishReason === 'content_filter' ? 'human' : 'recoverable';", to: "return 'recoverable';" }],
    tests: [[UNIT_RECOVERY, 'recoverable: invalid_decision and retryable model_failure'], [IT, 'S04: a filtered output']],
  },
  {
    name: 'RC-M3 an abandoned run fails its task instead of handing it over',
    edits: [{ file: EXECUTION, from: "        if (handoff) {\n          events.push(['task.run_failure.contingency'", to: "        if (handoff === undefined) {\n          events.push(['task.run_failure.contingency'" }],
    tests: [[IT, 'S13 abandonment'], [RECONCILIATION, 'a run abandoned mid-call']],
  },
  {
    name: 'RC-M4 the fallback notice is materialized only for the ADR-041 reasons',
    edits: [{ file: STORE, from: '[[...RUN_FAILURE_HANDOFF_REASONS], command.limit]', to: "[['run_failure_recovery_exhausted', 'non_retryable_model_failure'], command.limit]" }],
    tests: [[IT, 'per-run budget exhausted inside a turn'], [IT, 'S04: a filtered output']],
  },
  {
    name: 'RC-M5 a past consultation expiry is no longer refused recoverably',
    edits: [{ file: TEMPORAL, from: "      if (rejection) {\n        await this.#options.execution.appendStepWithin(uow, owned, token, { ...command, outcome: 'refused', error: rejection }", to: "      if (rejection && false) {\n        await this.#options.execution.appendStepWithin(uow, owned, token, { ...command, outcome: 'refused', error: rejection }" }],
    tests: [[IT, 'S14: a consultation with a past expiry']],
  },
  {
    name: 'RC-M6 a refused consultation is not shown back to the model',
    edits: [{ file: SOURCES, from: "if ((decision.type === 'request_consultation' || decision.type === 'request_handoff') && step.outcome === 'refused' && step.error) {", to: 'if (false) {' }],
    tests: [[IT, 'S14: a consultation with a past expiry']],
  },
  {
    name: 'RC-M7 KC-0 reverted: writes stay visible with zero writes remaining',
    edits: [{ file: CONTEXT, from: 'return limits.maxWriteActions - usage.writeActions > 0', to: 'return limits.maxWriteActions > 0' }],
    tests: [[UNIT_ACTIONS, 'KC-0']],
  },
  {
    name: 'RC-M8 KC-2 reverted: the finish reason of an invalid output is dropped',
    edits: [{ file: KERNEL, from: "details: { finishReason: decided.finishReason } },", to: 'details: null },' }],
    tests: [[UNIT_KERNEL, 'KC-2'], [IT, 'S03: two truncated outputs'], [IT, 'S04: a filtered output']],
  },
  {
    name: 'RC-M9 without the human runtime a formerly terminal failure cannot end the run',
    edits: [{ file: EXECUTION, from: "    if (disposition === 'human' && !this.#runFailureHandoff && FORMERLY_TERMINAL.has(termination.reason)) return null;\n", to: '' }],
    tests: [[IT, 'S15 without the human runtime']],
  },
  {
    name: 'RC-M10 attention omits replies the gate cancelled as expired or window_closed',
    edits: [{ file: STORE, from: "and cancel_reason in ('expired', 'window_closed')", to: "and cancel_reason in ('never')" }],
    tests: [[IT, 'S50: a reply cancelled at the gate']],
  },
  {
    name: 'RC-M11 the contingency handoff is not durable (task blocked without a human request)',
    edits: [{ file: TEMPORAL, from: '    await p.insertHuman(request);\n    await this.event(uow, task, request.requestId, \'handoff.requested\', now, events, {\n      initiatedBy: \'platform\'', to: '    await this.event(uow, task, request.requestId, \'handoff.requested\', now, events, {\n      initiatedBy: \'platform\'' }],
    tests: [[IT, 'S08 budget_exhausted'], [IT, 'S13 abandonment']],
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
