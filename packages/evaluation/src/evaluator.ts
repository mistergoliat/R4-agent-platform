import type { JsonValue } from '@r4/contracts';
import type { Finding, FindingDraft } from './finding.js';
import type { QualityVector } from './metrics.js';
import type { DomainOutcome, TaskOutcome } from './outcome.js';
import type { Rubric } from './rubric.js';
import type { SemanticJudge } from './semantic.js';
import type { SemanticView } from './privacy.js';
import type { EvaluationSubject } from './subject.js';
import { assertEvaluatorRef, type EvaluatorRef } from './versioning.js';

/**
 * Evaluators are post-hoc and read-only. They receive a deeply frozen copy of
 * a finished trajectory and return structured fragments; they hold no store,
 * no runtime and no way to reach the agent. Deterministic evaluators run
 * first and are pure; semantic evaluators run afterwards, through a judge, on
 * a privacy projection of the same subject.
 */
export interface EvaluatorDescriptor {
  readonly ref: EvaluatorRef;
  readonly kind: 'deterministic' | 'semantic';
  readonly description: string;
  /** Every code the evaluator may emit (checked against the taxonomy at definition time). */
  readonly emits: readonly string[];
  /** Deterministic only: codes it proves. A semantic finding with one of these codes is suppressed. */
  readonly authoritativeFor?: readonly string[];
  /** Semantic only: the versioned rubric it judges with. */
  readonly rubric?: Rubric;
}

export interface EvaluationFragment {
  readonly findings: readonly FindingDraft[];
  readonly metrics?: QualityVector;
  /** Structured by-products worth keeping (e.g. classified claims). Never reasoning. */
  readonly data?: Readonly<Record<string, JsonValue>>;
  readonly outcome?: {
    readonly objective?: TaskOutcome['goal']['objective'];
    readonly business?: readonly DomainOutcome[];
  };
  /** Semantic evaluators: `inconclusive` when the judge could not give a valid verdict. */
  readonly status?: 'completed' | 'inconclusive';
  readonly reason?: string;
}

export interface EvaluationContext {
  /** Deterministic findings already established (semantic evaluators must not re-judge them). */
  readonly priorFindings: readonly Finding[];
  /** Null when no judge is configured: semantic evaluators are then skipped, never faked. */
  readonly judge: SemanticJudge | null;
  readonly view: SemanticView;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface Evaluator {
  readonly descriptor: EvaluatorDescriptor;
  evaluate(subject: Readonly<EvaluationSubject>, context: EvaluationContext): EvaluationFragment | Promise<EvaluationFragment>;
}

export function assertDescriptor(descriptor: EvaluatorDescriptor): void {
  assertEvaluatorRef(descriptor.ref);
  if (descriptor.kind === 'semantic') {
    if (!descriptor.rubric) throw new Error(`semantic evaluator ${descriptor.ref.id} must declare a versioned rubric`);
    assertEvaluatorRef({ id: descriptor.rubric.id, version: descriptor.rubric.version }, `rubric of ${descriptor.ref.id}`);
    if ((descriptor.authoritativeFor ?? []).length > 0) throw new Error(`semantic evaluator ${descriptor.ref.id} cannot be authoritative for any code`);
  } else if (descriptor.rubric) {
    throw new Error(`deterministic evaluator ${descriptor.ref.id} must not declare a rubric`);
  }
}

/** A deep, frozen copy: an evaluator that tries to modify the trajectory throws. */
export function freezeSubject(subject: EvaluationSubject): Readonly<EvaluationSubject> {
  return deepFreeze(structuredClone(subject));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
