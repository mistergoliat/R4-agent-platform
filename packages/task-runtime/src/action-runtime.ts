import {
  PlatformError,
  fingerprint,
  actionAttemptSchema,
  actionExecutionSchema,
  actionReceiptSchema,
  identityAssuranceOf,
  observationSchema,
  policyDecisionSchema,
  runStatusForTermination,
  trustedActionContextSchema,
  type ActionAttempt,
  type ActionAttemptReport,
  type ActionAuthorizer,
  type ActionCommand,
  type ActionExecution,
  type ActionProposal,
  type ActionReceipt,
  type AgentDefinition,
  type CapabilityDefinition,
  type Clock,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type LeaseToken,
  type Observation,
  type PolicyDecision,
  type ProposeActionDecision,
  type RunStep,
  type Schedule,
  type ScheduleToken,
  type RunTermination,
  type TrustedActionContext,
  type WriteExecutionSemantics,
} from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import { assertExecutionTransition, nextActionStep, receiptStatusFor, type ActionNextStep, type UncertainOutcomeCode } from './action-lifecycle.js';
import { lockOwnedExecution, taskStatusForTermination, workerPrincipal, type OwnedExecution } from './execution-runtime.js';
import { finishRunWithin, parseOrThrow, transitionTaskWithin, truncate, type PendingEvent } from './mutations.js';
import type { ExecutionStore, ExecutionUnitOfWork } from './ports.js';
import { temporalOf, type TemporalRuntime } from './temporal-runtime.js';

export interface ActionRuntimeOptions {
  temporal?: TemporalRuntime;
  store: ExecutionStore;
  /** The Policy Engine. Only this runtime calls it, inside the fenced transaction that records its decision. */
  authorizer: ActionAuthorizer;
  ids: IdGenerator;
  clock: Clock;
  logger: StructuredLogger;
}

/** Everything durable about one proposal. */
export interface ActionState {
  readonly proposal: ActionProposal;
  readonly step: RunStep;
  readonly decision: PolicyDecision | null;
  readonly execution: ActionExecution | null;
  readonly attempts: readonly ActionAttempt[];
  readonly receipt: ActionReceipt | null;
  readonly observation: Observation | null;
  /**
   * awaiting_authorization     proposal durable; no policy decision yet (crash window A),
   *                            or (R4-E) approved by a human: to be evaluated again
   * awaiting_approval_outcome  (R4-E) a human rejected / let expire / withdrew the approval
   *                            request: its outcome is not observed yet
   * executing                  command durable; outcome not established yet (windows B, C)
   * observed                   outcome durable as an observation (window D)
   */
  readonly phase: 'awaiting_authorization' | 'awaiting_approval_outcome' | 'executing' | 'observed';
  /** For `executing`: what the durable attempt log permits next. */
  readonly next: ActionNextStep | null;
}

export type ActionProgress =
  /** More platform work is needed (authorization or another attempt). */
  | { readonly kind: 'pending'; readonly state: ActionState }
  /** The outcome is durable and observed; the agent may continue. */
  | { readonly kind: 'observed'; readonly state: ActionState; readonly observation: Observation }
  /** The platform ended the run (approval required, or outcome unknown); the task waits. */
  | { readonly kind: 'suspended'; readonly state: ActionState; readonly termination: RunTermination };

/** Permission to perform exactly one external call, granted after it was made durable. */
export interface ActionAttemptGrant {
  readonly kind: 'attempt';
  readonly state: ActionState;
  readonly attempt: ActionAttempt;
  readonly command: ActionCommand;
  readonly decision: PolicyDecision;
}

/**
 * (R4-E) Permission to perform exactly one `reconcile` call of an uncertain
 * command — same command, same execution key — fenced by the schedule token.
 */
export interface ReconciliationGrant {
  readonly token: ScheduleToken;
  readonly attempt: ActionAttempt;
  readonly command: ActionCommand;
  readonly decision: PolicyDecision;
}

export interface AuthorizeActionCommand {
  readonly proposalId: string;
  /** The agent definition the run is pinned to (registry). */
  readonly agent: Pick<AgentDefinition, 'agentId' | 'version' | 'capabilityScopes'>;
  /** The registered capability the proposal resolved to. */
  readonly capability: CapabilityDefinition;
  /** Its declared write semantics; null when it cannot execute (no write handlers). */
  readonly semantics: WriteExecutionSemantics | null;
  readonly validatedArguments: JsonObject;
}

export interface RejectActionCommand {
  readonly proposalId: string;
  readonly cause: string;
  readonly message: string;
  readonly details: JsonValue | null;
  /** Resolved capability version, when the capability exists. */
  readonly capabilityVersion?: number | null;
}

const RUNTIME = 'r4.governed-execution';

/**
 * Action Runtime (R4-D): platform authority over the life of every effect.
 *
 *   proposal (durable, with its step) → authorize: Policy Engine → decision
 *   (+ command with a platform execution key, atomically, on ALLOW) →
 *   advance: attempt row (fenced) → [external call by the ActionExecutor] →
 *   record: attempt outcome → receipt + observation + step (atomically)
 *
 * Every method is one fenced transaction (same rule as the Execution
 * Runtime): a worker that lost its lease can neither start an attempt nor
 * record an outcome, however late it comes back. The external call itself
 * is outside any transaction; the attempt row written before it and the
 * command's single execution key are what make its outcome recoverable
 * (ADR-019). Nothing here trusts model output: the proposal is data, the
 * policy input is built from durable records, and the next attempt is chosen
 * from the attempt log, never by the caller.
 */
export class ActionRuntime {
  readonly #store: ExecutionStore;
  readonly #authorizer: ActionAuthorizer;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #logger: StructuredLogger;
  readonly #temporal: TemporalRuntime | undefined;

  constructor(options: ActionRuntimeOptions) {
    this.#store = options.store;
    this.#authorizer = options.authorizer;
    this.#ids = options.ids;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#temporal = options.temporal;
  }

  get policy(): ActionAuthorizer['identity'] {
    return this.#authorizer.identity;
  }

  /**
   * (R4-E) A proposal of an earlier run that the platform must resolve before
   * the model is asked anything: approved by a human (evaluate it again), or
   * rejected / expired / withdrawn (observe that outcome). Read-only — the
   * kernel drives it through `executeAction` like any pending action.
   */
  pendingApproval(token: LeaseToken): Promise<{ step: RunStep; decision: ProposeActionDecision } | null> {
    return this.#store.transaction(async (uow) => {
      const owned = await lockOwnedExecution(uow, token);
      const proposalId = await uow.temporal?.pendingApprovalProposal(owned.task.taskId);
      if (!proposalId) return null;
      const { step } = await loadState(uow, owned, proposalId);
      return step.decision?.type === 'propose_action' ? { step, decision: step.decision } : null;
    });
  }

  /**
   * Durable retry backoff (R4-E): between two attempts of one command the run
   * keeps its place but gives up its lease, and an `action_retry` schedule
   * holds the task back until the delay passes — no worker sleeps on it.
   * The delay is the command's declared semantics (initial backoff, doubling
   * per attempt made; bounded by its declared maximum attempts).
   */
  deferRetry(token: LeaseToken, proposalId: string): Promise<boolean> {
    return this.#write(token, async (uow, owned, events, timestamp) => {
      const state = await loadState(uow, owned, proposalId);
      const last = state.attempts.at(-1);
      const execution = state.execution;
      if (!last || !execution || execution.semantics.initialBackoffMs === 0 || state.next?.kind !== 'attempt') return false;
      const delay = execution.semantics.initialBackoffMs * 2 ** Math.max(0, state.attempts.length - 1);
      const dueAt = new Date(Date.parse(last.finishedAt ?? last.startedAt) + delay).toISOString();
      if (Date.parse(timestamp) >= Date.parse(dueAt)) return false;
      if (!this.#temporal) throw new PlatformError('precondition', 'temporal_unavailable', 'durable retry scheduling requires the temporal runtime');
      await this.#temporal.scheduleWithin(uow, owned.task, 'action_retry', last.attemptId, dueAt, timestamp, events);
      await uow.releaseLease(token);
      return true;
    });
  }

  /**
   * (R4-E) Makes a human's rejection (or expiry / withdrawal) of the approval
   * request an observation of the proposal: the agent sees "this action was
   * rejected", linked to the proposal and the request. Nothing was executed.
   */
  async observeApprovalOutcome(token: LeaseToken, proposalId: string): Promise<ActionProgress> {
    return this.#write(token, async (uow, owned, events, timestamp) => {
      const state = await loadState(uow, owned, proposalId);
      if (state.phase !== 'awaiting_approval_outcome') return progressOf(state);
      const approval = (await temporalOf(uow).humanByProposal(proposalId))!;
      const code = approval.status === 'rejected' ? 'approval_rejected' : approval.status === 'expired' ? 'approval_expired' : 'approval_cancelled';
      const observation = this.#observation(state, {
        timestamp,
        capabilityVersion: approval.payload.capabilityVersion,
        policyDecisionId: approval.payload.policyDecisionId,
        executionId: null,
        receiptId: null,
        approvalRequestId: approval.requestId,
        outcome: 'rejected',
        payload: null,
        error: {
          code,
          message: approval.status === 'rejected' ? 'a human rejected the approval request; the action was not executed' : `the approval request was ${approval.status}; the action was not executed`,
          details: { approvalRequestId: approval.requestId, proposalId, decision: approval.status, decidedBy: approval.humanRef, policyDecisionId: approval.payload.policyDecisionId },
        },
        provenance: { runtime: RUNTIME, stage: 'approval', approvalRequestId: approval.requestId, decision: approval.status },
      });
      return this.#observe(uow, state, observation, token, events, timestamp);
    });
  }

  /** Where the proposal of the active run stands (recovery starts here). */
  loadAction(token: LeaseToken, proposalId: string): Promise<ActionProgress> {
    return this.#store.transaction(async (uow) => {
      const owned = await lockOwnedExecution(uow, token);
      return progressOf(await loadState(uow, owned, proposalId));
    });
  }

  /** The proposal cannot become a command (unknown capability, not a write, invalid arguments): observed as such. */
  async rejectAction(token: LeaseToken, command: RejectActionCommand): Promise<ActionProgress> {
    return this.#write(token, async (uow, owned, events, timestamp) => {
      const state = await loadState(uow, owned, command.proposalId);
      if (state.phase !== 'awaiting_authorization') return progressOf(state);
      const observation = this.#observation(state, {
        timestamp,
        capabilityVersion: command.capabilityVersion ?? null,
        policyDecisionId: null,
        executionId: null,
        receiptId: null,
        outcome: 'rejected',
        payload: null,
        error: { code: 'write_validation_failure', message: truncate(command.message), details: { cause: command.cause, details: command.details } },
        provenance: { runtime: RUNTIME, stage: 'validation', cause: command.cause },
      });
      events.push(['action.failed', { ...telemetryOf(state, token), stage: 'validation', code: 'write_validation_failure', cause: command.cause }]);
      return this.#observe(uow, state, observation, token, events, timestamp);
    });
  }

  /**
   * Asks the Policy Engine and makes its decision durable, in one fenced
   * transaction together with its consequence:
   *
   * - ALLOW            → the command (platform execution key, trusted context,
   *                      validated arguments, declared write semantics)
   * - DENY             → an observation of the denial; the agent continues
   * - REQUIRE_APPROVAL → an observation, the run suspended, the task
   *                      `requires_approval`, the lease released. Nothing executes.
   *
   * Idempotent: a proposal that already has a decision is not evaluated again.
   */
  async authorizeAction(token: LeaseToken, command: AuthorizeActionCommand): Promise<ActionProgress> {
    return this.#write(token, async (uow, owned, events, timestamp) => {
      const state = await loadState(uow, owned, command.proposalId);
      if (state.phase !== 'awaiting_authorization') return progressOf(state);
      const { proposal } = state;
      const { task, run } = owned;
      const { capability, agent, semantics } = command;
      if (capability.capabilityId !== proposal.capabilityId) {
        throw new PlatformError('conflict', 'capability_mismatch', 'the resolved capability is not the proposed one');
      }
      if (agent.agentId !== run.agentId || agent.version !== run.agentVersion) {
        throw new PlatformError('conflict', 'agent_mismatch', 'the agent definition is not the one the run is pinned to');
      }

      // The trusted context comes from durable records only: never from the proposal.
      const context: TrustedActionContext = parseOrThrow(trustedActionContextSchema, {
        taskId: task.taskId,
        runId: run.runId,
        agentId: run.agentId,
        agentVersion: run.agentVersion,
        correlationId: task.correlationId,
        grantedScopes: agent.capabilityScopes,
        actor: task.requestedBy,
        identityAssurance: identityAssuranceOf(task.requestedBy),
      });
      const approval = await uow.temporal?.humanByProposal(proposal.proposalId);
      const approvalEvidence = approval?.status === 'approved' ? {
        requestId: approval.requestId, proposalId: approval.payload.proposalId, capabilityId: approval.payload.capabilityId,
        capabilityVersion: approval.payload.capabilityVersion, argumentsMatch: approval.payload.argumentsHash === fingerprint(command.validatedArguments),
      } : undefined;
      const evaluation = this.#authorizer.evaluate({
        ...(approvalEvidence ? { approval: approvalEvidence } : {}),
        proposal: { proposalId: proposal.proposalId, evidenceRefs: proposal.evidenceRefs },
        agent: { agentId: agent.agentId, version: agent.version, capabilityScopes: agent.capabilityScopes },
        task: { taskId: task.taskId, status: task.status },
        context,
        capability: {
          capabilityId: capability.capabilityId,
          version: capability.version,
          riskClass: capability.riskClass,
          requiredScopes: capability.requiredScopes,
          identityRequirement: capability.identityRequirement,
          confirmationPolicy: capability.confirmationPolicy,
          approvalPolicy: capability.approvalPolicy,
          idempotency: capability.idempotency,
          writeRecovery: semantics?.recovery ?? null,
        },
      });
      // Defense in depth: no authorizer can make a read, or a write without safe semantics, executable.
      if (evaluation.outcome === 'allow' && (capability.riskClass === 'READ' || semantics === null)) {
        throw new PlatformError('internal', 'unexecutable_action_allowed', `the authorizer allowed ${capability.capabilityId}, which cannot execute safely`);
      }
      const decision = parseOrThrow(policyDecisionSchema, {
        decisionId: this.#ids.next(),
        proposalId: proposal.proposalId,
        taskId: task.taskId,
        runId: run.runId,
        agentId: run.agentId,
        agentVersion: run.agentVersion,
        capabilityId: capability.capabilityId,
        capabilityVersion: capability.version,
        riskClass: capability.riskClass,
        outcome: evaluation.outcome,
        reasonCode: evaluation.reasonCode,
        rule: evaluation.rule,
        message: truncate(evaluation.message),
        policy: this.#authorizer.identity,
        identityAssurance: context.identityAssurance,
        leaseGeneration: token.generation,
        correlationId: task.correlationId,
        evaluatedAt: timestamp,
      });
      await uow.insertPolicyDecision(decision);
      const base = telemetryOf(state, token);
      events.push(['policy.evaluated', { ...base, capabilityId: decision.capabilityId, riskClass: decision.riskClass, outcome: decision.outcome, reasonCode: decision.reasonCode, rule: decision.rule, policyId: decision.policy.policyId, policyVersion: decision.policy.version }]);
      const decided: ActionState = { ...state, decision };

      if (decision.outcome === 'allow') {
        const executionId = this.#ids.next();
        const execution = parseOrThrow(actionExecutionSchema, {
          executionId,
          proposalId: proposal.proposalId,
          policyDecisionId: decision.decisionId,
          taskId: task.taskId,
          runId: run.runId,
          capabilityId: capability.capabilityId,
          capabilityVersion: capability.version,
          riskClass: capability.riskClass,
          executionKey: executionKeyFor(executionId),
          semantics,
          validatedArguments: command.validatedArguments,
          trustedContext: context,
          correlationId: task.correlationId,
          createdAt: timestamp,
          status: 'prepared',
          version: 1,
          updatedAt: timestamp,
        });
        await uow.insertActionExecution(execution);
        events.push(['action.command.created', { ...base, executionId, capabilityId: execution.capabilityId, riskClass: execution.riskClass, recovery: execution.semantics.recovery, maxAttempts: execution.semantics.maxAttempts }]);
        return progressOf({ ...decided, execution, phase: 'executing', next: nextActionStep(execution, []) });
      }

      const observation = this.#observation(decided, {
        timestamp,
        capabilityVersion: capability.version,
        policyDecisionId: decision.decisionId,
        executionId: null,
        receiptId: null,
        outcome: 'rejected',
        payload: null,
        error: {
          code: decision.outcome === 'deny' ? 'policy_denied' : 'approval_required',
          message: decision.message,
          details: { policyDecisionId: decision.decisionId, reasonCode: decision.reasonCode, rule: decision.rule, policyId: decision.policy.policyId, policyVersion: decision.policy.version },
        },
        provenance: { runtime: RUNTIME, stage: 'policy', riskClass: decision.riskClass, policyId: decision.policy.policyId, policyVersion: decision.policy.version },
      });
      if (decision.outcome === 'deny') {
        events.push(['action.denied', { ...base, capabilityId: decision.capabilityId, riskClass: decision.riskClass, reasonCode: decision.reasonCode }]);
        return this.#observe(uow, decided, observation, token, events, timestamp);
      }
      events.push(['action.approval_required', { ...base, capabilityId: decision.capabilityId, riskClass: decision.riskClass, reasonCode: decision.reasonCode }]);
      const observed = await this.#observe(uow, decided, observation, token, events, timestamp);
      const suspended = await this.#suspend(uow, owned, observed.state, token, {
        reason: 'approval_required',
        code: decision.reasonCode,
        message: decision.message,
        details: { proposalId: proposal.proposalId, policyDecisionId: decision.decisionId, capabilityId: decision.capabilityId, riskClass: decision.riskClass },
      }, timestamp, events);
      // (R4-E) The approval request is bound to exactly this proposal, capability version and validated arguments.
      if (this.#temporal && uow.temporal) {
        const suspendedTask = (await uow.lockTask(task.taskId))!;
        await this.#temporal.requestApprovalWithin(uow, suspendedTask, {
          requestId: this.#ids.next(), taskId: task.taskId, runId: run.runId, kind: 'approval', status: 'requested', humanRef: null,
          createdAt: timestamp, updatedAt: timestamp, expiresAt: null, correlationId: task.correlationId,
          payload: {
            proposalId: proposal.proposalId, policyDecisionId: decision.decisionId, capabilityId: capability.capabilityId, capabilityVersion: capability.version,
            argumentsHash: fingerprint(command.validatedArguments), validatedArguments: command.validatedArguments,
          },
        }, timestamp, events);
      }
      return suspended;
    });
  }

  /**
   * Moves a command forward by the rule of its attempt log (ADR-018):
   * grants the next external call after making its attempt row durable
   * (fence verified immediately before the call), or settles the command
   * when no call may be made — a definitive "not applied" receipt, or a
   * suspension when the outcome cannot be established.
   */
  async advanceAction(token: LeaseToken, proposalId: string): Promise<ActionProgress | ActionAttemptGrant> {
    return this.#write(token, async (uow, owned, events, timestamp): Promise<ActionProgress | ActionAttemptGrant> => {
      const state = await loadState(uow, owned, proposalId);
      if (state.phase !== 'executing') return progressOf(state);
      const execution = state.execution!;
      const next = state.next!;
      switch (next.kind) {
        case 'resolved':
          throw new PlatformError('internal', 'unobserved_receipt', `execution ${execution.executionId} has a receipt but no observation`);
        case 'uncertain':
          return this.#uncertain(uow, owned, state, token, next.code, timestamp, events);
        case 'not_applied':
          return this.settleWithin(uow, state, next.attempt, null, token, events, timestamp);
        case 'attempt': {
          const attempt = parseOrThrow(actionAttemptSchema, {
            attemptId: this.#ids.next(),
            executionId: execution.executionId,
            attemptNumber: next.attemptNumber,
            kind: next.attemptKind,
            workerId: token.owner,
            leaseGeneration: token.generation,
            startedAt: timestamp,
            finishedAt: null,
            outcome: null,
            errorCode: null,
            detail: null,
          });
          await uow.insertActionAttempt(attempt);
          const current = execution.status === 'executing' ? execution : await this.#setStatus(uow, execution, 'executing', timestamp);
          return { kind: 'attempt', state: { ...state, execution: current, attempts: [...state.attempts, attempt] }, attempt, command: commandOf(current), decision: state.decision! };
        }
      }
    });
  }

  /**
   * Records what an attempt established. A definitive outcome produces the
   * receipt, the observation and the step completion atomically (window C
   * closes here); an unknown one is kept as such and the attempt log decides
   * what may follow.
   */
  async recordAttempt(token: LeaseToken, proposalId: string, attemptId: string, report: ActionAttemptReport): Promise<ActionProgress> {
    return this.#write(token, async (uow, owned, events, timestamp) => {
      const state = await loadState(uow, owned, proposalId);
      const attempt = state.attempts.find((a) => a.attemptId === attemptId);
      if (!attempt) throw new PlatformError('conflict', 'unknown_attempt', `attempt ${attemptId} is not an attempt of proposal ${proposalId}`);
      if (attempt.outcome !== null) {
        throw new PlatformError('conflict', 'attempt_already_recorded', `attempt ${attemptId} already has an outcome`);
      }
      if (state.attempts.at(-1)?.attemptId !== attemptId) {
        throw new PlatformError('conflict', 'attempt_superseded', `attempt ${attemptId} is no longer the latest attempt`);
      }
      const finished = parseOrThrow(actionAttemptSchema, {
        ...attempt,
        finishedAt: timestamp,
        outcome: report.outcome,
        errorCode: report.errorCode,
        detail: { message: report.message === null ? null : truncate(report.message), replayed: report.replayed, durationMs: report.durationMs, details: report.details },
      });
      if (!(await uow.finishActionAttempt(finished))) {
        throw new PlatformError('conflict', 'attempt_already_recorded', `attempt ${attemptId} already has an outcome`);
      }
      const execution = state.execution!;
      events.push(['action.attempt.recorded', { ...telemetryOf(state, token), executionId: execution.executionId, capabilityId: execution.capabilityId, riskClass: execution.riskClass, attempt: finished.attemptNumber, kind: finished.kind, outcome: finished.outcome, errorCode: finished.errorCode, replayed: report.replayed, durationMs: report.durationMs }]);
      const attempts = state.attempts.map((a) => (a.attemptId === attemptId ? finished : a));
      const updated: ActionState = { ...state, attempts };

      if (report.outcome === 'applied' || report.outcome === 'rejected' || report.outcome === 'failed') {
        return this.settleWithin(uow, updated, finished, report, token, events, timestamp);
      }
      const next = nextActionStep(execution, attempts);
      if (next.kind === 'uncertain') return this.#uncertain(uow, owned, { ...updated, next }, token, next.code, timestamp, events);
      if (next.kind === 'not_applied') return this.settleWithin(uow, updated, next.attempt, null, token, events, timestamp);
      return progressOf({ ...updated, next });
    });
  }

  // -------------------------------------------------------------------------
  // (R4-E) Reconciliation of uncertain effects
  // -------------------------------------------------------------------------

  /**
   * Claims dispatched reconciliation work (the scheduler decided it is due)
   * and grants exactly one `reconcile` attempt of the SAME command — same
   * execution key, next attempt number — after making it durable. Fenced by
   * the schedule's lease + generation instead of a task lease: reconciliation
   * runs no cognition and needs no run, so it also settles the effects of
   * tasks that are cancelling or already failed. Returns null when no work is
   * dispatched; work found already settled or out of attempts/time is closed
   * on the way (exhausted work waits for an operator, the outcome stays unknown).
   */
  async claimReconciliation(command: { workerId: string; leaseDurationMs: number }): Promise<ReconciliationGrant | null> {
    for (;;) {
      const claimed = await this.#store.transaction((uow) => temporalOf(uow).claimReconciliation(command.workerId, command.leaseDurationMs));
      if (!claimed) return null;
      const token: ScheduleToken = { scheduleId: claimed.scheduleId, taskId: claimed.taskId, owner: command.workerId, generation: claimed.generation };
      const grant = await this.#scheduleWrite(token, async (uow, schedule, events, timestamp) => {
        const temporal = this.#requireTemporal();
        const task = (await uow.lockTask(schedule.taskId))!;
        const execution = await temporalOf(uow).execution(schedule.referenceId);
        if (!execution || execution.taskId !== schedule.taskId) throw new PlatformError('internal', 'reconciliation_target_mismatch', 'reconciliation work must reference an execution of its task');
        const close = async (status: 'completed' | 'exhausted', data: Record<string, unknown>) => {
          await temporalOf(uow).updateSchedule({ ...schedule, status, owner: null, leaseExpiresAt: null, updatedAt: timestamp });
          await temporal.event(uow, task, schedule.scheduleId, status === 'completed' ? 'reconciliation.resolved' : 'reconciliation.unresolved', timestamp, events, { executionId: execution.executionId, attempts: schedule.attempts, ...data }, command.workerId);
        };
        if (execution.status !== 'needs_reconciliation' && execution.status !== 'executing') {
          await close('completed', { alreadySettled: true });
          return null;
        }
        const policy = schedule.policy!;
        if (schedule.attempts >= policy.maxAttempts || Date.parse(timestamp) >= Date.parse(schedule.deadlineAt!)) {
          await close('exhausted', { exhausted: true });
          return null;
        }
        const state = await readActionState(uow, execution.proposalId);
        if (state.decision?.outcome !== 'allow' || state.decision.decisionId !== execution.policyDecisionId) {
          throw new PlatformError('internal', 'command_not_authorized', 'an uncertain command must stand on its ALLOW decision');
        }
        const attempt = parseOrThrow(actionAttemptSchema, {
          attemptId: this.#ids.next(),
          executionId: execution.executionId,
          attemptNumber: state.attempts.length + 1,
          kind: 'reconcile',
          workerId: command.workerId,
          leaseGeneration: token.generation,
          startedAt: timestamp,
          finishedAt: null,
          outcome: null,
          errorCode: null,
          detail: null,
        });
        await uow.insertActionAttempt(attempt);
        const current = execution.status === 'executing' ? execution : await this.#setStatus(uow, execution, 'executing', timestamp);
        await temporalOf(uow).updateSchedule({ ...schedule, attempts: schedule.attempts + 1, updatedAt: timestamp });
        await temporal.event(uow, task, schedule.scheduleId, 'reconciliation.attempted', timestamp, events, { executionId: execution.executionId, attempt: attempt.attemptNumber, reconciliationAttempt: schedule.attempts + 1 }, command.workerId);
        return { token, attempt, command: commandOf(current), decision: state.decision } satisfies ReconciliationGrant;
      });
      if (grant) return grant;
    }
  }

  /**
   * Records what a reconcile attempt established. Known → receipt +
   * observation (+ the proposal's step), the work completes, and the task
   * becomes runnable (or reaches its deferred terminal status). Unknown →
   * the attempt stays unknown, the execution uncertain, and the work is
   * rescheduled by its durable policy (or exhausted). Never guessed.
   */
  async recordReconciliation(token: ScheduleToken, attemptId: string, report: ActionAttemptReport): Promise<'resolved' | 'rescheduled' | 'exhausted'> {
    return this.#scheduleWrite(token, async (uow, schedule, events, timestamp) => {
      const temporal = this.#requireTemporal();
      const p = temporalOf(uow);
      const task = (await uow.lockTask(schedule.taskId))!;
      const execution = (await p.execution(schedule.referenceId))!;
      const state = await readActionState(uow, execution.proposalId);
      const attempt = state.attempts.find((a) => a.attemptId === attemptId);
      if (!attempt || attempt.kind !== 'reconcile') throw new PlatformError('conflict', 'unknown_attempt', `attempt ${attemptId} is not a reconciliation of this work`);
      if (state.attempts.at(-1)?.attemptId !== attemptId || attempt.outcome !== null) throw new PlatformError('conflict', 'attempt_superseded', 'a newer reconciliation owns this execution');
      const finished = parseOrThrow(actionAttemptSchema, {
        ...attempt,
        finishedAt: timestamp,
        outcome: report.outcome,
        errorCode: report.errorCode,
        detail: { message: report.message === null ? null : truncate(report.message), replayed: report.replayed, durationMs: report.durationMs, details: report.details, fencedBy: 'schedule', scheduleId: schedule.scheduleId },
      });
      if (!(await uow.finishActionAttempt(finished))) throw new PlatformError('conflict', 'attempt_already_recorded', `attempt ${attemptId} already has an outcome`);
      const updated: ActionState = { ...state, attempts: state.attempts.map((a) => (a.attemptId === attemptId ? finished : a)) };
      const telemetryToken: LeaseToken = { taskId: token.taskId, owner: token.owner, generation: token.generation };
      events.push(['action.attempt.recorded', { ...telemetryOf(state, telemetryToken), executionId: execution.executionId, capabilityId: execution.capabilityId, riskClass: execution.riskClass, attempt: finished.attemptNumber, kind: finished.kind, outcome: finished.outcome, errorCode: finished.errorCode, replayed: report.replayed, durationMs: report.durationMs }]);

      if (report.outcome !== 'unknown') {
        // `not_applied` settles as a definitive "not applied" receipt: reconciliation never re-executes.
        await this.settleWithin(uow, updated, finished, report, telemetryToken, events, timestamp);
        await p.updateSchedule({ ...schedule, status: 'completed', owner: null, leaseExpiresAt: null, updatedAt: timestamp });
        await temporal.event(uow, task, schedule.scheduleId, 'reconciliation.resolved', timestamp, events, { executionId: execution.executionId, attempts: schedule.attempts, outcome: report.outcome, elapsedMs: Date.parse(timestamp) - Date.parse(schedule.createdAt) }, token.owner);
        await temporal.settleAfterReconciliationWithin(uow, (await uow.lockTask(task.taskId))!, timestamp, events);
        return 'resolved';
      }
      await this.#setStatus(uow, (await p.execution(execution.executionId))!, 'needs_reconciliation', timestamp);
      const policy = schedule.policy!;
      const exhausted = schedule.attempts >= policy.maxAttempts || Date.parse(timestamp) >= Date.parse(schedule.deadlineAt!);
      const delay = Math.min(policy.maxBackoffMs, policy.initialBackoffMs * 2 ** Math.max(0, schedule.attempts - 1));
      const dueAt = new Date(Math.min(Date.parse(schedule.deadlineAt!), Date.parse(timestamp) + delay)).toISOString();
      const next: Schedule = { ...schedule, status: exhausted ? 'exhausted' : 'pending', dueAt: exhausted ? schedule.dueAt : dueAt, owner: null, leaseExpiresAt: null, updatedAt: timestamp };
      await p.updateSchedule(next);
      await temporal.event(uow, task, schedule.scheduleId, 'reconciliation.unresolved', timestamp, events, { executionId: execution.executionId, attempts: schedule.attempts, exhausted, nextDueAt: exhausted ? null : dueAt, errorCode: report.errorCode }, token.owner);
      return exhausted ? 'exhausted' : 'rescheduled';
    });
  }

  #requireTemporal(): TemporalRuntime {
    if (!this.#temporal) throw new PlatformError('precondition', 'temporal_unavailable', 'reconciliation requires the temporal runtime');
    return this.#temporal;
  }

  /** One transaction fenced by a schedule token (task row lock first, then the schedule). */
  async #scheduleWrite<T>(token: ScheduleToken, fn: (uow: ExecutionUnitOfWork, schedule: Schedule, events: PendingEvent[], timestamp: string) => Promise<T>): Promise<T> {
    const events: PendingEvent[] = [];
    const result = await this.#store.transaction(async (uow) => {
      if (!(await uow.lockTask(token.taskId))) throw new PlatformError('not_found', 'task_not_found', 'task not found');
      const p = temporalOf(uow);
      const schedule = await p.lockSchedule(token);
      if (schedule.kind !== 'reconciliation' || schedule.status !== 'in_progress') throw new PlatformError('conflict', 'schedule_lease_lost', 'reconciliation work is not held');
      return fn(uow, schedule, events, await p.now());
    });
    for (const [name, fields] of events) emitTelemetry(this.#logger, name, fields);
    return result;
  }

  /** Receipt + observation + step, one transaction: the agent sees an outcome only with its evidence. */
  async settleWithin(
    uow: ExecutionUnitOfWork,
    state: ActionState,
    attempt: ActionAttempt,
    report: ActionAttemptReport | null,
    token: LeaseToken,
    events: PendingEvent[],
    timestamp: string,
  ): Promise<ActionProgress> {
    const execution = state.execution!;
    const outcome = report?.outcome ?? attempt.outcome;
    if (outcome !== 'applied' && outcome !== 'rejected' && outcome !== 'failed' && outcome !== 'not_applied') {
      throw new PlatformError('internal', 'unresolvable_outcome', `outcome ${String(outcome)} does not resolve an action`);
    }
    const status = receiptStatusFor(outcome);
    const receipt = parseOrThrow(actionReceiptSchema, {
      receiptId: this.#ids.next(),
      executionId: execution.executionId,
      proposalId: execution.proposalId,
      taskId: execution.taskId,
      runId: execution.runId,
      capabilityId: execution.capabilityId,
      capabilityVersion: execution.capabilityVersion,
      executionKey: execution.executionKey,
      status,
      resourceRef: outcome === 'applied' ? (report?.resourceRef ?? null) : null,
      externalOperationRef: outcome === 'applied' ? (report?.externalOperationRef ?? null) : null,
      result: outcome === 'applied' ? (report?.result ?? null) : null,
      error:
        outcome === 'applied'
          ? null
          : outcome === 'not_applied'
            ? { code: 'write_not_applied', message: 'reconciliation established that the command was never applied, and no execution attempt remains', details: null }
            : { code: report?.errorCode ?? outcome, message: truncate(report?.message ?? ''), details: report?.details ?? null },
      executedAt: (outcome === 'applied' ? report?.executedAt : null) ?? timestamp,
      recordedAt: timestamp,
      evidence: { obtainedVia: attempt.kind, attemptId: attempt.attemptId, attemptNumber: attempt.attemptNumber, attempts: state.attempts.length, replayed: report?.replayed ?? false },
      correlationId: execution.correlationId,
    });
    await uow.insertActionReceipt(receipt);
    const resolved = await this.#setStatus(uow, execution, status, timestamp);
    const base = { ...telemetryOf(state, token), executionId: execution.executionId, capabilityId: execution.capabilityId, riskClass: execution.riskClass, attempt: attempt.attemptNumber };
    events.push(['action.receipt.persisted', { ...base, receiptId: receipt.receiptId, status: receipt.status, obtainedVia: receipt.evidence.obtainedVia, attempts: receipt.evidence.attempts, replayed: receipt.evidence.replayed, receiptLatencyMs: Date.parse(timestamp) - Date.parse(execution.createdAt) }]);
    if (status !== 'succeeded') events.push(['action.failed', { ...base, stage: 'execution', status, code: receipt.error?.code ?? null }]);

    const observation = this.#observation(state, {
      timestamp,
      capabilityVersion: execution.capabilityVersion,
      policyDecisionId: execution.policyDecisionId,
      executionId: execution.executionId,
      receiptId: receipt.receiptId,
      ...(status === 'succeeded'
        ? {
            outcome: 'succeeded' as const,
            payload: { receiptId: receipt.receiptId, status: receipt.status, resourceRef: receipt.resourceRef, externalOperationRef: receipt.externalOperationRef, result: receipt.result, executedAt: receipt.executedAt },
            error: null,
          }
        : {
            outcome: status === 'rejected' ? ('rejected' as const) : ('failed' as const),
            payload: null,
            error: {
              code: status === 'rejected' ? ('action_rejected' as const) : ('write_execution_failure' as const),
              message: receipt.error!.message,
              details: { receiptId: receipt.receiptId, domainCode: receipt.error!.code, details: receipt.error!.details },
            },
          }),
      provenance: { runtime: RUNTIME, stage: 'execution', riskClass: execution.riskClass, obtainedVia: receipt.evidence.obtainedVia, attempts: receipt.evidence.attempts, policyDecisionId: execution.policyDecisionId },
    });
    return this.#observe(uow, { ...state, execution: resolved, receipt }, observation, token, events, timestamp);
  }

  /** The outcome cannot be established: flag it, suspend the run, block the task. Never guessed. */
  async #uncertain(
    uow: ExecutionUnitOfWork,
    owned: OwnedExecution,
    state: ActionState,
    token: LeaseToken,
    code: UncertainOutcomeCode,
    timestamp: string,
    events: PendingEvent[],
  ): Promise<ActionProgress> {
    const execution = state.execution!;
    const flagged = execution.status === 'needs_reconciliation' ? execution : await this.#setStatus(uow, execution, 'needs_reconciliation', timestamp);
    const last = state.attempts.at(-1) ?? null;
    events.push(['action.outcome_uncertain', { ...telemetryOf(state, token), executionId: execution.executionId, capabilityId: execution.capabilityId, riskClass: execution.riskClass, attempts: state.attempts.length, code, cause: 'unresolvable' }]);
    // The reconciliation work itself is created with the flag, in this transaction (0005 trigger).
    const suspended = await this.#suspend(uow, owned, { ...state, execution: flagged, next: { kind: 'uncertain', code } }, token, {
      reason: 'write_outcome_uncertain',
      code,
      message: code === 'write_reconciliation_failure' ? 'the action outcome could not be reconciled; it is not known whether the effect happened' : 'the action outcome is unknown and no safe attempt remains',
      details: {
        proposalId: execution.proposalId,
        executionId: execution.executionId,
        attempts: state.attempts.length,
        lastAttempt: last === null ? null : { kind: last.kind, outcome: last.outcome, errorCode: last.errorCode },
      },
    }, timestamp, events);
    if (this.#temporal && uow.temporal) {
      await this.#temporal.blockOnUncertainWithin(uow, (await uow.lockTask(owned.task.taskId))!, owned.run.runId, execution.executionId, timestamp, events);
    }
    return suspended;
  }

  /** Ends the run as suspended and moves the task to where it waits, releasing the lease — atomically. */
  async #suspend(
    uow: ExecutionUnitOfWork,
    owned: OwnedExecution,
    state: ActionState,
    token: LeaseToken,
    ending: { reason: 'approval_required' | 'write_outcome_uncertain'; code: string; message: string; details: JsonValue },
    timestamp: string,
    events: PendingEvent[],
  ): Promise<ActionProgress> {
    const run = await finishRunWithin(
      uow,
      (await uow.findActiveRun(owned.task.taskId)) ?? owned.run,
      { status: runStatusForTermination(ending.reason), termination: ending, correlationId: owned.task.correlationId },
      timestamp,
      events,
    );
    const task = await transitionTaskWithin(uow, this.#ids, owned.task, taskStatusForTermination(ending.reason), ending.reason, workerPrincipal(token.owner), owned.task.correlationId, timestamp, events);
    await uow.releaseLease(token);
    events.push(['run.suspended', { taskId: task.taskId, runId: run.runId, agentId: task.agentId, workerId: token.owner, terminationReason: ending.reason, code: ending.code, taskStatus: task.status }]);
    return { kind: 'suspended', state, termination: run.termination! };
  }

  async #observe(uow: ExecutionUnitOfWork, state: ActionState, observation: Observation, token: LeaseToken, events: PendingEvent[], timestamp: string): Promise<ActionProgress & { kind: 'observed' }> {
    const stored = await uow.insertObservation(observation);
    const observed: RunStep = { ...state.step, outcome: 'observed', observationId: stored.observationId, completedAt: timestamp };
    if (state.step.outcome === 'pending' && !(await uow.completePendingStep(observed))) {
      throw new PlatformError('conflict', 'step_not_pending', `step ${state.step.stepId} is no longer pending`);
    }
    events.push(['action.observation.persisted', { ...telemetryOf(state, token), observationId: stored.observationId, outcome: stored.outcome, errorCode: stored.error?.code ?? null, executionId: state.execution?.executionId ?? null }]);
    return { kind: 'observed', state: { ...state, step: observed, observation: stored, phase: 'observed', next: null }, observation: stored };
  }

  #observation(
    state: ActionState,
    fields: {
      timestamp: string;
      capabilityVersion: number | null;
      policyDecisionId: string | null;
      executionId: string | null;
      receiptId: string | null;
      approvalRequestId?: string | null;
      outcome: Observation['outcome'];
      payload: JsonValue | null;
      error: Observation['error'];
      provenance: JsonObject;
    },
  ): Observation {
    const { proposal } = state;
    return parseOrThrow(observationSchema, {
      observationId: this.#ids.next(),
      taskId: proposal.taskId,
      runId: proposal.runId,
      agentId: proposal.agentId,
      source: {
        kind: 'action',
        capabilityId: proposal.capabilityId,
        capabilityVersion: fields.capabilityVersion,
        proposalId: proposal.proposalId,
        policyDecisionId: fields.policyDecisionId,
        executionId: fields.executionId,
        receiptId: fields.receiptId,
        approvalRequestId: fields.approvalRequestId ?? null,
      },
      outcome: fields.outcome,
      payload: fields.payload,
      error: fields.error,
      observedAt: fields.timestamp,
      // A receipt is point-in-time evidence of what happened, not a statement
      // about the resource's current state: it never becomes "current".
      validUntil: null,
      provenance: fields.provenance,
      correlationId: proposal.correlationId,
    });
  }

  async #setStatus(uow: ExecutionUnitOfWork, execution: ActionExecution, status: ActionExecution['status'], timestamp: string): Promise<ActionExecution> {
    assertExecutionTransition(execution.status, status);
    const updated: ActionExecution = { ...execution, status, version: execution.version + 1, updatedAt: timestamp };
    if (!(await uow.updateActionExecutionStatus(updated, execution.version))) {
      throw new PlatformError('conflict', 'version_conflict', `action execution ${execution.executionId} changed concurrently`);
    }
    return updated;
  }

  /** One fenced transaction; telemetry only after commit. */
  async #write<T>(token: LeaseToken, fn: (uow: ExecutionUnitOfWork, owned: OwnedExecution, events: PendingEvent[], timestamp: string) => Promise<T>): Promise<T> {
    const events: PendingEvent[] = [];
    const result = await this.#store.transaction(async (uow) => {
      const owned = await lockOwnedExecution(uow, token);
      return fn(uow, owned, events, uow.temporal ? await uow.temporal.now() : this.#clock.now().toISOString());
    });
    for (const [name, fields] of events) emitTelemetry(this.#logger, name, fields);
    return result;
  }
}

/** The immutable command part of an execution record. */
export function commandOf(execution: ActionExecution): ActionCommand {
  const { status: _status, version: _version, updatedAt: _updatedAt, ...command } = execution;
  return command;
}

/** Platform execution key of a command: derived from its durable id, so it can never change. */
export function executionKeyFor(executionId: string): string {
  return `r4x_${executionId.replace(/-/g, '')}`;
}

/** Human approval outcomes the agent must observe (nothing was executed). */
const UNAPPROVED = new Set(['rejected', 'expired', 'cancelled']);

/**
 * A proposal of the active run — or (R4-E) of an earlier run of the same
 * task whose human approval outcome must still be resolved by this run.
 */
async function loadState(uow: ExecutionUnitOfWork, owned: OwnedExecution, proposalId: string): Promise<ActionState> {
  const proposal = await uow.findActionProposal(proposalId);
  const approval = await uow.temporal?.humanByProposal(proposalId);
  const carried = approval !== null && approval !== undefined && (approval.status === 'approved' || UNAPPROVED.has(approval.status));
  if (!proposal || proposal.taskId !== owned.task.taskId || (proposal.runId !== owned.run.runId && !carried)) {
    throw new PlatformError('conflict', 'unknown_proposal', `proposal ${proposalId} is not an action of the active run`);
  }
  return readActionState(uow, proposalId);
}

/** Internal ledger reader; callers must enforce task, lease or schedule ownership first. */
export async function readActionState(uow: ExecutionUnitOfWork, proposalId: string): Promise<ActionState> {
  const proposal = await uow.findActionProposal(proposalId);
  if (!proposal) throw new PlatformError('not_found', 'proposal_not_found', 'proposal not found');
  const step = (await uow.listRunSteps(proposal.runId)).find((s) => s.stepId === proposal.stepId);
  if (!step) throw new PlatformError('internal', 'proposal_step_missing', `proposal ${proposalId} has no step`);
  // The latest decision: after a human approval there may be a second one; the first is never edited.
  const decision = await uow.findPolicyDecisionByProposal(proposalId);
  const execution = await uow.findActionExecutionByProposal(proposalId);
  const attempts = execution ? await uow.listActionAttempts(execution.executionId) : [];
  const receipt = execution ? await uow.findActionReceiptByExecution(execution.executionId) : null;
  const observation = await uow.findObservationByProposal(proposalId);
  if (execution && !receipt) return { proposal, step, decision, execution, attempts, receipt, observation: null, phase: 'executing', next: nextActionStep(execution, attempts) };
  const approval = await uow.temporal?.humanByProposal(proposalId);
  const stillOriginal = approval !== null && approval !== undefined && decision?.decisionId === approval.payload.policyDecisionId;
  if (stillOriginal && approval.status === 'approved') {
    // Approval is evidence for a NEW policy evaluation, never an ALLOW by itself.
    return { proposal, step, decision, execution, attempts, receipt, observation: null, phase: 'awaiting_authorization', next: null };
  }
  if (stillOriginal && UNAPPROVED.has(approval.status) && observation?.source.kind === 'action' && observation.source.approvalRequestId !== approval.requestId) {
    return { proposal, step, decision, execution, attempts, receipt, observation, phase: 'awaiting_approval_outcome', next: null };
  }
  if (observation) return { proposal, step, decision, execution, attempts, receipt, observation, phase: 'observed', next: null };
  if (decision) throw new PlatformError('internal', 'unconsequenced_decision', `proposal ${proposalId} has a ${decision.outcome} decision without its consequence`);
  return { proposal, step, decision, execution, attempts, receipt, observation, phase: 'awaiting_authorization', next: null };
}

function progressOf(state: ActionState): ActionProgress {
  return state.phase === 'observed' && state.observation ? { kind: 'observed', state, observation: state.observation } : { kind: 'pending', state };
}

function telemetryOf(state: ActionState, token: LeaseToken): Record<string, unknown> {
  return {
    taskId: state.proposal.taskId,
    runId: state.proposal.runId,
    agentId: state.proposal.agentId,
    workerId: token.owner,
    iteration: state.proposal.iteration,
    proposalId: state.proposal.proposalId,
    correlationId: state.proposal.correlationId,
  };
}
