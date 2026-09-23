import type { FindingDraft } from '../finding.js';
import type { Evaluator, EvaluationFragment } from '../evaluator.js';
import { count } from '../metrics.js';
import { canonicalJson } from '../versioning.js';
import { stepsOf, type EvaluationSubject } from '../subject.js';

/**
 * Capability use (deterministic part). Capability protocol correctness (was
 * the decision well formed?) is the protocol evaluator's; this looks only at
 * one mechanical aspect of capability choice: the same read, with the same
 * arguments, repeated while its previous answer was still valid. A re-read
 * after the answer expired is a legitimate refresh and is not flagged.
 * Wrong or missing capabilities need understanding: capability rubric.
 */
export class CapabilityUseEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'r4.capability_use', version: 1 },
    kind: 'deterministic' as const,
    description: 'Duplicate reads of still-valid answers; reads and writes by capability.',
    emits: ['unnecessary_duplicate_call'],
    authoritativeFor: [],
  };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    const observations = new Map(subject.observations.map((o) => [o.observationId, o]));
    const previous = new Map<string, { observationId: string; validUntil: string | null; ok: boolean }>();
    const reads: Record<string, number> = {};
    let refreshes = 0;
    for (const step of stepsOf(subject)) {
      if (step.decision?.type !== 'read_capability' || !step.observationId) continue;
      const o = observations.get(step.observationId);
      if (!o) continue;
      reads[step.decision.capabilityId] = (reads[step.decision.capabilityId] ?? 0) + 1;
      const key = `${step.decision.capabilityId}|${canonicalJson(step.decision.arguments)}`;
      const prior = previous.get(key);
      if (prior?.ok) {
        const stillValid = prior.validUntil === null || Date.parse(prior.validUntil) > Date.parse(o.observedAt);
        if (stillValid) findings.push({ code: 'unnecessary_duplicate_call', subjectRef: { kind: 'step', id: step.stepId }, description: `${step.decision.capabilityId} repeated with identical arguments while the previous answer was valid`, evidenceRefs: [{ kind: 'observation', id: prior.observationId }, { kind: 'observation', id: o.observationId }] });
        else refreshes += 1;
      }
      previous.set(key, { observationId: o.observationId, validUntil: o.validUntil, ok: o.outcome === 'succeeded' });
    }
    return {
      findings,
      metrics: { capabilityReads: count(Object.values(reads).reduce((s, n) => s + n, 0)), refreshedReads: count(refreshes, 'identical re-reads after the previous answer expired') },
      data: { readsByCapability: reads, writesByCapability: tally(subject.actions.proposals.map((p) => p.capabilityId)) },
    };
  }
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
