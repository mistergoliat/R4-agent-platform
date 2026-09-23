import { ACTION_TIMING_RUBRIC, CAPABILITY_CHOICE_RUBRIC, CLAIM_EXTRACTION_RUBRIC, OBJECTIVE_CONTINUITY_RUBRIC, QUESTION_QUALITY_RUBRIC, defineRubric, type Rubric, type RubricLock } from '@r4/evaluation';

/**
 * Sales rubrics: the generic rubric text plus Sales guidance. They are pack
 * configuration for the judge, versioned and locked — never instructions for
 * the Sales Agent (R4-G does not touch the agent's prompt).
 */
export const SALES_OBJECTIVE_RUBRIC: Rubric = defineRubric({
  id: 'sales.rubric.objective_continuity',
  version: 1,
  title: 'Sales objective continuity',
  instructions: `${OBJECTIVE_CONTINUITY_RUBRIC.instructions}
Sales guidance:
- The customer's objective is usually a solution within constraints (e.g. equipping a home gym within a budget and a space). A side question about one product (weight, price) is incidental: answering it is correct; afterwards the conversation must return to the objective.
- Waiting for the customer is a normal end of a turn, not an abandoned objective.
- A budget correction must be reflected in later proposals.`,
  allowedCodes: OBJECTIVE_CONTINUITY_RUBRIC.allowedCodes,
  output: 'verdict',
});

export const SALES_QUESTION_RUBRIC: Rubric = defineRubric({
  id: 'sales.rubric.question_quality',
  version: 1,
  title: 'Sales question quality',
  instructions: `${QUESTION_QUALITY_RUBRIC.instructions}
Sales guidance:
- Information that commonly matters: budget, available space, training goals, delivery commune, contact data for a quote. Contact data on file may be available through customer context without asking.
- Offering a concrete proposal while asking one or two clarifying questions is good practice; asking for everything upfront is not required.`,
  allowedCodes: QUESTION_QUALITY_RUBRIC.allowedCodes,
  output: 'verdict',
});

export const SALES_CLAIM_EXTRACTION_RUBRIC: Rubric = defineRubric({
  id: 'sales.rubric.claim_extraction',
  version: 1,
  title: 'Sales claim extraction',
  instructions: `${CLAIM_EXTRACTION_RUBRIC.instructions}
Sales entity kinds: product (a specific item; use its catalog id such as RACK-PR200 as ref when the evidence gives it), category (a kind of equipment offered, e.g. racks, discos, or a product type such as "cinta" or "elíptica"), brand, service (shipping service), quote, customer.
Prices: attributes.amount in CLP as an integer. Stock: attributes.status or attributes.units. Compatibility claims ("compatible con", "sirve para", "calza con") list both products.`,
  allowedCodes: [],
  output: 'claims',
});

export const SALES_RUBRICS: readonly Rubric[] = [SALES_OBJECTIVE_RUBRIC, SALES_QUESTION_RUBRIC, SALES_CLAIM_EXTRACTION_RUBRIC, ACTION_TIMING_RUBRIC, CAPABILITY_CHOICE_RUBRIC];

/**
 * Recorded hash of every released rubric version used by the Sales
 * evaluation definition. Editing a rubric without bumping its version makes
 * `contract/quality-boundaries` fail.
 */
export const SALES_RUBRIC_LOCK: RubricLock = {
  'sales.rubric.objective_continuity@1': 'b3b9488d8f8cbef06edfb22382c4a715deb81a27ec36767e2c86f359ba28bf65',
  'sales.rubric.question_quality@1': '692607290b6fd241d28c4e41b197fe474210919dee0f8df509b094c4c3b9cf1d',
  'sales.rubric.claim_extraction@1': '92eaa0fc5a43d7c26f593c5faf38e536de4452e8a723e8aff2a9cb0f20c5c2e7',
  'r4.rubric.action_timing@1': '68896a894e623b80c390f9c1e77943c16391b045f8fb421137eac0c5edfe4c84',
  'r4.rubric.capability_choice@1': '217a237f5f85fc4b71fd75b293b81813f928337ffdb3d11af838ae820537860d',
};
