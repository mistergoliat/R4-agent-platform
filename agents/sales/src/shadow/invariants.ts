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
      return retried.length === 0 && callsAfter.length === 0 ? pass('the failed call was the run’s last; no retry (ADR-008)') : fail(`${retried.length} run(s) continued after the failed call; ${callsAfter.length} with provider calls after it`);
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
