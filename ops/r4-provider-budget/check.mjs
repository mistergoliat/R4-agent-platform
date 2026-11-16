#!/usr/bin/env node
// R4 model-provider budget check (read-only towards the provider and R4). One run = one status line, one snapshot, and
// at most one alert. Meant to run every few minutes from cron on the host:
//
//   */10 * * * * node ~/R4-agent-platform/ops/r4-provider-budget/check.mjs >> ~/r4-provider-budget.log 2>&1
//
// It distinguishes, from what OpenRouter exposes to an ordinary API key:
//   account balance   GET /credits  total_credits − total_usage (the whole account: every key, every worker)
//   configured budget GET /key      limit, limit_remaining, limit_reset (this key's own spend cap; null = none)
//   consumption       GET /key      usage_daily / usage_weekly / usage_monthly (this key)
//   provider errors   R4 logs       model.call.failed by errorKind: provider_error, quota_exhausted, timeout,
//   rate limits                     rate_limited (window CHECK_WINDOW_MINUTES)
// Per-model activity needs a management key and is not read.
//
// Thresholds live in an env file (default ~/.config/r4/provider-budget.env; see provider-budget.env.example), so they
// change without touching code. The API key is read from R4_MODEL_API_KEY in KEY_ENV_FILE and is never printed.
// Exit code: 0 OK, 1 WARN, 2 CRITICAL.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const envFile = (path) => (existsSync(path) ? Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.trim().replace(/^(['"])(.*)\1$/, '$2')])) : {});
const cfg = { ...envFile(process.env.PROVIDER_BUDGET_ENV ?? join(home, '.config/r4/provider-budget.env')), ...process.env };
const num = (name, fallback) => (cfg[name] === undefined || cfg[name] === '' ? fallback : Number(cfg[name]));
const T = {
  warnBalanceUsd: num('WARN_BALANCE_USD', 5), critBalanceUsd: num('CRIT_BALANCE_USD', 1),
  warnDaysLeft: num('WARN_DAYS_LEFT', 7), critDaysLeft: num('CRIT_DAYS_LEFT', 2),
  warnKeyRemainingPct: num('WARN_KEY_REMAINING_PCT', 20), critKeyRemainingPct: num('CRIT_KEY_REMAINING_PCT', 5),
  warnProviderErrors: num('WARN_PROVIDER_ERRORS', 3), warnRateLimited: num('WARN_RATE_LIMITED', 5),
  windowMinutes: num('CHECK_WINDOW_MINUTES', 60), alertRepeatMinutes: num('ALERT_REPEAT_MINUTES', 180),
};
const keyEnv = envFile(cfg.KEY_ENV_FILE ?? join(home, '.config/r4/production.env'));
const apiKey = cfg.PROVIDER_API_KEY ?? keyEnv.R4_MODEL_API_KEY;
const baseUrl = (cfg.PROVIDER_BASE_URL ?? keyEnv.R4_MODEL_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const stateFile = cfg.STATE_FILE ?? join(home, '.local/state/r4-provider-budget.json');
const snapshotsFile = cfg.SNAPSHOTS_FILE ?? join(home, '.local/state/r4-provider-usage.jsonl');
const logFiles = (cfg.LOG_FILES ?? ['r4-channel-gateway', 'r4-sales-worker', 'r4-sales-worker-lane', 'r4-scheduler', 'r4-web-qa-worker'].map((p) => join(home, `.pm2/logs/${p}-out.log`)).join(',')).split(',').filter(Boolean);

const findings = []; // [level, text]
const flag = (level, text) => findings.push([level, text]);

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return (await response.json()).data;
}

const now = new Date();
const snapshot = { at: now.toISOString() };
if (!apiKey) flag('CRITICAL', 'no provider API key found (R4_MODEL_API_KEY in KEY_ENV_FILE)');
else if (!cfg.PROVIDER_BASE_URL && !/openrouter\.ai/.test(baseUrl)) flag('WARN', `provider ${new URL(baseUrl).host} is not OpenRouter: balance and budget are not checked`);
else {
  const [credits, key] = await Promise.allSettled([get('/credits'), get('/key')]);
  if (credits.status === 'fulfilled') {
    snapshot.accountCreditsUsd = credits.value.total_credits;
    snapshot.accountUsageUsd = credits.value.total_usage;
    snapshot.balanceUsd = credits.value.total_credits - credits.value.total_usage;
  } else flag('WARN', `account balance unreadable (${credits.reason.message})`);
  if (key.status === 'fulfilled') {
    const k = key.value;
    Object.assign(snapshot, { keyUsageUsd: k.usage, usageDailyUsd: k.usage_daily, usageWeeklyUsd: k.usage_weekly, usageMonthlyUsd: k.usage_monthly, keyLimitUsd: k.limit, keyLimitRemainingUsd: k.limit_remaining, keyLimitReset: k.limit_reset });
    if (k.limit !== null && k.limit !== undefined && k.limit > 0) {
      const pct = (100 * (k.limit_remaining ?? 0)) / k.limit;
      if (pct <= T.critKeyRemainingPct) flag('CRITICAL', `key budget ${pct.toFixed(0)} % left (US$ ${k.limit_remaining} of ${k.limit}, reset ${k.limit_reset ?? 'never'})`);
      else if (pct <= T.warnKeyRemainingPct) flag('WARN', `key budget ${pct.toFixed(0)} % left (US$ ${k.limit_remaining} of ${k.limit})`);
    }
  } else flag('WARN', `key budget unreadable (${key.reason.message})`);
  if (snapshot.balanceUsd !== undefined) {
    // Daily burn: the larger of today's and the weekly average, so a quiet morning does not hide a busy week.
    const burn = Math.max(snapshot.usageDailyUsd ?? 0, (snapshot.usageWeeklyUsd ?? 0) / 7);
    snapshot.daysLeft = burn > 0 ? snapshot.balanceUsd / burn : null;
    const days = snapshot.daysLeft === null ? '' : `, about ${snapshot.daysLeft.toFixed(1)} days at US$ ${burn.toFixed(2)}/day`;
    if (snapshot.balanceUsd <= T.critBalanceUsd || (snapshot.daysLeft !== null && snapshot.daysLeft < T.critDaysLeft)) flag('CRITICAL', `account balance US$ ${snapshot.balanceUsd.toFixed(2)}${days}`);
    else if (snapshot.balanceUsd <= T.warnBalanceUsd || (snapshot.daysLeft !== null && snapshot.daysLeft < T.warnDaysLeft)) flag('WARN', `account balance US$ ${snapshot.balanceUsd.toFixed(2)}${days}`);
  }
}

// model.call.failed in the window, by kind (the logs are JSON lines; only the event and its errorKind are read).
const since = now.getTime() - T.windowMinutes * 60_000;
const failures = {};
for (const file of logFiles.filter((f) => existsSync(f))) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"model.call.failed"')) continue;
    const time = Date.parse(line.match(/"time":"([^"]+)"/)?.[1] ?? '');
    const kind = line.match(/"errorKind":"([a-z_]+)"/)?.[1] ?? 'unknown';
    if (time >= since) failures[kind] = (failures[kind] ?? 0) + 1;
  }
}
snapshot.failures = failures;
if (failures.quota_exhausted) flag('CRITICAL', `${failures.quota_exhausted} model calls refused for balance or spend limit in ${T.windowMinutes} min`);
if ((failures.provider_error ?? 0) >= T.warnProviderErrors) flag('WARN', `${failures.provider_error} provider errors in ${T.windowMinutes} min`);
if ((failures.rate_limited ?? 0) >= T.warnRateLimited) flag('WARN', `${failures.rate_limited} rate-limited calls in ${T.windowMinutes} min`);

const status = findings.some(([l]) => l === 'CRITICAL') ? 'CRITICAL' : findings.length > 0 ? 'WARN' : 'OK';
const summary = `${now.toISOString()} provider-budget ${status}${findings.length ? `: ${findings.map(([, t]) => t).join('; ')}` : ''} | balance ${snapshot.balanceUsd?.toFixed(2) ?? '–'} | today ${snapshot.usageDailyUsd?.toFixed(2) ?? '–'} | week ${snapshot.usageWeeklyUsd?.toFixed(2) ?? '–'} | failures ${JSON.stringify(failures)}`;
process.stdout.write(`${summary}\n`);

const ensureDir = (file) => import('node:fs').then(({ mkdirSync }) => mkdirSync(join(file, '..'), { recursive: true }));
await ensureDir(snapshotsFile);
appendFileSync(snapshotsFile, `${JSON.stringify({ ...snapshot, status })}\n`); // also the --measured input of ops/r4-metrics

// Alert on a change of status, and repeat a non-OK status every ALERT_REPEAT_MINUTES; never on every run.
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const due = status !== 'OK' && (state.lastStatus !== status || now.getTime() - Date.parse(state.lastAlertAt ?? 0) >= T.alertRepeatMinutes * 60_000);
const recovered = status === 'OK' && state.lastStatus && state.lastStatus !== 'OK';
if ((due || recovered) && cfg.ALERT_WEBHOOK_URL) {
  try {
    const r = await fetch(cfg.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `R4 ${summary}`, status, findings: findings.map(([level, text]) => ({ level, text })) }), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) process.stdout.write(`alert webhook answered HTTP ${r.status}\n`);
    else state.lastAlertAt = now.toISOString();
  } catch (error) {
    process.stdout.write(`alert webhook failed: ${error.message}\n`);
  }
} else if (due) state.lastAlertAt = now.toISOString(); // no webhook configured: the log line and the exit code are the alert
await ensureDir(stateFile);
writeFileSync(stateFile, JSON.stringify({ ...state, lastStatus: status, lastRunAt: now.toISOString() }));
process.exitCode = status === 'CRITICAL' ? 2 : status === 'WARN' ? 1 : 0;
