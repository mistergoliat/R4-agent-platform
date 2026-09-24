import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@r4/contracts';
import { FindingTaxonomy, evaluationArtifacts, genericDeterministicEvaluators, parseEvaluationSubject, runEvaluation, type EvaluationDefinition } from '@r4/evaluation';
import { PostgresTrajectoryReader } from '@r4/evaluator';
import type { Platform } from '@r4/api';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { completeFromObservations, contextOf, read, respond, sequence } from '../support/decisions.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { startTestWorker, testCapabilities, type TestWorker } from '../support/worker.js';

/**
 * R4-G: the canonical trajectory is rebuilt from durable R4 state only, with
 * no Agent Pack involved (the reader and the framework are domain-neutral),
 * and reading it changes nothing.
 */
const actor: Principal = { kind: 'service', ref: 'evaluation-it' };
const definition: EvaluationDefinition = { id: 'test.generic', version: 1, taxonomy: FindingTaxonomy.generic(), evaluators: genericDeterministicEvaluators(), privacy: { redactKeys: [] }, semanticTimeoutMs: 1000 };
let db: TestDatabase;
let platform: Platform;
const workers: TestWorker[] = [];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
});

afterEach(async () => {
  for (const w of workers.splice(0)) await w.platform.close();
  await platform?.close();
  await db?.drop();
});

async function runTask(script: Parameters<typeof startTestWorker>[1]['script']): Promise<string> {
  const { view } = await platform.tasks.createTask({ request: validTaskBody({ taskType: 'probe.fact_lookup', goal: { description: 'Retrieve test fact and complete task' }, input: { factKey: 'platform.name' } }), requestedBy: actor, correlationId: 'evaluation-it' });
  const w = await startTestWorker(db.url, { workerId: `evaluation-worker-${workers.length + 1}`, script, capabilities: testCapabilities(({ factKey }) => Promise.resolve({ factKey, found: true, value: 'R4' })) });
  workers.push(w);
  await w.platform.worker.runOnce();
  return view.task.taskId;
}

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ['agent_tasks', 'agent_runs', 'agent_run_steps', 'observations', 'context_snapshots', 'goals', 'memory_entries', 'temporal_events', 'task_waits']) {
    out[table] = Number((await platform.pool.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n);
  }
  out.taskVersions = Number((await platform.pool.query<{ n: string }>('select coalesce(sum(version), 0) as n from agent_tasks')).rows[0]!.n);
  return out;
}

describe('canonical trajectory from durable state', () => {
  it('builds an EvaluationSubject from a finished task and evaluates it deterministically', async () => {
    const taskId = await runTask(sequence([(req) => read(GET_TEST_FACT_ID, { factKey: String(contextOf(req).task.input.factKey) }), respond('The fact is R4.'), completeFromObservations('The platform name is R4')]));
    const before = await tableCounts();
    const subject = await new PostgresTrajectoryReader(platform.pool).subject(taskId);
    expect(await tableCounts()).toEqual(before);

    expect(parseEvaluationSubject(subject)).toEqual(subject);
    expect(subject.source).toEqual({ kind: 'durable', ref: `task:${taskId}` });
    expect(subject.task).toMatchObject({ taskId, status: 'completed' });
    expect(subject.agent.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(subject.runs).toHaveLength(1);
    expect(subject.runs[0]!.steps.map((s) => s.decision?.type)).toEqual(['read_capability', 'respond', 'complete']);
    expect(subject.runs[0]!.contexts.length).toBeGreaterThanOrEqual(3);
    expect(subject.responses).toHaveLength(1);
    // The response could see the observation produced before it.
    expect(subject.responses[0]!.evidenceInContext).toEqual([subject.observations[0]!.observationId]);
    expect(subject.goals.find((g) => g.goalId === subject.task.rootGoalId)).toBeDefined();
    expect(subject.modelCalls).toBeNull();
    expect(JSON.stringify(subject)).not.toMatch(/"reasoning|chain_of_thought/i);

    const run = await runEvaluation(subject, definition, { reproducibility: { gitSha: 'unknown', protocolVersion: 'test', modelUnderTest: null } });
    expect(run.status).toBe('completed');
    expect(run.subject.source.kind).toBe('durable');
    expect(run.result.findings).toEqual([]);
    expect(run.result.outcome.technical).toMatchObject({ status: 'completed', valid: true });
    expect(run.result.metrics['r4.protocol_adherence.protocolAdherence']).toMatchObject({ numerator: 3, denominator: 3 });
    expect(run.result.metrics['r4.efficiency.capabilityReads']?.value).toBe(1);
    expect(run.result.metrics['r4.context_composition.contextSnapshots']?.value).toBeGreaterThanOrEqual(3);
    expect(Object.keys(evaluationArtifacts(run, { subject }))).toContain('manifest.json');
  });

  it('measures a protocol failure from the step log without retrying it', async () => {
    const taskId = await runTask([{ type: 'text', content: '{"type":"respond","content":"x"} and then some prose' }]);
    const subject = await new PostgresTrajectoryReader(platform.pool).subject(taskId);
    const run = await runEvaluation(subject, definition, { reproducibility: { gitSha: 'unknown', protocolVersion: 'test', modelUnderTest: null } });
    expect(subject.runs).toHaveLength(1);
    // ADR-028: the run failed; the task is still running (a recovery run is next), measured as such.
    expect(run.result.outcome.technical).toMatchObject({ status: 'in_progress', failedRuns: 1 });
    expect(run.result.findings.map((f) => f.category)).toEqual(['MODEL_PROTOCOL']);
    expect(run.result.metrics['r4.protocol_adherence.protocolAdherence']).toMatchObject({ numerator: 0, denominator: 1 });
  });
});
