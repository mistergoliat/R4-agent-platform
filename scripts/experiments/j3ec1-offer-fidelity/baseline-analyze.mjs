#!/usr/bin/env node
// Historical baseline of the J3E-A (@5) and J3E-B (@6) EC2 canaries, from the whitelisted event extract
// (README.md in this directory: metadata only — times, ids, provider, model, finishReason, tokens, latency,
// decision type and outcome, run status, recovery events; never conversation text, snapshots or secrets).
//
//   node scripts/experiments/j3ec1-offer-fidelity/baseline-analyze.mjs   → <root>/baseline.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.env.R4_EXPERIMENT_BASELINE_ROOT ?? resolve(import.meta.dirname, '../../../artifacts/j3ec1-baseline');
const L = readFileSync(join(ROOT, 'canary-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
const out = {};
for (const canary of ['j3e', 'j3eb']) {
  const E = L.filter((l) => l.canary === canary);
  const calls = E.filter((l) => l.event === 'model.call.completed');
  const decisions = E.filter((l) => l.event === 'agent.decision');
  const invalid = decisions.filter((d) => d.outcome !== 'accepted');
  const invalidContext = invalid.map((d) => {
    const prev = decisions.filter((x) => x.taskId === d.taskId && x.time < d.time).at(-1);
    const call = calls.find((c) => c.runId === d.runId && Math.abs(Date.parse(c.time) - Date.parse(d.time)) < 2000);
    return { taskId: d.taskId, iteration: d.iteration, errorCode: d.errorCode ?? d.outcome, previous: prev ? `${prev.decisionType}${prev.capabilityId ? `:${prev.capabilityId}` : ''}` : null, finishReason: call?.finishReason, outputTokens: call?.outputTokens, inputTokens: call?.inputTokens, latencyMs: call?.latencyMs };
  });
  const tasks = [...new Set(calls.map((c) => c.taskId))].map((t) => {
    const tc = calls.filter((c) => c.taskId === t);
    return { taskId: t, calls: tc.length, inputTokens: tc.reduce((a, c) => a + c.inputTokens, 0), outputTokens: tc.reduce((a, c) => a + c.outputTokens, 0), modelMs: tc.reduce((a, c) => a + c.latencyMs, 0), maxInput: Math.max(...tc.map((c) => c.inputTokens)), minInput: Math.min(...tc.map((c) => c.inputTokens)) };
  });
  const lat = calls.map((c) => c.latencyMs);
  out[canary] = {
    modelIds: [...new Set(calls.map((c) => c.modelId))], providerIds: [...new Set(calls.map((c) => c.providerId))],
    modelCalls: calls.length, finishReasons: calls.reduce((a, c) => ({ ...a, [c.finishReason]: (a[c.finishReason] ?? 0) + 1 }), {}),
    invalidDecisions: invalid.length, invalidRate: +(invalid.length / calls.length).toFixed(4), invalidContext,
    decisionTypes: decisions.reduce((a, d) => ({ ...a, [d.decisionType ?? d.outcome]: (a[d.decisionType ?? d.outcome] ?? 0) + 1 }), {}),
    tokens: { input: calls.reduce((a, c) => a + c.inputTokens, 0), output: calls.reduce((a, c) => a + c.outputTokens, 0), inputPerCallP50: pct(calls.map((c) => c.inputTokens), 0.5), outputPerCallP50: pct(calls.map((c) => c.outputTokens), 0.5), outputPerCallMax: Math.max(...calls.map((c) => c.outputTokens)) },
    latencyMs: { total: lat.reduce((a, b) => a + b, 0), p50: pct(lat, 0.5), p90: pct(lat, 0.9), max: Math.max(...lat) },
    runs: E.filter((l) => l.event === 'run.finished').reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}),
    recoveries: E.filter((l) => l.event.startsWith('task.run_failure')).map((l) => l.event),
    tasks,
  };
}
writeFileSync(join(ROOT, 'baseline.json'), JSON.stringify(out, null, 2));
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
