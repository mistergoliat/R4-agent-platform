import {
  EMPTY_RUN_USAGE,
  agentDefinitionSchema,
  uuidv7,
  type AgentDefinition,
  type AgentRun,
  type AgentTask,
  type CompiledContext,
  type Goal,
  type JsonValue,
  type Observation,
  type ProposeActionDecision,
  type ReadCapabilityDecision,
  type RunStep,
  type TaskWait,
  type TemporalDecision,
} from '@r4/contracts';
import {
  KernelInterrupt,
  buildExecutionState,
  type ActionOutcome,
  type CapabilityDescriptor,
  type KernelTermination,
  type ExecutionContext,
  type ExecutionPolicy,
  type ExecutionState,
  type KernelSession,
  type PreparedContext,
  type PriorInteractions,
  type RunEnding,
  type StepRecord,
} from '@r4/agent-kernel';
import { ContextCompiler, platformContextSources, type ContextSource } from '@r4/context-compiler';
import { createSilentLogger } from '@r4/observability';
import { DEFAULT_CONTEXT_POLICY, contextCompileRequest } from '@r4/worker';

export const TEST_POLICY: ExecutionPolicy = {
  maxIterations: 20,
  maxModelCalls: 20,
  maxReadCapabilityCalls: 20,
  maxRunDurationMs: 60_000,
  modelCallTimeoutMs: 5_000,
  // R4-D: like an empty worker environment, no writes unless a test opts in.
  maxWriteActions: 0,
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
  /**
   * R4-D: what the platform does with a proposed action (default: a
   * receipt-backed success). `suspend` simulates a run the platform ended.
   */
  readonly action?: (decision: ProposeActionDecision) =>
    | { outcome: Observation['outcome']; payload?: JsonValue | null; errorCode?: string }
    | { suspend: KernelTermination };
  /** Clock for elapsed-time budgets. */
  readonly now?: () => Date;
  /** R4-C2: the compiler used by prepareContext (default: platform sources, default policy). */
  readonly compiler?: ContextCompiler;
  /** Extra context sources appended to the platform ones (ignored when `compiler` is given). */
  readonly contextSources?: readonly ContextSource[];
  /**
   * R4-E stand-in: offer `executeTemporal` (a wait/consultation/handoff records its step and suspends
   * the run, as the Temporal Runtime does). Absent ⇒ the session has no temporal runtime.
   */
  readonly temporal?: boolean;
  /** ADR-031: earlier runs' interaction records (see `MemorySession.continueFrom`). */
  readonly priorInteractions?: PriorInteractions;
  /** The run of this session (default: a first run of the task). */
  readonly run?: AgentRun;
}

/** A snapshot as the in-memory session keeps it (the durable one lives in PostgreSQL). */
export interface MemorySnapshot {
  readonly snapshotId: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly inputFingerprint: string;
  readonly contentHash: string;
  readonly context: CompiledContext;
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
  readonly actions: ProposeActionDecision[] = [];
  ending: RunEnding | null = null;
  /** Failure injection: throw from the named method on its next call. */
  readonly failNext: Partial<Record<'load' | 'prepareContext' | 'recordStep' | 'executeRead' | 'executeAction' | 'executeTemporal' | 'finish', Error>> = {};
  readonly snapshots: MemorySnapshot[] = [];
  readonly compiler: ContextCompiler;
  readonly #options: MemorySessionOptions;

  constructor(options: MemorySessionOptions = {}) {
    this.#options = options;
    this.compiler =
      options.compiler ?? new ContextCompiler({ sources: [...platformContextSources(), ...(options.contextSources ?? [])], policy: DEFAULT_CONTEXT_POLICY, logger: createSilentLogger() });
    this.agent = options.agent ?? agentFixture();
    this.task = options.task ?? taskFixture();
    this.run = options.run ?? runFixture(this.task);
    if (options.temporal) this.executeTemporal = (record, decision) => this.#temporal(record, decision);
  }

  /** Offered only with `temporal: true`. */
  declare executeTemporal?: NonNullable<KernelSession['executeTemporal']>;
  /** Waits this session opened (the durable TaskWait stand-in). */
  readonly waits: TemporalDecision[] = [];

  /**
   * The next run of the same task after this one was suspended on a wait that ended with `resolution`
   * (a durable wake): same task and observations, a new run, and the task's cross-run interaction
   * records — exactly what a worker loads after a restart. Nothing else survives.
   */
  static continueFrom(previous: MemorySession, resolution: TaskWait['resolution'], options: MemorySessionOptions = {}): MemorySession {
    const priorSteps = [...(previous.#options.priorInteractions?.steps ?? []), ...previous.steps.filter((s) => s.decision?.type === 'respond' || s.decision?.type === 'wait')];
    const priorWaits = [...(previous.#options.priorInteractions?.waits ?? []), waitRecord(previous, resolution)];
    const next = new MemorySession({
      ...previous.#options,
      ...options,
      agent: previous.agent,
      task: previous.task,
      run: runFixture(previous.task, { runId: uuidv7(), sequence: previous.run.sequence + 1 }),
      priorInteractions: { steps: priorSteps, waits: priorWaits },
    });
    next.observations.push(...previous.observations);
    return next;
  }

  #temporal(record: StepRecord, decision: TemporalDecision): Promise<{ kind: 'continued' } | { kind: 'suspended'; termination: KernelTermination }> {
    this.#inject('executeTemporal');
    if (record.contextSnapshotId && !this.snapshots.some((s) => s.snapshotId === record.contextSnapshotId && s.iteration === record.iteration)) {
      return Promise.reject(new Error('referenced record does not exist (agent_run_steps_context_snapshot_fk)'));
    }
    this.steps.push(this.#toStep(record));
    if (decision.type === 'manage_goal') return Promise.resolve({ kind: 'continued' });
    this.waits.push(decision);
    const termination: KernelTermination = { reason: 'waiting', code: 'waiting', message: 'task suspended by a structured decision', details: null };
    this.ending = { termination, result: null, finalStep: null };
    return Promise.resolve({ kind: 'suspended', termination });
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
        writeActions: this.actions.length,
        ...(this.#options.priorInteractions ? { priorInteractions: this.#options.priorInteractions } : {}),
      }),
    );
  }

  /** Same semantics as the durable session: compile, then reuse the iteration's snapshot if its inputs are unchanged. */
  async prepareContext(context: ExecutionContext): Promise<PreparedContext> {
    this.#inject('prepareContext');
    const outcome = await this.compiler.compile(contextCompileRequest(context, this.steps, this.#options.now?.() ?? new Date(this.run.startedAt)));
    if (outcome.kind === 'budget_exhausted') return { kind: 'budget_exhausted', limit: outcome.maxEstimatedTokens, required: outcome.requiredTokens };
    const latest = this.snapshots.filter((x) => x.iteration === context.iteration).at(-1);
    if (latest && latest.inputFingerprint === outcome.inputFingerprint) return { kind: 'ready', snapshotId: latest.snapshotId, context: latest.context, reused: true };
    const snapshot: MemorySnapshot = {
      snapshotId: uuidv7(),
      iteration: context.iteration,
      attempt: (latest?.attempt ?? 0) + 1,
      inputFingerprint: outcome.inputFingerprint,
      contentHash: outcome.contentHash,
      context: outcome.compiled,
    };
    this.snapshots.push(snapshot);
    return { kind: 'ready', snapshotId: snapshot.snapshotId, context: snapshot.context, reused: false };
  }

  recordStep(record: StepRecord): Promise<RunStep> {
    this.#inject('recordStep');
    // Mirrors agent_run_steps_context_snapshot_fk: a step references only a snapshot of its own iteration.
    if (record.contextSnapshotId && !this.snapshots.some((s) => s.snapshotId === record.contextSnapshotId && s.iteration === record.iteration)) {
      return Promise.reject(new Error('referenced record does not exist (agent_run_steps_context_snapshot_fk)'));
    }
    const step = this.#toStep(record);
    this.steps.push(step);
    return Promise.resolve(step);
  }

  async executeRead(step: RunStep, decision: ReadCapabilityDecision): Promise<Observation> {
    this.#inject('executeRead');
    const existing = this.observations.find((o) => o.source.kind === 'capability' && o.source.invocationId === step.invocationId);
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

  /** In-memory stand-in for the governed path: NOT a runtime implementation (no policy, no ledger). */
  executeAction(step: RunStep, decision: ProposeActionDecision): Promise<ActionOutcome> {
    this.#inject('executeAction');
    const existing = this.observations.find((o) => o.source.kind === 'action' && o.source.proposalId === step.proposalId);
    if (existing) return Promise.resolve({ kind: 'observed', observation: existing });
    this.actions.push(decision);
    const produced = this.#options.action?.(decision) ?? { outcome: 'succeeded' as const, payload: { applied: true } };
    if ('suspend' in produced) {
      this.ending = { termination: produced.suspend, result: null, finalStep: null };
      return Promise.resolve({ kind: 'suspended', termination: produced.suspend });
    }
    const receiptId = produced.outcome === 'succeeded' ? uuidv7() : null;
    const observation: Observation = {
      observationId: uuidv7(),
      taskId: this.task.taskId,
      runId: this.run.runId,
      agentId: this.agent.agentId,
      source: { kind: 'action', capabilityId: decision.capabilityId, capabilityVersion: 1, proposalId: step.proposalId!, policyDecisionId: uuidv7(), executionId: receiptId ? uuidv7() : null, receiptId },
      outcome: produced.outcome,
      payload: produced.outcome === 'succeeded' ? (produced.payload ?? null) : null,
      error: produced.outcome === 'succeeded' ? null : { code: (produced.errorCode ?? 'policy_denied') as 'policy_denied', message: 'not executed', details: null },
      observedAt: T0,
      validUntil: null,
      provenance: {},
      correlationId: this.task.correlationId,
    };
    this.observations.push(observation);
    const index = this.steps.findIndex((s) => s.stepId === step.stepId);
    this.steps[index] = { ...step, outcome: 'observed', observationId: observation.observationId, completedAt: T0 };
    return Promise.resolve({ kind: 'observed', observation });
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
      contextSnapshotId: record.contextSnapshotId ?? null,
      proposalId: record.decision?.type === 'propose_action' && record.outcome === 'pending' ? uuidv7() : null,
      origin: record.origin ?? 'model',
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

/** The durable TaskWait a suspended in-memory run opened, as it ended. */
function waitRecord(session: MemorySession, resolution: TaskWait['resolution']): TaskWait {
  const decision = session.waits.at(-1);
  const until = decision?.type === 'wait' && decision.condition.kind === 'WAIT_UNTIL' ? decision.condition.until : null;
  return {
    waitId: uuidv7(),
    taskId: session.task.taskId,
    runId: session.run.runId,
    kind: decision?.type === 'wait' ? decision.condition.kind : 'WAIT_FOR_HUMAN',
    status: resolution === 'cancelled' ? 'cancelled' : 'completed',
    resolution,
    referenceId: null,
    dueAt: until,
    createdAt: T0,
    completedAt: T0,
    correlationId: session.task.correlationId,
  };
}
