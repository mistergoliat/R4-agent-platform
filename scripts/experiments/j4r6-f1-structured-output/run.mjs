#!/usr/bin/env node
// R4-J4-R6 F-1: structured-output reliability of the decision turns that invite several reads (README.md here).
//
//   capture  the REAL canary runtime of @7/@8 on a throwaway LOCAL `canary` database, fixture owners, in-process
//            CIA/Customer Profile stubs (synthetic), scripted decisions; at each REAL turn the exact ModelRequest the
//            kernel built is saved (synthetic content only) and the turn ends. No model call.
//   replay   every saved request goes to the real model N times through the adapter of THIS build. Only the answer's
//            shape is recorded (shapeOf), with the strict parser's verdict. No answer text is kept.
//
//   npm run build
//   node scripts/experiments/j4r6-f1-structured-output/run.mjs capture
//   node scripts/experiments/j4r6-f1-structured-output/run.mjs replay --arm baseline --repeat 4 --env-file ../R4-agent-platform/.env
//
// Hard stops: the cumulative ledger (<root>/budget.json: 400 calls / US$6) and --max-calls.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { parseAgentDecision } from '@r4/agent-kernel';
import { FakeModelProvider } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { CAPABILITY_IDS, ContextView, read, shapeOf } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryGateway, startCanaryRuntime } from '@r4-sales/agent/canary';
import { createPool } from '@r4/persistence-postgres';

const REPO = resolve(import.meta.dirname, '../../..');
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    arm: { type: 'string', default: 'baseline' },
    repeat: { type: 'string', default: '4' },
    only: { type: 'string' },
    'max-calls': { type: 'string' },
    // Informational arm only: the production profile keeps thinking enabled.
    'thinking-disabled': { type: 'boolean', default: false },
    root: { type: 'string' },
    'env-file': { type: 'string' },
  },
});
const mode = positionals[0];
if (!['capture', 'replay', 'summary'].includes(mode)) throw new Error('usage: run.mjs capture | replay --arm <name> | summary');
args.root ??= join(REPO, 'artifacts', 'j4r6-f1-structured-output');
const REQUESTS = join(args.root, 'requests');
mkdirSync(REQUESTS, { recursive: true });
const logger = createSilentLogger();
const say = (line) => process.stdout.write(`${line}\n`);
const ADMIN_DATABASE_URL = process.env.R4_EXPERIMENT_ADMIN_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres'; // docker-compose.yml

// ---- scenarios: synthetic customer texts that invite several reads in one turn ---------------------------
const MULTI = [
  'Hola, busco discos de 10 kg y una barra olímpica. ¿Cuánto sale el despacho a Ñuñoa?',
  'Necesito un rack, una banca y mancuernas de 20 kg, con envío a Maipú. ¿Qué tienen y cuánto sale todo?',
  'Hola! ¿Tienen kettlebells de 16 y 24 kg? Y también cuánto cuesta enviarlas a Providencia.',
];
const HISTORY = [
  '¿Qué compré la última vez y tienen stock de eso hoy?',
  'Quiero repetir mi última compra. ¿Qué fue y cuánto sale ahora con despacho a La Serena?',
  'Hola, ¿me recomiendas algo que combine con lo que ya te compré? Dime si hay stock.',
];
const SCENARIOS = [
  // Guest, first decision of the turn.
  ...MULTI.flatMap((text, i) => ['sales-production@7', 'sales-production@8'].map((profile) => ({ id: `multi${i}-${profile.at(-1)}`, profile, cia: 'not_verified', text, steps: ['REAL'] }))),
  // Guest, second decision of the turn: one catalog read already observed (the canary failures were mid-turn).
  ...MULTI.flatMap((text, i) => ['sales-production@7', 'sales-production@8'].map((profile) => ({ id: `multi${i}-after-read-${profile.at(-1)}`, profile, cia: 'not_verified', text, steps: [read(CAPABILITY_IDS.catalogSearch, { query: text.includes('rack') ? 'rack' : text.includes('kettlebell') ? 'kettlebell' : 'disco 10 kg' }), 'REAL'] }))),
  // @8 linked (CIA verified + Customer Profile synthetic fixture): history plus current stock.
  ...HISTORY.map((text, i) => ({ id: `linked${i}-8`, profile: 'sales-production@8', cia: 'verified', text, steps: ['REAL'] })),
  ...HISTORY.map((text, i) => ({ id: `linked${i}-after-history-8`, profile: 'sales-production@8', cia: 'verified', text, steps: [read('customer.get_purchase_history', { limit: 10, offset: 0 }), 'REAL'] })),
  // @7 asked for its history (its definition mentions customer.get_context, which @7 does not register).
  ...HISTORY.map((text, i) => ({ id: `history${i}-7`, profile: 'sales-production@7', cia: 'not_verified', text, steps: ['REAL'] })),
];

// ---- capture -------------------------------------------------------------------------------------------
async function capture() {
  const CIA = 'http://127.0.0.1:8787';
  const CP = 'http://127.0.0.1:3010';
  const CUSTOMER_ENV = {
    R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: CIA, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001', R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500',
    R4_CUSTOMER_PROFILE_BASE_URL: CP, R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij', R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
  };
  const GATEWAY_ENV = { R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: CIA, R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'synthetic-channel-confirm-token-0001', R4_PROD_VERIFICATION_CODE_KEYS: `k1:${randomBytes(32).toString('base64')}` };
  // The synthetic fixtures of tests/integration/sales-profile-v8.test.ts (CIA verified grant; CP available with purchases).
  const GRANT_TOKEN = 'eyJzeW50aGV0aWMiOnRydWV9.eyJub3QiOiJhIHJlYWwgZ3JhbnQifQ.c3ludGhldGljLXNpZ25hdHVyZQ';
  const CUSTOMER_REF = 'prestashop_customer:900000201';
  const cpFixture = (file) => {
    const body = JSON.parse(readFileSync(join(REPO, 'adapters/domains/customer/http/fixtures', file), 'utf8'));
    body.provenance.authorizationBasis = 'customer_grant_verified';
    body.customerRef = CUSTOMER_REF;
    return body;
  };
  const CP_BODIES = { sales_context: cpFixture('sales-context-available-with-purchases.json'), purchase_history: cpFixture('purchase-history-available-normal.json') };
  const json = (status, body) => new globalThis.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  const owners = (sc) => async (url, init) => {
    const now = Date.now();
    if (url === `${CIA}/v1/identity/resolve`) {
      if (sc.cia !== 'verified') return json(200, { schemaVersion: 1, status: 'not_verified', resolvedAt: new Date(now - 1_000).toISOString() });
      const { purposes } = JSON.parse(init.body);
      return json(200, { schemaVersion: 1, status: 'verified', customerRef: CUSTOMER_REF, grant: { token: GRANT_TOKEN, expiresAt: new Date(now + 240_000).toISOString(), purposes }, resolvedAt: new Date(now - 1_000).toISOString() });
    }
    if (url.startsWith(CP)) {
      const body = globalThis.structuredClone(CP_BODIES[JSON.parse(init.body).purpose]);
      body.freshness.asOf = new Date(now - 2_000).toISOString();
      body.freshness.validUntil = new Date(now + 120_000).toISOString();
      return json(200, body);
    }
    if (url === `${CIA}/v1/identity/verifications`) return json(202, { schemaVersion: 1, verificationId: randomBytes(16).toString('base64url'), status: 'challenge_issued', expiresAt: new Date(now + 600_000).toISOString(), resendAvailableAt: new Date(now + 60_000).toISOString() });
    throw new Error(`unexpected owner call ${url}`);
  };
  const http = (port) => new Proxy(port, { get: (t, k) => (k === 'bindingKind' ? 'http' : typeof Reflect.get(t, k) === 'function' ? Reflect.get(t, k).bind(t) : Reflect.get(t, k)) });
  const routes = new Map();
  const wait = { type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'capture' } };
  const provider = new FakeModelProvider((request) => {
    const route = routes.get(request.context.sections.task.find((i) => i.kind === 'task').content.taskId);
    const step = route?.steps[route.next++];
    if (!step) return wait;
    if (step === 'REAL') {
      writeFileSync(join(REQUESTS, `${route.id}.json`), JSON.stringify(request));
      route.captured = true;
      return wait;
    }
    return { type: 'structured', data: step(new ContextView(request)) };
  });
  provider.providerId = 'openai-compatible.deepseek-v4-flash';
  const admin = async (sql) => {
    const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  const LIMITS = { R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '5000000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '15', R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '2', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '10000', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900' };
  for (const label of ['sales-production@7', 'sales-production@8']) {
    const dbName = `r4_canary_f1_${label.at(-1)}_${randomBytes(4).toString('hex')}`;
    await admin(`create database ${dbName}`);
    const dbUrl = ADMIN_DATABASE_URL.replace(/\/postgres$/, `/${dbName}`);
    const canary = loadCanaryEnvironment({
      R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: label, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'r4-j4r6-f1-experiment-identity-key-00000000001',
      R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: dbUrl, R4_LOG_LEVEL: 'silent', ...LIMITS, R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'exclude',
    });
    await initCanary(canary, logger);
    const gateway = label === 'sales-production@8'
      ? await startCanaryGateway(canary, { env: GATEWAY_ENV, logger, openPool: (name) => createPool({ connectionString: dbUrl, logger, applicationName: `r4-sales-canary:${name}`, max: 2 }), transport: () => Promise.reject(new Error('no confirm in this experiment')) })
      : null;
    try {
      for (const sc of SCENARIOS.filter((s) => s.profile === label)) {
        const runtime = await startCanaryRuntime(canary, {
          modelProvider: provider, catalog: http(new FixtureCatalog()), shipping: http(new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()),
          worker: { databaseUrl: dbUrl, logLevel: 'silent', dbPoolMax: 3, workerId: `f1:${sc.id}`, leaseDurationMs: 300_000, heartbeatIntervalMs: 30_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1, execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 600_000, modelCallTimeoutMs: 180_000, maxWriteActions: 50 }, context: { budget: { mode: 'unbounded' }, expiredEvidence: 'exclude' } },
          scheduler: null, captureFile: join(tmpdir(), `r4-f1-${dbName}-${sc.id}.jsonl`), logger, isolationCheckMs: 50,
          ...(label === 'sales-production@8' ? { customer: { env: CUSTOMER_ENV, fetch: owners(sc) } } : {}),
        });
        const route = { ...sc, next: 0, captured: false };
        try {
          const sent = await sendSynthetic(canary, { conversation: `${sc.id}-${randomBytes(3).toString('hex')}`, text: sc.text }, logger, undefined, GATEWAY_ENV);
          routes.set(sent.taskId, route);
          for (let c = 0; c < 40; c += 1) if ((await runtime.worker.worker.runOnce()).kind === 'idle') break;
        } finally {
          await runtime.close();
        }
        say(`${sc.id} captured=${route.captured}`);
      }
    } finally {
      await gateway?.close();
      await admin(`drop database if exists ${dbName} with (force)`);
    }
  }
}

// ---- replay --------------------------------------------------------------------------------------------
async function replay() {
  const MAX_CALLS = 400;
  const MAX_USD = 6;
  // EXTERNAL (api-docs.deepseek.com, 2026-10): peak prices per 1M tokens, cache MISS for every input token (upper bound).
  const USD_PER_M_INPUT = 0.3;
  const USD_PER_M_OUTPUT = 1.2;
  const LEDGER = join(args.root, 'budget.json');
  const CALLS = join(args.root, `calls-${args.arm}.jsonl`);
  const budget = (() => {
    try {
      return JSON.parse(readFileSync(LEDGER, 'utf8'));
    } catch {
      return { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    }
  })();
  const cap = Math.min(MAX_CALLS, args['max-calls'] === undefined ? MAX_CALLS : budget.calls + Number(args['max-calls']));
  // Only R4_MODEL_* lines are read; the API key is never printed.
  const dotenv = Object.fromEntries(readFileSync(args['env-file'] ?? join(REPO, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^R4_MODEL_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const modelConfig = loadOpenAICompatibleConfig({ ...dotenv, R4_MODEL_PROFILE: 'deepseek-v4-flash', R4_MODEL_MAX_OUTPUT_TOKENS: '', ...(args['thinking-disabled'] ? { R4_MODEL_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' } : {}) });
  const config = describeModelConfig(modelConfig);
  if (config.model !== 'deepseek-flash' || config.responseFormat !== 'json_object' || config.maxOutputTokens !== null) throw new Error('not the pinned production model profile');
  if (!args['thinking-disabled'] && config.extraBody.thinking?.type !== 'enabled') throw new Error('the production profile has thinking enabled');
  const provider = new OpenAICompatibleModelProvider(modelConfig);
  const commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'adapters', 'packages'], { encoding: 'utf8' }).trim().length > 0;
  const files = readdirSync(REQUESTS).filter((f) => f.endsWith('.json') && (!args.only || new RegExp(args.only).test(f))).sort();
  const STRUCTURAL = new Set(['invalid_structured_output', 'invalid_decision_schema', 'unknown_decision_type']);
  for (let attempt = 1; attempt <= Number(args.repeat); attempt += 1) {
    for (const file of files) {
      if (budget.calls >= cap || budget.usd >= MAX_USD) {
        say(`budget stop ${JSON.stringify(budget)}`);
        return;
      }
      const request = JSON.parse(readFileSync(join(REQUESTS, file), 'utf8'));
      const items = Object.values(request.context.sections).flat();
      const capabilities = items.filter((i) => i.kind === 'capability').map((i) => i.content);
      const observationIds = new Set(items.filter((i) => i.kind === 'observation').map((i) => i.content.observationId));
      let record;
      try {
        const response = await provider.invoke(request, globalThis.AbortSignal.timeout(180_000));
        budget.inputTokens += response.usage.inputTokens;
        budget.outputTokens += response.usage.outputTokens;
        const parsed = parseAgentDecision(response, { capabilities, observationIds });
        record = {
          finishReason: response.finishReason, outputTokens: response.usage.outputTokens,
          verdict: parsed.ok ? 'ok' : STRUCTURAL.has(parsed.error.code) ? 'malformed' : 'semantic', code: parsed.ok ? null : parsed.error.code,
          decision: parsed.ok ? parsed.decision.type : null,
          shape: response.content === null ? null : shapeOf(response.content),
        };
      } catch (error) {
        record = { verdict: 'error', code: error?.kind ?? error?.name ?? 'unknown' };
      }
      budget.calls += 1;
      budget.usd = (budget.inputTokens * USD_PER_M_INPUT + budget.outputTokens * USD_PER_M_OUTPUT) / 1e6;
      writeFileSync(LEDGER, JSON.stringify(budget, null, 2));
      appendFileSync(CALLS, `${JSON.stringify({ arm: args.arm, commit, dirty, thinking: !args['thinking-disabled'], request: file.replace(/\.json$/, ''), attempt, ...record })}\n`);
      say(`${args.arm} ${file} #${attempt} ${record.verdict}${record.code ? `:${record.code}` : ''} ${JSON.stringify(record.shape?.jsonDocuments ?? null)}+${record.shape?.otherTextChars ?? 0} budget=${budget.calls}/${budget.usd.toFixed(3)}`);
    }
  }
}

// ---- summary: malformed rate per arm and request family, and the shapes of the malformed answers --------------
function summary() {
  const rows = readdirSync(args.root).filter((f) => /^calls-.+\.jsonl$/.test(f)).flatMap((f) => readFileSync(join(args.root, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  const family = (request) => request.replace(/\d+(-(after-read|after-history))?-(\d)$/, '$1@$3');
  const table = {};
  for (const r of rows) {
    for (const key of [`${r.arm} | ALL`, `${r.arm} | ${family(r.request)}`]) {
      const t = (table[key] ??= { calls: 0, malformed: 0, semantic: 0, error: 0, shapes: {} });
      t.calls += 1;
      if (r.verdict === 'malformed') {
        t.malformed += 1;
        const shape = `${(r.shape?.jsonDocuments ?? []).map((d) => d ?? 'untyped').join('+') || 'none'}${r.shape?.otherTextChars ? '+prose' : ''}`;
        t.shapes[shape] = (t.shapes[shape] ?? 0) + 1;
      } else if (r.verdict === 'semantic') t.semantic += 1;
      else if (r.verdict === 'error') t.error += 1;
    }
  }
  for (const [key, t] of Object.entries(table).sort()) say(`${key.padEnd(40)} calls=${t.calls} malformed=${t.malformed} (${((100 * t.malformed) / t.calls).toFixed(1)}%) semantic=${t.semantic} error=${t.error} ${JSON.stringify(t.shapes)}`);
  say(`ledger ${readFileSync(join(args.root, 'budget.json'), 'utf8').replace(/\s+/g, ' ')}`);
}

await (mode === 'capture' ? capture() : mode === 'replay' ? replay() : summary());
