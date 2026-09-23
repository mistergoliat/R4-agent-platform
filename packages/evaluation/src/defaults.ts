import type { Evaluator } from './evaluator.js';
import { CapabilityUseEvaluator } from './evaluators/capability.js';
import { ContextCompositionEvaluator, EfficiencyEvaluator } from './evaluators/efficiency.js';
import { ExecutionOutcomeEvaluator } from './evaluators/execution.js';
import { GoalContinuityEvaluator } from './evaluators/goal.js';
import { GovernanceInvariantEvaluator } from './evaluators/governance.js';
import { ProtocolAdherenceEvaluator } from './evaluators/protocol.js';
import { defineRubric, type Rubric } from './rubric.js';

/** The generic deterministic evaluators every definition starts from (order = execution order). */
export function genericDeterministicEvaluators(): Evaluator[] {
  return [
    new ProtocolAdherenceEvaluator(),
    new ExecutionOutcomeEvaluator(),
    new GovernanceInvariantEvaluator(),
    new GoalContinuityEvaluator(),
    new CapabilityUseEvaluator(),
    new EfficiencyEvaluator(),
    new ContextCompositionEvaluator(),
  ];
}

const COMMON = [
  'You evaluate a FINISHED agent trajectory after the fact. You cannot change it and nothing you say reaches the agent.',
  'Judge only from the view you are given: turns, responses, the observations each response could see (evidenceInContext), goals, governed actions and domain state. Do not use outside knowledge to decide what is true.',
  'establishedFindings were already proven by deterministic checks: do not report them again.',
  'Answer with the JSON document only. Each finding cites the response/turn/proposal it is about (subjectRef) and the records it rests on (evidenceRefs), a confidence (low, medium, high) and a short evaluative rationale (at most 280 characters). Do not include your reasoning process.',
  'If the view does not let you decide, answer verdict "inconclusive" with no findings.',
].join('\n');

/** Generic rubrics (domain-neutral). Packs may define their own versions with domain guidance. */
export const OBJECTIVE_CONTINUITY_RUBRIC: Rubric = defineRubric({
  id: 'r4.rubric.objective_continuity',
  version: 1,
  title: 'Objective continuity',
  instructions: `${COMMON}
Question: did the trajectory keep serving the requester's real objective?
- The objective is what the requester is trying to achieve, as stated in the turns; goals are the agent's own representation of it and may be absent or coarse — do not require sub-goals or any goal-management activity.
- An incidental question may be answered; it must not permanently replace the objective. Corrections must be incorporated. After a wait/resume the objective must still be pursued.
- Report objective_drift when later responses stop addressing the objective, premature_completion when the task is closed while the objective is open, weak_recommendation when a recommendation ignores stated constraints or available evidence.
- Always set "objective": "preserved" or "drifted".`,
  allowedCodes: ['objective_drift', 'premature_completion', 'weak_recommendation'],
  output: 'verdict',
});

export const QUESTION_QUALITY_RUBRIC: Rubric = defineRubric({
  id: 'r4.rubric.question_quality',
  version: 1,
  title: 'Question quality',
  instructions: `${COMMON}
Question: were the agent's questions necessary?
- Consider what was already known (turns, domain state, observations), the objective, and what the next proposed action needs as input.
- There is no expected order of questions. A question is fine when its answer materially changes what the agent can do next.
- Report already_known_question (the answer was already available), repeated_question (asked again after being answered), unnecessary_question (the answer would not change anything).`,
  allowedCodes: ['already_known_question', 'repeated_question', 'unnecessary_question'],
  output: 'verdict',
});

export const ACTION_TIMING_RUBRIC: Rubric = defineRubric({
  id: 'r4.rubric.action_timing',
  version: 1,
  title: 'Action timing',
  instructions: `${COMMON}
Question: were governed writes proposed at the right time?
- A write the requester explicitly asked for may be proposed immediately when its inputs are known.
- Report premature_action when a write was proposed before the requester wanted it or before its inputs were known, unnecessarily_delayed_action when an explicitly requested write was postponed without need.
- Recording what the requester stated is not premature.`,
  allowedCodes: ['premature_action', 'unnecessarily_delayed_action'],
  output: 'verdict',
});

export const CAPABILITY_CHOICE_RUBRIC: Rubric = defineRubric({
  id: 'r4.rubric.capability_choice',
  version: 1,
  title: 'Capability choice',
  instructions: `${COMMON}
Question: did the agent read what it needed, with the right capabilities?
- Protocol correctness is already checked elsewhere; judge only the choice.
- Report wrong_capability when a capability could not serve what the agent tried to establish, missing_required_read when the agent asserted or acted on something it had not read.
- Re-reading after an answer expired is a legitimate refresh.`,
  allowedCodes: ['wrong_capability', 'missing_required_read'],
  output: 'verdict',
});

export const CLAIM_EXTRACTION_RUBRIC: Rubric = defineRubric({
  id: 'r4.rubric.claim_extraction',
  version: 1,
  title: 'Claim extraction',
  instructions: `You extract claims from the agent's responses in a finished trajectory. You do not judge whether they are true: the platform verifies each claim against the evidence the response could see.
For each response, list every claim about the world: entity facts, numeric facts, availability, prices, stock, specifications, relationships between entities, compatibility, and recommendations/opinions.
- type: one of entity_fact, numeric_fact, availability, price, stock, specification, relationship, compatibility, recommendation.
- text: the span (or a short normalized proposition), at most 300 characters.
- entities: every entity the claim is about, with the name used in the response, a kind, and the identifier if the response or its evidence gives one. For relationship/compatibility claims list both sides.
- attributes: the stated value when there is one (e.g. amount, unit, status).
Opinions such as "more versatile" or "this suits you" are type recommendation. Answer with the JSON document only; no reasoning.`,
  allowedCodes: [],
  output: 'claims',
});

export const GENERIC_RUBRICS: readonly Rubric[] = [OBJECTIVE_CONTINUITY_RUBRIC, QUESTION_QUALITY_RUBRIC, ACTION_TIMING_RUBRIC, CAPABILITY_CHOICE_RUBRIC, CLAIM_EXTRACTION_RUBRIC];
