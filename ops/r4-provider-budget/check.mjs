#!/usr/bin/env node
// R4 model-provider budget check (read-only towards the provider and R4). One run = one status line, one snapshot, and
// at most one alert. Meant to run every few minutes from cron on the host:
//
//   */10 * * * * node ~/R4-agent-platform/ops/r4-provider-budget/check.mjs >> ~/r4-provider-budget.log 2>&1
//
// What it reads, from what OpenRouter exposes to an ordinary API key:
//   spend budgets     GET /key      effective_budget / budgets[] (workspace cap, key cap): limit, spend, remaining,
//                                   resets_at; legacy limit / limit_remaining when those are absent
//   burn rate         GET /key      usage_daily, usage_weekly (this key)
//   account balance   GET /credits  total_credits - total_usage; optional: a key that may not read it (HTTP 401/403)
//                                   is noted once as information, never as a warning
//   provider refusals R4 logs       model.call.failed by errorKind in the last CHECK_WINDOW_MINUTES:
//                                   insufficient_balance and spend_limit_reached (money, never retried) are CRITICAL;
//                                   rate_limited (rate saturation, retried) and provider_error alert above a threshold
// Per-model activity needs a management key and is not read.
//
// Thresholds live in an env file (default ~/.config/r4/provider-budget.env; see provider-budget.env.example), so they
// change without touching code. The API key is read from R4_MODEL_API_KEY in KEY_ENV_FILE and is never printed, nor is
// the webhook URL. Exit code: 0 OK, 1 WARN, 2 CRITICAL.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const home = homedir();
const envFile = (path) => (existsSync(path) ? Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.trim().replace(/^(['"])(.*)\1$/, '$2')])) : {});
const cfg = { ...envFile(process.env.PROVIDER_BUDGET_ENV ?? join(home, '.config/r4/provider-budget.env')), ...process.env };
const num = (name, fallback) => (cfg[name] === undefined || cfg[name] === '' ? fallback : Number(cfg[name]));
const T = {
  warnBudgetRemainingPct: num('WARN_BUDGET_REMAINING_PCT', 20), critBudgetRemainingPct: num('CRIT_BUDGET_REMAINING_PCT', 5),
  warnDaysLeft: num('WARN_DAYS_LEFT', 7), critDaysLeft: num('CRIT_DAYS_LEFT', 2),
  warnBalanceUsd: num('WARN_BALANCE_USD', 5), critBalanceUsd: num('CRIT_BALANCE_USD', 1),
  warnRateLimited: num('WARN_RATE_LIMITED', 5), critRateLimited: num('CRIT_RATE_LIMITED', 50),
  warnProviderErrors: num('WARN_PROVIDER_ERRORS', 3),
  windowMinutes: num('CHECK_WINDOW_MINUTES', 60), alertRepeatMinutes: num('ALERT_REPEAT_MINUTES', 180),
};
const keyEnv = envFile(cfg.KEY_ENV_FILE ?? join(home, '.config/r4/production.env'));
const apiKey = cfg.PROVIDER_API_KEY ?? keyEnv.R4_MODEL_API_KEY;
const baseUrl = (cfg.PROVIDER_BASE_URL ?? keyEnv.R4_MODEL_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const stateFile = cfg.STATE_FILE ?? join(home, '.local/state/r4-provider-budget.json');
const snapshotsFile = cfg.SNAPSHOTS_FILE ?? join(home, '.local/state/r4-provider-usage.jsonl');
const logFiles = (cfg.LOG_FILES ?? ['r4-channel-gateway', 'r4-sales-worker', 'r4-sales-worker-lane', 'r4-scheduler', 'r4-web-qa-worker'].map((p) => join(home, `.pm2/logs/${p}-out.log`)).join(',')).split(',').filter(Boolean);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};

const findings = []; // [level, text]; INFO never changes the status nor alerts
const flag = (level, text) => findings.push([level, text]);
const usd = (n) => `US$ ${n.toFixed(2)}`;

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw Object.assign(new Error(`GET ${path}: HTTP ${response.status}`), { status: response.status });
  return (await response.json()).data;
}

const now = new Date();
const snapshot = { at: now.toISOString() };
if (!apiKey) flag('CRITICAL', 'no provider API key found (R4_MODEL_API_KEY in KEY_ENV_FILE)');
else if (!cfg.PROVIDER_BASE_URL && !/openrouter\.ai/.test(baseUrl)) flag('WARN', `provider ${new URL(baseUrl).host} is not OpenRouter: balance and budget are not checked`);
else {
  const [credits, key] = await Promise.allSettled([get('/credits'), get('/key')]);
  if (key.status === 'fulfilled') {
    const k = key.value;
    Object.assign(snapshot, { keyUsageUsd: k.usage, usageDailyUsd: k.usage_daily, usageWeeklyUsd: k.usage_weekly, usageMonthlyUsd: k.usage_monthly });
    // Daily burn: the larger of today's and the weekly average, so a quiet morning does not hide a busy week. It is this
    // key's burn; a workspace budget shared with other keys can run out sooner.
    snapshot.burnUsdPerDay = Math.max(k.usage_daily ?? 0, (k.usage_weekly ?? 0) / 7);
    const budgets = k.budgets?.length ? k.budgets : k.effective_budget ? [k.effective_budget]
      : k.limit > 0 ? [{ scope: 'key_limit', limit_usd: k.limit, remaining_usd: k.limit_remaining ?? 0, spend_usd: k.limit - (k.limit_remaining ?? 0), reset_interval: k.limit_reset, resets_at: null }] : [];
    snapshot.effectiveBudgetScope = k.effective_budget?.scope ?? null;
    snapshot.budgets = budgets.filter((b) => b.limit_usd > 0).map((b) => {
      const pct = (100 * b.remaining_usd) / b.limit_usd;
      const daysLeft = snapshot.burnUsdPerDay > 0 ? b.remaining_usd / snapshot.burnUsdPerDay : null;
      const daysToReset = b.resets_at ? (Date.parse(b.resets_at) - now.getTime()) / 86_400_000 : null;
      // Days left only matter when the money runs out before the budget resets.
      const short = (limit) => daysLeft !== null && daysLeft < limit && (daysToReset === null || daysLeft < daysToReset);
      const text = `${b.scope} budget ${usd(b.remaining_usd)} of ${usd(b.limit_usd)} left (${pct.toFixed(0)} %)${daysLeft === null ? '' : `, about ${daysLeft.toFixed(1)} days at ${usd(snapshot.burnUsdPerDay)}/day`}, resets ${b.resets_at?.slice(0, 10) ?? b.reset_interval ?? 'never'}`;
      if (pct <= T.critBudgetRemainingPct || short(T.critDaysLeft)) flag('CRITICAL', text);
      else if (pct <= T.warnBudgetRemainingPct || short(T.warnDaysLeft)) flag('WARN', text);
      return { scope: b.scope, limitUsd: b.limit_usd, spendUsd: b.spend_usd, remainingUsd: b.remaining_usd, remainingPct: pct, daysLeft, resetsAt: b.resets_at ?? null };
    });
  } else flag('WARN', `key budget unreadable (${key.reason.message})`);

  if (credits.status === 'fulfilled') {
    delete state.balanceUnreadableNoted;
    snapshot.accountCreditsUsd = credits.value.total_credits;
    snapshot.accountUsageUsd = credits.value.total_usage;
    snapshot.balanceUsd = credits.value.total_credits - credits.value.total_usage;
    const burn = snapshot.burnUsdPerDay ?? 0;
    const daysLeft = burn > 0 ? snapshot.balanceUsd / burn : null;
    const text = `account balance ${usd(snapshot.balanceUsd)}${daysLeft === null ? '' : `, about ${daysLeft.toFixed(1)} days at ${usd(burn)}/day`}`;
    if (snapshot.balanceUsd <= T.critBalanceUsd || (daysLeft !== null && daysLeft < T.critDaysLeft)) flag('CRITICAL', text);
    else if (snapshot.balanceUsd <= T.warnBalanceUsd || (daysLeft !== null && daysLeft < T.warnDaysLeft)) flag('WARN', text);
  } else if (credits.reason.status === 401 || credits.reason.status === 403) {
    snapshot.balanceReadable = false;
    if (!state.balanceUnreadableNoted) flag('INFO', `account balance not readable with this key (HTTP ${credits.reason.status}); the spend budgets are the guard`);
    state.balanceUnreadableNoted = true;
  } else flag('WARN', `account balance unreadable (${credits.reason.message})`);
}

// model.call.failed in the window, by kind (the logs are JSON lines; only the event, its time and errorKind are read).
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
const inWindow = `in ${T.windowMinutes} min`;
if (failures.insufficient_balance) flag('CRITICAL', `${failures.insufficient_balance} model calls refused for insufficient balance ${inWindow}`);
if (failures.spend_limit_reached) flag('CRITICAL', `${failures.spend_limit_reached} model calls refused for a spend limit ${inWindow}`);
const rateLimited = failures.rate_limited ?? 0;
if (rateLimited >= T.critRateLimited) flag('CRITICAL', `${rateLimited} rate-limited model calls ${inWindow} (rate saturation)`);
else if (rateLimited >= T.warnRateLimited) flag('WARN', `${rateLimited} rate-limited model calls ${inWindow} (rate saturation)`);
if ((failures.provider_error ?? 0) >= T.warnProviderErrors) flag('WARN', `${failures.provider_error} provider errors ${inWindow}`);

const alerting = findings.filter(([level]) => level !== 'INFO');
const status = alerting.some(([level]) => level === 'CRITICAL') ? 'CRITICAL' : alerting.length > 0 ? 'WARN' : 'OK';
const info = findings.filter(([level]) => level === 'INFO').map(([, text]) => ` (info: ${text})`).join('');
const budget = snapshot.budgets?.find((b) => b.scope === snapshot.effectiveBudgetScope) ?? snapshot.budgets?.[0];
const summary = `${now.toISOString()} provider-budget ${status}${alerting.length ? `: ${alerting.map(([, text]) => text).join('; ')}` : ''}${info}`
  + ` | budget ${budget ? `${budget.remainingUsd.toFixed(2)}/${budget.limitUsd.toFixed(2)} ${budget.scope}` : '–'} | balance ${snapshot.balanceUsd?.toFixed(2) ?? '–'}`
  + ` | today ${snapshot.usageDailyUsd?.toFixed(2) ?? '–'} | week ${snapshot.usageWeeklyUsd?.toFixed(2) ?? '–'} | failures ${JSON.stringify(failures)}`;
process.stdout.write(`${summary}\n`);

mkdirSync(dirname(snapshotsFile), { recursive: true });
appendFileSync(snapshotsFile, `${JSON.stringify({ ...snapshot, status })}\n`); // also the --measured input of ops/r4-metrics

// Alert on a change of status, and repeat a non-OK status every ALERT_REPEAT_MINUTES; never on every run.
const due = status !== 'OK' && (state.lastStatus !== status || now.getTime() - Date.parse(state.lastAlertAt ?? 0) >= T.alertRepeatMinutes * 60_000);
const recovered = status === 'OK' && state.lastStatus && state.lastStatus !== 'OK';
if ((due || recovered) && cfg.ALERT_WEBHOOK_URL) {
  try {
    const r = await fetch(cfg.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `R4 ${summary}`, status, findings: alerting.map(([level, text]) => ({ level, text })) }), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) process.stdout.write(`alert webhook answered HTTP ${r.status}\n`);
    else state.lastAlertAt = now.toISOString();
  } catch (error) {
    process.stdout.write(`alert webhook failed: ${error.name}\n`); // never the message: it may carry the URL
  }
} else if (due) state.lastAlertAt = now.toISOString(); // no webhook configured: the log line and the exit code are the alert
mkdirSync(dirname(stateFile), { recursive: true });
writeFileSync(stateFile, JSON.stringify({ ...state, lastStatus: status, lastRunAt: now.toISOString() }));
process.exitCode = status === 'CRITICAL' ? 2 : status === 'WARN' ? 1 : 0;
