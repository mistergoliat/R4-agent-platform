#!/usr/bin/env node
// R4-J4-R7 G-sem (docs/architecture/R4_J4_R7_GSEM_PREREGISTRATION.md, README.md here): how the production model
// interprets customer messages under the Turn Completion Guard. The REAL canary runtime of sales-production@8 on a
// throwaway LOCAL `canary` database, fixture Catalog, Shipping and Quote V2, in-process CIA and Customer Profile
// stubs, fake WhatsApp. Earlier turns are scripted; from the message under test on, the real model decides.
//
//   npm run build
//   node scripts/experiments/j4r7-gsem/run.mjs run --dry-run                 # no network: validates every case
//   node scripts/experiments/j4r7-gsem/run.mjs run --arm A --env-file ../R4-agent-platform/.env
//   node scripts/experiments/j4r7-gsem/run.mjs summary
//   node scripts/experiments/j4r7-gsem/run.mjs run --arm B --env-file ...    # refused unless the §6 rule activates it
//
// Hard stops: the durable ledger (<root>/budget.json), reserved BEFORE every real call: 500 calls / US$8 in total,
// arm A at most 300 calls / US$4.5. A failed call counts. The ledger survives restarts; done replicas are not re-run.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { FakeModelProvider } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { createPool } from '@r4/persistence-postgres';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, ContextView, parseConfirmation, read, respond } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryGateway, startCanaryRuntime } from '@r4-sales/agent/canary';

const REPO = resolve(import.meta.dirname, '../../..');
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    arm: { type: 'string', default: 'A' },
    replicas: { type: 'string', default: '5' },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    root: { type: 'string' },
    'env-file': { type: 'string' },
  },
});
const mode = positionals[0];
if (!['run', 'summary'].includes(mode)) throw new Error('usage: run.mjs run [--arm A|B] [--dry-run] | summary');
if (!['A', 'B'].includes(args.arm)) throw new Error('--arm must be A or B');
args.root ??= join(REPO, 'artifacts', args['dry-run'] ? 'j4r7-gsem-dry-run' : 'j4r7-gsem');
mkdirSync(args.root, { recursive: true });
const SAMPLES = join(args.root, 'samples.jsonl');
const LEDGER = join(args.root, 'budget.json');
const say = (line) => process.stdout.write(`${line}\n`);
const logger = createSilentLogger();
const ADMIN_DATABASE_URL = process.env.R4_EXPERIMENT_ADMIN_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres'; // docker-compose.yml

// ---- budget (pre-registration §6) -------------------------------------------------------------------------
const TOTAL = { calls: 500, usd: 8 };
const ARM_A = { calls: 300, usd: 4.5 };
const CASE_CALLS = 6;
// EXTERNAL (api-docs.deepseek.com, 2026-10): peak prices per 1M tokens, cache MISS for every input token (upper bound).
const USD_PER_M_INPUT = 0.3;
const USD_PER_M_OUTPUT = 1.2;
// Reserved before each call and released with its real usage: no single call can cross the limit.
const USD_RESERVE = 0.02;
const usdOf = (input, output) => (input * USD_PER_M_INPUT + output * USD_PER_M_OUTPUT) / 1e6;

const ledger = (() => {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch {
    return { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0, failedCalls: 0, arms: { A: { calls: 0, usd: 0 }, B: { calls: 0, usd: 0 } } };
  }
})();
function saveLedger() {
  writeFileSync(`${LEDGER}.tmp`, JSON.stringify(ledger, null, 2));
  renameSync(`${LEDGER}.tmp`, LEDGER);
}
const armLimit = (arm) => (arm === 'A' ? ARM_A : TOTAL);
const canCall = (arm) => ledger.calls < TOTAL.calls && ledger.usd + USD_RESERVE <= TOTAL.usd && ledger.arms[arm].calls < armLimit(arm).calls && ledger.arms[arm].usd + USD_RESERVE <= armLimit(arm).usd;

// ---- arm B: the v9 draft (R4_J4_R7_DESIGN §3.4) in place of the v8 sentence; only in the request of this experiment -----
const V8_SENTENCE = 'Complete the task (complete, in a turn without a reply) only when the conversation has clearly ended.';
const V9_BLOCK = `Conversation handling
1. Read every customer message against the conversation state: the workspace, your last offer, open requests and what you already said. A short message ("ok", "perfecto", "ya, dale") means different things in different states.
2. If a message asks for something, changes something or leaves a commercial request open, handle it (read, update the workspace, propose) and reply before your turn ends. Never complete the task while a customer request is unattended.
3. A purely social message (thanks, goodbye, an acknowledgement of your last reply) may need no reply. In that case wait for input without replying. The platform may ask you once to reconsider a specific message: reply if it needs anything; repeat your decision only if no reply is really needed. Use complete only when nothing is left to answer or do.
4. Agreement words are not, by themselves, an authorization of a quote, order or payment. The platform verifies every confirmation against the offer it refers to; if it does not accept one, ask the customer to confirm the specific offer explicitly.
5. If an ambiguity changes what would be quoted, ordered or charged (product, quantity, weight, destination, price, shipping), ask one short clarifying question before acting.
6. New messages can arrive while you work. Before each decision consider every message in the context, not only the first; one reply may answer several. If a newer message changes the request, follow the newest.
7. An action whose observation shows it succeeded (a receipt) must not be proposed again: refer to its result. If an outcome is unknown, say it is being verified; never retry it yourself.
8. Never state that a quote, order, payment, shipment or verification happened unless an observation backed by a receipt shows it.
9. Quote, Checkout and approvals decide prices, availability, shipping, validity and authorization. When they refuse, explain it and offer the next step; never work around them.
10. If the platform reports that your turn or your completion was not applied because a message has no reply, reread the pending messages and reply, or confirm that no reply is needed.
Messages marked as platform notices were sent by the platform, not by you; do not repeat them.`;
function withV9(request) {
  const text = JSON.stringify(request);
  const from = JSON.stringify(V8_SENTENCE).slice(1, -1);
  if (!text.includes(from)) throw new Error('the v8 sentence is not in the request: arm B would not differ from arm A');
  return JSON.parse(text.replaceAll(from, JSON.stringify(V9_BLOCK).slice(1, -1)));
}

// ---- cases (pre-registration §3): scripted turns up to the context, then the message under test -------------
const REAL = 'REAL';
const latest = (v, id) => v.observations(id).filter((o) => o.outcome === 'succeeded').at(-1);
const offers = (v) => latest(v, CAPABILITY_IDS.shippingQuote).payload.offers;
const previewOf = (v) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload;
const ws = (ops) => (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations: ops(v) } });
const search = (query) => read(CAPABILITY_IDS.catalogSearch, { query });
const closeWait = () => ({ type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'scripted first closing' });
const closeComplete = () => ({ type: 'complete', result: { summary: 'scripted first closing', evidence: [] } });

const informed = [{ text: '¿Tienen barras olímpicas?', steps: [search('barra olímpica'), respond('Sí, tenemos la Barra olímpica 20 kg y la Barra olímpica técnica 15 kg, ambas disponibles.')] }];
const selected = [{ text: 'Quiero una barra olímpica de 20 kg', steps: [ws(() => [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }]), respond('Anotada la barra olímpica de 20 kg.')] }];
const twoCandidates = [{ text: 'Busco una barra olímpica', steps: [search('barra olímpica'), respond('Tengo dos candidatas: la Barra olímpica 20 kg y la Barra olímpica técnica 15 kg.')] }];
const offered = (text, productId) => {
  const items = [{ productId, quantity: 1 }];
  const commune = 'Ñuñoa';
  return [
    { text, steps: [ws(() => [{ op: 'add_item', ...items[0] }, { op: 'set_delivery_destination', commune }]), read(CAPABILITY_IDS.shippingQuote, { destination: { commune }, basis: 'order', items }), respond((v) => `Opciones: ${offers(v).map((o) => `${o.carrierName} ${o.serviceType}`).join(' o ')}. ¿Cuál prefieres?`)] },
    {
      text: 'Prefiero Fixture Courier, servicio NORMAL.',
      steps: [ws((v) => { const o = offers(v).find((x) => x.carrierName === 'Fixture Courier'); return [{ op: 'select_shipping_offer', carrierName: o.carrierName, serviceType: o.serviceType, ownerNetClp: o.price.ownerNet.amount }]; }), read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), respond((v) => previewOf(v).presentation.offerMessage)],
    },
  ];
};
const offerBar = offered('Hola, quiero cotizar una barra olímpica de 20 kg con despacho a Ñuñoa.', 'BAR-OLY20');
const offer100 = offered('Hola, quiero cotizar el set de discos bumper de 100 kg con despacho a Ñuñoa.', 'PLT-BUMP-100');

const CASES = [
  { id: 'C01', context: 'tras información', message: 'Ok, gracias', prior: informed },
  { id: 'C02', context: 'tras información', message: 'Perfecto', prior: informed },
  { id: 'C03', context: 'tras una oferta', message: 'Perfecto', prior: offerBar },
  { id: 'C04', context: 'tras una respuesta', message: 'Muchas gracias, eso sería todo', prior: informed },
  { id: 'C05', context: 'sin selección', message: 'Necesito cotizar un rack', prior: [] },
  { id: 'C06', context: 'producto ya conversado', message: 'Mándame el precio', prior: [{ text: 'Me interesa la Barra olímpica 20 kg', steps: [search('barra olímpica 20 kg'), respond('Buena opción: es una barra olímpica de 20 kg para entrenamiento general.')] }] },
  { id: 'C07', context: 'selección existente', message: 'Quiero agregar dos discos', prior: selected },
  { id: 'C08', context: 'tras «¿busco opciones?»', message: 'Ya, dale', prior: [{ text: 'Busco una barra olímpica', steps: [respond('¿Busco opciones en el catálogo?')] }] },
  { id: 'C09', context: 'tras una oferta', message: 'Ya, dale', prior: offerBar },
  { id: 'C10', context: 'tras una oferta', message: 'Perfecto, avancemos', prior: offerBar },
  { id: 'C11', context: 'selección existente', message: 'Gracias, pero agrégale dos discos', prior: selected },
  { id: 'C12', context: 'tras una oferta de 100 kg', message: 'Mejor que sean 120 kg', prior: offer100 },
  { id: 'C13', context: 'dos candidatos', message: 'El mismo de antes', prior: twoCandidates },
  // C14: the reconsideration episode on a real request, after a scripted first closing (both ways of closing).
  { id: 'C14w', context: 'reconsideración tras wait guionado', message: 'Necesito cotizar un rack', prior: [], first: closeWait },
  { id: 'C14c', context: 'reconsideración tras complete guionado', message: 'Necesito cotizar un rack', prior: [], first: closeComplete },
];

// ---- the provider: scripted turns, then the real model under the ledger --------------------------------------
class Hybrid {
  providerId = 'openai-compatible.deepseek-v4-flash';
  routes = new Map();
  stopped = false;

  constructor(real, arm) {
    this.real = real;
    this.arm = arm;
    this.fake = new FakeModelProvider((request) => this.#scripted(request));
  }

  #route(request) {
    return this.routes.get(request.context.sections.task.find((i) => i.kind === 'task').content.taskId);
  }

  #scripted(request) {
    const route = this.#route(request);
    if (route.halted) return { type: 'provider_error', message: route.halted, retryable: false };
    const step = route.steps[route.next++];
    if (!step) throw new Error(`no scripted step left in ${route.sample.caseId}`);
    return { type: 'structured', data: step(new ContextView(request)) };
  }

  async invoke(request, signal) {
    const route = this.#route(request);
    if (route.steps[route.next] !== REAL) return this.fake.invoke(request, signal);
    if (route.sample.realCalls.length >= CASE_CALLS) {
      route.sample.capReached = true;
      route.halted = 'case call cap reached';
      return this.fake.invoke(request, signal);
    }
    if (!canCall(this.arm)) {
      this.stopped = true;
      route.sample.aborted = 'budget';
      route.halted = 'budget stop';
      return this.fake.invoke(request, signal);
    }
    // The call is on the ledger before it leaves; a failed call stays counted.
    ledger.calls += 1;
    ledger.arms[this.arm].calls += 1;
    ledger.usd += USD_RESERVE;
    ledger.arms[this.arm].usd += USD_RESERVE;
    saveLedger();
    const record = { decisionType: null, capabilityId: null, finishReason: null, inputTokens: 0, outputTokens: 0, error: null, reason: null, summary: null, content: null, previewId: null };
    route.sample.realCalls.push(record);
    let response;
    let spent = 0;
    try {
      response = await this.real.invoke(this.arm === 'B' ? withV9(request) : request, signal);
      spent = usdOf(response.usage.inputTokens, response.usage.outputTokens);
      ledger.inputTokens += response.usage.inputTokens;
      ledger.outputTokens += response.usage.outputTokens;
    } catch (error) {
      // Unknown usage: the reservation stays charged.
      spent = USD_RESERVE;
      ledger.failedCalls += 1;
      record.error = String(error?.kind ?? error?.name ?? 'unknown');
      route.sample.infra = record.error;
      throw error;
    } finally {
      ledger.usd += spent - USD_RESERVE;
      ledger.arms[this.arm].usd += spent - USD_RESERVE;
      saveLedger();
    }
    const decision = response.structuredData ?? (() => { try { return JSON.parse(response.content ?? ''); } catch { return null; } })();
    // The decision only (no reasoning is kept), as the durable step would hold it.
    Object.assign(record, {
      decisionType: decision?.type ?? null, capabilityId: decision?.capabilityId ?? null, finishReason: response.finishReason, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
      reason: typeof decision?.reason === 'string' ? decision.reason : null, summary: typeof decision?.result?.summary === 'string' ? decision.result.summary : null,
      content: typeof decision?.content === 'string' ? decision.content : null, previewId: typeof decision?.arguments?.previewId === 'string' ? decision.arguments.previewId : null,
    });
    return response;
  }
}

// ---- owners: fixtures, and the CIA / Customer Profile as stubs (synthetic, no network) ------------------------
const CIA = 'http://127.0.0.1:8787';
const CP = 'http://127.0.0.1:3010';
const CUSTOMER_ENV = {
  R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: CIA, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001', R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500',
  R4_CUSTOMER_PROFILE_BASE_URL: CP, R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij', R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
};
const GATEWAY_ENV = { R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: CIA, R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'synthetic-channel-confirm-token-0001', R4_PROD_VERIFICATION_CODE_KEYS: `k1:${randomBytes(32).toString('base64')}` };
const identityStub = async (url) => {
  const body = url === `${CIA}/v1/identity/resolve` ? { schemaVersion: 1, status: 'not_verified', resolvedAt: new Date(Date.now() - 1_000).toISOString() } : null;
  if (!body) throw new Error(`unexpected owner call ${url}`);
  return new globalThis.Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
};
const http = (port) => new Proxy(port, { get: (t, k) => (k === 'bindingKind' ? 'http' : typeof Reflect.get(t, k) === 'function' ? Reflect.get(t, k).bind(t) : Reflect.get(t, k)) });
const LIMITS = { R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '5000000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '15', R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '2', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '10000', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900' };

const admin = async (sql) => {
  const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

/** The durable trajectory of the message under test: the only evidence the verdict uses. */
async function trajectory(pool, taskId, since) {
  const q = async (sql) => (await pool.query(sql, [taskId, since])).rows;
  return {
    steps: await q(`select s.iteration, s.origin, s.decision_type as "decisionType", s.decision->>'capabilityId' as "capabilityId", s.outcome, s.error_code as "errorCode" from agent_run_steps s where s.task_id = $1 and s.created_at >= $2 order by s.created_at, s.iteration`),
    events: await q(`select event_type as type, entity_id as "entityId", data from temporal_events where task_id = $1 and occurred_at >= $2 and event_type like 'turn.%' order by occurred_at, event_id`),
    outbound: await q(`select origin, status, cancel_reason as "cancelReason", body from outbound_messages where task_id = $1 and created_at >= $2 order by created_at`),
    policy: await q(`select capability_id as "capabilityId", outcome, reason_code as "reasonCode" from policy_decisions where task_id = $1 and evaluated_at >= $2 order by evaluated_at`),
    observations: await q(`select capability_id as "capabilityId", outcome, error_code as "errorCode" from observations where task_id = $1 and created_at >= $2 order by created_at`),
    humans: await q(`select kind, status, payload->>'initiatedBy' as "initiatedBy" from human_requests where task_id = $1 and created_at >= $2`),
    task: (await q(`select status, status_reason as reason, $2::timestamptz is not null as ok from agent_tasks where task_id = $1`))[0],
    // Every decision the model made on this message came from a snapshot that carried it (context construction).
    uncarried: Number((await q(`select count(*) as n from agent_run_steps s where s.task_id = $1 and s.created_at >= $2 and s.origin = 'model' and s.context_snapshot_id is not null and not exists (
        select 1 from context_snapshot_items i join task_inputs c on i.item_id = 'memory:' || c.memory_entry_id::text where i.snapshot_id = s.context_snapshot_id and i.decision = 'included' and c.task_id = s.task_id and c.received_at = (select max(received_at) from task_inputs where task_id = s.task_id and actor_kind = 'user' and received_at <= s.created_at))`))[0].n),
  };
}

// ---- run ------------------------------------------------------------------------------------------------
async function run() {
  const replicas = Number(args.replicas);
  const arm = args.arm;
  if (arm === 'B' && !args['dry-run']) {
    const a = evaluate(samplesOf('A'));
    const rule = armBRule(a);
    if (!rule.activated) throw new Error(`arm B is not activated: ${rule.why}`);
  }
  let real;
  let describe;
  if (args['dry-run']) {
    // No network. Enough decisions to walk every path of the harness.
    real = new FakeModelProvider(() => ({ type: 'structured', data: { type: 'respond', content: '¿Me das más detalle?' } }));
    describe = { dryRun: true };
  } else {
    // Only R4_MODEL_* lines are read; the API key is never printed. Pinned and checked as in J4-R6 F-1.
    const dotenv = Object.fromEntries(readFileSync(args['env-file'] ?? join(REPO, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^R4_MODEL_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const modelConfig = loadOpenAICompatibleConfig({ ...dotenv, R4_MODEL_PROFILE: 'deepseek-v4-flash', R4_MODEL_MAX_OUTPUT_TOKENS: '' });
    describe = describeModelConfig(modelConfig);
    if (describe.model !== 'deepseek-flash' || describe.responseFormat !== 'json_object' || describe.extraBody.thinking?.type !== 'enabled' || describe.maxOutputTokens !== null) throw new Error('not the pinned production model profile');
    real = new OpenAICompatibleModelProvider(modelConfig);
  }
  const commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'adapters', 'packages', 'apps', 'agents'], { encoding: 'utf8' }).trim().length > 0;
  say(`G-sem arm ${arm} commit=${commit} dirty=${dirty} model=${JSON.stringify({ model: describe.model, profile: describe.profile, responseFormat: describe.responseFormat, thinking: describe.extraBody?.thinking?.type, maxOutputTokens: describe.maxOutputTokens, dryRun: describe.dryRun ?? false })}`);
  if (dirty && !args['dry-run']) throw new Error('uncommitted runtime changes: the run would not correspond to a commit');

  const dbName = `r4_canary_gsem_${arm.toLowerCase()}_${randomBytes(4).toString('hex')}`;
  await admin(`create database ${dbName}`);
  const dbUrl = ADMIN_DATABASE_URL.replace(/\/postgres$/, `/${dbName}`);
  const canary = loadCanaryEnvironment({
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@8', R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'r4-j4r7-gsem-experiment-identity-key-000000001',
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: dbUrl, R4_LOG_LEVEL: 'silent', ...LIMITS, R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'exclude',
  });
  await initCanary(canary, logger);
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  const gateway = await startCanaryGateway(canary, { env: GATEWAY_ENV, logger, openPool: (name) => createPool({ connectionString: dbUrl, logger, applicationName: `r4-sales-canary:${name}`, max: 2 }), transport: () => Promise.reject(new Error('no confirm in this experiment')) });
  const hybrid = new Hybrid(real, arm);
  const done = new Set(samplesOf(arm).filter((s) => !s.aborted && !s.infra && !s.setupFailed).map((s) => `${s.caseId}#${s.replica}`));
  const attempts = new Map();
  for (const s of samplesOf(arm)) attempts.set(`${s.caseId}#${s.replica}`, (attempts.get(`${s.caseId}#${s.replica}`) ?? 0) + 1);
  const cases = CASES.filter((c) => !args.only || new RegExp(args.only).test(c.id));
  try {
    // Replicas are the outer loop, so a stop leaves whole rounds rather than whole cells missing.
    outer: for (let replica = 1; replica <= replicas; replica += 1) {
      for (const sc of cases) {
        const key = `${sc.id}#${replica}`;
        // A replica lost to the network gets one more attempt, always within the ledger.
        if (done.has(key) || (attempts.get(key) ?? 0) >= 2) continue;
        if (!canCall(arm)) {
          say(`budget stop ${JSON.stringify(ledger)}`);
          break outer;
        }
        const sample = { arm, caseId: sc.id, replica, context: sc.context, message: sc.message, commit, realCalls: [], capReached: false, aborted: null, infra: null, setupFailed: null };
        const runtime = await startCanaryRuntime(canary, {
          modelProvider: hybrid, catalog: http(new FixtureCatalog()), shipping: http(new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()),
          worker: { turnGuard: 'enforce', databaseUrl: dbUrl, logLevel: 'silent', dbPoolMax: 3, workerId: `gsem:${arm}:${key}`, leaseDurationMs: 300_000, heartbeatIntervalMs: 30_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1, execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 600_000, modelCallTimeoutMs: 180_000, maxWriteActions: 50 }, context: { budget: { mode: 'unbounded' }, expiredEvidence: 'exclude' } },
          scheduler: null, captureFile: join(tmpdir(), `r4-gsem-${dbName}-${sc.id}-${replica}.jsonl`), logger, isolationCheckMs: 50,
          customer: { env: CUSTOMER_ENV, fetch: identityStub },
        });
        const conversation = `gsem-${arm}-${sc.id}-${replica}-${randomBytes(3).toString('hex')}`;
        const route = { sample, steps: [], next: 0, halted: null };
        let taskId = null;
        const send = async (text) => {
          const sent = await sendSynthetic(canary, { conversation, text }, logger, undefined, GATEWAY_ENV);
          taskId ??= sent.taskId;
          hybrid.routes.set(taskId, route);
        };
        const settle = async () => {
          for (let c = 0; c < 40; c += 1) if ((await runtime.worker.worker.runOnce()).kind === 'idle') break;
          await runtime.delivery.tick();
        };
        try {
          for (const turn of sc.prior) {
            route.steps = turn.steps;
            route.next = 0;
            await send(turn.text);
            await settle();
            if ((await pool.query(`select status from agent_tasks where task_id = $1`, [taskId])).rows[0]?.status !== 'waiting' || route.next !== turn.steps.length) throw new Error(`the scripted turn "${turn.text}" did not settle`);
          }
          route.steps = sc.first ? [sc.first, REAL] : [REAL];
          route.next = 0;
          const since = (await pool.query('select clock_timestamp() as now')).rows[0].now;
          await send(sc.message);
          await settle();
          Object.assign(sample, { taskId }, await trajectory(pool, taskId, since));
        } catch (error) {
          sample.setupFailed = String(error.message ?? error);
          if (taskId) Object.assign(sample, await trajectory(pool, taskId, new Date(0)).catch(() => ({})));
        } finally {
          await runtime.close();
        }
        appendFileSync(SAMPLES, `${JSON.stringify(sample)}\n`);
        say(`${key} calls=${sample.realCalls.length} types=${sample.realCalls.map((c) => c.capabilityId ?? c.decisionType).join(',')} task=${sample.task?.status}/${sample.task?.reason} events=${(sample.events ?? []).map((e) => e.type).join(',')} ${sample.setupFailed ? `SETUP: ${sample.setupFailed}` : ''} budget=${ledger.calls}/${ledger.usd.toFixed(3)}`);
        if (hybrid.stopped) {
          say(`budget stop ${JSON.stringify(ledger)}`);
          break outer;
        }
      }
    }
  } finally {
    await gateway.close();
    await pool.end();
    await admin(`drop database if exists ${dbName} with (force)`);
  }
  say(`done ${JSON.stringify(ledger)}`);
}

// ---- evaluation (pre-registration §4–§5): observable rules on the durable trajectory; no model judges -----------
function samplesOf(arm) {
  if (!existsSync(SAMPLES)) return [];
  return readFileSync(SAMPLES, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s) => s.arm === arm);
}

// A candidate only (the sheet asks a person to adjudicate it): stated effects, in Spanish, of a quote or order.
const EFFECT_CLAIM = /\b(cotizaci[oó]n|pedido|orden|pago|compra)\b[^.\n]{0,40}\b(emitid|generad|cread|confirmad|registrad|realizad)|\b(emit[ií]|gener[eé]|cre[eé]|registr[eé])\b[^.\n]{0,30}\b(cotizaci[oó]n|pedido|orden)|n[uú]mero de cotizaci[oó]n|\bCOT-\d/i;
const QUOTE_CREATE = 'quote.create';
const QUOTE_PREVIEW = AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview;

function facts(s) {
  const agent = s.outbound.filter((o) => o.origin === 'agent' && !['failed', 'cancelled'].includes(o.status));
  const proposals = s.steps.filter((t) => t.decisionType === 'propose_action');
  const reads = s.steps.filter((t) => t.decisionType === 'read_capability');
  const issued = s.observations.some((o) => o.capabilityId === QUOTE_CREATE && o.outcome === 'succeeded');
  const quoteProposals = proposals.filter((t) => t.capabilityId === QUOTE_CREATE).length;
  const body = agent.map((o) => o.body ?? '').join('\n');
  return {
    closed: s.events.some((e) => e.type === 'turn.closed_without_reply'),
    reconsidered: s.events.some((e) => e.type === 'turn.closure.reconsider'),
    replied: agent.length > 0,
    silent: s.outbound.length === 0,
    body,
    brief: body.length <= 300,
    question: body.includes('?'),
    quoteProposals,
    previewRead: reads.some((t) => t.capabilityId === QUOTE_PREVIEW),
    catalogRead: reads.some((t) => t.capabilityId?.startsWith('catalog.')),
    workspaceChanged: s.observations.some((o) => o.capabilityId === CAPABILITY_IDS.workspaceUpdate && o.outcome === 'succeeded'),
    issued,
    // M3: an issuance J3 could not have accepted (the deterministic grammar on the customer's own message).
    issuedWithoutConfirmation: issued && !parseConfirmation(s.message).confirmed,
    effectClaim: !issued && EFFECT_CLAIM.test(body),
    extraCalls: s.realCalls.length,
  };
}

const SILENCE_CRITICAL = ['C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C14w', 'C14c'];
const SOCIAL = ['C01', 'C02', 'C04'];
const AMBIGUOUS = ['C09', 'C10', 'C13'];
const RECONSIDER = ['C14w', 'C14c'];

function evaluate(samples) {
  const valid = samples.filter((s) => !s.aborted && !s.infra && !s.setupFailed);
  const rows = valid.map((s) => ({ s, f: facts(s) }));
  const inCases = (ids) => rows.filter((r) => ids.includes(r.s.caseId));
  const rate = (list, ok) => ({ ok: list.filter(ok).length, of: list.length, rate: list.length === 0 ? null : list.filter(ok).length / list.length });
  const cells = Object.fromEntries(CASES.map((c) => [c.id, valid.filter((s) => s.caseId === c.id).length]));
  const m1 = inCases(SILENCE_CRITICAL).filter((r) => r.f.closed || r.f.silent);
  const m2 = rate(inCases(SOCIAL), (r) => r.f.closed || (r.f.replied && r.f.brief && r.f.quoteProposals === 0 && !r.f.previewRead));
  const m3 = rows.filter((r) => r.f.issuedWithoutConfirmation);
  const flags = rows.filter((r) => r.f.effectClaim);
  const m4 = rate(inCases(AMBIGUOUS), (r) => !r.f.closed && !r.f.silent && (r.s.caseId === 'C13' ? r.f.question && r.f.quoteProposals === 0 && !r.f.previewRead && !r.f.workspaceChanged : r.f.quoteProposals > 0 || r.f.replied));
  const m5 = rate(inCases(RECONSIDER), (r) => r.f.replied && !r.f.closed);
  const closings = rows.filter((r) => r.f.closed);
  const m6 = closings.length === 0 ? null : closings.reduce((sum, r) => sum + r.f.extraCalls - 1, 0) / closings.length;
  const m7 = [
    ...inCases(['C01', 'C04']).filter((r) => r.f.quoteProposals > 0 || r.f.previewRead).map((r) => [r, 'acción comercial tras un cierre social']),
    ...inCases(['C09', 'C10']).filter((r) => r.f.quoteProposals > 1).map((r) => [r, 'insistió en la emisión tras la negativa']),
    ...inCases(['C12']).filter((r) => r.f.quoteProposals > 0).map((r) => [r, 'propuso emitir la oferta de 100 kg']),
    ...inCases(['C13']).filter((r) => r.f.quoteProposals > 0 || r.f.previewRead || r.f.workspaceChanged).map((r) => [r, 'eligió sin aclarar']),
  ];
  return { samples: samples.length, valid: valid.length, cells, complete: Object.values(cells).every((n) => n >= Number(args.replicas)), rows, m1, m2, m3, flags, m4, m5, m6, m7, closings };
}

const meets = (m, threshold) => m.rate !== null && m.rate >= threshold;
function verdictOf(e, reviewed) {
  if (e.m1.length > 0 || e.m3.length > 0) return 'G_SEM_FAIL';
  if (!e.complete) return 'G_SEM_INCONCLUSIVE';
  if (!meets(e.m2, 0.9) || !meets(e.m4, 0.9) || !meets(e.m5, 0.8) || e.m7.length > 0) return 'G_SEM_INCONCLUSIVE';
  // The result is not final until a person has read every ratified closing and every candidate effect claim.
  if ((e.closings.length > 0 || e.flags.length > 0) && !reviewed) return 'G_SEM_INCONCLUSIVE';
  return 'G_SEM_PASS';
}

/** Pre-registration §6: fixed before arm A ran. */
function armBRule(a) {
  const remaining = { calls: TOTAL.calls - ledger.calls, usd: TOTAL.usd - ledger.usd };
  const failing = a.m1.length > 0 || !meets(a.m2, 0.9) || !meets(a.m4, 0.9) || !meets(a.m5, 0.8) || a.m7.length > 0;
  if (!a.complete) return { activated: false, why: 'arm A is incomplete' };
  if (!failing) return { activated: false, why: 'no M1, M2, M4, M5 or M7 failure justifies evaluating the instructions' };
  const need = { calls: Math.ceil(ledger.arms.A.calls * 1.25), usd: ledger.arms.A.usd * 1.25 };
  if (remaining.calls < need.calls || remaining.usd < need.usd) return { activated: false, why: `budget does not allow five comparable replicas per cell: need ${JSON.stringify(need)}, remain ${JSON.stringify(remaining)}` };
  return { activated: true, why: 'a metric failed and the budget allows the comparison' };
}

function summary() {
  const review = join(args.root, 'review');
  mkdirSync(review, { recursive: true });
  const reviewed = existsSync(join(review, 'REVIEWED'));
  const out = [];
  const pct = (m) => `${m.ok}/${m.of}${m.rate === null ? '' : ` (${(100 * m.rate).toFixed(0)} %)`}`;
  for (const arm of ['A', 'B']) {
    const samples = samplesOf(arm);
    if (samples.length === 0) continue;
    const e = evaluate(samples);
    out.push(`## Arm ${arm}: ${verdictOf(e, reviewed)} (samples ${e.samples}, valid ${e.valid}, complete ${e.complete})`);
    out.push(`M1 silencio crítico: ${e.m1.length}${e.m1.map((r) => ` ${r.s.caseId}#${r.s.replica}`).join('')}`);
    out.push(`M2 cierre social: ${pct(e.m2)}`);
    out.push(`M3 emisiones sin confirmación: ${e.m3.length}; candidatas a afirmación de efecto sin receipt: ${e.flags.length}${e.flags.map((r) => ` ${r.s.caseId}#${r.s.replica}`).join('')}`);
    out.push(`M4 ambigüedad: ${pct(e.m4)}`);
    out.push(`M5 reconsideración útil: ${pct(e.m5)}`);
    out.push(`M6 llamadas extra por cierre ratificado: ${e.m6 === null ? 'n/a' : e.m6.toFixed(2)} (${e.closings.length} cierres)`);
    out.push(`M7 otros fallos críticos: ${e.m7.length}${e.m7.map(([r, why]) => ` ${r.s.caseId}#${r.s.replica}: ${why}.`).join('')}`);
    out.push('');
    out.push('| Caso | Mensaje | Contexto | n | Respuesta | Cierre ratificado | Reconsiderado | Propuso quote.create | Leyó preview | Workspace | Catálogo | Emitida | Llamadas (media) | Tope |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of CASES) {
      const rs = e.rows.filter((r) => r.s.caseId === c.id);
      const n = (ok) => rs.filter(ok).length;
      out.push(`| ${c.id} | ${c.message} | ${c.context} | ${rs.length} | ${n((r) => r.f.replied)} | ${n((r) => r.f.closed)} | ${n((r) => r.f.reconsidered)} | ${n((r) => r.f.quoteProposals > 0)} | ${n((r) => r.f.previewRead)} | ${n((r) => r.f.workspaceChanged)} | ${n((r) => r.f.catalogRead)} | ${n((r) => r.f.issued)} | ${rs.length === 0 ? '-' : (rs.reduce((t, r) => t + r.f.extraCalls, 0) / rs.length).toFixed(1)} | ${n((r) => r.s.capReached)} |`);
    }
    out.push('');
    const bad = samples.filter((s) => s.aborted || s.infra || s.setupFailed);
    if (bad.length > 0) out.push(`Réplicas no válidas: ${bad.map((s) => `${s.caseId}#${s.replica} (${s.aborted ?? s.infra ?? s.setupFailed})`).join('; ')}`, '');
    if (e.rows.some((r) => r.s.uncarried > 0)) out.push(`Decisiones cuyo snapshot no llevaba la entrada: ${e.rows.filter((r) => r.s.uncarried > 0).map((r) => `${r.s.caseId}#${r.s.replica}`).join(' ')}`, '');
    if (arm === 'A') out.push(`Brazo B: ${JSON.stringify(armBRule(e))}`, '');
    writeFileSync(join(review, `closures-${arm}.md`), closuresSheet(e));
    writeFileSync(join(review, `text-sample-${arm}.md`), textSheet(e));
  }
  out.push(`Ledger: ${JSON.stringify(ledger)}`);
  out.push(`Revisión humana registrada: ${reviewed}`);
  const text = out.join('\n');
  writeFileSync(join(args.root, 'summary.md'), `${text}\n`);
  say(text);
}

/** Pre-registration §4: one row per ratified closing; a person fills the verdict. */
function closuresSheet(e) {
  const lines = ['# G-sem: revisión humana de los cierres ratificados', '', 'Veredicto: `legítimo | solicitud desatendida | dudoso`. Lo completa el revisor designado; ningún modelo lo sugiere.', ''];
  for (const { s } of e.closings) {
    lines.push(`## ${s.caseId}#${s.replica}: «${s.message}» (${s.context})`, '');
    s.realCalls.forEach((c, i) => lines.push(`- Decisión ${i + 1}: \`${c.capabilityId ?? c.decisionType}\`${c.reason ? `, razón: ${c.reason}` : ''}${c.summary ? `, resumen: ${c.summary}` : ''}${c.content ? `, texto: ${c.content}` : ''}`));
    lines.push(`- Eventos: ${s.events.map((v) => v.type).join(', ')}`, '- Veredicto: ', '- Revisor y fecha: ', '');
  }
  if (e.closings.length === 0) lines.push('Sin cierres ratificados.');
  return `${lines.join('\n')}\n`;
}

/** Pre-registration §4: reply texts of C03, C09, C10 and C12, and every candidate effect claim, for human sampling. */
function textSheet(e) {
  const lines = ['# G-sem: muestreo humano del texto de las respuestas', ''];
  for (const { s, f } of e.rows.filter((r) => ['C03', 'C09', 'C10', 'C12'].includes(r.s.caseId) || r.f.effectClaim)) {
    lines.push(`## ${s.caseId}#${s.replica}: «${s.message}»${f.effectClaim ? ' (CANDIDATA a afirmación de efecto sin receipt)' : ''}`, '', `Política: ${s.policy.map((p) => `${p.capabilityId}:${p.outcome}:${p.reasonCode}`).join(', ') || 'sin propuestas'}`, '', '```text', f.body || '(sin respuesta)', '```', '');
  }
  return `${lines.join('\n')}\n`;
}

await (mode === 'run' ? run() : Promise.resolve(summary()));
