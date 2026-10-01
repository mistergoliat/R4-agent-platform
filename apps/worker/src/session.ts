import {
  PlatformError,
  type AgentTask,
  type ContextComposition,
  type Clock,
  type IdGenerator,
  type Observation,
  type ProposeActionDecision,
  type ReadCapabilityDecision,
  type RegisteredAgentDefinition,
  type RunStep,
  type TaskLease,
  type TemporalDecision,
} from '@r4/contracts';
import {
  KernelInterrupt,
  buildExecutionState,
  visibleCapabilities,
  type ActionOutcome,
  type CapabilityDescriptor,
  type ExecutionContext,
  type ExecutionPolicy,
  type ExecutionState,
  type KernelSession,
  type PreparedContext,
  type RunEnding,
  type StepRecord,
} from '@r4/agent-kernel';
import { ActionExecutor, CapabilityInvoker, type CapabilityRegistry, type ObservationStore } from '@r4/capability-runtime';
import { ContextCompiler, platformContextSources, snapshotComposition, type ContextCompileRequest } from '@r4/context-compiler';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { ActionProgress, ActionRuntime, AgentDefinitionResolver, DurableExecution, ExecutionRuntime, TemporalRuntime, TemporalDecisionOutcome } from '@r4/task-runtime';
import { DEFAULT_CONTEXT_POLICY } from './config.js';

export interface DurableSessionOptions {
  readonly lease: TaskLease;
  readonly execution: ExecutionRuntime;
  readonly agents: AgentDefinitionResolver;
  readonly capabilities: CapabilityRegistry;
  /** Unfenced read side of the observation store (idempotency lookups only). */
  readonly observations: Pick<ObservationStore, 'findByInvocationId'>;
  readonly policy: ExecutionPolicy;
  /**
   * R4-C2: builds the model's context. Defaults to the platform sources only
   * (no memory, no compaction) under the default context policy; the worker
   * platform wires memory, compaction and any extra sources.
   */
  readonly context?: ContextCompiler;
  /**
   * R4-D: the governed-execution authority (proposal → policy → command →
   * attempts → receipt). Without it no proposed action can be resolved.
   */
  readonly actions?: ActionRuntime;
  readonly temporal?: TemporalRuntime;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: StructuredLogger;
}

/**
 * KernelSession backed by durable state. Pure glue: every rule lives in the
 * ExecutionRuntime (ownership, run lifecycle), the CapabilityInvoker (scopes,
 * READ-only, schemas), the ActionRuntime + Policy Engine (R4-D: authority
 * over effects, attempt rules), the ActionExecutor (write handler calls,
 * outcome classification) or the kernel (decisions, budgets). Every write carries
 * the lease token, so it is fenced; runtime errors are translated into kernel
 * interruptions where the run must be left untouched.
 */
export class DurableKernelSession implements KernelSession {
  readonly #options: DurableSessionOptions;
  readonly #invoker: CapabilityInvoker;
  readonly #executor: ActionExecutor;
  readonly #compiler: ContextCompiler;
  /** Invocations whose observation this session wrote (fenced) itself. */
  readonly #recorded = new Set<string>();
  #agent: RegisteredAgentDefinition | null = null;
  /** The durable state of the latest load(): what prepareContext compiles from. */
  #loaded: DurableExecution | null = null;

  constructor(options: DurableSessionOptions) {
    this.#options = options;
    this.#compiler = options.context ?? new ContextCompiler({ sources: platformContextSources(), policy: DEFAULT_CONTEXT_POLICY, logger: options.logger });
    const { lease, execution } = options;
    // Observations of this session are written only through the fenced path:
    // a worker that lost its lease cannot record evidence.
    const fenced: ObservationStore = {
      record: async (observation) => {
        const stored = await execution.recordObservation(lease, observation);
        if (stored.source.kind === 'capability') this.#recorded.add(stored.source.invocationId);
        return stored;
      },
      findByInvocationId: (invocationId) => options.observations.findByInvocationId(invocationId),
    };
    this.#invoker = new CapabilityInvoker({ registry: options.capabilities, observations: fenced, ids: options.ids, clock: options.clock, logger: options.logger });
    this.#executor = new ActionExecutor({ registry: options.capabilities, logger: options.logger });
  }

  /**
   * Observational: reads durable state only. (R4-E) A proposal of an earlier
   * run still to be resolved (human approval outcome) is returned as the
   * pending action; the kernel drives it through `executeAction` — the
   * explicit governed phase — before any model call. (ADR-031) Likewise a
   * draft an earlier run deferred for revalidation is part of the state the
   * kernel resolves before any model call.
   */
  load(): Promise<ExecutionState> {
    return translate(async () => {
      const durable = await this.#options.execution.loadExecution(this.#options.lease);
      const agent = await this.#agentOf(durable.task);
      const carriedAction = (await this.#options.actions?.pendingApproval(this.#options.lease)) ?? null;
      this.#loaded = durable;
      return buildExecutionState({
        agent,
        task: durable.task,
        run: durable.run,
        goal: durable.goal,
        steps: durable.steps,
        observations: durable.observations,
        capabilities: this.#options.capabilities.discover(agent.capabilityScopes).map(toDescriptor),
        policy: this.#options.policy,
        now: this.#options.clock.now(),
        writeActions: durable.writeActions,
        carriedAction,
      });
    });
  }

  /**
   * Compiles the context of the upcoming model call and makes it durable
   * first. When this iteration already has a snapshot (the previous attempt
   * died during its model call) and its inputs — items and their freshness —
   * are unchanged, that snapshot is reused as-is: a logical attempt never
   * silently sees a different context. Changed inputs or a changed effective
   * policy/budget produce a new attempt that supersedes it.
   */
  prepareContext(context: ExecutionContext): Promise<PreparedContext> {
    return translate(async () => {
      const { lease, execution, logger } = this.#options;
      const outcome = await this.#compiler.compile(this.#compileRequest(context));
      if (outcome.kind === 'budget_exhausted') {
        return { kind: 'budget_exhausted', limit: outcome.maxEstimatedTokens, required: outcome.requiredTokens };
      }
      const telemetry = { taskId: context.task.taskId, runId: context.run.runId, agentId: context.agent.agentId, workerId: lease.owner, iteration: context.iteration };
      const latest = await execution.latestContextSnapshot(lease, context.iteration);
      if (latest && latest.inputFingerprint === outcome.inputFingerprint) {
        emitTelemetry(logger, 'context.snapshot.reused', { ...telemetry, attempt: latest.attempt, snapshotId: latest.snapshotId, contentHash: latest.contentHash });
        // Accounting of what the model actually receives: the stored snapshot.
        emitTelemetry(logger, 'context.compile.completed', compileCompleted(telemetry, latest.snapshotId, true, snapshotComposition(latest)));
        return { kind: 'ready', snapshotId: latest.snapshotId, context: latest.compiledContext, reused: true };
      }
      const snapshot = await execution.recordContextSnapshot(lease, {
        runId: context.run.runId,
        iteration: context.iteration,
        compilerVersion: outcome.compilerVersion,
        policyVersion: outcome.policyVersion,
        compiledContext: outcome.compiled,
        contentHash: outcome.contentHash,
        inputFingerprint: outcome.inputFingerprint,
        estimatedTokens: outcome.estimatedTokens,
        budget: outcome.budget,
        decisions: outcome.decisions,
        newSummaries: outcome.newSummaries,
      });
      emitTelemetry(logger, 'context.compile.completed', compileCompleted(telemetry, snapshot.snapshotId, false, outcome.composition));
      return { kind: 'ready', snapshotId: snapshot.snapshotId, context: snapshot.compiledContext, reused: false };
    });
  }

  #compileRequest(context: ExecutionContext): ContextCompileRequest {
    const loaded = this.#loaded;
    if (!loaded || loaded.run.runId !== context.run.runId) {
      throw new PlatformError('internal', 'session_not_loaded', 'load() must precede prepareContext()');
    }
    const request = contextCompileRequest(context, loaded.steps, this.#options.clock.now());
    // (R4-E) Every goal and the cross-run interaction records, as durable facts for the platform sources.
    return { ...request, execution: { ...request.execution, ...(loaded.goals ? { goals: loaded.goals } : {}), ...(loaded.interactions ? { interactions: loaded.interactions } : {}) } };
  }

  executeTemporal(step: StepRecord, decision: TemporalDecision): Promise<TemporalDecisionOutcome> {
    return translate(() => {
      if (!this.#options.temporal) throw new PlatformError('precondition', 'temporal_unavailable', 'temporal runtime is required');
      return this.#options.temporal.decide(this.#options.lease, step, decision);
    });
  }

  recordStep(step: StepRecord): Promise<RunStep> {
    return translate(() => this.#options.execution.recordStep(this.#options.lease, step));
  }

  executeRead(step: RunStep, decision: ReadCapabilityDecision): Promise<Observation> {
    return translate(async () => {
      if (step.invocationId === null) {
        throw new PlatformError('internal', 'read_without_invocation', `step ${step.stepId} has no invocation id`);
      }
      const agent = this.#agent;
      if (!agent) throw new PlatformError('internal', 'session_not_loaded', 'load() must precede executeRead()');
      const observation = await this.#invoker.invoke(
        { capabilityId: decision.capabilityId, arguments: decision.arguments },
        {
          taskId: step.taskId,
          runId: step.runId,
          agentId: agent.agentId,
          agentVersion: agent.version,
          correlationId: step.correlationId,
          grantedScopes: agent.capabilityScopes,
        },
        { invocationId: step.invocationId },
      );
      if (this.#recorded.has(step.invocationId)) return observation;
      // The invoker found an observation recorded earlier and wrote nothing:
      // make sure the step is linked to it (idempotent, fenced).
      return this.#options.execution.recordObservation(this.#options.lease, observation);
    });
  }

  /**
   * R4-D. Drives a proposal through the governed path from wherever its
   * durable ledger stands — the same code runs first time and after any
   * crash:
   *
   *   awaiting authorization → prepare (resolve + validate arguments) →
   *     reject (observed) | authorize (Policy Engine, in the runtime)
   *   executing → advance: the runtime grants exactly one attempt (made
   *     durable first, fenced) or settles the command → the ActionExecutor
   *     calls the write handler with the command's execution key → record
   *   observed / suspended → return
   *
   * Pure sequencing: which attempt may happen, and whether any may, is the
   * runtime's decision from the attempt log; this session never retries on
   * its own, never creates a key and never records an outcome unfenced.
   */
  executeAction(step: RunStep, _decision: ProposeActionDecision): Promise<ActionOutcome> {
    // The durable proposal — not the in-memory decision — is what gets governed.
    return translate(async () => {
      const { lease, actions } = this.#options;
      if (!actions) throw new PlatformError('internal', 'governed_execution_unavailable', 'this worker has no action runtime');
      if (step.proposalId === null) throw new PlatformError('internal', 'action_without_proposal', `step ${step.stepId} has no proposal id`);
      const agent = this.#agent;
      if (!agent) throw new PlatformError('internal', 'session_not_loaded', 'load() must precede executeAction()');
      const proposalId = step.proposalId;

      let progress: ActionProgress = await actions.loadAction(lease, proposalId);
      for (;;) {
        if (progress.kind === 'observed') return { kind: 'observed', observation: progress.observation };
        if (progress.kind === 'suspended') {
          const { reason, code, message, details } = progress.termination;
          return { kind: 'suspended', termination: { reason, code, message, details } };
        }
        const { state } = progress;
        if (state.phase === 'awaiting_approval_outcome') {
          progress = await actions.observeApprovalOutcome(lease, proposalId);
          continue;
        }
        if (state.phase === 'awaiting_authorization') {
          const prepared = this.#executor.prepare({ capabilityId: state.proposal.capabilityId, arguments: state.proposal.arguments });
          progress = prepared.ok
            ? await actions.authorizeAction(lease, { proposalId, agent, capability: prepared.capability, semantics: prepared.semantics, validatedArguments: prepared.validatedArguments })
            : await actions.rejectAction(lease, { proposalId, cause: prepared.cause, message: prepared.message, details: prepared.details });
          continue;
        }
        if (await actions.deferRetry(lease, proposalId)) throw new KernelInterrupt('stopped', 'action retry is scheduled durably');
        const advanced = await actions.advanceAction(lease, proposalId);
        if (advanced.kind !== 'attempt') {
          progress = advanced;
          continue;
        }
        const report = await this.#executor.attempt(
          { command: advanced.command, decision: advanced.decision },
          { attemptNumber: advanced.attempt.attemptNumber, kind: advanced.attempt.kind, workerId: lease.owner },
        );
        progress = await actions.recordAttempt(lease, proposalId, advanced.attempt.attemptId, report);
      }
    });
  }

  finish(ending: RunEnding): Promise<void> {
    return translate(async () => {
      await this.#options.execution.finishExecution(this.#options.lease, {
        termination: ending.termination,
        result: ending.result,
        ...(ending.finalStep ? { finalStep: ending.finalStep } : {}),
      });
    });
  }

  async #agentOf(task: AgentTask): Promise<RegisteredAgentDefinition> {
    // Definitions are immutable per (agentId, version): safe to reuse within the session.
    if (this.#agent) return this.#agent;
    const agent = await this.#options.agents.resolve(task.agentId, task.agentVersion);
    if (!agent) throw new PlatformError('internal', 'agent_definition_missing', `agent ${task.agentId}@${task.agentVersion} is not registered`);
    this.#agent = agent;
    return agent;
  }
}

/**
 * The compiler request of one iteration: the platform facts the kernel's
 * ExecutionContext holds, the run's recorded responses (from its step log),
 * the constraints as durable facts, and the agent's own context ceiling.
 */
export function contextCompileRequest(context: ExecutionContext, steps: readonly RunStep[], now: Date): ContextCompileRequest {
  const { limits, usage } = context.budget;
  const maxContextTokens = context.agent.contextPolicy.maxContextTokens;
  return {
    scope: { taskId: context.task.taskId, runId: context.run.runId, agentId: context.agent.agentId, agentVersion: context.agent.version, iteration: context.iteration },
    now,
    execution: {
      agent: context.agent,
      task: context.task,
      run: context.run,
      goal: context.goal,
      observations: context.observations,
      responses: steps.flatMap((s) => (s.decision?.type === 'respond' && s.outcome === 'recorded' ? [{ stepId: s.stepId, iteration: s.iteration, content: s.decision.content, recordedAt: s.createdAt }] : [])),
      // Visible to the model: READ, plus (R4-D) write classes when the run may write at all.
      // Visible ≠ executable: reads are checked on the decision, writes by policy.
      capabilities: visibleCapabilities(context).map((c) => ({ capabilityId: c.capabilityId, version: c.version, description: c.description, inputSchema: c.inputSchema, riskClass: c.riskClass })),
      constraints: {
        remaining: {
          iterations: limits.maxIterations - usage.iterations,
          modelCalls: limits.maxModelCalls - usage.modelCalls,
          readCapabilityCalls: limits.maxReadCapabilityCalls - usage.readCapabilityCalls,
          tokens: limits.maxTokens === null ? null : limits.maxTokens - usage.tokens,
          writeActions: Math.max(0, limits.maxWriteActions - usage.writeActions),
        },
        runDeadlineAt: new Date(Date.parse(context.run.startedAt) + limits.maxRunDurationMs).toISOString(),
      },
    },
    ...(maxContextTokens === undefined ? {} : { budgetCeilingTokens: maxContextTokens }),
  };
}

/**
 * Aggregated accounting of one model input (ADR-015): totals plus per-kind and
 * per-authority token maps — bounded cardinality (closed enums). Per-source and
 * per-item detail stays in `context_snapshot_items`. Never item content.
 */
function compileCompleted(base: Record<string, unknown>, snapshotId: string, reused: boolean, c: ContextComposition): Record<string, unknown> {
  const tokens = (tallies: Partial<Record<string, { included: { estimatedTokens: number } }>>) =>
    Object.fromEntries(Object.entries(tallies).map(([key, t]) => [key, t!.included.estimatedTokens]));
  return {
    ...base,
    snapshotId,
    reused,
    budgetMode: c.budget.mode,
    maxEstimatedTokens: c.budget.mode === 'fixed' ? c.budget.maxEstimatedTokens : null,
    rawEstimatedTokens: c.rawEstimatedTokens,
    compiledEstimatedTokens: c.compiledEstimatedTokens,
    includedEstimatedTokens: c.includedEstimatedTokens,
    excludedEstimatedTokens: c.excludedEstimatedTokens,
    includedCount: c.includedCount,
    excludedCount: c.excludedCount,
    compactedCount: c.compactedCount,
    compactionInputEstimatedTokens: c.compaction?.inputEstimatedTokens ?? 0,
    compactionOutputEstimatedTokens: c.compaction?.outputEstimatedTokens ?? 0,
    includedTokensByKind: tokens(c.byKind),
    includedTokensByAuthority: tokens(c.byAuthority),
  };
}

function toDescriptor(definition: { capabilityId: string; version: number; description: string; riskClass: CapabilityDescriptor['riskClass']; inputSchema: Record<string, unknown> }): CapabilityDescriptor {
  return {
    capabilityId: definition.capabilityId,
    version: definition.version,
    description: definition.description,
    riskClass: definition.riskClass,
    inputSchema: definition.inputSchema,
  };
}

/** Maps runtime refusals to kernel interruptions; everything else propagates. */
async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PlatformError) {
      if (error.code === 'lease_lost') throw new KernelInterrupt('lease_lost', error.message, { cause: error });
      if (error.code === 'task_not_runnable' || error.code === 'task_not_found') throw new KernelInterrupt('task_not_runnable', error.message, { cause: error });
      if (error.kind === 'unavailable') throw new KernelInterrupt('unavailable', error.message, { cause: error });
    }
    throw error;
  }
}
