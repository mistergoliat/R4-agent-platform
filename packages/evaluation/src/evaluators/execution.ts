import type { FindingDraft } from '../finding.js';
import type { Evaluator, EvaluationFragment } from '../evaluator.js';
import { count } from '../metrics.js';
import { technicalOutcome } from '../outcome.js';
import type { EvaluationSubject } from '../subject.js';

/** Termination reasons the platform classifies as failures (waiting, suspension and cancellation are legitimate stops). */
const TERMINATION_FINDINGS: Readonly<Record<string, string>> = { internal_failure: 'run_internal_failure', lease_lost: 'run_abandoned', budget_exhausted: 'budget_exhausted', capability_failure: 'capability_failure' };

/**
 * How runs ended and what domain owners answered (deterministic). A waiting,
 * suspended or cancelled run is a legitimate stop, not a failure: only the
 * termination reasons the platform classifies as failures produce findings.
 */
export class ExecutionOutcomeEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'r4.execution_outcomes', version: 1 },
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
    return {
      findings,
      metrics: {
        runs: count(subject.runs.length),
        failedRuns: count(technical.failedRuns),
        technicallyValid: count(technical.valid ? 1 : 0, `task ${subject.task.status}: ${technical.status}`),
      },
      data: { technicalStatus: technical.status, terminations: subject.runs.map((r) => r.termination?.reason ?? 'running') },
    };
  }
}
