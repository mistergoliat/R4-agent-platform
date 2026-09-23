import {
  PlatformError,
  type AgentTask,
  type Clock,
  type IdGenerator,
  type Observation,
  type ReadCapabilityDecision,
  type RegisteredAgentDefinition,
  type RunStep,
  type TaskLease,
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
import { CapabilityInvoker, type CapabilityRegistry, type ObservationStore } from '@r4/capability-runtime';
import type { StructuredLogger } from '@r4/observability';
import type { AgentDefinitionResolver, ExecutionRuntime } from '@r4/task-runtime';

export interface DurableSessionOptions {
  readonly lease: TaskLease;
  readonly execution: ExecutionRuntime;
  readonly agents: AgentDefinitionResolver;
  readonly capabilities: CapabilityRegistry;
  /** Unfenced read side of the observation store (idempotency lookups only). */
  readonly observations: Pick<ObservationStore, 'findByInvocationId'>;
  readonly policy: ExecutionPolicy;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: StructuredLogger;
}

/**
 * KernelSession backed by durable state. Pure glue: every rule lives in the
 * ExecutionRuntime (ownership, run lifecycle), the CapabilityInvoker (scopes,
 * READ-only, schemas) or the kernel (decisions, budgets). Every write carries
 * the lease token, so it is fenced; runtime errors are translated into kernel
 * interruptions where the run must be left untouched.
 */
export class DurableKernelSession implements KernelSession {
  readonly #options: DurableSessionOptions;
  readonly #invoker: CapabilityInvoker;
  /** Invocations whose observation this session wrote (fenced) itself. */
  readonly #recorded = new Set<string>();
  #agent: RegisteredAgentDefinition | null = null;

  constructor(options: DurableSessionOptions) {
    this.#options = options;
    const { lease, execution } = options;
    // Observations of this session are written only through the fenced path:
    // a worker that lost its lease cannot record evidence.
    const fenced: ObservationStore = {
      record: async (observation) => {
        const stored = await execution.recordObservation(lease, observation);
        this.#recorded.add(stored.source.invocationId);
        return stored;
      },
      findByInvocationId: (invocationId) => options.observations.findByInvocationId(invocationId),
    };
    this.#invoker = new CapabilityInvoker({ registry: options.capabilities, observations: fenced, ids: options.ids, clock: options.clock, logger: options.logger });
  }

  load(): Promise<ExecutionState> {
    return translate(async () => {
      const durable = await this.#options.execution.loadExecution(this.#options.lease);
      const agent = await this.#agentOf(durable.task);
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
      });
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
