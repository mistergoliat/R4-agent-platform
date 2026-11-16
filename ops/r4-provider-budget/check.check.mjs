// Self-check for check.mjs against a fake provider and webhook: node ops/r4-provider-budget/check.check.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'r4-budget-'));
let provider = {};
const alerts = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    if (req.method === 'POST') { alerts.push(JSON.parse(body)); res.end('ok'); return; }
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    const data = req.url === '/credits' ? provider.credits : provider.key;
    res.writeHead(data ? 200 : 500, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const log = join(dir, 'worker-out.log');
const run = (extra = {}) => new Promise((resolve) => {
  execFile(process.execPath, [fileURLToPath(new URL('./check.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, PROVIDER_BUDGET_ENV: join(dir, 'none.env'), PROVIDER_API_KEY: 'sk-test', PROVIDER_BASE_URL: base,
      STATE_FILE: join(dir, 'state.json'), SNAPSHOTS_FILE: join(dir, 'usage.jsonl'), LOG_FILES: log, ALERT_WEBHOOK_URL: `${base}/hook`, ...extra },
  }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
});
const key = (k = {}) => ({ limit: null, limit_remaining: null, usage: 3, usage_daily: 0.5, usage_weekly: 2.1, usage_monthly: 3, ...k });
const now = new Date().toISOString();

// Healthy: 40 US$ left at ~0.5/day.
provider = { credits: { total_credits: 50, total_usage: 10 }, key: key() };
writeFileSync(log, '');
let r = await run();
assert.equal(r.code, 0, r.stdout);
assert.match(r.stdout, /provider-budget OK/);
assert.equal(alerts.length, 0);
assert.doesNotMatch(r.stdout, /sk-test/); // the key is never printed

// Balance runs out in < 7 days: WARN, alerted once; the same status again is not re-alerted.
provider.credits = { total_credits: 50, total_usage: 47 };
r = await run();
assert.equal(r.code, 1, r.stdout);
assert.match(r.stdout, /account balance US\$ 3\.00, about 6\.0 days/);
assert.equal(alerts.length, 1);
await run();
assert.equal(alerts.length, 1);

// A key spend cap almost used, and a quota refusal in the logs: CRITICAL, alerted; rate limits below the threshold are not.
provider.key = key({ limit: 10, limit_remaining: 0.2 });
writeFileSync(log, [
  `{"level":"warn","time":"${now}","event":"model.call.failed","errorKind":"quota_exhausted"}`,
  `{"level":"warn","time":"${now}","event":"model.call.failed","errorKind":"rate_limited"}`,
  `{"level":"warn","time":"2020-01-01T00:00:00.000Z","event":"model.call.failed","errorKind":"provider_error"}`, // outside the window
].join('\n'));
r = await run();
assert.equal(r.code, 2, r.stdout);
assert.match(r.stdout, /key budget 2 % left/);
assert.match(r.stdout, /1 model calls refused for balance or spend limit/);
assert.match(r.stdout, /"rate_limited":1/);
assert.doesNotMatch(r.stdout, /provider errors/);
assert.equal(alerts.length, 2);
assert.equal(alerts[1].status, 'CRITICAL');

// Thresholds come from the env file, not code: a higher provider-error floor; the provider unreadable is a WARN.
writeFileSync(join(dir, 'budget.env'), 'WARN_BALANCE_USD=0\nWARN_DAYS_LEFT=0\nCRIT_DAYS_LEFT=0\n');
provider = { credits: undefined, key: key() };
writeFileSync(log, '');
r = await run({ PROVIDER_BUDGET_ENV: join(dir, 'budget.env') });
assert.equal(r.code, 1, r.stdout);
assert.match(r.stdout, /account balance unreadable/);

// Recovery is announced once.
provider = { credits: { total_credits: 50, total_usage: 10 }, key: key() };
r = await run();
assert.equal(r.code, 0, r.stdout);
assert.equal(alerts.at(-1).status, 'OK');

// Every run appended a snapshot the M1 report can read as --measured.
const snapshots = readFileSync(join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.equal(snapshots.length, 6);
assert.equal(snapshots[0].accountUsageUsd, 10);
server.close();
process.stdout.write('check.mjs self-check: OK\n');
