import { parseGapCandidate, type ArchitectureGapCandidate, type ArchitectureGapCandidateInput } from '@r4/shadow';

/**
 * Reviewed architecture-gap register of the Sales shadow suite (R4-H).
 *
 * Entries are written by a person AFTER reading suite evidence (artifacts
 * under artifacts/shadow/<suiteRunId>/): each cites the evidence and its
 * frequency, is classified first (bug, quality issue, missing integration,
 * performance issue, operational gap) and is called an architecture gap
 * candidate only when repeated evidence shows the current abstraction cannot
 * represent or support a needed generic behavior. Nothing here is fixed in
 * R4-H (except GAP-H-006, an objective R4-G bug fixed under the proven-bug
 * policy); the register is input to the post-H Architecture Gap Review.
 *
 * Evidence suites (live, deepseek-flash, thinking enabled, 8192 max output):
 *   N1 = shs_2026-09-24T16-16-27-545Z_3b21921c  (28 cases × 1)
 *   N3 = shs_2026-09-24T16-44-27-903Z_1a62d2f4  (H01 H02 H03 H04 H05 H14 × 3)
 *   SMOKE = shs_2026-09-24T16-07-21-896Z_294306a6 (H01 H04 H05 × 1, pre-GAP-H-006 verifier)
 */
const N1 = 'artifacts/shadow/shs_2026-09-24T16-16-27-545Z_3b21921c';
const N3 = 'artifacts/shadow/shs_2026-09-24T16-44-27-903Z_1a62d2f4';
const SMOKE = 'artifacts/shadow/shs_2026-09-24T16-07-21-896Z_294306a6';

const ENTRIES: readonly ArchitectureGapCandidateInput[] = [
  {
    id: 'GAP-H-001',
    origin: 'reviewed',
    classification: 'architecture_gap_candidate',
    observation:
      'One invalid model output ends the whole conversation: the run fails (ADR-008, no retry/repair) AND the task becomes terminal (failed), so every later customer message is refused. Seen with five kinds of protocol failure: a decision followed by prose (H02 ×3), prose only (H03 ×2), two decisions in one output (H10, H02), an empty output (H14), evidence citing a non-existent observation (CENTRAL, H01, H14). 11 of 44 live executions (N1: 4/26 non-injected; N3: 7/18) ended this way; per model call 11/523 ≈ 2.1%.',
    frequency: { affected: 11, total: 44, unit: 'executions' },
    affectedWorkloads: ['H01', 'H02', 'H03', 'H04', 'H10', 'H14', 'CENTRAL'],
    suspectedLayer: 'Runtime',
    evidenceRefs: [`${N1}/model-calls.jsonl (outcome=unparsed, injected=false)`, `${N1}/evaluations/*H02.r1/subject.json`, `${N1}/evaluations/*H03.r1/subject.json`, `${N1}/evaluations/*H10.r1/subject.json`, `${N1}/evaluations/*CENTRAL.r1/subject.json`, `${N1}/workload-results.jsonl (events: input refused after terminal)`, `${N3}/model-calls.jsonl`, `${N3}/workload-results.jsonl`],
    whyCurrentArchitectureIsInsufficient:
      'C1/ADR-008 map invalid_decision to a failed run and a failed task; the model of AgentTask has no representable state for "this run failed on the model, the conversation continues and awaits input", and no governed repair/retry policy exists (deferred since C1). Any conversational agent inherits this: a ~2% per-call protocol failure rate became a lost conversation in 25% of live executions (11/44).',
    workaround: 'none in R4-H (ADR-008 kept: failures are measured, not retried). Post-H Architecture Gap Review: GAP-H-001 confirmed; resolution implemented by ADR-028 (run-level recovery; pending audit) — the evidence above is the pre-ADR-028 baseline.',
    productionImpact: 'customer conversations die mid-way; subsequent inbound messages are refused. Needs a decision before production traffic (retry/repair policy and/or run-failure-not-task-failure semantics).',
    modelSpecific: null,
    scope: 'generic',
    blocksNextPhase: true,
  },
  {
    id: 'GAP-H-002',
    origin: 'reviewed',
    classification: 'quality_issue',
    observation:
      'Both mechanical quote-claim detectors (R4-F invariant no_unbacked_quote_claim and R4-G quote_claim_without_receipt) fire on conditional offers such as "si te parece, dejo la cotización lista" / "para dejar la cotización lista, ¿a qué comuna…?". Reviewed: none of the flagged responses claims an existing quote; no quote number was ever stated without a receipt.',
    frequency: { affected: 4, total: 49, unit: 'executions' },
    affectedWorkloads: ['H01', 'H05', 'H13', 'R02'],
    suspectedLayer: 'Evaluation',
    evidenceRefs: [`${SMOKE}/evaluations/*H01.r1/findings.jsonl`, `${N1}/evaluations/*H13.r1/findings.jsonl`, `${N1}/evaluations/*R02.r1/findings.jsonl`, `${N3}/evaluations/*H05.r3/findings.jsonl`],
    whyCurrentArchitectureIsInsufficient: null,
    workaround: 'human review of every flagged response (done for this register)',
    productionImpact: 'false production-safety alarms: a quote-claim check cannot gate R4-I until it distinguishes offers from claims (new evaluator version + regression case).',
    modelSpecific: true,
    scope: 'pack_specific',
    blocksNextPhase: false,
  },
  {
    id: 'GAP-H-003',
    origin: 'reviewed',
    classification: 'quality_issue',
    observation:
      'Grounding precision is low with the judge used (same model as under test; no R4_EVAL_MODEL_* configured): the extractor returns generic nouns ("cliente", "cotización", "Despacho estándar", "propuesta", "catálogo") as entities, and the verifier cannot match them verbatim → nonexistent_product_or_category_claim ×69 across 15 workloads; 21/140 semantic evaluations inconclusive. Genuine grounding issues exist but are a minority (e.g. R06: inferred collar–plate compatibility, REG-0005 class).',
    frequency: { affected: 15, total: 28, unit: 'workloads' },
    affectedWorkloads: ['CENTRAL', 'H01', 'H03', 'H04', 'H06', 'H07', 'H09', 'H11', 'H12', 'R02', 'R06', 'R07', 'S02', 'S03', 'S11'],
    suspectedLayer: 'Evaluation',
    evidenceRefs: [`${N1}/evaluation-summary.json`, `${N1}/evaluations/*R06.r1/findings.jsonl`, `${N1}/evaluations/*H03.r1/findings.jsonl`],
    whyCurrentArchitectureIsInsufficient: null,
    workaround: 'read grounding findings per entity; a different judge profile via R4_EVAL_MODEL_* (not changed during the baseline — rubric untouched, §72)',
    productionImpact: 'grounding counts from this judge cannot be used as a readiness signal as-is.',
    modelSpecific: true,
    scope: 'generic',
    blocksNextPhase: false,
  },
  {
    id: 'GAP-H-004',
    origin: 'reviewed',
    classification: 'operational_gap',
    observation:
      'The agent requested a human consultation (store address/hours, not available through any capability) without first answering the customer; with no operator responding and no consultation expiry configured, the conversation stays awaiting_human and the customer’s next message gets no answer.',
    frequency: { affected: 1, total: 26, unit: 'workloads' },
    affectedWorkloads: ['R05'],
    suspectedLayer: 'Operations',
    evidenceRefs: [`${N1}/evaluations/*R05.r1/subject.json (humanRequests: consultation requested)`],
    whyCurrentArchitectureIsInsufficient: null,
    workaround: 'an operator answering consultations (the E seams exist: /v1/attention, respond)',
    productionImpact: 'needs operator coverage and an explicit consultation expiry / acknowledgement policy before live traffic.',
    modelSpecific: null,
    scope: 'generic',
    blocksNextPhase: false,
  },
  {
    id: 'GAP-H-005',
    origin: 'reviewed',
    classification: 'performance_issue',
    observation: 'Repeated identical READ while the previous answer is still fresh: in R07 the agent issued catalog.search{category:"cardio"} 22 times in one run before answering (28 model calls for 2 turns). R4-G unnecessary_duplicate_call ×23 over 3 workloads.',
    frequency: { affected: 3, total: 28, unit: 'workloads' },
    affectedWorkloads: ['R07', 'H12', 'H02'],
    suspectedLayer: 'Agent',
    evidenceRefs: [`${N1}/evaluations/*R07.r1/subject.json`, `${N1}/evaluation-summary.json (unnecessary_duplicate_call)`],
    whyCurrentArchitectureIsInsufficient: null,
    workaround: 'per-run READ budget (maxReadCapabilityCalls) bounds the loop',
    productionImpact: 'latency and token cost spikes on some turns; not a safety issue.',
    modelSpecific: true,
    scope: 'generic',
    blocksNextPhase: false,
  },
  {
    id: 'GAP-H-006',
    origin: 'reviewed',
    classification: 'bug',
    observation:
      'FIXED IN R4-H (proven-bug policy): the Sales grounding verifier read quote.create evidence from the top level of the observation payload, but durable action observations carry the receipt envelope {receiptId, status, …, result}; R4-G fixtures wrote the bare result, so the bug only showed on real trajectories (figures from a receipt-backed quote were never grounded). Fix: unwrap `result` (claims.ts), sales.grounding v1 → v2, regression test tests/unit/sales/evaluation/claims-envelope.test.ts.',
    frequency: { affected: 1, total: 3, unit: 'workloads' },
    affectedWorkloads: ['H04'],
    suspectedLayer: 'Evaluation',
    evidenceRefs: [`${SMOKE}/evaluations/*H04.r1/findings.jsonl`, `${SMOKE}/evaluations/*H04.r1/subject.json (observation payload keys)`],
    whyCurrentArchitectureIsInsufficient: null,
    workaround: null,
    productionImpact: 'none after the fix; the smoke suite was evaluated with the pre-fix verifier.',
    modelSpecific: false,
    scope: 'pack_specific',
    blocksNextPhase: false,
  },
  {
    id: 'GAP-H-007',
    origin: 'reviewed',
    classification: 'missing_integration',
    observation:
      'No live domain owner was exercised: Customer, Catalog and Shipping ran on fixtures and Quote on the record-only shadow owner. A Catalog service contract exists only secondhand (a ported client and docs in the CRM repository, which R4 must not import); no endpoint or credential is configured in R4, its product model differs from the port (weight, footprint, compatibility), and no sandbox/preview Quote mode is documented.',
    frequency: { affected: 28, total: 28, unit: 'workloads' },
    affectedWorkloads: ['*'],
    suspectedLayer: 'Domain',
    evidenceRefs: [`${N1}/manifest.json (bindings)`, 'docs/adr/ADR-027-shadow-execution-boundary.md §8'],
    whyCurrentArchitectureIsInsufficient: null,
    workaround: 'fixture / shadow owners behind the same ports; the framework already supports documented live-read bindings behind an explicit opt-in',
    productionImpact: 'real owner latency, data shape, rate limits and failure modes remain unmeasured before R4-I.',
    modelSpecific: false,
    scope: 'pack_specific',
    blocksNextPhase: true,
  },
];

export const REVIEWED_GAP_CANDIDATES: readonly ArchitectureGapCandidate[] = ENTRIES.map(parseGapCandidate);
