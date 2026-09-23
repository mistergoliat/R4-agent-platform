import type { JsonValue } from '@r4/contracts';
import type { FindingDraft } from '../finding.js';
import type { Evaluator, EvaluationFragment } from '../evaluator.js';
import { count } from '../metrics.js';
import { canonicalJson } from '../versioning.js';
import type { EvaluationSubject, Position } from '../subject.js';

/**
 * Structured-state continuity, independent of any domain. A pack exposes its
 * state as keyed histories (from its own durable transitions, projected into
 * the subject); the generic checks are:
 *
 *   - a value that was set does not disappear from the current state
 *     without an explicit removal;
 *   - after a correction (a later set of the same key with another value)
 *     the current value is the corrected one, and the earlier value is kept
 *     as history only.
 */
export interface StateEvent {
  /** Where in the step log the change was decided (null when it cannot be placed). */
  readonly position: Position | null;
  readonly version: number;
  readonly kind: 'set' | 'removed';
  readonly value: JsonValue;
}

export interface KeyedStateHistory {
  readonly key: string;
  readonly events: readonly StateEvent[];
  /** The value the state holds now (`undefined`: absent). */
  readonly current: JsonValue | undefined;
}

export interface StateHistoryAccessor {
  /** Name of the state (e.g. the projection id). */
  readonly stateId: string;
  histories(subject: Readonly<EvaluationSubject>): readonly KeyedStateHistory[];
}

export class StateContinuityEvaluator implements Evaluator {
  readonly descriptor;
  readonly #accessors: readonly StateHistoryAccessor[];

  constructor(options: { ref: { id: string; version: number }; accessors: readonly StateHistoryAccessor[] }) {
    this.#accessors = options.accessors;
    this.descriptor = {
      ref: options.ref,
      kind: 'deterministic' as const,
      description: `Structured state continuity over ${options.accessors.map((a) => a.stateId).join(', ') || 'no state'}.`,
      emits: ['state_value_lost', 'correction_not_superseded'],
      authoritativeFor: ['state_value_lost', 'correction_not_superseded'],
    };
  }

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    let keys = 0;
    let corrections = 0;
    let correctionsSuperseded = 0;
    for (const accessor of this.#accessors) {
      for (const h of accessor.histories(subject)) {
        keys += 1;
        const ref = { kind: 'domain' as const, id: `${accessor.stateId}:${h.key}` };
        const events = [...h.events].sort((a, b) => a.version - b.version);
        const last = events.at(-1);
        if (last?.kind === 'set' && h.current === undefined) {
          findings.push({ code: 'state_value_lost', subjectRef: ref, description: `${accessor.stateId}.${h.key} was set (v${last.version}) and is absent now without a removal`, evidenceRefs: [ref] });
        }
        const sets = events.filter((e) => e.kind === 'set');
        const distinct = sets.filter((e, i) => i === 0 || canonicalJson(e.value) !== canonicalJson(sets[i - 1]!.value));
        if (distinct.length > 1) {
          corrections += distinct.length - 1;
          const latest = distinct.at(-1)!;
          if (h.current !== undefined && canonicalJson(h.current) === canonicalJson(latest.value)) correctionsSuperseded += distinct.length - 1;
          else if (h.current !== undefined) {
            findings.push({ code: 'correction_not_superseded', subjectRef: ref, description: `${accessor.stateId}.${h.key}: the current value is not the latest correction (v${latest.version})`, evidenceRefs: [ref], details: { correctedAtVersion: latest.version } });
          }
        }
      }
    }
    return { findings, metrics: { stateKeys: count(keys), corrections: count(corrections), correctionsSuperseded: count(correctionsSuperseded) } };
  }
}
