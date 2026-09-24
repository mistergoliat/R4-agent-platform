import { NON_RETRYABLE_MODEL_FAILURE, RUN_FAILURE_RECOVERY_EXHAUSTED, runFailureRecoveryOf } from '@r4/contracts';
import type { InvariantOutcome, ShadowModelCall, WorkloadInvariant } from '@r4/shadow';
import { CAPABILITY_IDS } from '../ids.js';
import { evaluateInvariants, type Invariant } from '../harness/invariants.js';
import type { ConversationState } from '../harness/runtime.js';

/**
 * Interprets a workload's expected properties for one Sales shadow run.
 *
 *   sales.<kind>   an R4-F invariant over durable state (reused, unchanged)
 *   shadow.<kind>  a platform property of the shadow execution itself,
 *                  checked from durable state plus what the executor saw
 *                  (handoff window, rejected inputs, injected faults)
 *
 * A conditional property that never arose (the agent never proposed the
 * write it is about, no approval was ever requested) is `exercised: false` —
 * neither passed nor failed.
 */
export interface ExecutionObservations {
  /** Per applied input: the runs executed from its submission until the next applied input. */
  readonly inputs: readonly { readonly index: number; readonly applied: boolean; readonly runIds: readonly string[]; readonly afterTerminal: boolean }[];
  readonly handoff: { readonly takenOverAt: number | null; readonly releasedAt: number | null; readonly runsDuringHandoff: readonly string[]; readonly runsAfterRelease: readonly string[] } | null;
  readonly cancel: { readonly statusAfterCancel: string; readonly uncertainAtCancel: number } | null;
  readonly modelCalls: readonly ShadowModelCall[];
  /** Quotes the shadow owner recorded (idempotency keys). */
  readonly shadowQuoteKeys: readonly string[];
}

type Outcome = Omit<InvariantOutcome, 'kind' | 'class'>;
const pass = (detail: string): Outcome => ({ exercised: true, passed: true, detail });
const fail = (detail: string): Outcome => ({ exercised: true, passed: false, detail });
const notExercised = (detail: string): Outcome => ({ exercised: false, passed: false, detail });

export function evaluateWorkloadInvariants(invariants: readonly WorkloadInvariant[], state: ConversationState, obs: ExecutionObservations): InvariantOutcome[] {
  return invariants.map((i) => {
    const outcome = i.kind.startsWith('sales.') ? salesInvariant(i, state) : shadowInvariant(i, state, obs);
    return { kind: i.kind, class: i.class, ...outcome, detail: outcome.detail.slice(0, 500) };
  });
}

/** The platform-initiated handoff (ADR-028) opened for a failed run, if any. */
function platformHandoff(state: ConversationState, runId: string, reason: string): { status: string } | null {
  const found = state.temporal.humans.find((h) => h.kind === 'handoff' && h.runId === runId && h.payload.initiatedBy === 'platform' && h.payload.reason === reason);
  return found ? { status: found.status } : null;
}

function salesInvariant(i: WorkloadInvariant, state: ConversationState): Outcome {
  const invariant = { kind: i.kind.slice('sales.'.length), ...i.params } as unknown as Invariant;
  const [result] = evaluateInvariants([invariant], state);
  return result!.passed ? pass(result!.detail) : fail(result!.detail);
}

function shadowInvariant(i: WorkloadInvariant, state: ConversationState, obs: ExecutionObservations): Outcome {
  const runs = [...state.runs].sort((a, b) => a.run.sequence - b.run.sequence);
  const responded = (runIds: readonly string[]) => runs.some((r) => runIds.includes(r.run.runId) && r.steps.some((s) => s.decision?.type === 'respond'));
  const quoteExecutions = state.ledger.executions.filter((e) => e.capabilityId === CAPABILITY_IDS.quoteCreate);
  const quoteReceipts = state.ledger.receipts.filter((r) => r.capabilityId === CAPABILITY_IDS.quoteCreate);
  switch (i.kind) {
    case 'shadow.responded_every_input': {
      const applied = obs.inputs.filter((x) => x.applied);
      const silent = applied.filter((x) => !responded(x.runIds));
      return silent.length === 0 ? pass(`${applied.length} input(s) answered`) : fail(`no response after input(s) ${silent.map((x) => x.index).join(', ')}`);
    }
    case 'shadow.no_autonomous_run_during_handoff': {
      if (!obs.handoff || obs.handoff.takenOverAt === null) return notExercised('no operator takeover happened');
      return obs.handoff.runsDuringHandoff.length === 0 ? pass('0 runs while the human owned the task, although input arrived meanwhile') : fail(`${obs.handoff.runsDuringHandoff.length} run(s) executed while the human owned the task`);
    }
    case 'shadow.resumed_after_release': {
      if (!obs.handoff || obs.handoff.releasedAt === null) return notExercised('the task was never released');
      return responded(obs.handoff.runsAfterRelease) ? pass(`${obs.handoff.runsAfterRelease.length} run(s) after release, with a response`) : fail('no response after the release');
    }
    case 'shadow.approval_reevaluated': {
      const required = state.ledger.decisions.filter((d) => d.outcome === 'require_approval');
      if (required.length === 0) return notExercised('no proposal required approval (the agent did not propose the governed write)');
      const problems: string[] = [];
      for (const d of required) {
        const later = state.ledger.decisions.filter((x) => x.proposalId === d.proposalId && x.decisionId !== d.decisionId);
        const executions = state.ledger.executions.filter((e) => e.proposalId === d.proposalId);
        const allowed = later.filter((x) => x.outcome === 'allow');
        if (executions.length > 1) problems.push(`proposal ${d.proposalId.slice(0, 8)} executed ${executions.length} times`);
        if (executions.some((e) => !allowed.some((a) => a.decisionId === e.policyDecisionId))) problems.push(`proposal ${d.proposalId.slice(0, 8)} executed without a re-evaluated ALLOW`);
        if (later.length === 0 && executions.length > 0) problems.push(`proposal ${d.proposalId.slice(0, 8)} executed with no second policy decision`);
      }
      const approvedAllows = state.ledger.decisions.filter((x) => x.outcome === 'allow' && required.some((r) => r.proposalId === x.proposalId));
      if (problems.length > 0) return fail(problems.join('; '));
      return approvedAllows.length > 0 ? pass(`approval → policy re-evaluated (${approvedAllows.map((a) => a.reasonCode).join(', ')}) → executed once`) : pass('approval requested; no execution without a re-evaluated ALLOW');
    }
    case 'shadow.reconciled_via_scheduler': {
      const schedules = state.temporal.schedules.filter((s) => s.kind === 'reconciliation');
      if (schedules.length === 0) return notExercised(quoteExecutions.length === 0 ? 'the agent proposed no quote' : 'the outcome was established within the run (no scheduled reconciliation)');
      const viaReconcile = quoteReceipts.filter((r) => r.evidence.obtainedVia === 'reconcile');
      const perExecution = new Map<string, number>();
      for (const r of quoteReceipts) perExecution.set(r.executionId, (perExecution.get(r.executionId) ?? 0) + 1);
      const duplicates = [...perExecution.values()].filter((n) => n > 1).length;
      return viaReconcile.length > 0 && duplicates === 0 ? pass(`${schedules.length} reconciliation schedule(s) (${schedules.map((s) => s.status).join(', ')}); receipt obtained via reconcile, same key`) : fail(`schedules ${schedules.map((s) => s.status).join(', ')}; receipts via reconcile ${viaReconcile.length}; duplicates ${duplicates}`);
    }
    case 'shadow.shadow_quotes_match_receipts': {
      const succeededKeys = new Set(quoteReceipts.filter((r) => r.status === 'succeeded').map((r) => r.executionKey));
      const unresolved = new Set(quoteExecutions.filter((e) => e.status === 'needs_reconciliation' || e.status === 'executing').map((e) => e.executionKey));
      const orphan = obs.shadowQuoteKeys.filter((k) => !succeededKeys.has(k) && !unresolved.has(k));
      const missing = [...succeededKeys].filter((k) => !obs.shadowQuoteKeys.includes(k));
      return orphan.length === 0 && missing.length === 0 ? pass(`${obs.shadowQuoteKeys.length} shadow quote(s) recorded, each backed by exactly one receipt`) : fail(`recorded without receipt: ${orphan.length}; receipt without record: ${missing.length}`);
    }
    case 'shadow.expired_evidence_in_history': {
      const withValidity = state.observations.some((o) => o.validUntil !== null);
      if (!withValidity) return notExercised('no evidence with a freshness window was observed');
      const inHistory = runs.some((r) => r.contexts.some((c) => Object.values(c.sectionByItem).includes('history')));
      return inHistory ? pass('after time passed, expired evidence was compiled into history (freshness recomputed)') : fail('no context ever placed expired evidence in history');
    }
    case 'shadow.model_failure_classified': {
      const injected = obs.modelCalls.filter((c) => c.injected && c.outcome === 'error');
      if (injected.length === 0) return notExercised('no provider fault was injected');
      const expected = typeof i.params.errorKind === 'string' ? i.params.errorKind : '';
      const failed = runs.filter((r) => r.run.termination?.failureClass === 'model');
      const kindOk = injected.every((c) => c.errorKind === expected);
      return failed.length > 0 && kindOk ? pass(`${failed.length} run(s) ended with failureClass=model (${failed.map((r) => r.run.termination?.code).join(', ')}); injected kind ${expected}`) : fail(`runs with failureClass=model: ${failed.length}; injected kinds ${injected.map((c) => c.errorKind).join(', ')}`);
    }
    case 'shadow.no_retry_after_model_failure': {
      const failedRuns = runs.filter((r) => r.run.termination?.failureClass === 'model');
      if (failedRuns.length === 0) return notExercised('no run failed on the model');
      const retried = failedRuns.filter((r) => {
        const failedStep = r.steps.findIndex((s) => s.outcome === 'model_failed');
        return failedStep >= 0 && failedStep < r.steps.length - 1;
      });
      const callsAfter = failedRuns.filter((r) => {
        const calls = obs.modelCalls.filter((c) => c.runId === r.run.runId);
        const firstError = calls.findIndex((c) => c.outcome === 'error');
        return firstError >= 0 && firstError < calls.length - 1;
      });
      return retried.length === 0 && callsAfter.length === 0 ? pass('the failed call was the run’s last; no retry inside the run (ADR-008; recovery, if any, is a new run — ADR-028)') : fail(`${retried.length} run(s) continued after the failed call; ${callsAfter.length} with provider calls after it`);
    }
    // --- ADR-028: run-level recovery (GAP-H-001) ---------------------------------
    case 'shadow.run_failure_recovered': {
      const failed = runs.filter((r) => runFailureRecoveryOf(r.run.termination)?.outcome === 'continued');
      if (failed.length === 0) return notExercised('no run failed recoverably');
      const problems: string[] = [];
      for (const f of failed) {
        const next = runs.find((r) => r.run.sequence === f.run.sequence + 1);
        if (!next) {
          problems.push(`run ${f.run.sequence}: no recovery run`);
          continue;
        }
        // A recovery run that failed again continues the chain, or ends it with a human (exhaustion / non-retryable: their own invariants).
        if (runFailureRecoveryOf(next.run.termination) !== null) continue;
        if (next.contexts.length === 0 || next.contexts.some((c) => f.contexts.some((fc) => fc.snapshotId === c.snapshotId))) problems.push(`run ${next.run.sequence}: no freshly compiled context`);
        if (!next.steps.some((s) => s.decision !== null)) problems.push(`run ${next.run.sequence}: no valid decision`);
      }
      if (state.task.status === 'failed') problems.push('the task became failed');
      // Recovery never touches goals: every agent goal comes from an accepted manage_goal, the root stays active.
      const decidedGoals = runs.flatMap((r) => r.steps).filter((s) => s.outcome === 'recorded' && s.decision?.type === 'manage_goal' && s.decision.change.operation === 'create').length;
      if (state.goals.filter((g) => g.origin === 'agent').length !== decidedGoals) problems.push('a goal appeared without an agent decision');
      if (state.goals.find((g) => g.goalId === state.task.rootGoalId)?.status !== 'active') problems.push('the root goal is no longer active');
      return problems.length === 0 ? pass(`${failed.length} failed run(s) → new run with fresh context and a valid decision; same task (${state.task.status})`) : fail(problems.join('; '));
    }
    case 'shadow.run_failure_recovery_exhausted': {
      const exhausted = runs.filter((r) => runFailureRecoveryOf(r.run.termination)?.outcome === 'exhausted');
      if (exhausted.length === 0) return notExercised('recovery was never exhausted');
      const problems: string[] = [];
      for (const e of exhausted) {
        const record = runFailureRecoveryOf(e.run.termination)!;
        const chain = runs.filter((r) => r.run.sequence <= e.run.sequence && r.run.sequence > e.run.sequence - record.consecutiveFailures! && r.run.status === 'failed');
        if (record.consecutiveFailures !== record.maxRunFailureRecoveries + 1 || chain.length !== record.consecutiveFailures) problems.push(`run ${e.run.sequence}: ${chain.length} consecutive failed run(s) for max ${record.maxRunFailureRecoveries}`);
        const handoff = platformHandoff(state, e.run.runId, RUN_FAILURE_RECOVERY_EXHAUSTED);
        if (!handoff) problems.push(`run ${e.run.sequence}: no platform handoff (${RUN_FAILURE_RECOVERY_EXHAUSTED})`);
        const later = runs.filter((r) => r.run.sequence > e.run.sequence);
        if (later.length > 0 && handoff && (handoff.status === 'requested')) problems.push('a run started while the platform handoff was still open');
        // Released by a human: the consecutive count starts again (history kept).
        const nextFailure = later.map((r) => runFailureRecoveryOf(r.run.termination)).find((x) => x !== null);
        if (nextFailure && nextFailure.outcome !== 'handed_off' && nextFailure.consecutiveFailures !== 1) problems.push(`after the release the count did not restart (${nextFailure.consecutiveFailures})`);
      }
      if (obs.inputs.some((x) => !x.applied)) problems.push('an input was refused');
      if (state.task.status === 'failed') problems.push('the task became failed');
      return problems.length === 0 ? pass(`${exhausted.length} exhaustion(s): ${runFailureRecoveryOf(exhausted[0]!.run.termination)!.consecutiveFailures} failed runs → blocked + platform handoff; inputs accepted`) : fail(problems.join('; '));
    }
    case 'shadow.non_retryable_handed_off': {
      const handed = runs.filter((r) => runFailureRecoveryOf(r.run.termination)?.outcome === 'handed_off');
      if (handed.length === 0) return notExercised('no non-retryable model failure');
      const problems: string[] = [];
      for (const h of handed) {
        if (h.run.termination?.reason !== 'model_failure') problems.push(`run ${h.run.sequence}: ${h.run.termination?.reason}`);
        const handoff = platformHandoff(state, h.run.runId, NON_RETRYABLE_MODEL_FAILURE);
        if (!handoff) problems.push(`run ${h.run.sequence}: no platform handoff (${NON_RETRYABLE_MODEL_FAILURE})`);
        const later = runs.filter((r) => r.run.sequence > h.run.sequence);
        if (later.length > 0 && handoff?.status === 'requested') problems.push('an automatic run followed a non-retryable failure');
      }
      if (state.task.status === 'failed') problems.push('the task became failed');
      return problems.length === 0 ? pass(`not retried; task ${state.task.status}, platform handoff (${NON_RETRYABLE_MODEL_FAILURE}) open for a human`) : fail(problems.join('; '));
    }
    case 'shadow.recovery_context_includes_new_input': {
      const customer = state.conversation.filter((e) => e.memoryType === 'CONVERSATIONAL' && (e.content as { actor?: { role?: string } }).actor?.role === 'participant');
      const recoveries = runs.filter((r) => runs.some((f) => f.run.sequence === r.run.sequence - 1 && runFailureRecoveryOf(f.run.termination)?.outcome === 'continued'));
      if (recoveries.length === 0) return notExercised('no recovery run');
      const problems: string[] = [];
      for (const r of recoveries) {
        const byInput = obs.inputs.findIndex((x) => x.runIds.includes(r.run.runId));
        const before = customer.slice(0, byInput < 0 ? customer.length : obs.inputs[byInput]!.index);
        const first = [...r.contexts].sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt)[0];
        const missing = before.filter((e) => !first?.itemIds.includes(`memory:${e.entryId}`));
        if (missing.length > 0) problems.push(`run ${r.run.sequence}: ${missing.length} earlier input(s) missing from its context`);
      }
      return problems.length === 0 ? pass(`every recovery run compiled every input received before it (${customer.length} input(s))`) : fail(problems.join('; '));
    }
    case 'shadow.read_before_failure_preserved': {
      const failed = runs.filter((r) => runFailureRecoveryOf(r.run.termination)?.outcome === 'continued');
      const reads = state.observations.filter((o) => o.source.kind === 'capability' && failed.some((f) => f.run.runId === o.runId));
      if (reads.length === 0) return notExercised('no READ before a recoverable failure');
      const problems: string[] = [];
      for (const o of reads) {
        const failedRun = failed.find((f) => f.run.runId === o.runId)!;
        const recovery = runs.find((r) => r.run.sequence === failedRun.run.sequence + 1);
        const first = recovery ? [...recovery.contexts].sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt)[0] : undefined;
        if (!first?.itemIds.includes(`observation:${o.observationId}`)) problems.push(`observation ${o.observationId.slice(0, 8)} not in the recovery context`);
      }
      const invocations = runs.flatMap((r) => r.steps.map((s) => s.invocationId).filter((id): id is string => id !== null));
      if (new Set(invocations).size !== invocations.length) problems.push('an invocation was executed twice');
      return problems.length === 0 ? pass(`${reads.length} READ observation(s) from the failed run are in the recovery context; nothing re-executed by the platform`) : fail(problems.join('; '));
    }
    case 'shadow.write_before_failure_not_replayed': {
      const failed = runs.filter((r) => runFailureRecoveryOf(r.run.termination)?.outcome === 'continued');
      const proposals = state.ledger.proposals.filter((p) => failed.some((f) => f.run.runId === p.runId));
      if (proposals.length === 0) return notExercised('no governed write before a recoverable failure');
      const problems: string[] = [];
      for (const p of proposals) {
        const failedRun = failed.find((f) => f.run.runId === p.runId)!;
        const executions = state.ledger.executions.filter((e) => e.proposalId === p.proposalId);
        const execution = executions[0];
        const receipts = execution ? state.ledger.receipts.filter((r) => r.executionId === execution.executionId) : [];
        const late = execution ? state.ledger.attempts.filter((a) => a.executionId === execution.executionId && Date.parse(a.startedAt) > Date.parse(failedRun.run.finishedAt ?? a.startedAt)) : [];
        if (executions.length !== 1) problems.push(`proposal ${p.proposalId.slice(0, 8)}: ${executions.length} execution(s)`);
        if (receipts.length !== 1) problems.push(`proposal ${p.proposalId.slice(0, 8)}: ${receipts.length} receipt(s)`);
        if (receipts.some((r) => r.executionKey !== execution!.executionKey)) problems.push(`proposal ${p.proposalId.slice(0, 8)}: receipt key differs from the execution key`);
        if (late.length > 0) problems.push(`proposal ${p.proposalId.slice(0, 8)}: ${late.length} attempt(s) after the run failed`);
        const recovery = runs.find((r) => r.run.sequence === failedRun.run.sequence + 1);
        const first = recovery ? [...recovery.contexts].sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt)[0] : undefined;
        const observed = state.observations.find((o) => o.source.kind === 'action' && o.source.receiptId === receipts[0]?.receiptId);
        if (!observed || !first?.itemIds.includes(`observation:${observed.observationId}`)) problems.push(`proposal ${p.proposalId.slice(0, 8)}: its receipt observation is not in the recovery context`);
      }
      return problems.length === 0 ? pass(`${proposals.length} write(s) before the failure: one execution, one receipt, same key, not replayed; receipt visible to the recovery run`) : fail(problems.join('; '));
    }
    case 'shadow.no_cognition_while_uncertain': {
      const reconciled = state.ledger.receipts.filter((r) => r.evidence.obtainedVia === 'reconcile');
      if (reconciled.length === 0) return notExercised('no outcome was established by reconciliation');
      const problems: string[] = [];
      for (const receipt of reconciled) {
        const origin = runs.find((r) => r.run.runId === receipt.runId);
        const later = runs.filter((r) => origin && r.run.sequence > origin.run.sequence);
        const early = later.filter((r) => Date.parse(r.run.startedAt) < Date.parse(receipt.recordedAt));
        if (early.length > 0) problems.push(`${early.length} run(s) started before the uncertain outcome was reconciled`);
      }
      const recovered = runs.some((r) => runFailureRecoveryOf(r.run.termination)?.outcome === 'continued');
      if (!recovered) problems.push('no recoverable failure after reconciliation');
      return problems.length === 0 ? pass('reconciliation established the outcome before any later cognition, including the failed run and its recovery') : fail(problems.join('; '));
    }
    case 'shadow.protocol_failure_recorded': {
      const injected = obs.modelCalls.filter((c) => c.injected && c.outcome === 'unparsed');
      if (injected.length === 0) return notExercised('no protocol fault was injected');
      const failed = runs.filter((r) => r.run.termination?.failureClass === 'protocol');
      const rescued = runs.some((r) => r.steps.some((s) => s.decision?.type === 'respond' && s.decision.content === '(injected)'));
      return failed.length > 0 && !rescued ? pass(`run ended with failureClass=protocol (${failed.map((r) => r.run.termination?.code).join(', ')}); the JSON was not rescued`) : fail(`protocol-failed runs ${failed.length}; rescued=${rescued}`);
    }
    case 'shadow.input_rejected_after_terminal': {
      const late = obs.inputs.filter((x) => x.afterTerminal);
      if (late.length === 0) return notExercised('no input arrived after the task ended');
      const accepted = late.filter((x) => x.applied || x.runIds.length > 0);
      return accepted.length === 0 ? pass(`${late.length} input(s) after the terminal state were refused; no run`) : fail(`${accepted.length} input(s) accepted after the terminal state`);
    }
    case 'shadow.cancel_deferred_until_reconciled': {
      if (!obs.cancel) return notExercised('no cancellation happened');
      if (obs.cancel.uncertainAtCancel === 0) return notExercised(`nothing was uncertain at cancellation (task went ${obs.cancel.statusAfterCancel})`);
      const resolved = quoteExecutions.every((e) => e.status !== 'needs_reconciliation' && e.status !== 'executing');
      const ok = obs.cancel.statusAfterCancel === 'blocked' && state.task.status === 'cancelled' && resolved && quoteReceipts.length > 0;
      return ok ? pass('cancel with an uncertain effect → blocked with a terminal intent → reconciled by key → cancelled, receipt kept') : fail(`after cancel: ${obs.cancel.statusAfterCancel}; final ${state.task.status}; executions resolved=${resolved}; receipts ${quoteReceipts.length}`);
    }
    default:
      throw new Error(`unknown workload invariant ${i.kind}`);
  }
}
