// Self-check for report.mjs on synthetic facts: node ops/r4-metrics/report.check.mjs (exits non-zero on failure).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'r4-metrics-'));
const run = (id, task, reason, at, calls, { trigger = true, answerAfterS = null, conversation = 1, status = 'suspended', inWindow = true } = {}) => ({
  run_id: id, task_id: task, in_window: inWindow, agent_id: 'sales', agent_version: 19, status, termination_reason: 'waiting', model_calls: calls,
  input_tokens: 1_000_000, output_tokens: 100_000, started_at: at, eligibility_reason: reason, profile: 'sales-production@19', binding_id: `b-${task}`, conversation_no: conversation,
  trigger_at: trigger ? at : null, answer_at: answerAfterS === null ? null : new Date(Date.parse(at) + answerAfterS * 1000).toISOString(), answer_delivered_at: null,
});
const task = (id, reason, conversation, extra = {}) => ({
  task_id: id, agent_id: 'sales', agent_version: 19, eligibility_reason: reason, profile: 'sales-production@19', binding_id: `b-${id}`, conversation_no: conversation,
  first_input_at: '2026-11-10T00:00:00Z', inputs: 1, handoffs: {}, agent_messages: 0, agent_messages_delivered: 0, agent_messages_cancelled: 0, agent_messages_failed: 0,
  previews: 0, distinct_ready_previews: 0, ...extra,
});
const facts = {
  generatedAt: '2026-11-16T00:00:00Z', since: '2026-11-01T00:00:00Z',
  runs: [
    run('r1', 't1', 'allowlisted', '2026-11-10T00:00:00Z', 2, { answerAfterS: 10 }),
    run('r2', 't1', 'allowlisted', '2026-11-10T01:00:00Z', 7, { answerAfterS: 30 }),
    // a consultation answer two hours later: answered, but no customer latency
    run('r4', 't1', 'allowlisted', '2026-11-10T03:00:00Z', 1, { trigger: false, answerAfterS: 5 }),
    run('r3', 't2', 'cohort', '2026-11-17T00:00:00Z', 1, { conversation: 2 }),
    // a turn that failed without answering and the recovery that answered it 70 s later; plus a run before the window
    run('r7', 't4', 'denied', '2026-10-20T00:00:00Z', 1, { conversation: 3, inWindow: false, answerAfterS: 5 }),
    run('r5', 't4', 'denied', '2026-11-11T00:00:00Z', 1, { conversation: 3, status: 'failed' }),
    run('r6', 't4', 'denied', '2026-11-11T00:01:00Z', 1, { conversation: 3, trigger: false, answerAfterS: 70 }),
  ],
  steps: [
    { run_id: 'r2', origin: 'model', capability: 'catalog.search', arguments_digest: 'a', outcome: 'observed' },
    { run_id: 'r2', origin: 'model', capability: 'catalog.search', arguments_digest: 'a', outcome: 'observed' },
    { run_id: 'r2', origin: 'model', capability: 'catalog.search', arguments_digest: 'b', outcome: 'observed' }, // a narrower filter is not a repeat
    { run_id: 'r2', origin: 'model', capability: 'catalog.get_product_context', arguments_digest: 'p', outcome: 'refused' }, // refused: not a read
    { run_id: 'r2', origin: 'model', capability: 'quote.create', outcome: 'observed', observation_outcome: 'rejected' },
  ],
  // Receipts as the runtime writes them: execute has 1 attempt; replay and reconcile have 2 or more.
  quotes: [
    { task_id: 't1', status: 'succeeded', attempts: 1, obtained_via: 'execute', replayed: false, executed_at: '2026-11-10T01:00:40Z', promotional: true },
    { task_id: 't1', status: 'succeeded', attempts: 2, obtained_via: 'replay', replayed: true, executed_at: '2026-11-10T01:30:00Z' },
    { task_id: 't1', status: 'failed', error_code: 'offer_changed', attempts: 3, obtained_via: 'reconcile', replayed: false },
  ],
  tasks: [
    task('t1', 'allowlisted', 1, { previews: 3, distinct_ready_previews: 2, handoffs: { agent: 1, platform: 2 }, agent_messages: 3, agent_messages_delivered: 2, agent_messages_cancelled: 1 }),
    task('t3', 'allowlisted', 1), // the same customer came back: a second task of conversation 1
    task('t4', 'denied', 3),
    task('t2', 'cohort', 2, { first_input_at: '2026-11-17T00:00:00Z', handoffs: { agent: 1 } }),
  ],
};
const models = [{ label: 'm-old', from: '2026-01-01T00:00:00Z', to: '2026-11-16T00:00:00Z', priceInPerM: 1, priceOutPerM: 10 }];
writeFileSync(join(dir, 'facts.json'), JSON.stringify(facts));
writeFileSync(join(dir, 'models.json'), JSON.stringify(models));
writeFileSync(join(dir, 'usage.jsonl'), ['2026-10-31T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-15T00:00:00Z'].map((at, i) => JSON.stringify({ at, accountUsageUsd: [1, 2, 4.5][i] })).join(String.fromCharCode(10)));
execFileSync(process.execPath, [fileURLToPath(new URL('./report.mjs', import.meta.url)), join(dir, 'facts.json'), '--models', join(dir, 'models.json'), '--measured', join(dir, 'usage.jsonl'), '--json', join(dir, 'out.json')]);
const r = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));

const testers = r.turnsBySegmentModel.find((g) => g.key === 'testers | m-old');
assert.equal(testers.turns, 3);
assert.equal(testers.inputTurns, 2);
assert.equal(testers.continuations, 1);
assert.equal(testers.answered, 3);
assert.deepEqual(testers.latencyS, { p50: 10, p90: 30, p95: 30 }); // the continuation has no latency
assert.equal(testers.turnsOver5Calls, 1);
assert.equal(testers.estimatedCostUsd, 6); // 3 turns × (1M in × $1 + 0.1M out × $10)
assert.equal(testers.catalogReadsPerTurn, 1); // 3 observed reads over 3 turns; the refused one is not a read
assert.equal(testers.catalogRepeatsPerTurn, 1 / 3); // only the identical search repeats
assert.deepEqual(testers.decisionErrors, { refused: 1 });
assert.deepEqual(testers.actionErrors, { rejected: 1 });
assert.equal(r.turnsBySegmentModel.find((g) => g.key === 'commercial | unattributed').estimatedCostUsd, null); // never a made-up cost
const t = r.tasksBySegment.find((g) => g.key === 'testers');
assert.equal(t.conversations, 1); // two tasks of the same customer are one conversation
assert.equal(t.tasks, 2);
assert.equal(t.quotesIssued, 2);
assert.equal(t.quotesIssuedPromotional, 1);
assert.equal(t.offers, 2);
assert.equal(t.multiOfferTasks, 1);
assert.deepEqual(t.settledBy, { execute: 1, replay: 1, reconcile: 1 }); // disjoint
assert.equal(t.ownerDeduplicated, 1);
assert.equal(t.extraAttempts, 3);
assert.deepEqual(t.notIssued, { 'failed:offer_changed': 1 });
assert.deepEqual(t.handoffs, { agent: 1, platform: 2 });
assert.equal(t.cancelled, 1);
assert.equal(t.interestToIssueS.p50, 3640);
assert.equal(t.costPerIssuedQuote, 3);
assert.deepEqual(r.tasksBySegment.find((g) => g.key === 'commercial').handoffs, { agent: 1 });
assert.ok(r.tasksBySegmentProfile.some((g) => g.key === 'testers | sales-production@19 | sales@19'));
assert.ok(r.turnsBySegmentProfileModel.some((g) => g.key === 'testers | sales-production@19 | sales@19 | m-old'));
assert.equal(r.costs.measured.usd, 2.5); // only the snapshots inside the window
assert.equal(r.costs.estimatedUsd, null); // one turn is in an unpriced window
assert.equal(r.longTurns.length, 1);
const recovered = r.turnsBySegmentModel.find((g) => g.key === 'other:denied | m-old');
assert.equal(recovered.turns, 2); // the run before the window is not a turn of this report
assert.equal(recovered.recoveries, 1);
assert.deepEqual(recovered.latencyS, { p50: 130, p90: 130, p95: 130 }); // measured from the failed turn's input
assert.equal(recovered.unansweredInputs, 0);
assert.equal(r.tasksBySegment.find((g) => g.key === 'other:denied').estimatedCostUsd, 6); // but the task's cost covers its whole life
// A key that cannot read the account balance: the measured cost falls back to the key's own usage, labelled as such.
writeFileSync(join(dir, 'usage.jsonl'), ['2026-11-02T00:00:00Z', '2026-11-15T00:00:00Z'].map((at, i) => JSON.stringify({ at, keyUsageUsd: [3, 4][i] })).join(String.fromCharCode(10)));
execFileSync(process.execPath, [fileURLToPath(new URL('./report.mjs', import.meta.url)), join(dir, 'facts.json'), '--models', join(dir, 'models.json'), '--measured', join(dir, 'usage.jsonl'), '--json', join(dir, 'out.json')]);
assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).costs.measured, { usd: 1, from: '2026-11-02T00:00:00Z', to: '2026-11-15T00:00:00Z', scope: 'this API key only' });
process.stdout.write('report.mjs self-check: OK\n');
