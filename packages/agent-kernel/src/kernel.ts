import {
  MAX_AUTHORITY_CORRECTIONS,
  MAX_REVALIDATION_READS,
  RESPONSE_AUTHORITY_DEFERRED,
  RESPONSE_AUTHORITY_DEGRADED,
  RESPONSE_AUTHORITY_ERROR_PREFIX,
  RESPONSE_AUTHORITY_SUPPRESSED,
  type AgentDecision,
  type CompiledContext,
  type CompletionResult,
  type JsonObject,
  type ProposeActionDecision,
  type ReadCapabilityDecision,
  type ResponseAuthorityValidator,
  type ResponseAuthorityVerdict,
  type RunStep,
  type WaitDecision,
} from '@r4/contracts';
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
  /** ADR-031: the pack's deterministic pre-respond authority validator (absent ⇒ responses are recorded as decided). */
  readonly responseAuthority?: ResponseAuthorityValidator;
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
/** ADR-031: the stated reason of the platform wait that defers a draft (shown back to the agent as a wait episode). */
const REVALIDATION_WAIT_REASON = 'Platform: the drafted reply waits until its owner evidence can be revalidated before it is sent.';
const DEGRADATION_ALREADY_SENT = 'Not sent: this run already sent its safe fallback reply; do not state these facts as current.';
const RESPONSE_AUTHORITY_UNVERIFIABLE = 'response_authority_unverifiable';
const UNVERIFIABLE_FEEDBACK = 'The evidence for facts stated in the draft could not be revalidated; do not state them as current.';
const SUPPRESSED_FEEDBACK = 'Not sent: after the safe fallback reply, this run states no further facts that need the owner\'s authority.';

/** A `respond` the kernel must authorize before it becomes durable. */
interface ResponseDraft {
  readonly content: string;
  /** Usage of the model call that drafted it (none when the platform records an already durable draft). */
  readonly usage: ModelUsage;
  /** Snapshot of the drafting model call (of the current iteration); null for a durable (deferred) draft. */
  readonly snapshotId: string | null;
  /** The draft is already durable (deferred): recording it again is a platform step. */
  readonly deferred: boolean;
  /** Its revalidation wait already happened: it is never deferred again. */
  readonly waited: boolean;
}

type SessionCall = <T>(fn: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; outcome: KernelOutcome }>;

/**
 * The ContextSnapshot of each iteration a platform step is recorded at
 * (agent_run_steps_context_snapshot_fk admits only the step's own iteration):
 * compiled once per iteration — the model never sees it, the audit does.
 */
class IterationSnapshots {
  #known: { readonly iteration: number; readonly id: string | null } | null;
  constructor(
    private readonly session: KernelSession,
    private readonly call: SessionCall,
    known: { readonly iteration: number; readonly id: string | null } | null,
  ) {
    this.#known = known;
  }

  async of(context: ExecutionContext): Promise<{ ok: true; id: string | null } | { ok: false; outcome: KernelOutcome }> {
    if (this.#known?.iteration === context.iteration) return { ok: true, id: this.#known.id };
    const prepared = await this.call(() => this.session.prepareContext(context));
    if (!prepared.ok) return prepared;
    this.#known = { iteration: context.iteration, id: prepared.value.kind === 'ready' ? prepared.value.snapshotId : null };
    return { ok: true, id: this.#known.id };
  }

  async record(context: ExecutionContext, step: Pick<StepRecord, 'decision' | 'outcome' | 'error' | 'usage' | 'origin'>): Promise<{ ok: true } | { ok: false; outcome: KernelOutcome }> {
    const snapshot = await this.of(context);
    if (!snapshot.ok) return snapshot;
    const recorded = await this.call(() => this.session.recordStep({ runId: context.run.runId, iteration: context.iteration, contextSnapshotId: snapshot.id, ...step }));
    return recorded.ok ? { ok: true } : recorded;
  }
}

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
  readonly #authority: ResponseAuthorityValidator | undefined;

  constructor(options: AgentKernelOptions) {
    this.#gateway = options.gateway;
    this.#logger = options.logger;
    this.#authority = options.responseAuthority;
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

      // ADR-031: a durable draft not yet resolved — deferred until its owner evidence could be
      // revalidated (possibly by an earlier run that waited), or a degradation interrupted by a
      // crash — is resolved by the platform before the model is asked anything.
      const pending = this.#authority ? context.responseAuthority.pending : null;
      if (pending) {
        const resolved =
          pending.kind === 'deferred'
            ? await this.#respond(session, context, { content: pending.content, usage: NO_USAGE, snapshotId: null, deferred: true, waited: pending.waited }, telemetry)
            : await this.#degrade(session, context, pending.content, { kind: 'reject', code: pending.code, feedback: '' }, null, telemetry);
        if (resolved) return resolved;
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
        case 'wait':
        case 'request_consultation':
        case 'request_handoff':
        case 'manage_goal': {
          const changed = await this.#call(session, () => {
            if (!session.executeTemporal) throw new Error('temporal runtime unavailable');
            return session.executeTemporal(step({ decision, outcome: 'recorded', error: null, usage }), decision);
          });
          if (!changed.ok) return changed.outcome;
          if (changed.value.kind === 'suspended') return { kind: 'terminated', termination: changed.value.termination };
          continue;
        }
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
          const responded = await this.#respond(session, context, { content: decision.content, usage, snapshotId, deferred: false, waited: false }, telemetry);
          if (responded) return responded;
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

  /**
   * ADR-031. Records a `respond` only once the pack's authority validator
   * allows it. Evidence that expired is revalidated with platform READs (the
   * same draft is kept when the truth is unchanged). Evidence still inside the
   * owner's validity window but too close to its end (`notBefore`) is not
   * refreshed now — the owner would return that same window — the draft is
   * deferred durably instead: recorded `refused` (deferred, never sent) and
   * the run suspended on a platform WAIT_UNTIL; the run woken from it resolves
   * the draft first (at most one deferral per draft). A contradicted draft is
   * recorded `refused` with its feedback; the recovery budget is the RUN's:
   * one correction cycle, then one safe degradation, then refusals only. The
   * safe degradation exhausts response-authority recovery for authoritative
   * claims for the remainder of the run (R4-J1E-R2.1): no deferral, wait or
   * revalidation, and a draft with claims is refused even if allowed.
   * Returns an outcome only when the loop must stop.
   */
  async #respond(session: KernelSession, initial: ExecutionContext, draft: ResponseDraft, telemetry: Record<string, unknown>): Promise<KernelOutcome | null> {
    let context = initial;
    // Each step is recorded against the snapshot of ITS iteration (durable FK): the drafting model call's own
    // snapshot, or — once platform steps moved the iteration, or for a durable (deferred) draft — the snapshot
    // compiled for that iteration (same inputs plus the refreshed evidence the draft was validated against).
    const snapshots = new IterationSnapshots(session, (fn) => this.#call(session, fn), draft.snapshotId === null ? null : { iteration: initial.iteration, id: draft.snapshotId });
    const author = draft.deferred ? { origin: 'platform' as const, usage: NO_USAGE } : { origin: 'model' as const, usage: draft.usage };
    const record = (outcome: 'recorded' | 'refused', error: { code: string; message: string } | null) =>
      snapshots.record(context, { decision: { type: 'respond', content: draft.content }, outcome, error, ...author });
    const reload = async (): Promise<KernelOutcome | null> => {
      const reloaded = await this.#call(session, () => session.load());
      if (!reloaded.ok) return reloaded.outcome;
      context = reloaded.value.context;
      return null;
    };
    const validator = this.#authority;
    if (!validator) {
      const recorded = await record('recorded', null);
      return recorded.ok ? null : recorded.outcome;
    }
    const input = () => ({ content: draft.content, observations: context.observations });
    let verdict = await validator.validate(input());
    const notBefore = verdict.kind === 'revalidation_required' ? (verdict.notBefore ?? null) : null;
    emitTelemetry(this.#logger, 'response.authority.checked', {
      ...telemetry,
      iteration: context.iteration,
      verdict: verdict.kind,
      claims: verdict.claims?.length ?? 0,
      reads: verdict.kind === 'revalidation_required' ? verdict.reads.length : 0,
      notBefore,
      deferred: draft.deferred,
      waited: draft.waited,
    });
    const budget = initial.responseAuthority;
    // R4-J1E-R2.1: the run already sent its one safe degradation, which exhausts response-authority recovery for
    // authoritative claims for the rest of the run. Revalidating would open a new recovery (deferral, wait, platform
    // READs), and a draft stating claims is refused even when the validator allows it. Both are refused below like
    // any later invalid draft. A draft with no authority claims keeps the normal semantics.
    if (budget.degraded && verdict.kind === 'revalidation_required') {
      verdict = { kind: 'reject', code: RESPONSE_AUTHORITY_UNVERIFIABLE, feedback: UNVERIFIABLE_FEEDBACK, ...(verdict.claims ? { claims: verdict.claims } : {}) };
    } else if (budget.degraded && verdict.kind === 'allow' && (verdict.claims?.length ?? 0) > 0) {
      verdict = { kind: 'reject', code: RESPONSE_AUTHORITY_SUPPRESSED, feedback: SUPPRESSED_FEEDBACK, claims: verdict.claims! };
    } else if (verdict.kind === 'revalidation_required') {
      if (notBefore !== null && !draft.waited && session.executeTemporal) {
        emitTelemetry(this.#logger, 'response.authority.deferred', { ...telemetry, iteration: context.iteration, notBefore, reads: verdict.reads.length });
        if (!draft.deferred) {
          const refused = await record('refused', {
            code: RESPONSE_AUTHORITY_DEFERRED,
            message: `Not sent yet: the evidence it states is revalidated with its owner at ${notBefore} (when a refresh can yield a new validity window); the platform records it then if it is still supported.`,
          });
          if (!refused.ok) return refused.outcome;
          const stopped = await reload();
          if (stopped) return stopped;
        }
        const wait: WaitDecision = { type: 'wait', condition: { kind: 'WAIT_UNTIL', until: notBefore }, reason: REVALIDATION_WAIT_REASON };
        const snapshot = await snapshots.of(context);
        if (!snapshot.ok) return snapshot.outcome;
        const executeTemporal = session.executeTemporal.bind(session);
        const changed = await this.#call(session, () =>
          executeTemporal({ runId: context.run.runId, iteration: context.iteration, contextSnapshotId: snapshot.id, decision: wait, outcome: 'recorded', error: null, usage: NO_USAGE, origin: 'platform' }, wait),
        );
        if (!changed.ok) return changed.outcome;
        return changed.value.kind === 'suspended' ? { kind: 'terminated', termination: changed.value.termination } : null;
      }
      for (const read of verdict.reads.slice(0, MAX_REVALIDATION_READS)) {
        if (checkBeforeRead(context.budget.limits, context.budget.usage)) break;
        const readDecision: ReadCapabilityDecision = { type: 'read_capability', capabilityId: read.capabilityId, arguments: read.arguments };
        const recorded = await this.#call(session, () =>
          session.recordStep({ runId: context.run.runId, iteration: context.iteration, contextSnapshotId: null, decision: readDecision, outcome: 'pending', error: null, usage: NO_USAGE, origin: 'platform' }),
        );
        if (!recorded.ok) return recorded.outcome;
        const read_ = await this.#executeRead(session, recorded.value, readDecision, { ...telemetry, origin: 'platform' }, false);
        if (read_) return read_;
        const stopped = await reload();
        if (stopped) return stopped;
      }
      verdict = await validator.validate(input());
      emitTelemetry(this.#logger, 'response.authority.revalidated', { ...telemetry, iteration: context.iteration, draftSnapshotId: draft.snapshotId, verdict: verdict.kind, claims: verdict.claims?.length ?? 0, deferred: draft.deferred });
      if (verdict.kind === 'revalidation_required') {
        verdict = { kind: 'reject', code: RESPONSE_AUTHORITY_UNVERIFIABLE, feedback: UNVERIFIABLE_FEEDBACK, ...(verdict.claims ? { claims: verdict.claims } : {}) };
      }
    }
    if (verdict.kind === 'allow') {
      const recorded = await record('recorded', null);
      return recorded.ok ? null : recorded.outcome;
    }
    const code = verdict.code.startsWith(RESPONSE_AUTHORITY_ERROR_PREFIX) ? verdict.code : `${RESPONSE_AUTHORITY_ERROR_PREFIX}rejected`;
    if (budget.degraded) {
      // The run already sent its one safe degradation: this draft is refused, never replaced by another.
      emitTelemetry(this.#logger, 'response.authority.suppressed', { ...telemetry, iteration: context.iteration, code });
      const refused = await record('refused', { code, message: `${verdict.feedback}\n${DEGRADATION_ALREADY_SENT}` });
      return refused.ok ? null : refused.outcome;
    }
    if (budget.corrections < MAX_AUTHORITY_CORRECTIONS) {
      emitTelemetry(this.#logger, 'response.authority.rejected', { ...telemetry, iteration: context.iteration, code });
      const refused = await record('refused', { code, message: verdict.feedback });
      return refused.ok ? null : refused.outcome;
    }
    const refused = await record('refused', { code: RESPONSE_AUTHORITY_DEGRADED, message: verdict.feedback });
    if (!refused.ok) return refused.outcome;
    const stopped = await reload();
    if (stopped) return stopped;
    return this.#degrade(session, context, draft.content, verdict, snapshots, telemetry);
  }

  /** Records the run's one safe degradation (a platform `respond`, token-free) in place of `content`. */
  async #degrade(
    session: KernelSession,
    context: ExecutionContext,
    content: string,
    verdict: ResponseAuthorityVerdict,
    known: IterationSnapshots | null,
    telemetry: Record<string, unknown>,
  ): Promise<KernelOutcome | null> {
    const validator = this.#authority!;
    const snapshots = known ?? new IterationSnapshots(session, (fn) => this.#call(session, fn), null);
    const degraded = validator.degraded({ content, observations: context.observations, verdict });
    emitTelemetry(this.#logger, 'response.authority.degraded', { ...telemetry, iteration: context.iteration, code: verdict.kind === 'reject' ? verdict.code : null });
    const recorded = await snapshots.record(context, { decision: { type: 'respond', content: degraded }, outcome: 'recorded', error: null, origin: 'platform', usage: NO_USAGE });
    return recorded.ok ? null : recorded.outcome;
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
