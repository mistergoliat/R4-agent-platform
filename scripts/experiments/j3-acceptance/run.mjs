#!/usr/bin/env node
// R4-J3 final acceptance, local evidence (docs/acceptance/R4_J3_FINAL_ACCEPTANCE.md §5): the REAL canary runtime
// of sales-production@7 on a throwaway LOCAL database, fixture owners (fixture Quote V2, never the real service),
// synthetic customer turns, and the REAL model for EVERY agent decision. Nothing is scripted on the agent side; the
// customer side is a small rule-based responder that reads only the messages the agent delivered.
//
//   npm run build
//   node scripts/experiments/j3-acceptance/run.mjs
//   node scripts/experiments/j3-acceptance/run.mjs --scenarios multiproduct --max-calls 60
//
// Hard stops: the ledger <root>/budget.json (160 calls / US$3) and --max-calls.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { FIXTURE_PRODUCTS, FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { profileFingerprint, profileLabel } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryRuntime } from '@r4-sales/agent/canary';
import { SALES_PRODUCTION_PROFILES, salesProductionAgentVersion } from '@r4-sales/agent/production';

const REPO = resolve(import.meta.dirname, '../../..');
const PROFILE = 'sales-production@7';
const { values: args } = parseArgs({
  options: {
    scenarios: { type: 'string', default: 'multiproduct,price-change,catalog-down,shipping-down,quote-down,unknown-commune' },
    'max-calls': { type: 'string' },
    root: { type: 'string' },
  },
});
const ROOT = args.root ?? join(REPO, 'artifacts', 'j3-acceptance');
mkdirSync(ROOT, { recursive: true });
const CALLS = join(ROOT, 'calls.jsonl');
const LEDGER = join(ROOT, 'budget.json');
const MAX_CALLS = 160;
const MAX_USD = 3;
// EXTERNAL (api-docs.deepseek.com, 2026-10): peak prices per 1M tokens, every input token billed as a cache miss (upper bound).
const USD_PER_M_INPUT = 0.3;
const USD_PER_M_OUTPUT = 1.2;
const ADMIN_DATABASE_URL = process.env.R4_EXPERIMENT_ADMIN_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres'; // docker-compose.yml
const logger = createSilentLogger();
const sha = (t) => createHash('sha256').update(t).digest('hex');
const say = (line) => process.stdout.write(`${line}\n`);

// ---- model: the production profile pinned by tests/unit/sales/openai-compatible-provider.test.ts -------------
// Only R4_MODEL_* lines of the local .env are read (endpoint and key); nothing of them is written anywhere.
const dotenv = Object.fromEntries(readFileSync(join(REPO, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^R4_MODEL_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const modelConfig = loadOpenAICompatibleConfig({ ...dotenv, R4_MODEL_PROFILE: 'deepseek-v4-flash', R4_MODEL_MAX_OUTPUT_TOKENS: '' });
const real = new OpenAICompatibleModelProvider(modelConfig);
const config = describeModelConfig(modelConfig);
if (config.model !== 'deepseek-flash' || config.responseFormat !== 'json_object' || config.extraBody.thinking?.type !== 'enabled' || config.maxOutputTokens !== null) throw new Error('not the pinned production model profile');

const budget = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
const callCap = Math.min(MAX_CALLS, args['max-calls'] === undefined ? MAX_CALLS : budget.calls + Number(args['max-calls']));

/** Every agent decision goes to the real model; each call is recorded (the decision only: no reasoning text is kept). */
class Recorded {
  providerId = real.providerId;
  scenario = null;
  turn = 0;

  async invoke(request, signal) {
    if (budget.calls + 1 > callCap || budget.usd >= MAX_USD) throw new Error('budget exhausted');
    const started = performance.now();
    let response;
    let error = null;
    try {
      response = await real.invoke(request, signal);
    } catch (e) {
      error = e;
    }
    budget.calls += 1;
    if (response) {
      budget.inputTokens += response.usage.inputTokens;
      budget.outputTokens += response.usage.outputTokens;
      budget.usd = (budget.inputTokens * USD_PER_M_INPUT + budget.outputTokens * USD_PER_M_OUTPUT) / 1e6;
    }
    writeFileSync(LEDGER, JSON.stringify(budget, null, 2));
    const decision = response ? (response.structuredData ?? parseOrNull(response.content)) : null;
    const record = {
      scenario: this.scenario.id, turn: this.turn, latencyMs: Math.round(performance.now() - started), error: error ? String(error.message ?? error) : null,
      finishReason: response?.finishReason ?? null, modelId: response?.modelId ?? null, usage: response?.usage ?? null,
      json: decision !== null, decisionType: decision?.type ?? null, capabilityId: decision?.capabilityId ?? null, decision,
      raw: decision === null ? (response?.content ?? '').slice(0, 600) : null,
    };
    appendFileSync(CALLS, `${JSON.stringify(record)}\n`);
    this.scenario.calls.push(record);
    if (error) throw error;
    return response;
  }
}

function parseOrNull(text) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return null;
  }
}

// ---- owners: fixture Catalog (swappable, for a price change), Shipping and Quote V2 -------------------------
function owners() {
  let base = new FixtureCatalog();
  const http = (port) => new Proxy(port, { get: (t, k) => (k === 'bindingKind' ? 'http' : typeof Reflect.get(t, k) === 'function' ? Reflect.get(t, k).bind(t) : Reflect.get(t, k)) });
  const catalog = { search: (...a) => base.search(...a), getProductContext: (...a) => base.getProductContext(...a), getItemContext: (...a) => base.getItemContext(...a) };
  const quotes = new FixtureQuoteV2Service();
  const shipping = new FixtureShipping();
  return {
    catalog: http(catalog), shipping: http(shipping), quotes: http(quotes), quoteOwner: quotes,
    catalogDown: () => base.availability.set({ mode: 'down' }),
    shippingDown: () => shipping.availability.set({ mode: 'down' }),
    quoteDown: () => quotes.availability.set({ mode: 'down' }),
    /** The owner changes a price: every later read (search, product, item) sees it. */
    setPrice: (productKey, gross) => {
      base = new FixtureCatalog({ products: FIXTURE_PRODUCTS.map((p) => (p.productKey === productKey ? { ...p, regularGross: gross, finalGross: gross } : p)) });
    },
  };
}

// ---- customer side: synthetic turns chosen only from what the agent delivered ---------------------------------
const OFFER = /Cotización lista para emitir \(Ref\. (Q-[A-Z0-9]{6}-\d+)\)/;
const ISSUED = /\bPC-\d{6}\b/;
const CARRIER = /Fixture (Courier|Express)/;
const CONFIRM = 'Sí, emítela.';

const SCENARIOS = {
  // S1 + S2 + S3 + S4 + S5 (+ S8 replay and S10 capture after issuance).
  multiproduct: {
    first: 'Hola, necesito una rack, una barra olímpica y 100 kilos en discos. Todo junto, por favor, con despacho a Maipú.',
    next(s, text) {
      if (ISSUED.test(text)) return null;
      if (OFFER.test(text)) {
        if (!s.changed) return (s.changed = true), 'Está bien, pero mejor son dos racks.';
        if (!s.ambiguous) return (s.ambiguous = true), 'Sí.';
        return CONFIRM;
      }
      if (s.ambiguous) return CONFIRM;
      const spec = 'La Power Rack PR-200, la barra olímpica de 20 kg y el set de discos bumper de 100 kg.';
      if (!s.spec) return (s.spec = true), CARRIER.test(text) ? `${spec} Para el despacho, prefiero Fixture Courier, servicio NORMAL.` : spec;
      if (CARRIER.test(text)) return 'Prefiero Fixture Courier, servicio NORMAL.';
      return (s.generic = (s.generic ?? 0) + 1) <= 3 ? 'Sí, avancemos con eso, por favor.' : null;
    },
  },
  // S6: the owner raises a price after the offer was presented; the customer confirms the old offer.
  'price-change': {
    first: 'Hola, quiero cotizar 2 kettlebells de 16 kg. Sin despacho, los retiro en la tienda.',
    next(s, text, o) {
      if (ISSUED.test(text)) return null;
      if (OFFER.test(text)) {
        if (!s.mutated) {
          s.mutated = true;
          o.setPrice('KB-16', 36_990);
        }
        return CONFIRM;
      }
      return (s.generic = (s.generic ?? 0) + 1) <= 2 ? 'Sin despacho, los retiro yo. Avancemos, por favor.' : null;
    },
  },
  // S7: Catalog unavailable for the whole conversation.
  'catalog-down': {
    setup: (o) => o.catalogDown(),
    first: 'Hola, quiero cotizar una barra olímpica de 20 kg con despacho a Ñuñoa.',
    next: (s) => ((s.asked = (s.asked ?? 0) + 1) === 1 ? '¿Me puedes dar el precio igual, aunque sea aproximado?' : null),
  },
  // S7 at issuance: Shipping (re-read by quote.create@5) or Quote V2 goes down after the offer; the customer confirms.
  'shipping-down': outageAtIssuance((o) => o.shippingDown()),
  'quote-down': outageAtIssuance((o) => o.quoteDown()),
  // S1 as stated by the owner (San Bernardo), against a Shipping owner whose commune catalog does not know it.
  'unknown-commune': {
    first: 'Hola, quiero cotizar una rack con despacho a San Bernardo.',
    next(s, text) {
      if (OFFER.test(text) || ISSUED.test(text)) return null;
      if (!s.spec) return (s.spec = true), 'La Power Rack PR-200.';
      return (s.generic = (s.generic ?? 0) + 1) <= 1 ? 'Sí, avancemos con eso, por favor.' : null;
    },
  },
};

function outageAtIssuance(fail) {
  return {
    first: 'Hola, quiero cotizar una barra olímpica de 20 kg con despacho a Ñuñoa.',
    next(s, text, o) {
      if (s.failed) return null;
      if (OFFER.test(text)) {
        s.failed = true;
        fail(o);
        return CONFIRM;
      }
      if (CARRIER.test(text)) return 'Prefiero Fixture Courier, servicio NORMAL.';
      return (s.generic = (s.generic ?? 0) + 1) <= 2 ? 'Sí, avancemos con eso, por favor.' : null;
    },
  };
}

// ---- run --------------------------------------------------------------------------------------------------
const admin = async (sql) => {
  const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
const profile = SALES_PRODUCTION_PROFILES.find((x) => profileLabel(x) === PROFILE);
const summary = {
  startedAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0, node: process.version,
  model: { ...config, providerId: real.providerId }, profile: { label: PROFILE, fingerprint: profileFingerprint(profile), agentVersion: salesProductionAgentVersion(profile) }, args, scenarios: [],
};
const model = new Recorded();
const MAX_CUSTOMER_TURNS = 12;
// Throwaway databases are dropped only after every result is written.
const dropLater = [];

for (const id of args.scenarios.split(',')) {
  const def = SCENARIOS[id];
  const dbName = `r4_canary_j3acc_${id.replace(/-/g, '_')}_${randomBytes(4).toString('hex')}`;
  await admin(`create database ${dbName}`);
  const dbUrl = ADMIN_DATABASE_URL.replace(/\/postgres$/, `/${dbName}`);
  const canary = loadCanaryEnvironment({
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: PROFILE, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'r4-j3-acceptance-identity-key-0000000000000001',
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: dbUrl, R4_LOG_LEVEL: 'silent',
    // The limits of the C1 experiment (README there); not production limits.
    R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '5000000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '15',
    R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '2', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '10000', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900',
  });
  await initCanary(canary, logger);
  const o = owners();
  def.setup?.(o);
  const sc = { id, calls: [], transcript: [], replay: null };
  model.scenario = sc;
  const captureFile = join(tmpdir(), `r4-j3acc-${dbName}.jsonl`);
  const runtime = await startCanaryRuntime(canary, {
    modelProvider: model, catalog: o.catalog, shipping: o.shipping, quotes: o.quotes,
    worker: { databaseUrl: dbUrl, logLevel: 'silent', dbPoolMax: 3, workerId: `j3acc:${id}`, leaseDurationMs: 300_000, heartbeatIntervalMs: 30_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1, execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 600_000, modelCallTimeoutMs: 180_000, maxWriteActions: 50 }, context: { budget: { mode: 'unbounded' } } },
    // The generic scheduler fires the durable action_retry backoff (20/40/80 s) and reconciliations, in real time.
    scheduler: { databaseUrl: dbUrl, logLevel: 'silent', dbPoolMax: 2, owner: `j3acc:${id}:scheduler`, leaseMs: 30_000, pollMs: 25, reconciliationPolicy: { maxAttempts: 3, initialBackoffMs: 0, maxBackoffMs: 0, deadlineMs: 86_400_000 } },
    captureFile, logger, isolationCheckMs: 50,
  });
  const probe = new pg.Pool({ connectionString: dbUrl, max: 1 });
  const pendingRetries = async (task) => Number((await probe.query("select count(*)::int as n from schedules where task_id = $1 and kind in ('action_retry', 'reconciliation') and status in ('pending', 'claimed', 'dispatched', 'in_progress')", [task])).rows[0].n);
  /** One customer turn: step worker, scheduler and delivery until nothing is runnable and no retry is pending (max 6 min). */
  const settle = async (task) => {
    const until = Date.now() + 360_000;
    while (Date.now() < until) {
      const fired = (await runtime.scheduler.scheduler.runOnce()).kind === 'fired';
      const cycle = await runtime.worker.worker.runOnce();
      await runtime.delivery.tick();
      if (cycle.kind === 'idle' && !fired) {
        if ((await pendingRetries(task)) === 0) return;
        await sleep(1_000);
      }
    }
    throw new Error('turn did not settle within 6 minutes');
  };
  const conversation = `j3acc-${id}`;
  const captured = () => (existsSync(captureFile) ? readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  let taskId = null;
  let confirmEventId = null;
  const state = {};
  try {
    let text = def.first;
    for (let turn = 1; text !== null && turn <= MAX_CUSTOMER_TURNS; turn += 1) {
      model.turn = turn;
      const eventId = `${conversation}-t${turn}`;
      if (text === CONFIRM) confirmEventId = eventId;
      sc.transcript.push({ turn, from: 'customer', text, eventId, at: new Date().toISOString() });
      const sent = await sendSynthetic(canary, { conversation, text, eventId }, logger);
      taskId ??= sent.taskId;
      const before = captured().length;
      await settle(taskId);
      const fresh = captured().slice(before);
      for (const m of fresh) sc.transcript.push({ turn, from: 'agent', text: m.text, recipientRef: m.recipientRef, outboundId: m.outboundId, at: m.capturedAt });
      text = def.next(state, fresh.map((m) => m.text).join('\n\n'), o);
    }
    // S8: the provider re-delivers the confirming event (same provider event id).
    if (confirmEventId) {
      const createCallsBefore = o.quoteOwner.createCalls;
      const again = await sendSynthetic(canary, { conversation, text: CONFIRM, eventId: confirmEventId }, logger);
      await settle(taskId);
      sc.replay = { outcome: again.kind, createCallsBefore, createCallsAfter: o.quoteOwner.createCalls };
    }
  } catch (e) {
    sc.error = String(e.message ?? e);
  } finally {
    await runtime.close();
    await probe.end();
  }

  // ---- evidence from the canary database and the fixture owner -------------------------------------------
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  // A failing query is recorded, never fatal: the database is dropped either way.
  const q = (sql) => (taskId ? pool.query(sql, [taskId]).then((r) => r.rows, (e) => ({ error: String(e.message ?? e) })) : []);
  const records = {
    runs: await q('select status, termination_code from agent_runs where task_id = $1 order by created_at'),
    task: await q('select status from agent_tasks where task_id = $1'),
    inputs: await q('select input_id, external_key, source_ref, actor_kind, received_at from task_inputs where task_id = $1 order by received_at'),
    proposals: await q('select capability_id, arguments, created_at from action_proposals where task_id = $1 order by created_at'),
    policy: await q('select capability_id, capability_version, outcome, reason_code, policy_id, policy_version, policy_hash from policy_decisions where task_id = $1 order by evaluated_at'),
    executions: await q('select execution_id, capability_id, capability_version, execution_key, status, max_attempts, initial_backoff_ms from action_executions where task_id = $1 order by created_at'),
    attempts: await q('select e.capability_id, a.attempt_number, a.kind, a.outcome, a.error_code from action_execution_attempts a join action_executions e using (execution_id) where e.task_id = $1 order by a.started_at'),
    receipts: await q('select capability_id, capability_version, status, error_code, resource_ref, replayed, attempts, result from action_receipts where task_id = $1 order by recorded_at'),
    decisions: await q('select execution_key, preview_id, outcome, reason_code, measurements, quote_request, decided_at from sales.quote_autonomous_decisions where task_id = $1 order by decided_at'),
    evidence: await q('select execution_key, commercial_version, presented_reference, presented_gross, offer_outbound_id, offer_text_sha256, confirmation_input_id, confirmation_text_sha256, grammar_version, grammar_rule, offer_at, confirmation_at from sales.quote_intent_evidence where task_id = $1'),
    requests: await q('select execution_key, request, request_sha256 from sales.quote_v2_requests where task_id = $1'),
    sends: await q('select s.execution_key, s.sent_at from sales.quote_v2_sends s join sales.quote_v2_requests r using (execution_key) where r.task_id = $1'),
    issued: await q('select quote_number, quote_id, valid_through_local_date, pdf_sha256, byte_length, document_verification from sales.quote_v2_issued where task_id = $1'),
    humanRequests: await q('select kind, status from human_requests where task_id = $1'),
    inbound: await q('select count(*)::int as events, sum(duplicate_deliveries)::int as duplicates from inbound_events where $1::uuid is not null'),
    outbound: await q("select status, channel, hold_reason, content_sha256, accepted_at from outbound_messages where task_id = $1 order by created_at"),
  };
  await pool.end();
  dropLater.push(dbName);

  const owned = await Promise.all(o.quoteOwner.quotes.map(async (quote) => {
    const doc = await o.quoteOwner.getDocument(quote.quoteId);
    return { quoteNumber: quote.quoteNumber, status: quote.status, totals: quote.totals, lines: quote.lines.length, document: quote.document, pdfSha256Recomputed: sha(doc.bytes) };
  }));
  const agentTexts = sc.transcript.filter((m) => m.from === 'agent');
  const offers = agentTexts.filter((m) => OFFER.test(m.text)).map((m) => ({ turn: m.turn, reference: OFFER.exec(m.text)[1], sha256: sha(m.text), chars: m.text.length }));
  const entry = {
    id, taskId, error: sc.error ?? null, transcript: sc.transcript, offers, replay: sc.replay, records,
    owner: { createCalls: o.quoteOwner.createCalls, quotes: owned },
    recipients: [...new Set(agentTexts.map((m) => m.recipientRef))],
    model: {
      calls: sc.calls.length, json: sc.calls.filter((c) => c.json).length, finishReasons: [...new Set(sc.calls.map((c) => c.finishReason))],
      decisions: sc.calls.map((c) => (c.capabilityId ? `${c.decisionType}:${c.capabilityId}` : c.decisionType)),
      inputTokens: sc.calls.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), 0), outputTokens: sc.calls.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0),
      latencyMs: sc.calls.map((c) => c.latencyMs),
    },
  };
  summary.scenarios.push(entry);
  writeFileSync(join(ROOT, `${id}.json`), JSON.stringify(entry, null, 2));
  say(`${id}: calls=${entry.model.calls} json=${entry.model.json} offers=${offers.length} decisions=${Array.isArray(records.decisions) ? records.decisions.map((d) => `${d.outcome}:${d.reason_code}`).join(',') : 'query-error'} quotes=${owned.map((x) => x.quoteNumber).join(',')} replay=${sc.replay?.outcome ?? '-'} error=${entry.error ?? '-'} budget=${budget.calls}/${budget.usd.toFixed(3)}`);
}
summary.finishedAt = new Date().toISOString();
summary.budget = budget;
writeFileSync(join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
for (const name of dropLater) await admin(`drop database if exists ${name} with (force)`);
say(`done ${JSON.stringify(budget)}`);
