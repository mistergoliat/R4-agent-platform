// Self-check for check.mjs against a fake provider and webhook: node ops/r4-provider-budget/check.check.mjs
// Prints the monitor's line for each scenario, then "check.mjs self-check: OK".
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'r4-budget-'));
const SECRET_HOOK = '/hook/T000-SECRET-WEBHOOK-TOKEN';
let provider = {}; // { credits: [status, data], key: [status, data] }
const alerts = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    if (req.method === 'POST') { assert.equal(req.url, SECRET_HOOK); alerts.push(JSON.parse(body)); res.end('ok'); return; }
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    const [status, data] = req.url === '/credits' ? provider.credits : provider.key;
    const error = status === 403 ? { message: 'Only management keys or keys created by organization admins can fetch organization credits', code: 403 } : undefined;
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? { data } : { error }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const log = join(dir, 'worker-out.log');
const run = (name, extra = {}) => new Promise((resolve) => {
  execFile(process.execPath, [fileURLToPath(new URL('./check.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, PROVIDER_BUDGET_ENV: join(dir, 'none.env'), PROVIDER_API_KEY: 'sk-test', PROVIDER_BASE_URL: base,
      STATE_FILE: join(dir, 'state.json'), SNAPSHOTS_FILE: join(dir, 'usage.jsonl'), LOG_FILES: log, ALERT_WEBHOOK_URL: `${base}${SECRET_HOOK}`, ...extra },
  }, (error, stdout) => {
    process.stdout.write(`[${name}] exit ${error?.code ?? 0}: ${stdout}`);
    assert.doesNotMatch(stdout, /sk-test|SECRET-WEBHOOK/); // neither the key nor the webhook URL is ever printed
    resolve({ code: error?.code ?? 0, stdout });
  });
});
const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
// The production shape of GET /key (2026-11-18): a monthly workspace budget and a key limit, plus the legacy fields.
const key = ({ remaining = 8, keyRemaining = 9, daily = 0.3, weekly = 1.4, resetsIn = 12 } = {}) => {
  const budget = (scope, limit, left) => ({ scope, limit_usd: limit, spend_usd: limit - left, remaining_usd: left, reset_interval: 'monthly', resets_at: days(resetsIn) });
  return { limit: 10, limit_remaining: keyRemaining, limit_reset: 'monthly', usage: 2, usage_daily: daily, usage_weekly: weekly, usage_monthly: 2,
    effective_budget: budget('workspace', 10, remaining), budgets: [budget('workspace', 10, remaining), budget('key_limit', 10, keyRemaining)], rate_limit: { requests: -1, interval: '10s' } };
};
const failed = (kind, time = new Date().toISOString()) => `{"level":"warn","time":"${time}","event":"model.call.failed","errorKind":"${kind}"}`;
const FORBIDDEN = [403, undefined];

// Production today: /credits 403, budgets healthy. OK, the 403 noted once as information and not repeated; no alert.
provider = { credits: FORBIDDEN, key: [200, key()] };
writeFileSync(log, '');
let r = await run('credits 403, budget healthy');
assert.equal(r.code, 0);
assert.match(r.stdout, /provider-budget OK \(info: account balance not readable with this key \(HTTP 403\)/);
assert.match(r.stdout, /budget 8\.00\/10\.00 workspace/);
r = await run('credits 403 again');
assert.equal(r.code, 0);
assert.doesNotMatch(r.stdout, /info:|WARN/);
assert.equal(alerts.length, 0);

// The workspace budget almost spent: CRITICAL, alerted once.
provider.key = [200, key({ remaining: 0.3 })];
r = await run('budget near its limit');
assert.equal(r.code, 2);
assert.match(r.stdout, /CRITICAL: workspace budget US\$ 0\.30 of US\$ 10\.00 left \(3 %\)/);
assert.equal(alerts.length, 1);
assert.equal(alerts[0].status, 'CRITICAL');
await run('budget near its limit, again');
assert.equal(alerts.length, 1); // the same status is not re-alerted before ALERT_REPEAT_MINUTES

// 40 % left but at US$ 1/day it runs out in 4 days, before the reset in 12: WARN. The same burn with a reset in 2 days: OK.
provider.key = [200, key({ remaining: 4, daily: 1, weekly: 7 })];
r = await run('budget runs out before reset');
assert.equal(r.code, 1);
assert.match(r.stdout, /WARN: workspace budget US\$ 4\.00 of US\$ 10\.00 left \(40 %\), about 4\.0 days at US\$ 1\.00\/day/);
provider.key = [200, key({ remaining: 4, daily: 1, weekly: 7, resetsIn: 2 })];
r = await run('budget resets before it runs out');
assert.equal(r.code, 0);

// A burst of rate limits (rate saturation, retried by R4): WARN, with the count; money refusals stay at zero.
provider.key = [200, key()];
writeFileSync(log, [...Array(6)].map(() => failed('rate_limited')).join('\n'));
r = await run('rate-limited burst');
assert.equal(r.code, 1);
assert.match(r.stdout, /WARN: 6 rate-limited model calls in 60 min \(rate saturation\)/);
// ... and a threshold from the env file, not code, silences it.
writeFileSync(join(dir, 'budget.env'), 'WARN_RATE_LIMITED=10\n');
r = await run('rate-limited burst under a raised threshold', { PROVIDER_BUDGET_ENV: join(dir, 'budget.env') });
assert.equal(r.code, 0);

// Refusals for money in the logs, each class on its own: CRITICAL. Old lines are outside the window.
writeFileSync(log, [failed('insufficient_balance'), failed('spend_limit_reached'), failed('spend_limit_reached'), failed('rate_limited'), failed('provider_error', '2020-01-01T00:00:00.000Z')].join('\n'));
r = await run('balance and spend-limit refusals');
assert.equal(r.code, 2);
assert.match(r.stdout, /1 model calls refused for insufficient balance in 60 min; 2 model calls refused for a spend limit in 60 min/);
assert.match(r.stdout, /"rate_limited":1/);
assert.doesNotMatch(r.stdout, /rate saturation|provider errors/);

// A key that may read the account balance: a low balance warns.
writeFileSync(log, '');
provider = { credits: [200, { total_credits: 50, total_usage: 47 }], key: [200, key()] };
r = await run('readable balance, low');
assert.equal(r.code, 1);
assert.match(r.stdout, /WARN: account balance US\$ 3\.00/);

// The key endpoint failing is a WARN (not a silent OK).
provider = { credits: FORBIDDEN, key: [500, undefined] };
r = await run('key endpoint down');
assert.equal(r.code, 1);
assert.match(r.stdout, /key budget unreadable \(GET \/key: HTTP 500\)/);

// Recovery is announced once.
provider = { credits: FORBIDDEN, key: [200, key()] };
r = await run('recovered');
assert.equal(r.code, 0);
assert.equal(alerts.at(-1).status, 'OK');

// Every run appended a snapshot (the --measured input of ops/r4-metrics), with no secret in it nor in the state file.
const raw = readFileSync(join(dir, 'usage.jsonl'), 'utf8');
const snapshots = raw.trim().split('\n').map((l) => JSON.parse(l));
assert.equal(snapshots.length, 12);
assert.deepEqual(snapshots[0].budgets.map((b) => [b.scope, b.remainingUsd]), [['workspace', 8], ['key_limit', 9]]);
assert.equal(snapshots[0].keyUsageUsd, 2);
assert.equal(snapshots[0].balanceReadable, false);
assert.deepEqual(snapshots[8].failures, { insufficient_balance: 1, spend_limit_reached: 2, rate_limited: 1 });
assert.doesNotMatch(raw + readFileSync(join(dir, 'state.json'), 'utf8'), /sk-test|SECRET-WEBHOOK/);
server.close();
process.stdout.write('check.mjs self-check: OK\n');
