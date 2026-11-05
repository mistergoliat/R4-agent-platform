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
import { SalesCorrectionEvaluator, SalesQuoteEvaluator, operationClaimDetector, quoteClaimDetector, salesKnownState, salesQuestionClassifier, salesWorkspaceHistories } from './evaluators.js';
import { salesDomainView } from './projection.js';
import { SALES_CLAIM_EXTRACTION_RUBRIC, SALES_DS1_RUBRIC, SALES_OBJECTIVE_RUBRIC, SALES_QUESTION_RUBRIC } from './rubrics.js';
import { salesTaxonomy } from './taxonomy.js';

export const SALES_EVALUATION_ID = 'sales.reference';
/** 2: DS-1 operation-claim evaluator (`operation_claim_without_receipt`). 3: DS-1 semantic rubric (judge only). */
export const SALES_EVALUATION_VERSION = 3;

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
      // DS-1: offline measurement only; it does not prevent a wrong promise in production (D7-3).
      new ReceiptBackedClaimEvaluator({ ref: { id: 'sales.operation_claims', version: 1 }, detector: operationClaimDetector, code: 'operation_claim_without_receipt' }),
      new SalesQuoteEvaluator(),
      new StateContinuityEvaluator({ ref: { id: 'sales.workspace_continuity', version: 1 }, accessors: [salesWorkspaceHistories] }),
      new SalesCorrectionEvaluator(),
      new KnownInformationQuestionEvaluator({ ref: { id: 'sales.known_questions', version: 1 }, classifier: salesQuestionClassifier, state: salesKnownState }),
      new GroundingEvaluator({
        ref: { id: 'sales.grounding', version: 2 },
        extractor: new JudgeClaimExtractor({ ref: { id: 'sales.claim_extractor', version: 1 }, rubric: SALES_CLAIM_EXTRACTION_RUBRIC }),
        verifier: new SalesClaimVerifier(),
        nonexistentEntityCode: 'nonexistent_product_or_category_claim',
      }),
      new RubricEvaluator({ ref: { id: 'sales.objective_continuity', version: 1 }, rubric: SALES_OBJECTIVE_RUBRIC, description: 'Whether the trajectory kept serving the customer objective (incidental questions, corrections, waits).', assessesObjective: true }),
      new RubricEvaluator({ ref: { id: 'sales.question_quality', version: 1 }, rubric: SALES_QUESTION_RUBRIC, description: 'Necessary vs redundant / already-known / unnecessary questions, in context.' }),
      // DS-1 semantic detection (judge only; inconclusive without one): implicit confirmations, unavailable offers, unverified commitments.
      new RubricEvaluator({ ref: { id: 'sales.ds1_commitments', version: 1 }, rubric: SALES_DS1_RUBRIC, description: 'DS-1: implicit confirmations of changes no capability made, offers of unavailable operations, unverified commercial commitments.' }),
      new RubricEvaluator({ ref: { id: 'r4.action_timing', version: 1 }, rubric: ACTION_TIMING_RUBRIC, description: 'Premature or unnecessarily delayed governed writes.' }),
      new RubricEvaluator({ ref: { id: 'r4.capability_choice', version: 1 }, rubric: CAPABILITY_CHOICE_RUBRIC, description: 'Wrong capability or missing required read.' }),
    ],
    // Personal contact data never reaches a judge; product names, prices and the customer's display name do (they are what is judged).
    privacy: { redactKeys: ['email', 'phone', 'rut', 'address'], domainView: salesDomainView },
    semanticTimeoutMs: 120_000,
  };
}
