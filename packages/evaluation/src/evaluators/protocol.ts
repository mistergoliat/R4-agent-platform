import type { FindingDraft } from '../finding.js';
import type { Evaluator, EvaluationFragment } from '../evaluator.js';
import { count, rate } from '../metrics.js';
import { stepsOf, type EvaluationSubject, type ModelCallRecord, type SubjectStep } from '../subject.js';

const PROTOCOL_CODES = ['invalid_structured_output', 'multiple_decisions', 'trailing_non_protocol_output', 'invalid_evidence_reference', 'wrong_decision_type', 'protocol_non_adherence'];
const PROVIDER_CODES = ['provider_http_failure', 'provider_malformed_response'];

/**
 * Protocol adherence (deterministic). Every model call is one run step, so:
 *
 *   decision attempts  = steps where the model answered (outcome ≠ model_failed)
 *   valid decisions    = attempts the platform accepted as an AgentDecision
 *   adherence rate     = valid decisions / decision attempts
 *
 * The denominator is decision attempts — never user turns or runs. Provider
 * failures (no answer) are counted apart: they are not the model breaking the
 * protocol. Three families stay distinct:
 *
 *   provider transport failure  (HTTP error, rate limit, timeout)  → PROVIDER
 *   provider malformed response (not a model answer at all)        → PROVIDER
 *   valid JSON, invalid R4 decision                                → MODEL_PROTOCOL
 *
 * When harness call records exist, unparseable output is refined by its
 * shape (two decision documents vs. a document plus stray text) without ever
 * reading the text itself. Measured, never retried (ADR-008 stands).
 */
export class ProtocolAdherenceEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'r4.protocol_adherence', version: 1 },
    kind: 'deterministic' as const,
    description: 'Decision protocol adherence and provider failure classification from the step log.',
    emits: [...PROTOCOL_CODES, ...PROVIDER_CODES],
    authoritativeFor: [...PROTOCOL_CODES, ...PROVIDER_CODES],
  };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    // Only model decisions are protocol attempts: platform steps (the turn-closing wait, R4-J1E-R2.2) call no model.
    const steps = stepsOf(subject).filter((s) => s.origin !== 'platform');
    const calls = alignCalls(subject, steps);
    const findings: FindingDraft[] = [];
    const failureTypes: Record<string, number> = {};
    const decisionTypes: Record<string, number> = {};
    let attempts = 0;
    let valid = 0;
    let providerFailures = 0;
    for (const step of steps) {
      if (step.decision) decisionTypes[step.decision.type] = (decisionTypes[step.decision.type] ?? 0) + 1;
      if (step.outcome === 'model_failed') {
        const kind = step.error?.code ?? 'provider_error';
        if (kind === 'cancelled') continue;
        providerFailures += 1;
        const code = kind === 'invalid_provider_response' ? 'provider_malformed_response' : 'provider_http_failure';
        failureTypes[code] = (failureTypes[code] ?? 0) + 1;
        findings.push({ code, subjectRef: { kind: 'step', id: step.stepId }, description: `model call failed at run ${step.position.run}#${step.position.iteration} (${kind})`, evidenceRefs: [{ kind: 'step', id: step.stepId }], details: { providerErrorKind: kind } });
        continue;
      }
      attempts += 1;
      if (step.outcome !== 'invalid') {
        valid += 1;
        continue;
      }
      const decisionErrorCode = step.error?.code ?? 'unknown';
      const code = protocolCode(decisionErrorCode, calls.get(step.stepId) ?? null);
      failureTypes[code] = (failureTypes[code] ?? 0) + 1;
      const call = calls.get(step.stepId);
      findings.push({
        code,
        subjectRef: { kind: 'step', id: step.stepId },
        description: `decision rejected at run ${step.position.run}#${step.position.iteration}: ${decisionErrorCode}`,
        evidenceRefs: [{ kind: 'step', id: step.stepId }, ...(call ? [{ kind: 'model_call' as const, id: String(call.index) }] : [])],
        details: { decisionErrorCode, ...(call?.unparsedShape ? { jsonDocuments: call.unparsedShape.jsonDocuments.length, otherTextChars: call.unparsedShape.otherTextChars } : {}) },
      });
    }
    return {
      findings,
      metrics: {
        decisionAttempts: count(attempts),
        validDecisions: count(valid),
        invalidDecisions: count(attempts - valid),
        protocolAdherence: rate(valid, attempts, 'ratio', 'valid AgentDecisions / decision attempts (model calls that returned an answer)'),
        providerFailures: count(providerFailures),
      },
      data: { decisionTypes, failureTypes, shapeEvidence: subject.modelCalls === null ? 'unavailable' : 'harness_call_records' },
    };
  }
}

function protocolCode(decisionErrorCode: string, call: ModelCallRecord | null): string {
  switch (decisionErrorCode) {
    case 'invalid_structured_output': {
      const shape = call?.unparsedShape;
      if (shape && shape.jsonDocuments.length > 1) return 'multiple_decisions';
      if (shape && shape.jsonDocuments.length === 1 && shape.otherTextChars > 0) return 'trailing_non_protocol_output';
      return 'invalid_structured_output';
    }
    case 'unknown_evidence':
      return 'invalid_evidence_reference';
    case 'capability_not_permitted':
      return 'wrong_decision_type';
    default:
      return 'protocol_non_adherence';
  }
}

/** Harness call records are per run and in call order; each run step is one call. */
function alignCalls(subject: Readonly<EvaluationSubject>, steps: readonly SubjectStep[]): Map<string, ModelCallRecord> {
  const out = new Map<string, ModelCallRecord>();
  if (!subject.modelCalls) return out;
  for (const run of subject.runs) {
    const calls = subject.modelCalls.filter((c) => c.runId === run.runId).sort((a, b) => a.index - b.index);
    const runSteps = steps.filter((s) => s.runId === run.runId);
    runSteps.forEach((s, i) => {
      const call = calls[i];
      if (call) out.set(s.stepId, call);
    });
  }
  return out;
}
