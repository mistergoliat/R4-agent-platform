import type { AgentDecision, CompiledContext, CompletionResult, JsonObject, ProposeActionDecision, ReadCapabilityDecision, RunStep } from '@r4/contracts';
import type { ModelError, ModelGateway, ModelUsage } from '@r4/model-gateway';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import { budgetTerminationCode, checkBeforeModelCall, checkBeforeRead, checkBeforeWrite, modelCallTimeout, type BudgetExhaustion } from './budget.js';
import type { ExecutionContext } from './context.js';
import { parseAgentDecision, type DecisionError } from './decision-parser.js';
import { renderModelRequest } from './request.js';
import {
  KernelInterrupt,
  type InterruptionCause,
  type KernelSession,
  type KernelTermination,
  type RunEnding,
  type StepRecord,
} from './session.js';

export interface AgentKernelOptions {
  readonly gateway: ModelGateway;
  readonly logger: StructuredLogger;
}

export interface KernelRunOptions {
  /** Aborted by the worker on lease loss or shutdown; reason should be a KernelInterrupt. */
  readonly signal?: AbortSignal;
  /** For telemetry only. */
  readonly workerId?: string;
}

export type KernelOutcome =
  | { readonly kind: 'terminated'; readonly termination: KernelTermination }
  | { readonly kind: 'interrupted'; readonly cause: InterruptionCause };

/** The result of asking the model for the next decision. */
export type DecideOutcome =
  | { readonly kind: 'decision'; readonly decision: AgentDecision; readonly usage: ModelUsage }
  | { readonly kind: 'invalid'; readonly error: DecisionError; readonly usage: ModelUsage }
  | { readonly kind: 'model_failure'; readonly error: ModelError };

const NO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Agent Kernel (R4-C1, context from R4-C2). Runs the loop
 *
 *   load durable state → budget → prepare context (snapshot durable) → model →
 *   validate decision → READ (execute + observation) | propose_action (R4-D:
 *   governed by the platform → observation) | respond | complete → repeat
 *
 * The model decides WHICH decision comes next; the kernel decides whether it
 * is acceptable and the session port (platform) performs it. The kernel keeps
 * no loop state across iterations: each iteration starts from `session.load()`,
 * so any worker can continue a run after a crash. Iterative, never recursive.
 *
 * Independent of storage, transport, providers, domains and of how context is
 * compiled: it depends only on contracts, the ModelGateway interface and the
 * KernelSession port.
 */
export class AgentKernel {
  readonly #gateway: ModelGateway;
  readonly #logger: StructuredLogger;

  constructor(options: AgentKernelOptions) {
    this.#gateway = options.gateway;
    this.#logger = options.logger;
  }

  /**
   * One model call turned into a validated decision (or a classified failure).
   * The model sees `compiled`; the decision is still validated against the
   * platform's own facts in `context` (visible ≠ executable).
   */
  async decide(context: ExecutionContext, compiled: CompiledContext, signal?: AbortSignal): Promise<DecideOutcome> {
    const request = renderModelRequest(context, compiled, modelCallTimeout(context.budget.limits, context.budget.usage));
    const result = await this.#gateway.generate(request, signal ? { signal } : {});
    if (!result.ok) return { kind: 'model_failure', error: result.error };
    const parsed = parseAgentDecision(result.response, {
      capabilities: context.capabilities,
      observationIds: new Set(context.observations.map((o) => o.observationId)),
    });
    return parsed.ok
      ? { kind: 'decision', decision: parsed.decision, usage: result.response.usage }
      : { kind: 'invalid', error: parsed.error, usage: result.response.usage };
  }

  async run(session: KernelSession, options: KernelRunOptions = {}): Promise<KernelOutcome> {
    const signal = options.signal;
    for (;;) {
      if (signal?.aborted) return interrupted(signal);

      const loaded = await this.#call(session, () => session.load());
      if (!loaded.ok) return loaded.outcome;
      const { context, pendingRead, pendingAction } = loaded.value;
      const telemetry = {
        taskId: context.task.taskId,
        runId: context.run.runId,
        agentId: context.agent.agentId,
        workerId: options.workerId ?? null,
        iteration: context.iteration,
      };

      // Recovery: a READ that was decided but not observed is executed with its
      // recorded invocation id; the model is not asked again.
      if (pendingRead) {
        const read = await this.#executeRead(session, pendingRead.step, pendingRead.decision, { ...telemetry, iteration: pendingRead.step.iteration }, true);
        if (read) return read;
        continue;
      }
      // R4-D recovery: an action whose outcome is not observed is resolved by the
      // platform from its ledger first; the model never continues past it.
      if (pendingAction) {
        const action = await this.#executeAction(session, pendingAction.step, pendingAction.decision);
        if (action) return action;
        continue;
      }

      const exhausted = checkBeforeModelCall(context.budget.limits, context.budget.usage);
      if (exhausted) return this.#exhausted(session, exhausted, null, telemetry);

      // The context is compiled and its snapshot made durable before the model
      // is called, so any later reader knows exactly what this call saw.
      const prepared = await this.#call(session, () => session.prepareContext(context));
      if (!prepared.ok) return prepared.outcome;
      if (prepared.value.kind === 'budget_exhausted') {
        const { limit, required } = prepared.value;
        return this.#exhausted(session, { dimension: 'maxContextTokens', limit, used: required }, null, telemetry);
      }
      const { snapshotId, context: compiled } = prepared.value;

      const decided = await this.decide(context, compiled, signal);
      // A call cut short by lease loss or shutdown is not ours to record.
      if (signal?.aborted) return interrupted(signal);
      const step = (partial: Pick<StepRecord, 'decision' | 'outcome' | 'error' | 'usage'>): StepRecord => ({
        runId: context.run.runId,
        iteration: context.iteration,
        contextSnapshotId: snapshotId,
        ...partial,
      });

      if (decided.kind === 'model_failure') {
        const { error } = decided;
        if (error.kind === 'cancelled') return { kind: 'interrupted', cause: 'stopped' };
        emitTelemetry(this.#logger, 'agent.decision', { ...telemetry, outcome: 'model_failure', errorCode: error.kind });
        return this.#finish(session, {
          termination: { reason: 'model_failure', code: error.kind, message: error.message, details: { retryable: error.retryable, latencyMs: error.latencyMs } },
          result: null,
          finalStep: step({ decision: null, outcome: 'model_failed', error: { code: error.kind, message: error.message }, usage: NO_USAGE }),
        });
      }

      if (decided.kind === 'invalid') {
        emitTelemetry(this.#logger, 'agent.decision', { ...telemetry, outcome: 'invalid', errorCode: decided.error.code });
        return this.#finish(session, {
          termination: { reason: 'invalid_decision', code: decided.error.code, message: decided.error.message, details: null },
          result: null,
          finalStep: step({ decision: null, outcome: 'invalid', error: decided.error, usage: decided.usage }),
        });
      }

      const { decision, usage } = decided;
      emitTelemetry(this.#logger, 'agent.decision', {
        ...telemetry,
        outcome: 'accepted',
        decisionType: decision.type,
        capabilityId: decision.type === 'read_capability' || decision.type === 'propose_action' ? decision.capabilityId : null,
      });

      switch (decision.type) {
        case 'read_capability': {
          const readExhausted = checkBeforeRead(context.budget.limits, context.budget.usage);
          if (readExhausted) {
            return this.#exhausted(session, readExhausted, step({ decision, outcome: 'refused', error: { code: 'budget_exhausted', message: `${readExhausted.dimension} reached` }, usage }), telemetry);
          }
          const recorded = await this.#call(session, () => session.recordStep(step({ decision, outcome: 'pending', error: null, usage })));
          if (!recorded.ok) return recorded.outcome;
          const read = await this.#executeRead(session, recorded.value, decision, telemetry, false);
          if (read) return read;
          continue;
        }
        case 'propose_action': {
          // Before the proposal is recorded, i.e. before any further write can be created.
          const writeExhausted = checkBeforeWrite(context.budget.limits, context.budget.usage);
          if (writeExhausted) {
            return this.#exhausted(session, writeExhausted, step({ decision, outcome: 'refused', error: { code: 'budget_exhausted', message: `${writeExhausted.dimension} reached` }, usage }), telemetry);
          }
          const recorded = await this.#call(session, () => session.recordStep(step({ decision, outcome: 'pending', error: null, usage })));
          if (!recorded.ok) return recorded.outcome;
          const action = await this.#executeAction(session, recorded.value, decision);
          if (action) return action;
          continue;
        }
        case 'respond': {
          const recorded = await this.#call(session, () => session.recordStep(step({ decision, outcome: 'recorded', error: null, usage })));
          if (!recorded.ok) return recorded.outcome;
          continue;
        }
        case 'complete':
          return this.#finish(session, {
            termination: { reason: 'completed', code: 'completed', message: 'agent completed the task', details: null },
            result: completionResult(decision.result),
            finalStep: step({ decision, outcome: 'recorded', error: null, usage }),
          });
      }
    }
  }

  /** Returns an outcome only when the loop must stop. */
  async #executeRead(
    session: KernelSession,
    step: RunStep,
    decision: ReadCapabilityDecision,
    telemetry: Record<string, unknown>,
    recovery: boolean,
  ): Promise<KernelOutcome | null> {
    emitTelemetry(this.#logger, 'capability.invoked', { ...telemetry, capabilityId: decision.capabilityId, invocationId: step.invocationId, recovery });
    try {
      await session.executeRead(step, decision);
      return null;
    } catch (error) {
      if (error instanceof KernelInterrupt) return { kind: 'interrupted', cause: error.interruption };
      // No durable evidence could be produced for this invocation.
      return this.#finish(session, {
        termination: {
          reason: 'capability_failure',
          code: 'capability_execution_error',
          message: error instanceof Error ? error.message : 'capability execution failed',
          details: { capabilityId: decision.capabilityId, invocationId: step.invocationId },
        },
        result: null,
        finalStep: null,
      });
    }
  }

  /**
   * (R4-D) Hands a pending proposal to the platform. Returns an outcome only
   * when the loop must stop: the platform suspended the run itself, ownership
   * was lost, or the platform could not resolve the action — in which case
   * the run fails as a platform fault and the platform keeps any attempt whose
   * outcome is unknown flagged for reconciliation (never "failed"). Telemetry
   * of every stage (proposed, evaluated, command, attempts, receipt) is the
   * platform's.
   */
  async #executeAction(session: KernelSession, step: RunStep, decision: ProposeActionDecision): Promise<KernelOutcome | null> {
    try {
      const outcome = await session.executeAction(step, decision);
      return outcome.kind === 'observed' ? null : { kind: 'terminated', termination: outcome.termination };
    } catch (error) {
      if (error instanceof KernelInterrupt) return { kind: 'interrupted', cause: error.interruption };
      this.#logger.error({ err: describeError(error), proposalId: step.proposalId }, 'governed action could not be resolved');
      return this.#finish(session, {
        termination: {
          reason: 'internal_failure',
          code: 'action_execution_error',
          message: describeError(error).message,
          details: { capabilityId: decision.capabilityId, proposalId: step.proposalId },
        },
        result: null,
        finalStep: null,
      });
    }
  }

  #exhausted(session: KernelSession, exhausted: BudgetExhaustion, finalStep: StepRecord | null, telemetry: Record<string, unknown>): Promise<KernelOutcome> {
    emitTelemetry(this.#logger, 'budget.exhausted', { ...telemetry, dimension: exhausted.dimension, limit: exhausted.limit, used: exhausted.used });
    return this.#finish(session, {
      termination: {
        reason: 'budget_exhausted',
        code: budgetTerminationCode(exhausted.dimension),
        message: `${exhausted.dimension} exhausted (${exhausted.used}/${exhausted.limit})`,
        details: { dimension: exhausted.dimension, limit: exhausted.limit, used: exhausted.used },
      },
      result: null,
      finalStep,
    });
  }

  async #finish(session: KernelSession, ending: RunEnding): Promise<KernelOutcome> {
    try {
      await session.finish(ending);
      return { kind: 'terminated', termination: ending.termination };
    } catch (error) {
      if (error instanceof KernelInterrupt) return { kind: 'interrupted', cause: error.interruption };
      if (ending.termination.reason === 'internal_failure' && ending.finalStep === null) {
        // Even the fallback was refused: leave the run for recovery.
        return { kind: 'interrupted', cause: 'unavailable' };
      }
      // The platform refused this ending (a platform fault, not a transient one):
      // record that instead, so a run can never loop forever on an unrecordable end.
      this.#logger.error({ err: describeError(error), terminationReason: ending.termination.reason }, 'run ending refused; recording internal_failure');
      return this.#finish(session, {
        termination: { reason: 'internal_failure', code: 'ending_refused', message: describeError(error).message, details: { refusedReason: ending.termination.reason } },
        result: null,
        finalStep: null,
      });
    }
  }

  /**
   * Session calls: interruptions stop the loop as-is; any other failure is a
   * platform fault and ends the run as internal_failure (if still possible).
   */
  async #call<T>(session: KernelSession, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; outcome: KernelOutcome }> {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      if (error instanceof KernelInterrupt) return { ok: false, outcome: { kind: 'interrupted', cause: error.interruption } };
      this.#logger.error({ err: describeError(error) }, 'kernel internal failure');
      const outcome = await this.#finish(session, {
        termination: { reason: 'internal_failure', code: 'internal_error', message: describeError(error).message, details: null },
        result: null,
        finalStep: null,
      });
      return { ok: false, outcome };
    }
  }
}

/** The structured result stored on the run and task: data only, no effect. */
export function completionResult(result: CompletionResult): JsonObject {
  return { summary: result.summary, evidence: result.evidence, ...(result.data === undefined ? {} : { data: result.data }) };
}

function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
}

function interrupted(signal: AbortSignal): KernelOutcome {
  const reason: unknown = signal.reason;
  return { kind: 'interrupted', cause: reason instanceof KernelInterrupt ? reason.interruption : 'stopped' };
}
