import type { Distribution } from '@r4/evaluation';
import type { CountedRate } from './aggregate.js';
import type { ArchitectureGapCandidate } from './gaps.js';
import type { ShadowSuiteRun } from './suite.js';

/**
 * Human report of a shadow suite (R4-H). Sections are kept apart on purpose —
 * execution correctness, agent quality, domain integration, operational
 * metrics, shadow safety, gap candidates — and there is no overall score.
 * The readiness matrix is descriptive: each row states the evidence.
 */
const r = (c: CountedRate) => `${c.numerator}/${c.denominator}${c.rate === null ? '' : ` (${(c.rate * 100).toFixed(1)}%)`}`;
const d = (x: Distribution, unit = '') => (x.n === 0 ? 'n/a' : `median ${x.median}${unit} · p95 ${x.p95 === null ? `n/a (n=${x.n}<20)` : `${x.p95}${unit}`} · max ${x.max}${unit} (n=${x.n}${x.missing ? `, missing ${x.missing}` : ''})`);
const kv = (o: Readonly<Record<string, number>>) => Object.entries(o).map(([k, v]) => `${k}×${v}`).join(', ') || 'none';

export function shadowSuiteReport(suite: ShadowSuiteRun, reviewed: readonly ArchitectureGapCandidate[] = []): string {
  const a = suite.aggregates;
  const p = suite.plan;
  const q = a.quality;
  const executed = suite.runs.filter((x) => x.status === 'executed');
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  add(`# Shadow suite ${suite.suiteRunId}`, '', `${suite.label}`, '');
  add(`- execution mode: **${p.execution.mode}** (${p.execution.suiteMode}; declared by ${p.execution.declaredBy}; live model ${p.execution.allowLiveModel ? 'allowed' : 'not allowed'}; live read ${p.execution.allowLiveRead ? 'allowed' : 'not allowed'})`);
  add(`- model: ${p.modelProfile ? `${p.modelProfile.provider} ${p.modelProfile.model} (profile ${p.modelProfile.profile ?? '-'}, max output ${p.modelProfile.maxOutputTokens ?? '-'}, context ${p.modelProfile.contextWindowTokens ?? '-'}, format ${p.modelProfile.responseFormat ?? '-'}, extras ${JSON.stringify(p.modelProfile.extras)}, fingerprint ${p.modelProfile.fingerprint.slice(0, 12)})` : 'none'}`);
  add(`- judge: ${suite.reproducibility.judgeProfile ? `${suite.reproducibility.judgeProfile.provider} ${suite.reproducibility.judgeProfile.model} (${suite.reproducibility.judgeProfile.fingerprint.slice(0, 12)})` : 'none (semantic evaluators skipped)'}`);
  add(`- code: ${suite.reproducibility.gitSha}${suite.reproducibility.gitDirty ? ' (working tree dirty)' : ''} · corpus ${p.corpus.id}@${p.corpus.version} (${p.corpus.fingerprint.slice(0, 12)}) · evaluation ${suite.reproducibility.evaluationDefinition.id}@${suite.reproducibility.evaluationDefinition.version}`);
  add(`- executions: planned ${suite.counts.planned}, executed ${suite.counts.executed}, execution failures ${suite.counts.executionFailed}, not run (budget) ${suite.counts.notRunDueToBudget}, not run (stop condition) ${suite.counts.notRunDueToStopCondition}; repetitions ${p.repetitions}; concurrency ${p.concurrency}`);
  add(`- stop: ${suite.stop.stopped ? `**STOPPED** — ${suite.stop.reason}` : 'not stopped'} · budget used: ${suite.budget.usage.modelCalls} model calls, ${suite.budget.usage.inputTokens} input / ${suite.budget.usage.outputTokens} output tokens${suite.budget.exhausted ? ` (exhausted: ${suite.budget.exhausted})` : ''}`, '');

  add('## 1. Execution correctness', '');
  add(`- legitimate technical stop (R4-G): ${r(a.technical.legitimateStop)}; stop acceptable for the case: ${r(a.technical.acceptableStopForCase)}`);
  add(`- technical status distribution: ${kv(a.technical.statusDistribution)}`);
  add(`- invariants (exercised) — safety ${a.invariants.byClass.safety.passed}/${a.invariants.byClass.safety.total}, technical ${a.invariants.byClass.technical.passed}/${a.invariants.byClass.technical.total}, behavioral ${a.invariants.byClass.behavioral.passed}/${a.invariants.byClass.behavioral.total}; not exercised (condition never arose): ${a.invariants.byClass.safety.notExercised + a.invariants.byClass.technical.notExercised + a.invariants.byClass.behavioral.notExercised}`);
  add(`- runs recovered after a worker loss: ${a.reliability.runsRecovered}; execution failures (infrastructure): ${a.reliability.executionFailures}`);
  if (a.invariants.failed.length > 0) {
    add('', '| run | class | invariant | detail |', '|---|---|---|---|');
    for (const f of a.invariants.failed) add(`| ${f.shadowRunId.split('.').slice(-2).join('.')} | ${f.class} | ${f.kind} | ${f.detail.replace(/\|/g, '/').slice(0, 160)} |`);
  }
  add('');

  add('## 2. Agent quality (R4-G vector)', '');
  if (q) {
    add(`- protocol adherence (valid decisions / decision attempts): ${r(a.protocol.adherence)}; excluding workloads with injected provider faults: ${r(a.protocol.adherenceExcludingInjectedFaults)}`);
    add(`- root goal preserved: ${q.rootGoalPreserved.numerator}/${q.rootGoalPreserved.denominator}; governance findings: ${a.governance.governanceFindings}`);
    add(`- semantic coverage: requested ${a.semantic.requested}, completed ${a.semantic.completed}, inconclusive ${a.semantic.inconclusive}, skipped ${a.semantic.skipped}, error ${a.semantic.error}${a.semantic.requested === 0 ? ' — no judge: absence of semantic findings is NOT a pass' : ''}`);
    add('', '| finding code | occurrences | runs affected |', '|---|---|---|');
    for (const [code, v] of Object.entries(q.findingsByCode)) add(`| ${code} | ${v.occurrences} | ${v.runsAffected} |`);
    if (Object.keys(q.findingsByCode).length === 0) add('| (none) | 0 | 0 |');
  } else add('- no trajectory was evaluated');
  add('');

  add('## 3. Domain integration', '', '| Domain | Binding | Status |', '|---|---|---|');
  for (const b of p.bindings) add(`| ${b.domain} | ${b.kind}:${b.bindingId}@${b.version} | ${b.kind === 'live-read' ? 'REAL (read-only)' : b.kind === 'sandbox' ? 'SANDBOX' : b.kind === 'shadow' ? 'SHADOW' : 'FIXTURE'}${b.contractRef ? ` — contract ${b.contractRef}` : ''} |`);
  add(`| outbound | ${p.outbound.kind}:${p.outbound.bindingId}@${p.outbound.version} | shadow-only (actual delivery ${p.actualOutboundDelivery}) |`, '');
  add(`- domain calls ${a.reliability.domainCalls}; errors ${kv(a.reliability.domainErrorsByCategory)} (rate ${r(a.reliability.domainErrorRate)}); domain rate limits ${a.reliability.domainRateLimits}`, '');

  add('## 4. Operational metrics', '');
  add(`- user-perceived latency (input received → response ready): ${d(a.operational.userPerceivedMs, 'ms')}`);
  add(`- turn wall-clock: ${d(a.operational.turnWallClockMs, 'ms')}`);
  add(`- model call latency: ${d(a.operational.modelCallMs, 'ms')}`);
  add(`- domain call latency: ${d(a.operational.domainCallMs, 'ms')}`);
  add(`- evaluation latency (per trajectory): ${d(a.operational.evaluationMs, 'ms')}`);
  add(`- model calls / input turn: ${d(a.operational.modelCallsPerInputTurn)}; input tokens / input turn: ${d(a.operational.inputTokensPerInputTurn)}`);
  add(`- capability reads / input turn: ${d(a.operational.capabilityReadsPerInputTurn)}; reads ${a.operational.capabilityReads} (duplicate while fresh ${a.operational.duplicateReads}, refresh after expiry ${a.operational.refreshReads}); write proposals / task: ${d(a.operational.writeProposalsPerTask)}`);
  add(`- context: max tokens per workload ${d(a.operational.contextMaxTokens)}; growth first→last call ${d(a.operational.contextGrowthTokens)}`);
  add(`- totals: ${a.operational.totals.modelCalls} model calls, ${a.operational.totals.inputTokens} input / ${a.operational.totals.outputTokens} output tokens; reasoning tokens: not exposed. ${a.operational.totals.note}`);
  add(`- provider: errors ${kv(a.reliability.providerErrorsByKind)} over ${a.reliability.modelCalls} real calls (rate ${r(a.reliability.providerErrorRate)}); provider rate limits ${a.reliability.providerRateLimits}; injected (controlled) faults ${kv(a.reliability.injectedFaults)}`, '');

  add('## 5. Governance and human collaboration', '');
  add(`- proposals ${a.governance.proposals}: ALLOW ${a.governance.allow}, DENY ${a.governance.deny}, REQUIRE_APPROVAL ${a.governance.requireApproval}; receipts ${kv(a.governance.receiptsByStatus)}; reconciliation attempts ${a.governance.reconciliationAttempts}`);
  add(`- operator actions applied: ${kv(a.human.byStatus)}; ownership violations ${a.human.ownershipViolations}`, '');

  add('## 6. Shadow safety', '');
  add(`- production effects: **${a.safety.productionEffects}** · real outbound deliveries: **${a.safety.realOutboundDeliveries}** · messages that would have been delivered: ${a.safety.outboundWouldDeliver}`);
  add(`- shadow effects executed: ${a.safety.shadowEffectsExecuted}; sandbox effects: ${a.safety.sandboxEffectsExecuted}; calls refused by the boundary: ${a.safety.blockedCalls}`);
  add(`- failed safety checks: ${kv(a.safety.failedChecks)} over ${a.safety.runsChecked} executed runs`, '');

  add('## 7. Readiness matrix (descriptive — no weighted score)', '', '| Dimension | Evidence |', '|---|---|');
  add(`| runtime integrity | legitimate stops ${r(a.technical.legitimateStop)}; technical invariants ${a.invariants.byClass.technical.passed}/${a.invariants.byClass.technical.total}; recoveries ${a.reliability.runsRecovered} |`);
  add(`| governance | ${a.governance.proposals} proposals, ${a.governance.governanceFindings} governance findings, unapproved writes ${a.safety.failedChecks.unapproved_writes_zero ?? 0} |`);
  add(`| quality | ${q ? Object.keys(q.findingsByCode).length : 0} distinct finding codes; behavioral expectations ${a.invariants.byClass.behavioral.passed}/${a.invariants.byClass.behavioral.total} |`);
  add(`| grounding | semantic ${a.semantic.completed}/${a.semantic.requested} completed, ${a.semantic.inconclusive} inconclusive |`);
  add(`| provider reliability | provider error rate ${r(a.reliability.providerErrorRate)}; protocol adherence ${r(a.protocol.adherence)} |`);
  add(`| domain integration | ${p.bindings.map((b) => `${b.domain}=${b.kind}`).join(', ')} |`);
  add(`| latency | user-perceived ${d(a.operational.userPerceivedMs, 'ms')} |`);
  add(`| cost | ${a.operational.totals.inputTokens} in / ${a.operational.totals.outputTokens} out tokens over ${executed.length} executions (no pricing in the runtime) |`);
  add(`| shadow safety | production effects ${a.safety.productionEffects}; real deliveries ${a.safety.realOutboundDeliveries} |`, '');

  const blockers = suite.observations.filter((o) => o.blocksNextPhase);
  add('## 8. Production blockers vs. autonomy/quality limitations', '');
  add(`- production safety blockers observed: ${blockers.length === 0 && a.safety.productionEffects === 0 && a.safety.realOutboundDeliveries === 0 ? 'none' : blockers.map((b) => b.id).join(', ')}`);
  add(`- autonomy / quality limitations: ${suite.observations.filter((o) => !o.blocksNextPhase && o.classification === 'quality_issue').map((o) => o.id).join(', ') || 'none recurring'}`, '');

  add('## 9. Architecture gap candidates', '');
  add('Observed (deterministic, conservative — never an architecture gap by themselves):', '');
  for (const o of suite.observations) add(`- **${o.id}** [${o.classification}, ${o.suspectedLayer}] ${o.observation} — ${o.frequency.affected}/${o.frequency.total} ${o.frequency.unit}; evidence: ${o.evidenceRefs.slice(0, 3).join(', ')}${o.evidenceRefs.length > 3 ? ', …' : ''}`);
  if (suite.observations.length === 0) add('- none');
  add('', 'Reviewed register (human-authored after reading the evidence):', '');
  for (const g of reviewed) add(`- **${g.id}** [${g.classification}, ${g.suspectedLayer}, ${g.scope}] ${g.observation} — ${g.frequency.affected}/${g.frequency.total} ${g.frequency.unit}${g.whyCurrentArchitectureIsInsufficient ? `; why: ${g.whyCurrentArchitectureIsInsufficient}` : ''}`);
  if (reviewed.length === 0) add('- none recorded for this suite');
  add('');

  add('## 10. Per-run summary', '', '| run | status | technical | findings | model calls | tokens in/out | invariants failed | safety |', '|---|---|---|---|---|---|---|---|');
  const resultById = new Map((suite.benchmark?.results ?? []).map((x) => [x.evaluationRunId, x]));
  for (const run of suite.runs) {
    const res = run.evaluationRunId ? resultById.get(run.evaluationRunId) : undefined;
    const failedInv = run.caseInvariants.filter((i) => !i.passed).map((i) => i.kind);
    const failedSafety = run.safety.filter((c) => !c.passed && c.severity !== 'warning').map((c) => c.code);
    add(`| ${run.case.id}.r${run.repetition} | ${run.status} | ${res?.outcome?.technicalStatus ?? '-'} | ${res ? Object.keys(res.findingCodes).join(', ') || '-' : '-'} | ${run.operational?.modelCalls.total ?? '-'} | ${run.operational ? `${run.operational.tokens.input}/${run.operational.tokens.output}` : '-'} | ${failedInv.join(', ') || '-'} | ${run.status === 'executed' ? failedSafety.join(', ') || 'ok' : run.error ?? '-'} |`);
  }
  add('');
  return lines.join('\n');
}
