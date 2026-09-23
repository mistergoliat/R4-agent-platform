import type { JsonValue } from '@r4/contracts';
import type { FindingDraft } from '../finding.js';
import type { Evaluator, EvaluationFragment } from '../evaluator.js';
import { count } from '../metrics.js';
import type { EvaluationSubject, Position, SubjectResponse } from '../subject.js';

/**
 * Deterministic detection of `already_known_question`, only where the
 * evidence is structured: the pack says which information key a question
 * asks for (a small, explicit classifier — or nothing when it cannot tell),
 * and which keys its structured state already held at a point of the step
 * log. A question for a key already known at that point is flagged.
 *
 * Anything that needs understanding (was the question useful, necessary,
 * repeated in other words?) is left to the question-quality rubric. There is
 * no expected order of questions here: only "was this already known?".
 */
export interface QuestionClassifier {
  /** Information keys a question asks for; empty when it cannot be classified reliably. */
  classify(question: string): readonly string[];
}

export interface KnownStateAt {
  /** Keys with a current value strictly before `position` (and the value, for evidence). */
  knownAt(subject: Readonly<EvaluationSubject>, position: Position): ReadonlyMap<string, { readonly value: JsonValue; readonly evidenceId: string }>;
}

/**
 * The interrogative sentences of a response: each segment ending in a
 * question mark, cut at its opening mark (¿) or at the previous sentence
 * boundary, so a statement before the question is not read as part of it.
 */
export function questionsOf(text: string): string[] {
  return text
    .split(/(?<=[?？])|\n+/)
    .filter((s) => /[?？]\s*$/.test(s))
    .map((s) => {
      const opening = s.lastIndexOf('¿');
      const start = opening >= 0 ? opening : Math.max(s.lastIndexOf('. '), s.lastIndexOf(': '), s.lastIndexOf('! '), s.lastIndexOf('; ')) + 1;
      return s.slice(start).replace(/^[\s\d).•*-]+/, '').trim();
    })
    .filter((s) => s.length > 1);
}

export class KnownInformationQuestionEvaluator implements Evaluator {
  readonly descriptor;
  readonly #classifier: QuestionClassifier;
  readonly #state: KnownStateAt;

  constructor(options: { ref: { id: string; version: number }; classifier: QuestionClassifier; state: KnownStateAt }) {
    this.#classifier = options.classifier;
    this.#state = options.state;
    this.descriptor = { ref: options.ref, kind: 'deterministic' as const, description: 'Questions for information already present in structured state.', emits: ['already_known_question'], authoritativeFor: [] };
  }

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    let questions = 0;
    let classified = 0;
    for (const response of subject.responses) {
      for (const question of questionsOf(response.text)) {
        questions += 1;
        const keys = this.#classifier.classify(question);
        if (keys.length > 0) classified += 1;
        const known = this.#state.knownAt(subject, response.position);
        for (const key of keys) {
          const hit = known.get(key);
          if (hit) findings.push(finding(response, key, question, hit.evidenceId));
        }
      }
    }
    return { findings, metrics: { questions: count(questions), classifiedQuestions: count(classified, 'questions the classifier could map to an information key') } };
  }
}

function finding(response: SubjectResponse, key: string, question: string, evidenceId: string): FindingDraft {
  return {
    code: 'already_known_question',
    subjectRef: { kind: 'response', id: response.responseId },
    description: `asks for "${key}", already recorded in structured state before this response`,
    evidenceRefs: [{ kind: 'response', id: response.responseId }, { kind: 'domain', id: evidenceId }],
    details: { key, question: question.slice(0, 160) },
  };
}
