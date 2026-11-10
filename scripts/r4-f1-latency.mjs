#!/usr/bin/env node
// R4 turn latency by component (read-only). Reads the JSON lines of the R4 pm2 logs (worker(s) and gateway) and prints,
// per agent run: queue (inbound ingested → run started), model (Σ model calls), capabilities (Σ invocations, Quote
// included), platform (the rest of the run), delivery (run finished → provider accepted) and the total until the
// contact's phone confirmed delivery. Never prints message text, identifiers of the contact or credentials.
//
//   node scripts/r4-f1-latency.mjs [--since 2026-11-10T00:00] [--task <taskId>] <log> [<log> ...]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const since = opt('--since');
const onlyTask = opt('--task');
if (args.length === 0) {
  process.stderr.write('usage: latency.mjs [--since ISO] [--task id] <log>...\n');
  process.exit(2);
}

const events = [];
for (const file of args) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    let e;
    try {
      e = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    if (!e.event || !e.time || !e.taskId) continue;
    if (since && e.time < since) continue;
    if (onlyTask && e.taskId !== onlyTask) continue;
    events.push({ ...e, t: Date.parse(e.time) });
  }
}
events.sort((a, b) => a.t - b.t);

const runs = new Map();
for (const e of events) {
  if (e.event === 'run.started') runs.set(e.runId, { taskId: e.taskId, start: e.t, end: null, model: 0, modelCalls: 0, outTokens: 0, maxModel: 0, caps: 0, capCalls: 0, quote: 0 });
  const r = e.runId ? runs.get(e.runId) : undefined;
  if (!r) continue;
  if (e.event === 'model.call.completed') {
    r.model += e.latencyMs ?? 0;
    r.modelCalls += 1;
    r.outTokens += e.outputTokens ?? 0;
    r.maxModel = Math.max(r.maxModel, e.latencyMs ?? 0);
  }
  if (e.event === 'capability.invocation.completed') {
    r.caps += e.durationMs ?? 0;
    r.capCalls += 1;
  }
  if (e.event === 'quote.call') r.quote += e.durationMs ?? 0;
  if (e.event === 'run.finished') r.end = e.t;
}

const byTask = (taskId, name) => events.filter((e) => e.taskId === taskId && e.event === name);
const s = (ms) => (ms === null || ms === undefined ? '-' : (ms / 1000).toFixed(1));
const rows = [];
for (const [runId, r] of runs) {
  if (r.end === null) continue;
  const ingested = byTask(r.taskId, 'inbound.ingested').filter((e) => e.t <= r.start).at(-1);
  const accepted = byTask(r.taskId, 'outbound.accepted').find((e) => e.t >= r.end && e.origin === 'agent');
  const delivered = accepted ? byTask(r.taskId, 'outbound.delivered').find((e) => e.outboundId === accepted.outboundId) : undefined;
  const run = r.end - r.start;
  rows.push({
    run: runId.slice(0, 8),
    at: new Date(r.start).toISOString().slice(11, 19),
    queue: ingested ? r.start - ingested.t : null,
    model: r.model,
    calls: r.modelCalls,
    slowest: r.maxModel,
    outTok: r.outTokens,
    caps: r.caps,
    capCalls: r.capCalls,
    platform: Math.max(0, run - r.model - r.caps),
    delivery: accepted ? accepted.t - r.end : null,
    total: ingested && delivered ? delivered.t - ingested.t : ingested && accepted ? accepted.t - ingested.t : null,
  });
}
process.stdout.write('run       start     queue  model(calls, slowest, out tok)  capabilities(calls)  platform  delivery  total(s)\n');
for (const x of rows) {
  process.stdout.write(`${x.run}  ${x.at}  ${s(x.queue).padStart(5)}  ${`${s(x.model)} (${x.calls}, ${s(x.slowest)}, ${x.outTok})`.padEnd(30)}  ${`${s(x.caps)} (${x.capCalls})`.padEnd(19)}  ${s(x.platform).padStart(8)}  ${s(x.delivery).padStart(8)}  ${s(x.total).padStart(8)}\n`);
}
const sum = (k) => rows.reduce((a, x) => a + (x[k] ?? 0), 0);
const all = sum('queue') + sum('model') + sum('caps') + sum('platform') + sum('delivery');
if (rows.length > 0 && all > 0) {
  const pct = (k) => `${((100 * sum(k)) / all).toFixed(0)}%`;
  process.stdout.write(`\n${rows.length} runs — share of time: queue ${pct('queue')}, model ${pct('model')}, capabilities ${pct('caps')}, platform ${pct('platform')}, delivery ${pct('delivery')}\n`);
}
