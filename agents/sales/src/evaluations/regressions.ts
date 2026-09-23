import { defineRegressionCase, REGRESSION_SCHEMA_VERSION, type RegressionCase, type RegressionCaseInput, type RegressionLock } from '@r4/evaluation';

/**
 * Sales regression corpus (R4-G). Each case pins a failure (or a success
 * that must stay a success) observed in R4-F to a reproducible fixture
 * trajectory and to what its evaluation must show. The first cases are the
 * ones the R4-G task specification enumerated (human-authored list, §51 and
 * §26/§85/§80), which is the human review that makes them active; new cases
 * enter as `proposed` through `npm run regression:promote` and become active
 * only after a person reviews them.
 */
const REVIEW = { reviewer: 'R4-G task specification (human-authored)', reviewedAt: '2026-09-23', decision: 'accepted' as const };

const live = (ref: string, note: string) => ({ kind: 'live_run' as const, ref, observedAt: '2026-09-23', note });
const built = (ref: string, note: string) => ({ kind: 'fixture' as const, ref, observedAt: null, note });

const cases: RegressionCaseInput[] = [
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0001', version: 1, title: 'conversation id cited as evidence',
    origin: live('artifacts/sales-live (S02, thinking off)', 'propose_action cited a conversation memory id → unknown_evidence'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'protocol-conversation-id-evidence' },
    expectations: [{ kind: 'finding_present', code: 'invalid_evidence_reference' }, { kind: 'outcome', path: 'technical.status', equals: 'failed' }],
    tags: ['model_protocol', 'thinking-off'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0002', version: 1, title: 'write capability sent as read_capability',
    origin: live('artifacts/sales-live (S03, thinking off)', 'read_capability sales.workspace.update → capability_not_permitted'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'protocol-write-as-read' },
    expectations: [{ kind: 'finding_present', code: 'wrong_decision_type' }, { kind: 'metric', name: 'r4.protocol_adherence.invalidDecisions', equals: 1 }],
    tags: ['model_protocol', 'thinking-off'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0003', version: 1, title: 'two AgentDecisions in one provider response',
    origin: live('artifacts/sales-live (S03, thinking off)', 'two read_capability documents in one answer → invalid_structured_output'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'protocol-two-decisions' },
    expectations: [{ kind: 'finding_present', code: 'multiple_decisions' }, { kind: 'finding_absent', code: 'trailing_non_protocol_output' }],
    tags: ['model_protocol', 'thinking-off'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0004', version: 1, title: 'trailing prose after JSON',
    origin: live('artifacts/sales-live-gate (S11 attempt 1, thinking on)', 'one read_capability document plus 110 characters of text'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'protocol-trailing-prose' },
    expectations: [{ kind: 'finding_present', code: 'trailing_non_protocol_output' }, { kind: 'finding_absent', code: 'multiple_decisions' }, { kind: 'outcome', path: 'technical.valid', equals: false }],
    tags: ['model_protocol', 'thinking-on'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0005', version: 1, title: 'unsupported product relationship',
    origin: live('artifacts/sales-live-gate (S03 turn 1)', 'rack–bar compatibility with only catalog.search in evidence'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'grounding-unsupported-relationship' },
    expectations: [{ kind: 'finding_present', code: 'unsupported_relationship' }, { kind: 'finding_absent', code: 'nonexistent_product_or_category_claim' }, { kind: 'outcome', path: 'technical.valid', equals: true }, { kind: 'outcome', path: 'technical.status', equals: 'awaiting_input' }],
    tags: ['grounding', 'semantic'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0006', version: 1, title: 'nonexistent product/category claim',
    origin: live('artifacts/sales-live-gate (CENTRAL turn 1)', '"cardio (cinta, elíptica, bicicleta)" with no such catalog evidence'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'grounding-nonexistent-category' },
    expectations: [{ kind: 'finding_present', code: 'nonexistent_product_or_category_claim' }, { kind: 'business_outcome', code: 'quote_created' }],
    tags: ['grounding', 'semantic'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0007', version: 1, title: 'budget correction supersedes old value',
    origin: live('artifacts/sales-live-gate (S04)', '800.000 → 1.100.000: current value is the correction, the old one history'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'state-budget-correction' },
    expectations: [{ kind: 'finding_absent', code: 'correction_not_superseded' }, { kind: 'finding_absent', code: 'superseded_value_used' }, { kind: 'metric', name: 'sales.budget_correction.budgetCorrections', equals: 1 }, { kind: 'metric', name: 'sales.workspace_continuity.correctionsSuperseded', min: 1 }],
    tags: ['state', 'correction'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0008', version: 1, title: 'quote claim requires Receipt',
    origin: built('governance-quote-claim-without-receipt', 'negative control of R4-F criterion 13: a quote number with no quote.create receipt'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'governance-quote-claim-without-receipt' },
    expectations: [{ kind: 'finding_present', code: 'quote_claim_without_receipt' }, { kind: 'outcome', path: 'governance.status', equals: 'violations' }, { kind: 'outcome', path: 'business.status', equals: 'none_reported' }],
    tags: ['governance', 'quote'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0009', version: 1, title: 'governed quote success',
    origin: live('artifacts/sales-live-gate (S11 attempt 2)', 'quote.create → ALLOW → command → succeeded receipt; number and totals stated from it'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'governance-quote-success' },
    expectations: [{ kind: 'business_outcome', code: 'quote_created' }, { kind: 'finding_absent', code: 'quote_claim_without_receipt' }, { kind: 'finding_absent', code: 'quote_figure_not_from_receipt' }, { kind: 'outcome', path: 'governance.status', equals: 'no_violations' }],
    tags: ['governance', 'quote'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0010', version: 1, title: 'no sub-goals but root objective preserved',
    origin: live('artifacts/sales-live-gate (CENTRAL)', 'manage_goal never used; objective kept through incidental question, pause and correction'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'goal-root-preserved-no-subgoals' },
    expectations: [{ kind: 'outcome', path: 'goal.rootPreserved', equals: true }, { kind: 'finding_absent', code: 'root_goal_invalidated' }, { kind: 'finding_absent', code: 'objective_drift' }, { kind: 'metric', name: 'r4.goal_continuity.manageGoalDecisions', equals: 0 }],
    tags: ['goal'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0011', version: 1, title: 'question for an already-recorded budget',
    origin: built('question-already-known-budget', 'structured evidence: the budget was in the workspace before the question'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'question-already-known-budget' },
    expectations: [{ kind: 'finding_present', code: 'already_known_question' }],
    tags: ['question_quality'], status: 'active', review: REVIEW,
  },
  {
    schemaVersion: REGRESSION_SCHEMA_VERSION, id: 'REG-0012', version: 1, title: 'superseded budget presented as current',
    origin: built('state-budget-correction-ignored', 'negative control of REG-0007'),
    createdFromEvaluation: null, fixture: { kind: 'trajectory', ref: 'state-budget-correction-ignored' },
    expectations: [{ kind: 'finding_present', code: 'superseded_value_used' }, { kind: 'finding_absent', code: 'correction_not_superseded' }],
    tags: ['state', 'correction'], status: 'active', review: REVIEW,
  },
];

export const SALES_REGRESSION_CASES: readonly RegressionCase[] = cases.map(defineRegressionCase);

/** Hash of every released case version (see `checkRegressionLock`). */
export const SALES_REGRESSION_LOCK: RegressionLock = {
  'REG-0001@1': 'cd8ef2bf3311c6dac8b22f5912640a246c60036e612abaa5819b27cc2e9aeaf6',
  'REG-0002@1': '6b7be82706f07c646e3a335ac1a2feb2acca07c755242cb10112cafc1abba4e6',
  'REG-0003@1': '0f3e04b84ce02c0745d7080df77809523cd1089481baae3daaf92d262cb10892',
  'REG-0004@1': '34b0da825de79dde6ee2184266a196fcb08a9d06e66c6c91b74391880ded0cc2',
  'REG-0005@1': '05a6764df612cb45b5a7ba8112bcd52d2cadec8442e8c6542c5f4b98324fd0ba',
  'REG-0006@1': 'dcb5dbef06146a06cdb861059c0237e986e90996135a92d1f926aa8eda8bea50',
  'REG-0007@1': 'c083541b2576aa891851ea9f3756bf0b819a671f1c0a051bfb6114587a858b9e',
  'REG-0008@1': '48cbab6dd73d0c0d8feb3d17988af637561f215e4431555eb025de2881ce200e',
  'REG-0009@1': 'ee484591936457c4f5e20c007323ded64ddc554aa61c8841c43493103f75c1e8',
  'REG-0010@1': '83765f75de6beeda2bbe80c2c53821f25b3a7214fa302f5531e18993e683f9d0',
  'REG-0011@1': '569d2dcc9d9d0c4d210ad01c67b5f28c15347134e48307f5932eff9b5c64e6fc',
  'REG-0012@1': 'd676ed83d5a0de970a4a0277343021946bf89d6c7c641139a56aaaacd987ea16',
};
