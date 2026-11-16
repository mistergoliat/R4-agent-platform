#!/usr/bin/env node
// R4 commercial baseline (M1): turns the facts exported by baseline.sql into a comparable report, by segment
// (testers = allowlisted conversations; commercial = rollout cohort), profile, agent version and model, never mixing them.
//
//   node ops/r4-metrics/report.mjs facts.json [--models models.json] [--measured provider-usage.jsonl] [--json out.json]
//
// Units: a CONVERSATION is one customer on one channel (opaque per export); a TASK is one episode of it (a new task
// opens when the previous one ended); a TURN is one run (kind 'input' when a customer input started it, 'continuation'
// for wake-ups, consultation answers and recoveries, which have no customer latency).
//
// Cost. ESTIMATED = tokens recorded in the database × the price of the model window in --models (R4 keeps no model id
// per call, so a window not covered is 'unattributed' and gets no cost). It is an upper bound for the calls R4 records:
// every input token is priced as not cached (the database keeps no cache counts); perception (vision, speech) calls are
// not in it. MEASURED = the provider's own account usage: --measured takes the snapshots the provider budget monitor
// (ops/r4-provider-budget, its own PR) appends, {"at", "accountUsageUsd"} per line, and reports the spend between the first and the
// last snapshot inside the window. It covers the whole provider account (every worker, web QA and perception), and it is
// wrong across a usage-counter reset (a new account). Not visible here: quote executions still held, with no receipt yet.
// TURN tables cover the runs started in the window; TASK tables cover each task of the population whole. Output: text on stdout; --json also writes the aggregates.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { models: { type: 'string' }, measured: { type: 'string' }, json: { type: 'string' } } });
if (!positionals[0]) throw new Error('usage: report.mjs facts.json [--models models.json] [--measured provider-usage.jsonl] [--json out.json]');
const facts = JSON.parse(readFileSync(positionals[0], 'utf8'));
const models = args.models ? JSON.parse(readFileSync(args.models, 'utf8')) : [];

// Object.groupBy needs Node 21; the repository supports Node 20.
const groupBy = (xs, key) => { const g = {}; for (const x of xs) (g[key(x)] ??= []).push(x); return g; };
const countBy = (xs) => Object.fromEntries(Object.entries(groupBy(xs, (x) => x)).map(([k, v]) => [k, v.length]));
const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
const pct = (xs, p) => {
  const s = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const sumOrNull = (xs) => (xs.some((x) => x === null) ? null : sum(xs));
// live-ops rollout eligibility: allowlisted = named testers; cohort = the rollout percentage (real commercial traffic).
const segmentOf = (reason) => (reason === 'allowlisted' ? 'testers' : reason === 'cohort' ? 'commercial' : reason ? `other:${reason}` : 'unbound');
const agentOf = (r) => `${r.agent_id}@${r.agent_version}`;
const modelOf = (r) => {
  const at = Date.parse(r.started_at);
  return models.find((m) => at >= Date.parse(m.from) && at < Date.parse(m.to ?? '2999-01-01') && (!m.agents || m.agents.includes(agentOf(r)))) ?? null;
};
const costOf = (model, input, output) => (model ? ((input ?? 0) * model.priceInPerM + (output ?? 0) * model.priceOutPerM) / 1e6 : null);
const seconds = (xs) => xs.map((x) => (x === null ? null : x / 1000));
const merge = (counts) => { const m = {}; for (const c of counts) for (const [k, n] of Object.entries(c)) m[k] = (m[k] ?? 0) + n; return m; };

// ---- turns (runs) ------------------------------------------------------------------------------------------------
const stepsByRun = groupBy(facts.steps, (s) => s.run_id);
// A recovery (a continuation right after a failed run that never answered) answers that run's input: it inherits its trigger.
const triggers = new Map();
for (const runs of Object.values(groupBy([...facts.runs].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)), (r) => r.task_id))) {
  let previous = null;
  for (const r of runs) {
    const inherited = !r.trigger_at && previous && previous.status === 'failed' && previous.answer_at === null ? triggers.get(previous.run_id) : null;
    triggers.set(r.run_id, r.trigger_at ?? inherited ?? null);
    previous = r;
  }
}
const allTurns = facts.runs.map((r) => {
  const steps = (stepsByRun[r.run_id] ?? []).filter((s) => s.origin === 'model');
  // A Catalog read is a step the platform executed (observed); its key is the exact arguments, filters included.
  const catalog = steps.filter((s) => String(s.capability ?? '').startsWith('catalog.') && s.outcome === 'observed');
  const seen = new Set();
  let repeats = 0;
  for (const s of catalog) {
    const k = `${s.capability}|${s.arguments_digest}`;
    if (seen.has(k)) repeats += 1;
    seen.add(k);
  }
  const model = modelOf(r);
  return {
    run: r.run_id, task: r.task_id, started: r.started_at, inWindow: r.in_window !== false, kind: r.trigger_at ? 'input' : triggers.get(r.run_id) ? 'recovery' : 'continuation', profile: r.profile ?? 'unbound', agent: agentOf(r),
    model: model?.label ?? 'unattributed', segment: segmentOf(r.eligibility_reason),
    status: r.status, ending: r.termination_reason, modelCalls: r.model_calls ?? steps.length, input: r.input_tokens, output: r.output_tokens,
    cost: costOf(model, r.input_tokens, r.output_tokens),
    answered: r.answer_at !== null, latencyMs: ms(triggers.get(r.run_id), r.answer_at), deliveredMs: ms(triggers.get(r.run_id), r.answer_delivered_at),
    catalogReads: catalog.length, catalogRepeats: repeats,
    // Decisions the platform refused or could not parse, and failed model calls; executed actions rejected or failed.
    decisionErrors: countBy(steps.filter((s) => ['refused', 'invalid', 'model_failed'].includes(s.outcome)).map((s) => s.outcome)),
    actionErrors: countBy(steps.filter((s) => ['rejected', 'failed'].includes(s.observation_outcome)).map((s) => s.observation_outcome)),
    sequence: steps.map((s) => (s.capability ?? s.decision_type ?? s.outcome).replace('catalog.', '').replace('get_product_context', 'ctx')),
  };
});
const turns = allTurns.filter((t) => t.inWindow);

function groupTurns(key) {
  return Object.entries(groupBy(turns, key)).map(([k, ts]) => {
    const timed = seconds(ts.map((t) => t.latencyMs));
    const delivered = seconds(ts.map((t) => t.deliveredMs));
    return {
      key: k, turns: ts.length, inputTurns: ts.filter((t) => t.kind === 'input').length, recoveries: ts.filter((t) => t.kind === 'recovery').length, continuations: ts.filter((t) => t.kind === 'continuation').length,
      // input turns that never got an answer, neither from their own run nor from a recovery
      unansweredInputs: ts.filter((t) => t.kind === 'input' && !t.answered && !allTurns.some((u) => u.kind === 'recovery' && u.answered && u.task === t.task && Date.parse(u.started) > Date.parse(t.started))).length,
      answered: ts.filter((t) => t.answered).length,
      latencyS: { p50: pct(timed, 0.5), p90: pct(timed, 0.9), p95: pct(timed, 0.95) },
      deliveredS: { p50: pct(delivered, 0.5), p90: pct(delivered, 0.9) },
      modelCallsPerTurn: { mean: mean(ts.map((t) => t.modelCalls)), p90: pct(ts.map((t) => t.modelCalls), 0.9) },
      turnsOver5Calls: ts.filter((t) => t.modelCalls > 5).length,
      tokensPerTurn: { input: mean(ts.map((t) => t.input ?? 0)), output: mean(ts.map((t) => t.output ?? 0)) },
      estimatedCostUsd: sumOrNull(ts.map((t) => t.cost)),
      catalogReadsPerTurn: mean(ts.map((t) => t.catalogReads)), catalogRepeatsPerTurn: mean(ts.map((t) => t.catalogRepeats)),
      decisionErrors: merge(ts.map((t) => t.decisionErrors)), actionErrors: merge(ts.map((t) => t.actionErrors)),
      endings: countBy(ts.map((t) => t.ending ?? t.status)),
    };
  });
}

// ---- tasks (conversation episodes) and quotes ---------------------------------------------------------------------
// One receipt per governed execution (its idempotency key). obtained_via never overlaps: execute = settled by the first
// attempt; replay = R4 sent the same key again after an unknown outcome; reconcile = settled by reading the owner.
// replayed = the owner said it had already applied that key (deduplicated). attempts − 1 = extra attempts.
const quotesByTask = groupBy(facts.quotes, (q) => q.task_id);
const turnsByTask = groupBy(allTurns, (t) => t.task);
const tasks = facts.tasks.map((t) => {
  const qs = quotesByTask[t.task_id] ?? [];
  const issued = qs.filter((q) => q.status === 'succeeded');
  const tt = turnsByTask[t.task_id] ?? [];
  const firstIssued = issued.map((q) => q.executed_at ?? q.recorded_at).sort()[0] ?? null;
  return {
    task: t.task_id, segment: segmentOf(t.eligibility_reason), profile: t.profile ?? 'unbound', agent: agentOf(t), conversation: t.conversation_no ?? null,
    inputs: t.inputs, turns: tt.length, cost: sumOrNull(tt.map((x) => x.cost)),
    offers: t.distinct_ready_previews ?? 0, previews: t.previews ?? 0,
    quotesIssued: issued.length, quotesIssuedPromotional: issued.filter((q) => q.promotional).length,
    notIssued: qs.filter((q) => q.status !== 'succeeded').map((q) => `${q.status}:${q.error_code ?? q.reason_code ?? '-'}`),
    settledBy: qs.map((q) => q.obtained_via), ownerDeduplicated: qs.filter((q) => q.replayed).length,
    extraAttempts: sum(qs.map((q) => Math.max(0, (q.attempts ?? 1) - 1))),
    interestToIssueMs: ms(t.first_input_at, firstIssued),
    handoffs: t.handoffs ?? {}, agentMessages: t.agent_messages ?? 0, delivered: t.agent_messages_delivered ?? 0, cancelled: t.agent_messages_cancelled ?? 0, failed: t.agent_messages_failed ?? 0,
  };
});

function groupTasks(key) {
  return Object.entries(groupBy(tasks, key)).map(([k, ts]) => {
    const issued = sum(ts.map((t) => t.quotesIssued));
    const cost = sumOrNull(ts.map((t) => t.cost));
    return {
      key: k, conversations: new Set(ts.map((t) => t.conversation).filter((c) => c !== null)).size, tasks: ts.length,
      offers: sum(ts.map((t) => t.offers)), multiOfferTasks: ts.filter((t) => t.offers > 1).length,
      quotesIssued: issued, quotesIssuedPromotional: sum(ts.map((t) => t.quotesIssuedPromotional)),
      tasksWithQuote: ts.filter((t) => t.quotesIssued > 0).length, quotesPerQuotingTask: mean(ts.filter((t) => t.quotesIssued > 0).map((t) => t.quotesIssued)),
      notIssued: countBy(ts.flatMap((t) => t.notIssued)),
      settledBy: countBy(ts.flatMap((t) => t.settledBy)), ownerDeduplicated: sum(ts.map((t) => t.ownerDeduplicated)), extraAttempts: sum(ts.map((t) => t.extraAttempts)),
      interestToIssueS: { p50: pct(seconds(ts.map((t) => t.interestToIssueMs)), 0.5), p90: pct(seconds(ts.map((t) => t.interestToIssueMs)), 0.9) },
      handoffs: merge(ts.map((t) => t.handoffs)), tasksWithHandoff: ts.filter((t) => Object.keys(t.handoffs).length > 0).length,
      agentMessages: sum(ts.map((t) => t.agentMessages)), delivered: sum(ts.map((t) => t.delivered)), cancelled: sum(ts.map((t) => t.cancelled)), failed: sum(ts.map((t) => t.failed)),
      estimatedCostUsd: cost, costPerTask: cost === null ? null : cost / ts.length, costPerIssuedQuote: cost === null || issued === 0 ? null : cost / issued,
    };
  });
}

const measured = (() => {
  if (!args.measured) return null;
  const inWindow = readFileSync(args.measured, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    .filter((p) => Number.isFinite(p.accountUsageUsd) && Date.parse(p.at) >= Date.parse(facts.since) && Date.parse(p.at) <= Date.parse(facts.generatedAt))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (inWindow.length < 2) return { usd: null, note: 'fewer than two provider snapshots in the window' };
  const [first, last] = [inWindow[0], inWindow.at(-1)];
  return { usd: last.accountUsageUsd - first.accountUsageUsd, from: first.at, to: last.at, scope: 'whole provider account' };
})();

const report = {
  generatedAt: facts.generatedAt, since: facts.since,
  costs: { estimatedUsd: sumOrNull(turns.map((t) => t.cost)), estimateBasis: 'recorded calls, input priced as not cached', measured },
  turnsBySegmentProfileModel: groupTurns((t) => `${t.segment} | ${t.profile} | ${t.agent} | ${t.model}`),
  turnsBySegmentModel: groupTurns((t) => `${t.segment} | ${t.model}`),
  tasksBySegmentProfile: groupTasks((t) => `${t.segment} | ${t.profile} | ${t.agent}`),
  tasksBySegment: groupTasks((t) => t.segment),
  longTurns: turns.filter((t) => t.modelCalls > 5).sort((a, b) => b.modelCalls - a.modelCalls).slice(0, 25).map((t) => ({ run: t.run, agent: t.agent, model: t.model, calls: t.modelCalls, latencyS: t.latencyMs === null ? null : Math.round(t.latencyMs / 1000), catalogRepeats: t.catalogRepeats, sequence: t.sequence.join(' > ') })),
};

const f = (x, d = 1) => (x === null || x === undefined ? '–' : typeof x === 'number' ? x.toFixed(d) : String(x));
const j = (o) => JSON.stringify(o);
const out = (l) => process.stdout.write(`${l}\n`);
out(`R4 commercial baseline — facts since ${report.since}, generated ${report.generatedAt}`);
out(`cost: estimated US$ ${f(report.costs.estimatedUsd, 3)} (${report.costs.estimateBasis}); measured US$ ${measured === null ? '– (no --measured)' : measured.usd === null ? `– (${measured.note})` : `${f(measured.usd, 3)} (${measured.scope}, ${measured.from} → ${measured.to})`}`);
for (const [title, groups] of [['segment | profile | agent | model', report.turnsBySegmentProfileModel], ['segment | model', report.turnsBySegmentModel]]) {
  out(`\nTURNS by ${title}`);
  out('key | turns (input/recovery/continuation) | answered (inputs never answered) | latency s p50/p90/p95 | to delivery p50/p90 | calls/turn mean (p90) | turns>5 calls | in/out tokens/turn | est. US$ | catalog reads (repeats)/turn | decision errors | action errors');
  for (const g of groups) out(`${g.key} | ${g.turns} (${g.inputTurns}/${g.recoveries}/${g.continuations}) | ${g.answered} (${g.unansweredInputs}) | ${f(g.latencyS.p50)}/${f(g.latencyS.p90)}/${f(g.latencyS.p95)} | ${f(g.deliveredS.p50)}/${f(g.deliveredS.p90)} | ${f(g.modelCallsPerTurn.mean, 2)} (${f(g.modelCallsPerTurn.p90, 0)}) | ${g.turnsOver5Calls} | ${f(g.tokensPerTurn.input, 0)}/${f(g.tokensPerTurn.output, 0)} | ${f(g.estimatedCostUsd, 3)} | ${f(g.catalogReadsPerTurn, 2)} (${f(g.catalogRepeatsPerTurn, 2)}) | ${j(g.decisionErrors)} | ${j(g.actionErrors)}`);
}
for (const [title, groups] of [['segment | profile | agent', report.tasksBySegmentProfile], ['segment', report.tasksBySegment]]) {
  out(`\nCONVERSATIONS AND TASKS by ${title}`);
  for (const g of groups) {
    out(`${g.key}: conversations ${g.conversations}, tasks ${g.tasks}; offers ${g.offers} (tasks with >1 offer ${g.multiOfferTasks}); quotes issued ${g.quotesIssued} (promotional ${g.quotesIssuedPromotional}) in ${g.tasksWithQuote} tasks, ${f(g.quotesPerQuotingTask, 2)} per quoting task`);
    out(`   not issued ${j(g.notIssued)}; settled by ${j(g.settledBy)}, owner-deduplicated ${g.ownerDeduplicated}, extra attempts ${g.extraAttempts}; interest→issue s p50/p90 ${f(g.interestToIssueS.p50, 0)}/${f(g.interestToIssueS.p90, 0)}`);
    out(`   handoffs ${j(g.handoffs)} (${g.tasksWithHandoff} tasks); agent messages ${g.agentMessages}, delivered/read ${g.delivered}, cancelled ${g.cancelled}, failed ${g.failed}; est. US$ ${f(g.estimatedCostUsd, 3)}, per task ${f(g.costPerTask, 4)}, per issued quote ${f(g.costPerIssuedQuote, 4)}`);
  }
}
out('\nLONGEST TURNS (> 5 model calls)');
for (const t of report.longTurns) out(`${t.run.slice(0, 13)} ${t.agent} ${t.model} calls=${t.calls} latency=${f(t.latencyS, 0)}s repeats=${t.catalogRepeats}: ${t.sequence}`);
if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
