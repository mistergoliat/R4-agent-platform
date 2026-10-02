import { fingerprint, type BenchmarkScenario, type EvaluationSubject, type ModelCallRecord, type ModelProfile, type TrajectoryProducer } from '@r4/evaluation';
import { PostgresTrajectoryReader } from '@r4/evaluator';
import { createLogger } from '@r4/observability';
import { createPool } from '@r4/persistence-postgres';
import type { ModelProvider } from '@r4/model-gateway';
import { createScenarioDatabase } from '../harness/database.js';
import { RecordingModelProvider, type RecordedModelCall } from '../harness/recording.js';
import { runScenario } from '../harness/runner.js';
import { scenarioById, type SalesScenario } from '../harness/scenarios.js';
import { PostgresSalesStore } from '../workspace/store.js';
import { REFERENCE_FIXTURES, fixtureJudge, type FixtureJudgeScript } from './fixtures/trajectories.js';
import { salesWorkspaceProjection } from './projection.js';

/**
 * Sales benchmark corpus (R4-G). It reuses the R4-F scenarios (no copy):
 * the benchmark set is the representative subset S02, S03, S04, S11 and
 * CENTRAL, each identified by a content version of its definition. How a
 * trajectory is produced is a producer's choice:
 *
 *   fixture  — offline, deterministic: representative trajectories of the
 *              live-gate phenomena (see fixtures/trajectories.ts);
 *   scripted — the scenario's scripted trajectory through the real harness
 *              on a throwaway PostgreSQL database (CI stand-in model);
 *   live     — the configured real ModelProvider through the same harness.
 *
 * Every producer ends in an EvaluationSubject; scripted and live ones are
 * rebuilt from durable state by the canonical trajectory reader.
 */
export const REFERENCE_SCENARIO_IDS = ['S02', 'S03', 'S04', 'S11', 'CENTRAL'] as const;

/** Content version of a scenario: its turns and invariants (what the customer says and what must hold). */
export function scenarioVersion(scenario: SalesScenario): string {
  const turns = scenario.turns.map((t) => ('customer' in t ? { customer: t.customer } : 'operator' in t ? { operator: t.operator } : { control: t.control }));
  return fingerprint({ id: scenario.id, turns, invariants: scenario.invariants }).slice(0, 16);
}

export function referenceScenarioSet(ids: readonly string[] = REFERENCE_SCENARIO_IDS): { id: string; version: string; scenarios: BenchmarkScenario[] } {
  const scenarios = ids.map((id) => {
    const s = scenarioById(id);
    return { id: s.id, version: scenarioVersion(s) };
  });
  return { id: 'sales.reference-corpus', version: fingerprint(scenarios).slice(0, 16), scenarios };
}

export type FixtureTrajectorySet = 'live-gate-representative' | 'candidate-grounded';

/**
 * Offline producer over fixture trajectories. `live-gate-representative`
 * reproduces what the live gate showed, including non-determinism across
 * attempts: S11's first attempt failed on trailing text after the JSON
 * decision and its second succeeded, so repetition 1 of S11 is the failure.
 * `candidate-grounded` is the same corpus where a hypothetical candidate no
 * longer makes the unsupported claims (S03 compatibility, CENTRAL cardio) —
 * everything else identical, for a controlled experiment.
 */
export class FixtureTrajectoryProducer implements TrajectoryProducer {
  readonly mode = 'fixture';
  readonly set: FixtureTrajectorySet;
  readonly #entries = new Map<string, { subject: EvaluationSubject; judge: FixtureJudgeScript }>();
  readonly judge;

  constructor(set: FixtureTrajectorySet = 'live-gate-representative') {
    this.set = set;
    this.judge = fixtureJudge(this.#entries);
  }

  static modelProfile(): ModelProfile {
    return { role: 'under_test', provider: 'fixture', profile: null, host: null, model: 'fixture-trajectory', maxOutputTokens: null, contextWindowTokens: null, temperature: null, responseFormat: null, extras: {} };
  }

  produce(scenario: BenchmarkScenario, repetition: number): Promise<{ subject: EvaluationSubject }> {
    const id = `${this.set}-${scenario.id.toLowerCase()}-r${repetition}`;
    const grounded = this.set === 'candidate-grounded';
    const built = (() => {
      switch (scenario.id) {
        case 'S02':
          return REFERENCE_FIXTURES.S02(id);
        case 'S03':
          return REFERENCE_FIXTURES.S03(id, grounded);
        case 'S04':
          return REFERENCE_FIXTURES.S04(id);
        case 'S11':
          return repetition === 1 ? REFERENCE_FIXTURES.S11_TRAILING_PROSE(id) : REFERENCE_FIXTURES.S11(id);
        case 'CENTRAL':
          return REFERENCE_FIXTURES.CENTRAL(id, grounded);
        default:
          throw new Error(`no fixture trajectory for scenario ${scenario.id}`);
      }
    })();
    this.#entries.set(built.subject.subjectId, built);
    return Promise.resolve({ subject: built.subject });
  }
}

/**
 * Harness producer: runs the scenario on a throwaway database (Core + Sales
 * migrations), then rebuilds the trajectory from durable state with the
 * canonical reader — the same path any finished task takes. `live` records
 * per-call metadata (never output text) around the provider.
 */
export class HarnessTrajectoryProducer implements TrajectoryProducer {
  readonly mode: 'scripted' | 'live';
  readonly #adminUrl: string;
  readonly #provider: ModelProvider | null;
  readonly #description: Record<string, unknown> | undefined;

  constructor(options: { adminDatabaseUrl: string; mode: 'scripted' | 'live'; modelProvider?: ModelProvider; modelDescription?: Record<string, unknown> }) {
    if (options.mode === 'live' && !options.modelProvider) throw new Error('live mode needs a configured model provider');
    this.mode = options.mode;
    this.#adminUrl = options.adminDatabaseUrl;
    this.#provider = options.modelProvider ?? null;
    this.#description = options.modelDescription;
  }

  async produce(scenario: BenchmarkScenario): Promise<{ subject: EvaluationSubject }> {
    const db = await createScenarioDatabase(this.#adminUrl, `r4_eval_${this.mode}`);
    try {
      const recorder = this.#provider ? new RecordingModelProvider(this.#provider) : null;
      const run = await runScenario(scenarioById(scenario.id), { databaseUrl: db.url, mode: this.mode, ...(recorder ? { modelProvider: recorder } : {}), ...(this.#description ? { modelDescription: this.#description } : {}) });
      const pool = createPool({ connectionString: db.url, logger: createLogger({ service: 'sales-evaluation', level: 'silent' }), applicationName: 'sales-evaluation', max: 2 });
      try {
        const reader = new PostgresTrajectoryReader(pool, { projections: [salesWorkspaceProjection(new PostgresSalesStore(pool))] });
        const subject = await reader.subject(run.report.taskId, { sourceRef: `${this.mode}:${scenario.id}`, modelCalls: recorder ? recorder.calls.map(toModelCallRecord) : null });
        return { subject };
      } finally {
        await pool.end();
      }
    } finally {
      await db.drop();
    }
  }
}

/** Harness recording → the metadata-only record Quality keeps (the decision document itself is dropped). */
export function toModelCallRecord(c: RecordedModelCall): ModelCallRecord {
  return { index: c.index, runId: c.runId, finishReason: c.finishReason, inputTokens: c.inputTokens, outputTokens: c.outputTokens, reasoningTokens: null, latencyMs: c.latencyMs, unparsedShape: c.unparsedShape ? { ...c.unparsedShape, jsonDocuments: [...c.unparsedShape.jsonDocuments] } : null, error: c.error ? c.error.slice(0, 500) : null };
}

/** The model under test as a profile: configuration identity only, never the key. */
export function modelProfileFromDescription(description: { profile: string; host: string; model: string; contextWindowTokens: number; maxOutputTokens: number | null; responseFormat: string; temperature: number | null; extraBody: Readonly<Record<string, unknown>> }, role: ModelProfile['role'] = 'under_test'): ModelProfile {
  return { role, provider: 'openai_compatible', profile: description.profile, host: description.host, model: description.model, maxOutputTokens: description.maxOutputTokens, contextWindowTokens: description.contextWindowTokens, temperature: description.temperature, responseFormat: description.responseFormat, extras: structuredClone(description.extraBody) as ModelProfile['extras'] };
}

export const SCRIPTED_MODEL_PROFILE: ModelProfile = { role: 'under_test', provider: 'scripted', profile: null, host: null, model: 'scripted-trajectory', maxOutputTokens: null, contextWindowTokens: null, temperature: null, responseFormat: null, extras: {} };
