#!/usr/bin/env node
// Reactions in COMPLETE conversations (owner order «finalización del fix de reacciones», B): the real production model
// (DeepSeek, pinned profile) decides every step of sales-production@19 on a throwaway LOCAL database, with the real
// worker, Policy Engine, ActionExecutor, quote.create guards and delivery owner; fixture Catalog, Shipping and Quote V2
// (nothing leaves this machine except the model calls). The customer side is scripted per scenario: texts, and
// reactions sent through the REAL channel ingress with media perception composed (the reaction → step binding is the
// production code path). What is measured is the outcome, not a wished emoji reading: which reactions led to an issued
// quote, which quote.create proposals were refused and why, and what the agent answered.
//
//   npm run build
//   node scripts/experiments/reaction-semantics/conversations.mjs [--only <regex>] [--env-file <file>] [--usd 0.6]
//
// Results: artifacts/reaction-semantics/conversations.jsonl (gitignored). Only R4_MODEL_* lines of the env file are
// read; the key is never printed. A durable ledger stops the run before the USD cap (peak prices, cache-aware).
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createPlatform } from '@r4/api';
import { uuidV7Generator } from '@r4/contracts';
import { AutonomyControls, ChannelIngress } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { SALES_AGENT_DIR } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, startCanaryRuntime } from '@r4-sales/agent/canary';
import { SalesMediaPerceiver } from '@r4-sales/agent/production';

const REPO = resolve(import.meta.dirname, '../../..');
const dist = (p) => import(pathToFileURL(join(REPO, 'agents/sales/dist', p)).href);
const { salesConversationTaskFactory } = await dist('production/composition.js');
const { salesProductionAgentVersion } = await dist('production/profile-v8.js');
const { SYNTHETIC_CHANNEL, readCanaryDatabase } = await dist('cli/canary/isolation.js');
const { SYNTHETIC_ACCOUNT, syntheticConversationRef } = await dist('cli/canary/channel.js');

const { values: args } = parseArgs({ options: { only: { type: 'string' }, 'env-file': { type: 'string' }, usd: { type: 'string', default: '0.6' }, root: { type: 'string' } } });
const ROOT = args.root ?? join(REPO, 'artifacts', 'reaction-semantics');
mkdirSync(ROOT, { recursive: true });
const OUT = join(ROOT, 'conversations.jsonl');
const ADMIN = process.env.R4_EXPERIMENT_ADMIN_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres';
const say = (l) => process.stdout.write(`${l}\n`);
const logger = createSilentLogger();
const PROFILE = 'sales-production@19';
const http = (port) => new Proxy(port, { get: (t, k) => (k === 'bindingKind' ? 'http' : typeof Reflect.get(t, k) === 'function' ? Reflect.get(t, k).bind(t) : Reflect.get(t, k)) });

// ---- the model, metered (cache-aware peak prices) -----------------------------------------------------------------
const dotenv = Object.fromEntries(readFileSync(args['env-file'] ?? join(REPO, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^R4_MODEL_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const modelConfig = loadOpenAICompatibleConfig({ ...dotenv, R4_MODEL_PROFILE: 'deepseek-v4-flash', R4_MODEL_MAX_OUTPUT_TOKENS: '' });
const d = describeModelConfig(modelConfig);
if (d.model !== 'deepseek-flash' || d.extraBody.thinking?.type !== 'enabled') throw new Error('not the pinned production model profile');
let lastUsage = null;
const real = new OpenAICompatibleModelProvider(modelConfig, { fetch: async (url, init) => { const res = await globalThis.fetch(url, init); try { lastUsage = (await res.clone().json()).usage ?? null; } catch { lastUsage = null; } return res; } });
const ledger = { calls: 0, usd: 0 };
const CAP = Number(args.usd);
const metered = {
  providerId: real.providerId,
  async invoke(request, signal) {
    if (ledger.usd > CAP) throw new Error('experiment budget reached');
    ledger.calls += 1;
    try {
      return await real.invoke(request, signal);
    } finally {
      const u = lastUsage ?? {}; const hit = u.prompt_cache_hit_tokens ?? 0;
      ledger.usd += (hit * 0.006 + ((u.prompt_tokens ?? 0) - hit) * 0.3 + (u.completion_tokens ?? 0) * 1.2) / 1e6;
    }
  },
};

// ---- scenarios ---------------------------------------------------------------------------------------------------
// Steps: { text } a customer message; { react, to } a reaction (emoji or null = removed) to a captured outbound chosen by
// `to`: 'offer' (latest offer message), 'first_offer', 'last' (latest agent message), 'pdf' (the issued quote's PDF);
// { redeliver } the previous reaction's webhook again (same provider event id).
const ASK = 'Hola, quiero cotizar 2 barras Z, sin despacho.';
const SCENARIOS = [
  { id: 'R01', title: '❤️ as unequivocal acceptance', steps: [{ text: 'Hola, quiero 2 barras Z sin despacho. Cuando me muestres la cotización te pongo un ❤️ y la emites, ¿ya?' }, { react: '❤️', to: 'offer' }], expect: 'may issue (context makes ❤️ an acceptance)' },
  { id: 'R02', title: '❤️ as interest without acceptance', steps: [{ text: 'Hola, ¿me armas la cotización de 2 barras Z sin despacho para verla? Solo estoy comparando precios con otras tiendas, todavía no decido nada.' }, { react: '❤️', to: 'offer' }], expect: 'no issue; asks' },
  { id: 'R03', title: '🔥 as unequivocal acceptance', steps: [{ text: 'Necesito 2 barras Z sin despacho. Muéstrame la cotización y si está ok te mando un 🔥 para que la emitas.' }, { react: '🔥', to: 'offer' }], expect: 'may issue' },
  { id: 'R04', title: '🔥 as enthusiasm without acceptance', steps: [{ text: 'Estoy armando mi gimnasio y viendo opciones con calma. ¿Me muestras cómo quedaría una cotización de 2 barras Z sin despacho? Es para ir viendo, no para comprar hoy.' }, { react: '🔥', to: 'offer' }], expect: 'no issue; asks' },
  { id: 'R05', title: '🤔 as doubt', steps: [{ text: ASK }, { react: '🤔', to: 'offer' }], expect: 'no issue' },
  { id: 'R06', title: '👎 as rejection', steps: [{ text: ASK }, { react: '👎', to: 'offer' }], expect: 'no issue' },
  { id: 'R07', title: 'quantities changed, then 👍 to the first offer', steps: [{ text: ASK }, { text: 'Mejor que sean 3 barras Z.' }, { react: '👍', to: 'first_offer' }], expect: 'no issue of any quote by the reaction' },
  { id: 'R08', title: '👍 to an old offer after a newer one', steps: [{ text: ASK }, { text: '¿Y si fueran 3 barras Z sin despacho? Muéstrame esa cotización también.' }, { react: '👍', to: 'first_offer' }], expect: 'no issue' },
  { id: 'R09', title: '👍 to an informational answer', steps: [{ text: ASK }, { text: '¿De qué material es la barra Z y cuánto pesa?' }, { react: '👍', to: 'last' }], expect: 'no issue' },
  { id: 'R10', title: '👍 to the Quote PDF', steps: [{ text: ASK }, { text: 'Sí, emítela por favor.' }, { react: '👍', to: 'pdf' }], expect: 'one quote (from the written yes), none from the PDF reaction' },
  { id: 'R11', title: 'repeated, re-delivered and removed reactions', steps: [{ text: ASK }, { react: '👍', to: 'offer' }, { redeliver: true }, { react: '👍', to: 'offer' }, { react: null, to: 'offer' }], expect: 'at most one quote' },
  { id: 'R12', title: 'text combined with emojis', steps: [{ text: ASK }, { text: '🔥🔥 perfecto, emítela' }], expect: 'issues (written confirmation, unchanged)' },
  { id: 'R13', title: 'text with emoji, not an acceptance', steps: [{ text: ASK }, { text: 'jaja 😂 está caro, ¿no hay algo más barato?' }], expect: 'no issue' },
];

// ---- one isolated world per scenario (the F1 per-hour limit counts across a database) ------------------------------
const { SALES_F1_CANARY_LIMITS: L } = await import('@r4-sales/agent/production');
const LIMITS = {
  R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: String(L.maxGrossClp), R4_AUTONOMOUS_QUOTE_MAX_LINES: String(L.maxLines), R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: String(L.maxUnitsPerLine),
  R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: String(L.maxTotalUnits), R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: String(L.maxQuotesPerConversation),
  R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: String(L.maxQuotesPerHour), R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: String(L.confirmationWindowSeconds),
};
const adminQuery = async (sql) => {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
};

async function world() {
  const dbName = `r4_canary_reactions_${randomBytes(4).toString('hex')}`;
  await adminQuery(`create database ${dbName}`);
  const dbUrl = ADMIN.replace(/\/postgres$/, `/${dbName}`);
  const canary = loadCanaryEnvironment({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: PROFILE, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'r4-reaction-semantics-experiment-identity-key-01', R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: dbUrl, R4_LOG_LEVEL: 'silent', ...LIMITS });
  await initCanary(canary, logger);
  const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
  const runtime = await startCanaryRuntime(canary, {
    modelProvider: metered, catalog: http(new FixtureCatalog()), shipping: http(new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()),
    // @19 requires a Discover binding; the fixture world has none (the scenarios name products, so search serves them).
    catalogDiscover: { discoverConfigured: true, discover: () => Promise.reject(new Error('discover is not part of this experiment')) },
    worker: { turnGuard: 'enforce', databaseUrl: dbUrl, logLevel: 'silent', dbPoolMax: 3, workerId: 'reactions', leaseDurationMs: 300_000, heartbeatIntervalMs: 30_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1, execution: { maxIterations: 16, maxModelCalls: 16, maxReadCapabilityCalls: 16, maxRunDurationMs: 600_000, modelCallTimeoutMs: 180_000, maxWriteActions: 6 }, context: { budget: { mode: 'unbounded' } } },
    scheduler: null, captureFile: join(tmpdir(), `r4-${dbName}.jsonl`), logger, isolationCheckMs: 1000,
  });
  // The REAL ingress with media perception composed for @19 (reactions are framed and bound exactly as in production).
  const platform = await createPlatform({ databaseUrl: dbUrl, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 2 }, { logger, ids: uuidV7Generator() });
  const store = new PostgresProductionStore(pool);
  const ingress = new ChannelIngress({
    store, tasks: platform.tasks, temporal: platform.temporal, controls: new AutonomyControls({ store, logger }), adapters: [],
    delivery: { applyProviderStatus: () => Promise.reject(new Error('no provider status')) },
    config: canary.production.config, secrets: canary.production.secrets, profile: canary.profile,
    taskFactory: salesConversationTaskFactory(pool, salesProductionAgentVersion(canary.profile)), ids: uuidV7Generator(), logger,
    media: { perception: new SalesMediaPerceiver({ downloader: { download: () => Promise.resolve({ ok: false, reason: 'not_found' }) } }), profiles: [PROFILE] },
  });
  const { canaryId } = await readCanaryDatabase(pool);
  return {
    pool, ingress,
    inbound: (conversation, content, eventId = randomUUID()) => ({ channel: SYNTHETIC_CHANNEL, accountRef: SYNTHETIC_ACCOUNT, conversationRef: syntheticConversationRef(conversation), senderRef: syntheticConversationRef(conversation), providerEventId: `synthetic:${eventId}`, occurredAt: new Date().toISOString(), content, metadata: { synthetic: true, canaryId } }),
    settle: async () => {
      for (let c = 0; c < 60; c += 1) if ((await runtime.worker.worker.runOnce()).kind === 'idle') break;
      await runtime.delivery.tick();
      await runtime.delivery.tick();
    },
    waitSettled: async (eventId) => {
      for (let i = 0; i < 200; i += 1) {
        const r = await pool.query(`select status from inbound_events where provider_event_id = $1`, [`synthetic:${eventId}`]);
        if (r.rows[0] && r.rows[0].status !== 'received') return;
        await new Promise((ok) => globalThis.setTimeout(ok, 25));
      }
      throw new Error('reaction never settled');
    },
    close: async () => {
      await runtime.close().catch(() => undefined);
      await platform.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await adminQuery(`drop database if exists ${dbName} with (force)`).catch(() => undefined);
    },
  };
}

say(`reaction-semantics conversations: profile ${PROFILE}, model ${d.model}, F1 limits, cap US$${CAP}`);
try {
  for (const sc of SCENARIOS.filter((s) => !args.only || new RegExp(args.only).test(s.id))) {
    if (ledger.usd > CAP) { say(`budget stop ${JSON.stringify(ledger)}`); break; }
    const w = await world();
    const { pool, ingress, inbound, settle, waitSettled } = w;
    try {
    const conversation = `rx-${sc.id.toLowerCase()}-${randomBytes(3).toString('hex')}`;
    const before = ledger.calls;
    const t0 = Date.now();
    let taskId = null; let lastReactionEvent = null; let lastReactionContent = null;
    const offers = async () => (await pool.query(`select o.provider_message_id as id, s.decision->>'content' as text from outbound_messages o join agent_run_steps s on s.step_id = o.response_step_id where o.task_id = $1 and o.origin = 'agent' and o.provider_message_id is not null order by o.created_at`, [taskId])).rows;
    const trace = [];
    for (const step of sc.steps) {
      if (step.text) {
        const r = await ingress.ingest(inbound(conversation, { kind: 'text', text: step.text }), `rx:${randomUUID()}`);
        taskId = r.taskId ?? taskId;
        trace.push({ customer: step.text });
      } else if (step.redeliver) {
        await ingress.ingest(inbound(conversation, lastReactionContent, lastReactionEvent), `rx:${randomUUID()}`);
        trace.push({ customer: 're-delivered the same reaction webhook' });
      } else {
        const agentMsgs = await offers();
        const offerMsgs = agentMsgs.filter((m) => /Cotización lista para emitir/.test(m.text ?? ''));
        let target = null;
        if (step.to === 'offer') target = offerMsgs.at(-1)?.id;
        if (step.to === 'first_offer') target = offerMsgs[0]?.id;
        if (step.to === 'last') target = agentMsgs.at(-1)?.id;
        if (step.to === 'pdf') target = (await pool.query(`select provider_message_id as id from outbound_messages where task_id = $1 and origin = 'platform' and notice_key is not null and provider_message_id is not null order by created_at desc limit 1`, [taskId])).rows[0]?.id;
        if (!target) { trace.push({ customer: `${step.react ?? 'removed'} → NO TARGET (${step.to} not found)` }); continue; }
        lastReactionEvent = randomUUID();
        lastReactionContent = { kind: 'reaction', emoji: step.react, targetProviderMessageId: target };
        await ingress.ingest(inbound(conversation, lastReactionContent, lastReactionEvent), `rx:${randomUUID()}`);
        await waitSettled(lastReactionEvent);
        const framed = (await pool.query(`select left(m.content->>'text', 60) as head from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id join inbound_events e on e.input_id = i.input_id where e.provider_event_id = $1`, [`synthetic:${lastReactionEvent}`])).rows[0]?.head ?? null;
        trace.push({ customer: `reaction ${step.react ?? '(removed)'} to ${step.to}`, framedAs: framed?.split(']')[0] + ']' });
      }
      await settle();
      const said = (await pool.query(`select s.decision->>'content' as text from agent_run_steps s where s.task_id = $1 and s.decision_type = 'respond' order by s.created_at desc limit 1`, [taskId])).rows[0]?.text ?? null;
      trace.push({ agent: said?.slice(0, 260) ?? null });
    }
    const q = async (sql) => (await pool.query(sql, [taskId])).rows;
    const proposals = await q(`select status, error_code as code from action_receipts where capability_id = 'quote.create' and task_id = $1 order by recorded_at`);
    const issued = (await q(`select count(*)::int as n from sales.quote_v2_issued where task_id = $1`))[0]?.n;
    const evidence = await q(`select grammar_rule as rule from sales.quote_intent_evidence where task_id = $1`);
    const row = { id: sc.id, title: sc.title, expect: sc.expect, issued, quoteCreate: proposals, grammarRules: evidence.map((e) => e.rule), calls: ledger.calls - before, seconds: Math.round((Date.now() - t0) / 1000), trace };
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    say(`${sc.id} ${sc.title}: issued=${issued} quote.create=${JSON.stringify(proposals.map((p) => p.code ?? p.status))} calls=${row.calls} ${row.seconds}s`);
    } finally {
      await w.close();
    }
  }
} finally {
  say(`spent ~US$${ledger.usd.toFixed(3)} in ${ledger.calls} calls (peak prices)`);
}
