// Self-check for report.mjs on synthetic facts: node ops/r4-metrics/report.check.mjs (exits non-zero on failure).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'r4-metrics-'));
const run = (id, task, reason, at, calls, answerAfterS) => ({
  run_id: id, task_id: task, agent_id: 'sales', agent_version: 19, status: 'suspended', termination_reason: 'waiting', model_calls: calls,
  input_tokens: 1_000_000, output_tokens: 100_000, started_at: at, eligibility_reason: reason, profile: 'sales-production@19', binding_id: `b-${task}`,
  trigger_at: at, answer_at: answerAfterS === null ? null : new Date(Date.parse(at) + answerAfterS * 1000).toISOString(), answer_delivered_at: null,
});
const facts = {
  generatedAt: '2026-11-16T00:00:00Z', since: '2026-11-01T00:00:00Z',
  runs: [run('r1', 't1', 'allowlisted', '2026-11-10T00:00:00Z', 2, 10), run('r2', 't1', 'allowlisted', '2026-11-10T01:00:00Z', 7, 30), run('r3', 't2', 'cohort', '2026-11-17T00:00:00Z', 1, null)],
  steps: [
    { run_id: 'r2', origin: 'model', capability: 'catalog.search', target: 'disco' },
    { run_id: 'r2', origin: 'model', capability: 'catalog.search', target: 'disco' },
    { run_id: 'r2', origin: 'model', capability: 'catalog.get_product_context', target: 'p1', outcome: 'invalid' },
  ],
  quotes: [
    { task_id: 't1', status: 'succeeded', attempts: 1, obtained_via: 'execute', executed_at: '2026-11-10T01:00:40Z', promotional: true },
    { task_id: 't1', status: 'failed', error_code: 'offer_changed', attempts: 2, obtained_via: 'reconcile' },
    { task_id: 't1', status: 'failed', error_code: 'x', attempts: 1, replayed: true, obtained_via: 'replay' },
  ],
  tasks: [
    { task_id: 't1', eligibility_reason: 'allowlisted', binding_id: 'b-t1', first_input_at: '2026-11-10T00:00:00Z', inputs: 2, handoffs: 0, agent_messages: 2, agent_messages_delivered: 2, outbound_failed: 0, previews: 2, distinct_ready_previews: 2 },
    { task_id: 't2', eligibility_reason: 'cohort', binding_id: 'b-t2', first_input_at: '2026-11-17T00:00:00Z', inputs: 1, handoffs: 1, agent_messages: 0, agent_messages_delivered: 0, outbound_failed: 0, previews: 0, distinct_ready_previews: 0 },
  ],
};
const models = [{ label: 'm-old', from: '2026-01-01T00:00:00Z', to: '2026-11-16T00:00:00Z', priceInPerM: 1, priceOutPerM: 10 }];
writeFileSync(join(dir, 'facts.json'), JSON.stringify(facts));
writeFileSync(join(dir, 'models.json'), JSON.stringify(models));
writeFileSync(join(dir, 'usage.jsonl'), ['2026-10-31T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-15T00:00:00Z'].map((at, i) => JSON.stringify({ at, accountUsageUsd: [1, 2, 4.5][i] })).join(String.fromCharCode(10)));
execFileSync(process.execPath, [fileURLToPath(new URL('./report.mjs', import.meta.url)), join(dir, 'facts.json'), '--models', join(dir, 'models.json'), '--measured', join(dir, 'usage.jsonl'), '--json', join(dir, 'out.json')]);
const r = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));

const testers = r.bySegmentModel.find((g) => g.key === 'testers | m-old');
assert.equal(testers.turns, 2);
assert.deepEqual(testers.latencyS, { p50: 10, p90: 30, p95: 30 });
assert.equal(testers.turnsOver5Calls, 1);
assert.equal(testers.costUsd, 4); // 2 turns × (1M in × $1 + 0.1M out × $10)
assert.equal(testers.catalogRepeatsPerTurn, 0.5);
assert.equal(testers.errorsPerTurn, 0.5);
const commercial = r.bySegmentModel.find((g) => g.key === 'commercial | unattributed');
assert.equal(commercial.costUsd, null); // an unpriced window never reports a made-up cost
const t = r.tasksBySegment.find((g) => g.key === 'testers');
assert.equal(t.quotesIssued, 1);
assert.equal(t.quotesIssuedPromotional, 1);
assert.equal(t.multiOfferTasks, 1);
assert.equal(t.interestToIssueS.p50, 3640);
assert.equal(t.costPerIssuedQuote, 4);
assert.equal(r.tasksBySegment.find((g) => g.key === 'commercial').handoffs, 1);
assert.equal(r.longTurns.length, 1);
assert.equal(t.retried, 1);
assert.equal(t.idempotentReplays, 1);
assert.equal(t.reconciled, 1);
assert.equal(t.offers, 2);
assert.ok(r.bySegmentAgentModel.some((g) => g.key === 'testers | sales-production@19 | sales@19 | m-old'));
assert.equal(r.costs.measured.usd, 2.5); // only the snapshots inside the window
assert.equal(r.costs.estimatedUsd, null); // one turn is in an unpriced window
console.log('report.mjs self-check: OK');
