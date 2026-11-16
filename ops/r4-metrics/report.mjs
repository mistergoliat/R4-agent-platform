#!/usr/bin/env node
// R4 commercial baseline (M1): turns the facts exported by baseline.sql into a comparable report — by agent version,
// model and segment (testers = allowlisted conversations; commercial = rollout), never mixing them.
//
//   node ops/r4-metrics/report.mjs facts.json [--models models.json] [--json out.json]
//
// Model attribution: R4's database does not record which model served a call (the provider telemetry does, in the
// logs), so a models file maps time windows (and optionally agents) to a model and its prices; a window not covered is
// reported as "unattributed". Prices are per million tokens; cost is an UPPER BOUND (every input token priced as not
// cached: the database keeps no cache counts). Output: text report on stdout; --json also writes the aggregates.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { models: { type: 'string' }, json: { type: 'string' } } });
if (!positionals[0]) throw new Error('usage: report.mjs facts.json [--models models.json] [--json out.json]');
const facts = JSON.parse(readFileSync(positionals[0], 'utf8'));
const models = args.models ? JSON.parse(readFileSync(args.models, 'utf8')) : [];

const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
const pct = (xs, p) => {
  const s = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const segmentOf = (reason) => (reason === 'allowlisted' ? 'testers' : reason === 'rollout' || reason === 'rollout_percent' ? 'commercial' : reason ? `other:${reason}` : 'unbound');
const agentOf = (r) => `${r.agent_id}@${r.agent_version}`;
const modelOf = (r) => {
  const at = Date.parse(r.started_at);
  return models.find((m) => at >= Date.parse(m.from) && at < Date.parse(m.to ?? '2999-01-01') && (!m.agents || m.agents.includes(agentOf(r)))) ?? null;
};
const costOf = (model, input, output) => (model ? ((input ?? 0) * model.priceInPerM + (output ?? 0) * model.priceOutPerM) / 1e6 : null);

// ---- runs (turns) -------------------------------------------------------------------------------------------------
const stepsByRun = new Map();
for (const s of facts.steps) (stepsByRun.get(s.run_id) ?? stepsByRun.set(s.run_id, []).get(s.run_id)).push(s);
const ERROR_OUTCOMES = new Set(['invalid', 'model_failed', 'failed', 'rejected']);
const turns = facts.runs.map((r) => {
  const steps = (stepsByRun.get(r.run_id) ?? []).filter((s) => s.origin === 'model');
  const catalog = steps.filter((s) => String(s.capability ?? '').startsWith('catalog.'));
  const seen = new Set();
  let repeats = 0;
  for (const s of catalog) {
    const k = `${s.capability}|${s.target ?? ''}`;
    if (seen.has(k)) repeats += 1;
    seen.add(k);
  }
  const model = modelOf(r);
  return {
    run: r.run_id, task: r.task_id, agent: agentOf(r), model: model?.label ?? 'unattributed', segment: segmentOf(r.eligibility_reason),
    status: r.status, ending: r.termination_reason, modelCalls: r.model_calls ?? steps.length, input: r.input_tokens, output: r.output_tokens,
    cost: costOf(model, r.input_tokens, r.output_tokens),
    latencyMs: ms(r.trigger_at, r.answer_at), deliveredMs: ms(r.trigger_at, r.answer_delivered_at), answered: r.answer_at !== null,
    catalogReads: catalog.length, catalogRepeats: repeats,
    errors: steps.filter((s) => ERROR_OUTCOMES.has(s.outcome) || s.observation_outcome === 'failed').length,
    sequence: steps.map((s) => (s.capability ?? s.decision_type ?? s.outcome).replace('catalog.', '').replace('get_product_context', 'ctx')),
  };
});

function groupTurns(key) {
  const groups = new Map();
  for (const t of turns) (groups.get(key(t)) ?? groups.set(key(t), []).get(key(t))).push(t);
  return [...groups].map(([k, ts]) => {
    const answered = ts.filter((t) => t.latencyMs !== null);
    return {
      key: k, turns: ts.length, answered: answered.length,
      latencyS: { p50: pct(answered.map((t) => t.latencyMs / 1000), 0.5), p90: pct(answered.map((t) => t.latencyMs / 1000), 0.9), p95: pct(answered.map((t) => t.latencyMs / 1000), 0.95) },
      modelCallsPerTurn: { mean: mean(ts.map((t) => t.modelCalls)), p90: pct(ts.map((t) => t.modelCalls), 0.9) },
      turnsOver5Calls: ts.filter((t) => t.modelCalls > 5).length,
      tokensPerTurn: { input: mean(ts.map((t) => t.input ?? 0)), output: mean(ts.map((t) => t.output ?? 0)) },
      costUsd: ts.some((t) => t.cost === null) ? null : sum(ts.map((t) => t.cost)),
      catalogReadsPerTurn: mean(ts.map((t) => t.catalogReads)), catalogRepeatsPerTurn: mean(ts.map((t) => t.catalogRepeats)),
      errorsPerTurn: mean(ts.map((t) => t.errors)),
      endings: Object.fromEntries(Object.entries(Object.groupBy(ts, (t) => t.ending ?? t.status)).map(([e, xs]) => [e, xs.length])),
    };
  });
}

// ---- tasks (conversation episodes) and quotes --------------------------------------------------------------------
const quotesByTask = Object.groupBy(facts.quotes, (q) => q.task_id);
const turnsByTask = Object.groupBy(turns, (t) => t.task);
const tasks = facts.tasks.map((t) => {
  const qs = quotesByTask[t.task_id] ?? [];
  const issued = qs.filter((q) => q.status === 'succeeded');
  const tt = turnsByTask[t.task_id] ?? [];
  const firstIssued = issued.map((q) => q.executed_at ?? q.recorded_at).sort()[0] ?? null;
  return {
    task: t.task_id, segment: segmentOf(t.eligibility_reason), channel: t.channel, binding: t.binding_id, inputs: t.inputs, turns: tt.length,
    cost: tt.some((x) => x.cost === null) ? null : sum(tt.map((x) => x.cost)),
    quotesIssued: issued.length, quotesIssuedPromotional: issued.filter((q) => q.promotional).length,
    quotesRefused: qs.filter((q) => q.status !== 'succeeded').length,
    refusalCodes: qs.filter((q) => q.status !== 'succeeded').map((q) => q.error_code ?? q.reason_code),
    replayedOrRetried: qs.filter((q) => q.replayed || (q.attempts ?? 1) > 1 || q.obtained_via !== 'execute').length,
    distinctOffers: t.distinct_ready_previews, previews: t.previews,
    interestToIssueMs: ms(t.first_input_at, firstIssued),
    handoffs: t.handoffs, agentMessages: t.agent_messages, agentMessagesDelivered: t.agent_messages_delivered, outboundFailed: t.outbound_failed,
  };
});

function groupTasks(key) {
  return Object.entries(Object.groupBy(tasks, key)).map(([k, ts]) => {
    const issued = sum(ts.map((t) => t.quotesIssued));
    const cost = ts.some((t) => t.cost === null) ? null : sum(ts.map((t) => t.cost));
    return {
      key: k, tasks: ts.length, conversations: new Set(ts.map((t) => t.binding).filter(Boolean)).size,
      quotesIssued: issued, quotesIssuedPromotional: sum(ts.map((t) => t.quotesIssuedPromotional)),
      tasksWithQuote: ts.filter((t) => t.quotesIssued > 0).length, quotesPerQuotingTask: mean(ts.filter((t) => t.quotesIssued > 0).map((t) => t.quotesIssued)),
      multiOfferTasks: ts.filter((t) => t.distinctOffers > 1).length,
      quotesRefused: sum(ts.map((t) => t.quotesRefused)), refusalCodes: Object.fromEntries(Object.entries(Object.groupBy(ts.flatMap((t) => t.refusalCodes), (c) => c)).map(([c, xs]) => [c, xs.length])),
      replayedOrRetried: sum(ts.map((t) => t.replayedOrRetried)),
      interestToIssueS: { p50: pct(ts.map((t) => (t.interestToIssueMs === null ? null : t.interestToIssueMs / 1000)), 0.5), p90: pct(ts.map((t) => (t.interestToIssueMs === null ? null : t.interestToIssueMs / 1000)), 0.9) },
      handoffs: sum(ts.map((t) => t.handoffs)), tasksWithHandoff: ts.filter((t) => t.handoffs > 0).length,
      agentMessages: sum(ts.map((t) => t.agentMessages)), delivered: sum(ts.map((t) => t.agentMessagesDelivered)), outboundFailed: sum(ts.map((t) => t.outboundFailed)),
      costUsd: cost, costPerTask: cost === null ? null : cost / ts.length, costPerIssuedQuote: cost === null || issued === 0 ? null : cost / issued,
    };
  });
}

const report = {
  generatedAt: facts.generatedAt, since: facts.since, costBasis: 'upper bound: every input token priced as not cached',
  bySegmentAgentModel: groupTurns((t) => `${t.segment} | ${t.agent} | ${t.model}`),
  bySegmentModel: groupTurns((t) => `${t.segment} | ${t.model}`),
  tasksBySegment: groupTasks((t) => t.segment),
  longTurns: turns.filter((t) => t.modelCalls > 5).sort((a, b) => b.modelCalls - a.modelCalls).slice(0, 25).map((t) => ({ run: t.run, agent: t.agent, model: t.model, calls: t.modelCalls, latencyS: t.latencyMs === null ? null : Math.round(t.latencyMs / 1000), catalogRepeats: t.catalogRepeats, sequence: t.sequence.join(' > ') })),
};

const f = (x, d = 1) => (x === null || x === undefined ? '–' : typeof x === 'number' ? x.toFixed(d) : String(x));
const out = (l) => process.stdout.write(`${l}\n`);
out(`R4 commercial baseline — facts since ${report.since}, generated ${report.generatedAt}; cost = ${report.costBasis}`);
out('\nTURNS by segment | agent | model');
out('key | turns | answered | latency s p50/p90/p95 | calls/turn mean (p90) | turns>5 calls | in/out tokens per turn | cost US$ | catalog reads (repeats)/turn | errors/turn');
for (const g of report.bySegmentAgentModel) out(`${g.key} | ${g.turns} | ${g.answered} | ${f(g.latencyS.p50)}/${f(g.latencyS.p90)}/${f(g.latencyS.p95)} | ${f(g.modelCallsPerTurn.mean, 2)} (${f(g.modelCallsPerTurn.p90, 0)}) | ${g.turnsOver5Calls} | ${f(g.tokensPerTurn.input, 0)}/${f(g.tokensPerTurn.output, 0)} | ${f(g.costUsd, 3)} | ${f(g.catalogReadsPerTurn, 2)} (${f(g.catalogRepeatsPerTurn, 2)}) | ${f(g.errorsPerTurn, 2)}`);
out('\nCONVERSATION EPISODES (tasks) by segment');
for (const g of report.tasksBySegment) {
  out(`${g.key}: tasks ${g.tasks}, conversations ${g.conversations}; quotes issued ${g.quotesIssued} (promotional ${g.quotesIssuedPromotional}) in ${g.tasksWithQuote} tasks, ${f(g.quotesPerQuotingTask, 2)} per quoting task; tasks with >1 offer ${g.multiOfferTasks}; refused ${g.quotesRefused} ${JSON.stringify(g.refusalCodes)}; replays/retries ${g.replayedOrRetried}`);
  out(`   interest→issue s p50/p90 ${f(g.interestToIssueS.p50, 0)}/${f(g.interestToIssueS.p90, 0)}; handoffs ${g.handoffs} (${g.tasksWithHandoff} tasks); agent messages ${g.agentMessages}, delivered/read ${g.delivered}, failed ${g.outboundFailed}; cost US$ ${f(g.costUsd, 3)}, per task ${f(g.costPerTask, 4)}, per issued quote ${f(g.costPerIssuedQuote, 4)}`);
}
out('\nLONGEST TURNS (> 5 model calls)');
for (const t of report.longTurns) out(`${t.run.slice(0, 13)} ${t.agent} ${t.model} calls=${t.calls} latency=${f(t.latencyS, 0)}s repeats=${t.catalogRepeats}: ${t.sequence}`);
if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
