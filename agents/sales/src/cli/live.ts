import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configuredModelProvider } from '../model.js';
import { adminDatabaseUrl, createScenarioDatabase } from '../harness/database.js';
import { runScenario } from '../harness/runner.js';
import { ALL_SCENARIOS, scenarioById, type SalesScenario } from '../harness/scenarios.js';
import { loadLocalEnv, option, print, printReport } from './common.js';

/** Telemetry kept in live artifacts: metadata-only events (the platform never logs content). */
const KEPT_EVENTS = /^(model\.call\.|context\.compile\.completed$|agent\.decision$|action\.|policy\.evaluated$|run\.|task\.wait\.|goal\.)/;

/**
 * `npm run sales:live` — live behavioral harness (never part of CI). Runs the
 * representative scenarios against the configured real ModelProvider, each
 * in its own throwaway database, and writes one JSON artifact per scenario
 * plus a summary under `artifacts/sales-live/<timestamp>/` (git-ignored).
 * Invariant results are reported for manual review; a model behaving
 * differently never fails this command — only infrastructure errors do.
 *
 *   --scenario <ID[,ID…]>   run these instead of the representative subset
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const model = configuredModelProvider(process.env);
  if (!model) {
    print('live provider smoke not executed: credentials unavailable (set R4_MODEL_PROVIDER=openai_compatible and R4_MODEL_*; see .env.example)');
    return;
  }
  const selected: SalesScenario[] = option('scenario')?.split(',').map((id) => scenarioById(id.trim())) ?? ALL_SCENARIOS.filter((s) => s.live);
  const outDir = resolve(process.env.R4_SALES_ARTIFACTS_DIR ?? 'artifacts/sales-live', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });
  print(`model: ${JSON.stringify(model.description)}`);
  print(`artifacts: ${outDir}`);
  const summary: Record<string, unknown>[] = [];
  for (const scenario of selected) {
    const db = await createScenarioDatabase(adminDatabaseUrl(process.env), 'r4_sales_live');
    try {
      const run = await runScenario(scenario, { databaseUrl: db.url, mode: 'live', modelProvider: model.provider, modelDescription: model.description });
      const artifact = {
        report: run.report,
        invariants: run.invariants.map((r) => ({ ...r.invariant, passed: r.passed, detail: r.detail })),
        telemetry: run.telemetry.filter((e) => typeof e.event === 'string' && KEPT_EVENTS.test(e.event)),
        elapsedMs: run.elapsedMs,
      };
      const serialized = JSON.stringify(artifact, null, 2);
      // Defense in depth: an artifact must never carry the credential.
      const key = process.env.R4_MODEL_API_KEY;
      if (key && serialized.includes(key)) throw new Error(`refusing to write ${scenario.id}: the artifact contains the API key`);
      writeFileSync(join(outDir, `${scenario.id}.json`), serialized);
      printReport(run.report, run.invariants);
      summary.push({ scenario: scenario.id, taskStatus: run.report.finalTaskStatus, invariantsPassed: run.invariants.filter((r) => r.passed).length, invariantsTotal: run.invariants.length, tokens: run.report.tokens, elapsedMs: run.elapsedMs });
    } finally {
      await db.drop();
    }
  }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ model: model.description, scenarios: summary }, null, 2));
  print(`\nsummary: ${JSON.stringify(summary)}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`sales:live failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
