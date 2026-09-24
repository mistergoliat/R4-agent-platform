import { runFailureDisposition, runFailureRecoveryOf } from '@r4/contracts';
import type { FindingDraft } from '../finding.js';
import type { Evaluator, EvaluationFragment } from '../evaluator.js';
import { count, distribution, measure } from '../metrics.js';
import { technicalOutcome } from '../outcome.js';
import type { EvaluationSubject } from '../subject.js';

/** Termination reasons the platform classifies as failures (waiting, suspension and cancellation are legitimate stops). */
const TERMINATION_FINDINGS: Readonly<Record<string, string>> = { internal_failure: 'run_internal_failure', lease_lost: 'run_abandoned', budget_exhausted: 'budget_exhausted', capability_failure: 'capability_failure' };

/**
 * How runs ended and what domain owners answered (deterministic). A waiting,
 * suspended or cancelled run is a legitimate stop, not a failure: only the
 * termination reasons the platform classifies as failures produce findings.
 *
 * v2 (ADR-028): run-level recovery, read from the disposition the platform
 * stamped on each failed run — Quality measures it, never drives it:
 *
 *   recoverableRunFailures  failed runs the platform may recover (invalid_decision, retryable model_failure)
 *   recoveredRunFailures    failure sequences a later run left with a valid decision (completed or suspended)
 *   exhaustedRecoveries     sequences that exceeded the budget → human
 *   nonRetryableHandoffs    non-retryable model failures → human, not retried
 *   attemptsToRecovery      failed runs per recovered sequence (mean; values in data)
 */
export class ExecutionOutcomeEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'r4.execution_outcomes', version: 2 },
    kind: 'deterministic' as const,
    description: 'Run terminations, read failures and domain answers to governed actions.',
    emits: ['run_internal_failure', 'run_abandoned', 'budget_exhausted', 'capability_failure', 'capability_read_failed', 'action_rejected_by_domain', 'action_failed_in_domain'],
    authoritativeFor: ['run_internal_failure', 'run_abandoned', 'budget_exhausted', 'capability_failure', 'capability_read_failed', 'action_rejected_by_domain', 'action_failed_in_domain'],
  };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    for (const run of subject.runs) {
      const code = TERMINATION_FINDINGS[run.termination?.reason ?? ''];
      if (code) findings.push({ code, subjectRef: { kind: 'run', id: run.runId }, description: `run ${run.sequence} ended: ${run.termination!.reason} (${run.termination!.code})`, evidenceRefs: [{ kind: 'run', id: run.runId }], details: { terminationCode: run.termination!.code } });
    }
    for (const o of subject.observations) {
      if (o.source.kind === 'capability' && o.outcome !== 'succeeded') {
        findings.push({ code: 'capability_read_failed', subjectRef: { kind: 'observation', id: o.observationId }, description: `${o.source.capabilityId} answered ${o.outcome} (${o.error?.code ?? '-'})`, evidenceRefs: [{ kind: 'observation', id: o.observationId }], details: { capabilityId: o.source.capabilityId, errorCode: o.error?.code ?? null } });
      }
    }
    for (const r of subject.actions.receipts) {
      if (r.status === 'succeeded') continue;
      findings.push({ code: r.status === 'rejected' ? 'action_rejected_by_domain' : 'action_failed_in_domain', subjectRef: { kind: 'receipt', id: r.receiptId }, description: `${r.capabilityId} ${r.status} (${r.error?.code ?? '-'})`, evidenceRefs: [{ kind: 'receipt', id: r.receiptId }], details: { capabilityId: r.capabilityId, errorCode: r.error?.code ?? null } });
    }
    const technical = technicalOutcome(subject);
    const recovery = runFailureRecoveryMetrics(subject);
    return {
      findings,
      metrics: {
        runs: count(subject.runs.length),
        failedRuns: count(technical.failedRuns),
        technicallyValid: count(technical.valid ? 1 : 0, `task ${subject.task.status}: ${technical.status}`),
        recoverableRunFailures: count(recovery.recoverable),
        recoveredRunFailures: count(recovery.attempts.length),
        exhaustedRecoveries: count(recovery.exhausted),
        nonRetryableHandoffs: count(recovery.handedOff),
        attemptsToRecovery: measure(recovery.attempts.length === 0 ? null : distribution(recovery.attempts).mean, 'count', recovery.attempts.length === 0 ? 'no recovered run failure' : null),
      },
      data: { technicalStatus: technical.status, terminations: subject.runs.map((r) => r.termination?.reason ?? 'running'), attemptsToRecovery: recovery.attempts },
    };
  }
}

/**
 * ADR-028 recovery facts of one task. A sequence of consecutive failed runs
 * the platform continued is "recovered" when the next run ended as a
 * legitimate stop (completed / suspended) with an accepted decision (a takeover
 * that interrupts it is not a recovery); its attempts = the failed runs.
 */
function runFailureRecoveryMetrics(subject: Readonly<EvaluationSubject>): { recoverable: number; exhausted: number; handedOff: number; attempts: number[] } {
  const runs = [...subject.runs].sort((a, b) => a.sequence - b.sequence);
  const recorded = runs.map((r) => runFailureRecoveryOf(r.termination));
  const attempts: number[] = [];
  runs.forEach((run, i) => {
    const previous = recorded[i - 1];
    if (i > 0 && previous?.outcome === 'continued' && recorded[i] === null && (run.status === 'completed' || run.status === 'suspended') && run.steps.some((st) => st.decision !== null)) attempts.push(previous.consecutiveFailures ?? 1);
  });
  return {
    recoverable: runs.filter((r) => r.status === 'failed' && r.termination !== null && runFailureDisposition(r.termination) === 'recoverable').length,
    exhausted: recorded.filter((x) => x?.outcome === 'exhausted').length,
    handedOff: recorded.filter((x) => x?.outcome === 'handed_off').length,
    attempts,
  };
}
