import { FakeModelProvider, type ModelProvider } from '@r4/model-gateway';
import { evaluateInvariants, type InvariantResult } from './invariants.js';
import { buildReport, type ScenarioReport } from './report.js';
import { SalesHarness, type ConversationState } from './runtime.js';
import type { SalesScenario } from './scenarios.js';
import { scriptedAgent } from './scripted.js';

export interface ScenarioRun {
  readonly report: ScenarioReport;
  readonly invariants: readonly InvariantResult[];
  readonly passed: boolean;
  readonly state: ConversationState;
  /** Metadata-only telemetry of the run (live mode). */
  readonly telemetry: readonly Record<string, unknown>[];
  readonly elapsedMs: number;
}

export interface RunScenarioOptions {
  readonly databaseUrl: string;
  /** `scripted`: the scenario's own trajectory drives a FakeModelProvider. `live`: the configured real provider decides. */
  readonly mode: 'scripted' | 'live';
  readonly modelProvider?: ModelProvider;
  readonly modelDescription?: Record<string, unknown>;
  /** Live mode: model calls may take seconds. */
  readonly modelCallTimeoutMs?: number;
}

/**
 * Runs one scenario end to end on a migrated database (Core + Sales
 * migrations) and returns its structured report and invariant results. In
 * live mode the customer turns are sent as-is and the scripted trajectory is
 * ignored: whatever the model decides is recorded, nothing is corrected.
 */
export async function runScenario(scenario: SalesScenario, options: RunScenarioOptions): Promise<ScenarioRun> {
  const started = Date.now();
  const provider = options.mode === 'scripted' ? new FakeModelProvider(scriptedAgent(scenario.turns.flatMap((t) => ('agent' in t ? t.agent : [])))) : options.modelProvider;
  if (!provider) throw new Error('live mode needs a configured model provider');
  const harness = await SalesHarness.start({
    databaseUrl: options.databaseUrl,
    modelProvider: provider,
    captureTelemetry: true,
    ...(scenario.harness ?? {}),
    execution: { modelCallTimeoutMs: options.modelCallTimeoutMs ?? (options.mode === 'live' ? 180_000 : 10_000) },
  });
  try {
    const taskId = await harness.openConversation({ customerRef: scenario.customerRef ?? null, correlationId: `scenario-${scenario.id.toLowerCase()}` });
    for (const turn of scenario.turns) {
      if ('control' in turn) await turn.run(harness, taskId);
      else if ('operator' in turn) await harness.answerConsultation(taskId, turn.operator);
      else if (turn.workerDiesWhen && options.mode === 'scripted') await harness.sayThroughWorkerDeath(taskId, turn.customer, () => turn.workerDiesWhen!(harness));
      else await harness.say(taskId, turn.customer);
    }
    const state = await harness.inspect(taskId);
    const invariants = evaluateInvariants(scenario.invariants, state);
    return {
      report: buildReport({ id: scenario.id, title: scenario.title, mode: options.mode, model: options.modelDescription ?? (options.mode === 'scripted' ? { provider: 'fake', note: 'scripted stand-in (CI only)' } : null), state }),
      invariants,
      passed: invariants.every((i) => i.passed),
      state,
      telemetry: [...harness.telemetry],
      elapsedMs: Date.now() - started,
    };
  } finally {
    await harness.close();
  }
}
