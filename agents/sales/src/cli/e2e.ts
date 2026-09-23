import { createInterface } from 'node:readline/promises';
import { configuredModelProvider } from '../model.js';
import { adminDatabaseUrl, createScenarioDatabase, redactedUrl } from '../harness/database.js';
import { evaluateInvariants } from '../harness/invariants.js';
import { buildReport } from '../harness/report.js';
import { runScenario } from '../harness/runner.js';
import { SalesHarness } from '../harness/runtime.js';
import { CENTRAL_SCENARIO, scenarioById } from '../harness/scenarios.js';
import { flag, loadLocalEnv, option, print, printReport } from './common.js';

/**
 * `npm run sales:e2e` — conversational E2E harness over a throwaway,
 * migrated database.
 *
 *   --scenario <ID>   run one acceptance scenario with its scripted stand-in (offline)
 *   --interactive     talk to the Sales agent yourself (needs R4_MODEL_* configured)
 *   --customer <ref>  bind the interactive conversation to a fixture customer (default: anonymous)
 *   --keep-db         keep the database afterwards (its URL is printed without the password)
 *
 * Without options: interactive when a model provider is configured,
 * otherwise the central $800.000 home-gym scenario, scripted.
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const model = configuredModelProvider(process.env);
  const db = await createScenarioDatabase(adminDatabaseUrl(process.env), 'r4_sales_e2e');
  print(`database: ${redactedUrl(db.url)}`);
  try {
    const scenarioId = option('scenario');
    if (scenarioId !== undefined || (!flag('interactive') && model === null)) {
      const scenario = scenarioId ? scenarioById(scenarioId) : CENTRAL_SCENARIO;
      if (!model) print('no model provider configured (R4_MODEL_*): running the scripted stand-in, which exercises platform semantics only');
      const run = await runScenario(scenario, { databaseUrl: db.url, mode: 'scripted' });
      printReport(run.report, run.invariants);
      process.exitCode = run.passed ? 0 : 1;
      return;
    }
    if (!model) throw new Error('interactive mode needs a model provider: set R4_MODEL_PROVIDER=openai_compatible and R4_MODEL_* (see .env.example)');
    await interactive(db.url, model.provider, model.description);
  } finally {
    if (flag('keep-db')) print(`kept database ${db.name}`);
    else await db.drop();
  }
}

async function interactive(databaseUrl: string, provider: NonNullable<ReturnType<typeof configuredModelProvider>>['provider'], description: Record<string, unknown>): Promise<void> {
  const harness = await SalesHarness.start({ databaseUrl, modelProvider: provider, captureTelemetry: true, execution: { modelCallTimeoutMs: 180_000 } });
  const taskId = await harness.openConversation({ customerRef: option('customer') ?? null, channelRef: 'cli' });
  print(`model: ${JSON.stringify(description)}`);
  print(`conversation ${taskId} — type a message; commands: /state /answer <text> /restart /advance <minutes> /report /quit`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const line = (await rl.question('you> ')).trim();
      if (!line) continue;
      if (line === '/quit') break;
      if (line === '/state') {
        const state = await harness.inspect(taskId);
        print(JSON.stringify({ task: state.task.status, goals: state.goals.map((g) => [g.description, g.status]), workspace: state.workspace, quotes: state.quoteReferences }, null, 2));
        continue;
      }
      if (line === '/restart') {
        await harness.restartWorker();
        print('(worker replaced)');
        continue;
      }
      if (line.startsWith('/advance ')) {
        harness.clock.offsetMs += Number(line.slice(9)) * 60_000;
        print(`(process clock +${line.slice(9)} min)`);
        continue;
      }
      if (line === '/report') {
        const state = await harness.inspect(taskId);
        printReport(buildReport({ id: 'INTERACTIVE', title: 'interactive session', mode: 'live', model: description, state }), evaluateInvariants([{ kind: 'no_unbacked_quote_claim' }, { kind: 'root_goal_active' }], state));
        continue;
      }
      const turn = line.startsWith('/answer ') ? await harness.answerConsultation(taskId, line.slice(8)) : await harness.say(taskId, line);
      const state = await harness.inspect(taskId);
      for (const { run, steps } of state.runs.filter((r) => turn.runIds.includes(r.run.runId))) {
        for (const s of steps) {
          if (s.decision?.type === 'respond') print(`agent> ${s.decision.content}`);
          else print(`  · ${s.decision?.type ?? s.outcome}${s.decision && 'capabilityId' in s.decision ? ` ${s.decision.capabilityId}` : ''} → ${s.outcome}${s.error ? ` (${s.error.code})` : ''}`);
        }
        print(`  (run ${run.sequence}: ${run.status}${run.termination ? ` / ${run.termination.reason}` : ''})`);
      }
      print(`  [task ${state.task.status}]`);
    }
  } finally {
    rl.close();
    await harness.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`sales:e2e failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
