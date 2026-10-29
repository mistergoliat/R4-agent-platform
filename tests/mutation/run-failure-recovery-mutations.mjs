// ADR-028 (GAP-H-001) mutation checks: each mutation weakens one guarantee of
// run-level recovery; the listed tests must FAIL against it. Every edited
// source is always restored (finally), and the script verifies the
// restoration byte for byte.
//
//   npm run test:mutation:recovery
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UNIT = ['--project', 'unit', 'tests/unit/task-runtime/run-failure-recovery.test.ts'];
const INTEGRATION = ['--project', 'integration', 'tests/integration/run-failure-recovery.test.ts'];

const EXECUTION = 'packages/task-runtime/src/execution-runtime.ts';
const RECOVERY_KEEP = '        // Same durable task, still running, no active run: the next claim is the recovery.\n        task = owned.task;\n';
const TEMPORAL = 'packages/task-runtime/src/temporal-runtime.ts';
const RUN = 'packages/contracts/src/run.ts';

// R4-J4-R7-1: anchors of "recover budget_exhausted", "recover capability_failure without evidence" and "non-retryable model
// failure retried" follow the rewritten runFailureDisposition (same intent). "exhaustion without attention" now anchors on
// handOffAfterRunFailureWithin: its old anchor first matched holdForHumansWithin (R4-I), so it mutated the wrong function.
const MUTATIONS = [
  {
    name: 'unbounded recovery (the consecutive count never grows)',
    edits: [{ file: EXECUTION, from: "      if (runFailureRecoveryOf(earlier.termination)?.outcome !== 'continued') break;", to: '      break;' }],
    tests: [INTEGRATION],
  },
  {
    name: 'recovery never exhausts (the budget is never compared)',
    edits: [{ file: EXECUTION, from: "outcome: consecutiveFailures > maxRunFailureRecoveries ? 'exhausted' : 'continued'", to: "outcome: consecutiveFailures > Number.MAX_SAFE_INTEGER ? 'exhausted' : 'continued'" }],
    tests: [INTEGRATION],
  },
  {
    name: 'recover budget_exhausted',
    edits: [{ file: RUN, from: "  return 'human';\n}\n\n/** Task status reason: recoverable", to: "  return termination.reason === 'budget_exhausted' ? 'recoverable' : 'human';\n}\n\n/** Task status reason: recoverable" }],
    tests: [UNIT, INTEGRATION],
  },
  {
    name: 'recover capability_failure without evidence',
    edits: [{ file: RUN, from: "  return 'human';\n}\n\n/** Task status reason: recoverable", to: "  return termination.reason === 'capability_failure' ? 'recoverable' : 'human';\n}\n\n/** Task status reason: recoverable" }],
    tests: [UNIT],
  },
  {
    name: 'retry an accepted AgentDecision (a completed run is "recovered")',
    edits: [{ file: RUN, from: "  if (status !== 'failed' && status !== 'abandoned') return null;", to: "  if (status !== 'failed' && status !== 'abandoned') return termination.reason === 'completed' ? 'recoverable' : null;" }],
    tests: [UNIT, INTEGRATION],
  },
  {
    name: 'non-retryable model failure retried',
    edits: [{ file: RUN, from: "return details.retryable === true ? 'recoverable' : 'human';", to: "return 'recoverable';" }],
    tests: [UNIT, INTEGRATION],
  },
  {
    name: 'task becomes failed before the recovery budget is exhausted',
    // (R4-J4-R7-2: anchored on the recovery branch's comment; the turn guard's deferral also keeps owned.task.)
    edits: [{ file: EXECUTION, from: RECOVERY_KEEP, to: "        // Same durable task, still running, no active run: the next claim is the recovery.\n        task = await transitionTaskWithin(uow, this.#ids, owned.task, 'failed', reason, actor, owned.task.correlationId, timestamp, events);\n" }],
    tests: [INTEGRATION],
  },
  {
    name: 'exhaustion without attention (no platform handoff request)',
    edits: [{ file: TEMPORAL, from: '    await p.insertHuman(request);\n    await this.event(uow, task, request.requestId, \'handoff.requested\', now, events, {\n      initiatedBy: \'platform\', reason: cause.reason', to: '    await this.event(uow, task, request.requestId, \'handoff.requested\', now, events, {\n      initiatedBy: \'platform\', reason: cause.reason' }],
    tests: [INTEGRATION],
  },
  {
    name: 'recover while a human owns the task (platform handoff does not block)',
    edits: [{ file: TEMPORAL, from: "    const blocked = await transitionTaskWithin(uow, this.#options.ids, task, 'blocked', cause.reason, cause.actor, task.correlationId, now, events);", to: '    const blocked = task;' }],
    tests: [INTEGRATION],
  },
  {
    name: 'recover before reconciliation (claim ignores uncertain effects)',
    edits: [{ file: 'packages/persistence-postgres/src/execution-store.ts', from: "            and not exists (select 1 from action_executions e where e.task_id=agent_tasks.task_id and e.status='needs_reconciliation')\n", to: '' }],
    tests: [INTEGRATION],
  },
  {
    name: 'reuse the failed run’s ContextSnapshot for the recovery run',
    edits: [
      { file: 'packages/persistence-postgres/src/execution-store.ts', from: "'select * from context_snapshots where run_id = $1 and iteration = $2 order by attempt desc limit 1'", to: "'select * from context_snapshots where task_id = (select task_id from agent_runs where run_id = $1) and iteration = $2 order by created_at desc, attempt desc limit 1'" },
      { file: 'apps/worker/src/session.ts', from: '      if (latest && latest.inputFingerprint === outcome.inputFingerprint) {', to: '      if (latest) {' },
    ],
    tests: [INTEGRATION],
  },
  {
    name: 'ignore customer input that arrives between the failed run and the recovery',
    // (R4-I: submitInput's body moved into #submitInputWithin — same check, new indentation.)
    edits: [{ file: TEMPORAL, from: "    if (isTerminalTaskStatus(task.status) || (await p.terminalIntent(taskId))) {\n      throw new PlatformError('conflict', 'task_not_accepting_input'", to: "    if (isTerminalTaskStatus(task.status) || task.status === 'running' || (await p.terminalIntent(taskId))) {\n      throw new PlatformError('conflict', 'task_not_accepting_input'" }],
    tests: [INTEGRATION],
  },
  {
    name: 'reset maxWriteActions for the new run',
    edits: [{ file: EXECUTION, from: '      const writeActions = await uow.countActionExecutions(task.taskId);', to: '      const writeActions = (await uow.countActionExecutions(task.taskId)) * 0;' }],
    tests: [INTEGRATION],
  },
  {
    name: 'a goal is created during recovery',
    edits: [
      {
        file: EXECUTION,
        from: RECOVERY_KEEP,
        to: RECOVERY_KEEP + "        await uow.insertGoal({ goalId: this.#ids.next(), taskId: owned.task.taskId, parentGoalId: owned.task.rootGoalId, description: 'recover the conversation', successCriteria: [], status: 'active', origin: 'agent', correlationId: owned.task.correlationId, version: 1, createdAt: timestamp, updatedAt: timestamp });\n",
      },
    ],
    tests: [INTEGRATION],
  },
];

function vitest(args) {
  const r = spawnSync('npx', ['vitest', 'run', ...args], { shell: true, encoding: 'utf8' });
  return r.status;
}

let failures = 0;
process.stdout.write(`baseline: ${vitest(UNIT) === 0 && vitest(INTEGRATION) === 0 ? 'green' : 'RED'}\n`);
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
    for (const args of m.tests) if (vitest(args) !== 0) detected = true;
  } finally {
    for (const [file, content] of originals) writeFileSync(file, content);
  }
  for (const [file, content] of originals) if (readFileSync(file, 'utf8') !== content) throw new Error(`${file} was not restored`);
  if (!detected) failures += 1;
  process.stdout.write(`${detected ? 'DETECTED' : 'SURVIVED'}: ${m.name}\n`);
}
process.stdout.write(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected; all sources restored\n`);
if (failures > 0) process.exitCode = 1;
