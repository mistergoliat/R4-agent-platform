import {
  ACTION_TIMING_RUBRIC,
  CAPABILITY_CHOICE_RUBRIC,
  GroundingEvaluator,
  JudgeClaimExtractor,
  KnownInformationQuestionEvaluator,
  ReceiptBackedClaimEvaluator,
  RubricEvaluator,
  StateContinuityEvaluator,
  genericDeterministicEvaluators,
  type EvaluationDefinition,
} from '@r4/evaluation';
import { SalesClaimVerifier } from './claims.js';
import { SalesCorrectionEvaluator, SalesQuoteEvaluator, quoteClaimDetector, salesKnownState, salesQuestionClassifier, salesWorkspaceHistories } from './evaluators.js';
import { salesDomainView } from './projection.js';
import { SALES_CLAIM_EXTRACTION_RUBRIC, SALES_OBJECTIVE_RUBRIC, SALES_QUESTION_RUBRIC } from './rubrics.js';
import { salesTaxonomy } from './taxonomy.js';

export const SALES_EVALUATION_ID = 'sales.reference';
export const SALES_EVALUATION_VERSION = 1;

/**
 * The Sales evaluation definition (R4-G): the generic deterministic
 * evaluators, the Sales deterministic pack (receipt-backed quote claims,
 * quote figures, workspace continuity, budget correction, already-known
 * questions), then the semantic evaluators (grounding, objective continuity,
 * question quality, action timing, capability choice) — which run only when
 * a judge is supplied and are inconclusive, never failing, when it fails.
 */
export function salesEvaluationDefinition(): EvaluationDefinition {
  return {
    id: SALES_EVALUATION_ID,
    version: SALES_EVALUATION_VERSION,
    taxonomy: salesTaxonomy(),
    evaluators: [
      ...genericDeterministicEvaluators(),
      new ReceiptBackedClaimEvaluator({ ref: { id: 'sales.quote_claims', version: 1 }, detector: quoteClaimDetector, code: 'quote_claim_without_receipt' }),
      new SalesQuoteEvaluator(),
      new StateContinuityEvaluator({ ref: { id: 'sales.workspace_continuity', version: 1 }, accessors: [salesWorkspaceHistories] }),
      new SalesCorrectionEvaluator(),
      new KnownInformationQuestionEvaluator({ ref: { id: 'sales.known_questions', version: 1 }, classifier: salesQuestionClassifier, state: salesKnownState }),
      new GroundingEvaluator({
        ref: { id: 'sales.grounding', version: 3 },
        extractor: new JudgeClaimExtractor({ ref: { id: 'sales.claim_extractor', version: 2 }, rubric: SALES_CLAIM_EXTRACTION_RUBRIC }),
        verifier: new SalesClaimVerifier(),
        nonexistentEntityCode: 'nonexistent_product_or_category_claim',
      }),
      new RubricEvaluator({ ref: { id: 'sales.objective_continuity', version: 1 }, rubric: SALES_OBJECTIVE_RUBRIC, description: 'Whether the trajectory kept serving the customer objective (incidental questions, corrections, waits).', assessesObjective: true }),
      new RubricEvaluator({ ref: { id: 'sales.question_quality', version: 1 }, rubric: SALES_QUESTION_RUBRIC, description: 'Necessary vs redundant / already-known / unnecessary questions, in context.' }),
      new RubricEvaluator({ ref: { id: 'r4.action_timing', version: 1 }, rubric: ACTION_TIMING_RUBRIC, description: 'Premature or unnecessarily delayed governed writes.' }),
      new RubricEvaluator({ ref: { id: 'r4.capability_choice', version: 1 }, rubric: CAPABILITY_CHOICE_RUBRIC, description: 'Wrong capability or missing required read.' }),
    ],
    // Personal contact data never reaches a judge; product names, prices and the customer's display name do (they are what is judged).
    privacy: { redactKeys: ['email', 'phone', 'rut', 'address'], domainView: salesDomainView },
    semanticTimeoutMs: 120_000,
  };
}
