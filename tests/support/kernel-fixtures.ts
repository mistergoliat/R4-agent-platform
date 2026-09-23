import {
  EMPTY_RUN_USAGE,
  agentDefinitionSchema,
  uuidv7,
  type AgentDefinition,
  type AgentRun,
  type AgentTask,
  type Goal,
  type JsonValue,
  type Observation,
  type ReadCapabilityDecision,
  type RunStep,
} from '@r4/contracts';
import {
  KernelInterrupt,
  buildExecutionState,
  type CapabilityDescriptor,
  type ExecutionPolicy,
  type ExecutionState,
  type KernelSession,
  type RunEnding,
  type StepRecord,
} from '@r4/agent-kernel';

export const TEST_POLICY: ExecutionPolicy = {
  maxIterations: 20,
  maxModelCalls: 20,
  maxReadCapabilityCalls: 20,
  maxRunDurationMs: 60_000,
  modelCallTimeoutMs: 5_000,
};

const T0 = '2026-01-01T00:00:00.000Z';

export function agentFixture(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return agentDefinitionSchema.parse({
    schemaVersion: 1,
    agentId: 'kernel-probe',
    version: 1,
    displayName: 'Kernel probe',
    description: 'Unit-test agent',
    instructions: 'Use observations only.',
    taskTypes: ['probe.fact_lookup'],
    capabilityScopes: ['platform_test.read'],
    modelRequirements: { reasoningLevel: 'low', latencySensitivity: 'low', costSensitivity: 'low', structuredOutput: true, toolUse: false },
    budgets: {},
    ...overrides,
  });
}

export function taskFixture(overrides: Partial<AgentTask> = {}): AgentTask {
  const taskId = uuidv7(Date.parse(T0));
  const goalId = uuidv7(Date.parse(T0));
  return {
    taskId,
    taskType: 'probe.fact_lookup',
    agentId: 'kernel-probe',
    agentVersion: 1,
    status: 'running',
    statusReason: 'run_started',
    parentTaskId: null,
    rootGoalId: goalId,
    currentGoalId: goalId,
    requestedBy: { kind: 'service', ref: 'unit' },
    input: { factKey: 'platform.name' },
    constraints: {},
    budget: {},
    result: null,
    deadlineAt: null,
    idempotencyKey: null,
    correlationId: 'unit-corr',
    version: 2,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function runFixture(task: AgentTask, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: uuidv7(Date.parse(T0)),
    taskId: task.taskId,
    sequence: 1,
    agentId: task.agentId,
    agentVersion: task.agentVersion,
    status: 'running',
    contextSnapshotRef: null,
    usage: { ...EMPTY_RUN_USAGE },
    result: null,
    failure: null,
    termination: null,
    recoveries: 0,
    correlationId: task.correlationId,
    version: 1,
    startedAt: T0,
    finishedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function goalFixture(task: AgentTask): Goal {
  return {
    goalId: task.rootGoalId,
    taskId: task.taskId,
    parentGoalId: null,
    description: 'Retrieve the test fact and complete',
    successCriteria: ['result cites an observation'],
    status: 'active',
    origin: 'requester',
    correlationId: task.correlationId,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  };
}

export const READ_FACT: CapabilityDescriptor = {
  capabilityId: 'platform_test.get_test_fact',
  version: 1,
  description: 'Returns a synthetic test fact',
  riskClass: 'READ',
  inputSchema: { type: 'object' },
};

export const WRITE_THING: CapabilityDescriptor = {
  capabilityId: 'platform_test.write_thing',
  version: 1,
  description: 'Synthetic reversible write',
  riskClass: 'REVERSIBLE_WRITE',
  inputSchema: { type: 'object' },
};

export interface MemorySessionOptions {
  readonly agent?: AgentDefinition;
  readonly task?: AgentTask;
  readonly capabilities?: readonly CapabilityDescriptor[];
  readonly policy?: Partial<ExecutionPolicy>;
  /** Produces the observation outcome for a READ; default echoes the arguments. */
  readonly read?: (decision: ReadCapabilityDecision) => { outcome: Observation['outcome']; payload: JsonValue | null; errorCode?: string } | Promise<{ outcome: Observation['outcome']; payload: JsonValue | null; errorCode?: string }>;
  /** Clock for elapsed-time budgets. */
  readonly now?: () => Date;
}

/**
 * In-memory KernelSession for unit tests: state lives in arrays and is
 * rebuilt into an ExecutionState on every load(), mimicking the durable one.
 * NOT a runtime implementation.
 */
export class MemorySession implements KernelSession {
  readonly agent: AgentDefinition;
  readonly task: AgentTask;
  readonly run: AgentRun;
  readonly steps: RunStep[] = [];
  readonly observations: Observation[] = [];
  readonly reads: ReadCapabilityDecision[] = [];
  ending: RunEnding | null = null;
  /** Failure injection: throw from the named method on its next call. */
  readonly failNext: Partial<Record<'load' | 'recordStep' | 'executeRead' | 'finish', Error>> = {};
  readonly #options: MemorySessionOptions;

  constructor(options: MemorySessionOptions = {}) {
    this.#options = options;
    this.agent = options.agent ?? agentFixture();
    this.task = options.task ?? taskFixture();
    this.run = runFixture(this.task);
  }

  load(): Promise<ExecutionState> {
    this.#inject('load');
    if (this.ending) throw new KernelInterrupt('task_not_runnable');
    return Promise.resolve(
      buildExecutionState({
        agent: this.agent,
        task: this.task,
        run: this.run,
        goal: goalFixture(this.task),
        steps: this.steps,
        observations: this.observations,
        capabilities: this.#options.capabilities ?? [READ_FACT, WRITE_THING],
        policy: { ...TEST_POLICY, ...this.#options.policy },
        now: this.#options.now?.() ?? new Date(this.run.startedAt),
      }),
    );
  }

  recordStep(record: StepRecord): Promise<RunStep> {
    this.#inject('recordStep');
    const step = this.#toStep(record);
    this.steps.push(step);
    return Promise.resolve(step);
  }

  async executeRead(step: RunStep, decision: ReadCapabilityDecision): Promise<Observation> {
    this.#inject('executeRead');
    const existing = this.observations.find((o) => o.source.invocationId === step.invocationId);
    if (existing) return existing;
    this.reads.push(decision);
    const produced = this.#options.read ? await this.#options.read(decision) : { outcome: 'succeeded' as const, payload: decision.arguments };
    const observation: Observation = {
      observationId: uuidv7(),
      taskId: this.task.taskId,
      runId: this.run.runId,
      agentId: this.agent.agentId,
      source: { kind: 'capability', capabilityId: decision.capabilityId, capabilityVersion: 1, invocationId: step.invocationId! },
      outcome: produced.outcome,
      payload: produced.outcome === 'succeeded' ? produced.payload : null,
      error: produced.outcome === 'succeeded' ? null : { code: (produced.errorCode ?? 'handler_error') as 'handler_error', message: 'failed', details: null },
      observedAt: T0,
      validUntil: null,
      provenance: {},
      correlationId: this.task.correlationId,
    };
    this.observations.push(observation);
    const index = this.steps.findIndex((s) => s.stepId === step.stepId);
    this.steps[index] = { ...step, outcome: 'observed', observationId: observation.observationId, completedAt: T0 };
    return observation;
  }

  finish(ending: RunEnding): Promise<void> {
    this.#inject('finish');
    if (ending.finalStep) this.steps.push(this.#toStep(ending.finalStep));
    this.ending = ending;
    return Promise.resolve();
  }

  #toStep(record: StepRecord): RunStep {
    const executesRead = record.decision?.type === 'read_capability' && record.outcome === 'pending';
    return {
      stepId: uuidv7(),
      runId: record.runId,
      taskId: this.task.taskId,
      iteration: record.iteration,
      leaseGeneration: 1,
      decision: record.decision,
      outcome: record.outcome,
      error: record.error,
      invocationId: executesRead ? uuidv7() : null,
      observationId: null,
      usage: record.usage,
      correlationId: this.task.correlationId,
      createdAt: T0,
      completedAt: record.outcome === 'pending' ? null : T0,
    };
  }

  #inject(method: keyof MemorySession['failNext']): void {
    const error = this.failNext[method];
    if (error) {
      delete this.failNext[method];
      throw error;
    }
  }
}
