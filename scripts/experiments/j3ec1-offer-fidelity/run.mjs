#!/usr/bin/env node
// R4-J3E-C1 offer experiment (README.md in this directory): the REAL canary runtime of a Sales production
// profile on a throwaway LOCAL database, fixture owners (fixture Quote V2, never the real service), scripted
// decisions everywhere EXCEPT the turn where the model writes the offer (or re-presents it): there the exact
// request the kernel built goes to the real model, and its decision goes back to the kernel.
//
//   npm run build
//   node scripts/experiments/j3ec1-offer-fidelity/run.mjs --label C --first 100 --count 55 --ambiguous-every 3
//   node scripts/experiments/j3ec1-offer-fidelity/run.mjs --label AB --profiles sales-production@6,sales-production@7 --first 500 --count 20 --max-calls 40
//
// Hard stops: the cumulative ledger (<root>/budget.json: 150 calls / US$10, the original authorization) and --max-calls.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { profileFingerprint, profileLabel } from '@r4/live-ops';
import { FakeModelProvider } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, ContextView, read, renderOfferMessage, respond } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryRuntime } from '@r4-sales/agent/canary';
import { SALES_PRODUCTION_PROFILES, salesProductionAgentVersion } from '@r4-sales/agent/production';

const REPO = resolve(import.meta.dirname, '../../..');
const { values: args } = parseArgs({
  options: {
    label: { type: 'string', default: 'A' },
    profiles: { type: 'string', default: 'sales-production@7' },
    first: { type: 'string', default: '0' },
    count: { type: 'string', default: '30' },
    'ambiguous-every': { type: 'string', default: '0' },
    'max-calls': { type: 'string' },
    // A deterministic stand-in that copies the Sales rendering: checks the harness without spending real calls.
    'dry-run': { type: 'boolean', default: false },
    root: { type: 'string' },
  },
});
args.root ??= join(REPO, 'artifacts', args['dry-run'] ? 'j3ec1-fidelity-dry-run' : 'j3ec1-fidelity');
const LABEL = args.label;
const PROFILES = args.profiles.split(',');
const FIRST = Number(args.first);
const COUNT = Number(args.count);
const AMBIGUOUS_EVERY = Number(args['ambiguous-every']);
const OUT = join(args.root, `phase-${LABEL}`);
mkdirSync(OUT, { recursive: true });
const SAMPLES = join(OUT, 'samples.jsonl');
const CALLS = join(OUT, 'calls.jsonl');
// The Sales rendering and the model's text of every real call (synthetic content), checkable against the hashes in calls.jsonl.
const TEXTS = join(OUT, 'texts.jsonl');
const LEDGER = join(args.root, 'budget.json');
const MAX_CALLS = 150;
const MAX_USD = 10;
// EXTERNAL (api-docs.deepseek.com, 2026-10): peak prices per 1M tokens, cache MISS for every input token (upper bound).
const USD_PER_M_INPUT = 0.3;
const USD_PER_M_OUTPUT = 1.2;
const ADMIN_DATABASE_URL = process.env.R4_EXPERIMENT_ADMIN_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres'; // docker-compose.yml
const logger = createSilentLogger();
const sha = (t) => createHash('sha256').update(t).digest('hex');
const say = (line) => process.stdout.write(`${line}\n`);

// ---- model: the production profile pinned by tests/unit/sales/openai-compatible-provider.test.ts (E) ----
// Only R4_MODEL_* lines of the local .env are read (endpoint and key); nothing of them is written anywhere.
const dotenv = Object.fromEntries(readFileSync(join(REPO, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^R4_MODEL_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const modelConfig = loadOpenAICompatibleConfig({ ...dotenv, R4_MODEL_PROFILE: 'deepseek-v4-flash', R4_MODEL_MAX_OUTPUT_TOKENS: '' });
const real = args['dry-run']
  ? new FakeModelProvider((request) => {
    const p = previewOf(new ContextView(request));
    return { type: 'structured', data: { type: 'respond', content: renderOfferMessage(p.snapshot, p.presentation.reference) } };
  })
  : new OpenAICompatibleModelProvider(modelConfig);
const config = describeModelConfig(modelConfig);
if (config.model !== 'deepseek-flash' || config.responseFormat !== 'json_object' || config.extraBody.thinking?.type !== 'enabled' || config.maxOutputTokens !== null) throw new Error('not the pinned production model profile');

const budget = (() => {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch {
    return { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  }
})();
const callCap = Math.min(MAX_CALLS, args['max-calls'] === undefined ? MAX_CALLS : budget.calls + Number(args['max-calls']));
const saveBudget = () => writeFileSync(LEDGER, JSON.stringify(budget, null, 2));
const exhausted = (needed = 1) => budget.calls + needed > callCap || budget.usd >= MAX_USD;

// ---- scenarios (synthetic: fixture catalog keys, fixture shipping, rewritten names) -----------------
const SIMPLE = [
  ['RACK-SQ100', 3], ['BAR-OLY20', 3], ['BAR-OLY15', 2], ['BAR-EZ', 3], ['PLT-BUMP-60', 2], ['PLT-IRON-50', 3], ['BENCH-FID', 2],
  ['BENCH-FLAT', 3], ['KB-16', 3], ['FLOOR-MAT', 5], ['PULLUP-BAR', 3], ['COLLARS', 5], ['RACK-HR50', 1], ['DB-ADJ-24', 1],
];
const COMMUNES = ['Ñuñoa', 'Providencia', 'Las Condes', 'Peñalolén', 'Maipú', 'Viña del Mar', 'Rancagua', 'Concepción', 'La Serena', 'Puerto Montt', 'Estación Central', 'Valparaíso'];
const RENAMES = [
  'Par Mancuernas Hexagonales 12.5kg | HWM®',
  'Barra Olímpica “Pro” 20 kg – 2,2 m | IronHome®',
  'Set de discos "bumper" 60 kg (2×20 + 2×10)',
  'Banco ajustable FID 7 posiciones · carga máx. 300 kg',
  'Kettlebell 16 kg — hierro fundido, asa 35 mm Ø',
  'Piso de caucho 100×100×2 cm (unidad) – alta densidad, ideal para zonas de levantamiento olímpico con caída de barra',
  'Rack de sentadillas SQ-100 / ajustable 1,10–1,75 m',
  'Seguros "clip" para barra olímpica (par) ñ',
];
const CONFIRMATIONS = ['Sí, emítela.', 'Confirmo la cotización.', 'CONFIRMO', 'Sí, confirmo esa cotización. Emítela por favor.', 'Dale, emítela.'];
const AMBIGUOUS = ['Sí', 'ok', 'dale', 'Perfecto'];

/** Deterministic scenario #n: depends on n only (the generator of phases A and C). */
function scenario(n, ambiguous) {
  let s = (n * 2654435761 + 97) >>> 0;
  const rnd = (k) => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) % k;
  const variant = n % 9 === 4;
  const lines = variant ? 1 + rnd(2) : 1 + rnd(3);
  const pool = [...SIMPLE];
  const items = [];
  if (variant) items.push({ productId: rnd(2) === 0 ? 'KB-COMP-12' : 'KB-COMP-24', quantity: 1 + rnd(2) });
  while (items.length < lines) {
    const [key, max] = pool.splice(rnd(pool.length), 1)[0];
    items.push({ productId: key, quantity: 1 + rnd(max) });
  }
  const delivery = variant ? null : rnd(5) === 0 ? null : COMMUNES[rnd(COMMUNES.length)];
  const renames = {};
  if (rnd(10) < 6) renames[items[rnd(items.length)].productId.replace(/-(12|24)$/, '')] = RENAMES[rnd(RENAMES.length)];
  const taxRate = rnd(6) === 0 ? 0.1 : null;
  return { id: `fid-${LABEL.toLowerCase()}-${n}`, n, items, delivery, pick: rnd(2), renames, taxRate, confirmation: ambiguous ? AMBIGUOUS[rnd(AMBIGUOUS.length)] : CONFIRMATIONS[rnd(CONFIRMATIONS.length)], ambiguous };
}

function owners(sc) {
  const base = new FixtureCatalog();
  const patch = (item) => {
    if (item.status !== 'found') return item;
    const name = sc.renames[item.parentProduct.productKey];
    let out = name ? { ...item, parentProduct: { ...item.parentProduct, name } } : item;
    if (sc.taxRate !== null && out.pricing.status === 'available') out = { ...out, pricing: { ...out.pricing, tax: { ...out.pricing.tax, rate: sc.taxRate } } };
    return out;
  };
  const catalog = { search: (...a) => base.search(...a), getProductContext: (...a) => base.getProductContext(...a), getItemContext: async (...a) => patch(await base.getItemContext(...a)) };
  const http = (port) => new Proxy(port, { get: (t, k) => (k === 'bindingKind' ? 'http' : typeof Reflect.get(t, k) === 'function' ? Reflect.get(t, k).bind(t) : Reflect.get(t, k)) });
  return { catalog: http(catalog), shipping: http(new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()) };
}

// ---- scripted steps (identical for every profile) ----------------------------------------------
const latest = (v, id) => v.observations(id).filter((o) => o.outcome === 'succeeded').at(-1);
const offers = (v) => latest(v, CAPABILITY_IDS.shippingQuote).payload.offers;
const previewOf = (v) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)?.payload ?? null;
const ws = (ops) => (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations: ops(v) } });
const propose = (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: previewOf(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] });
const outcome = respond((v) => {
  const o = v.observations(CAPABILITY_IDS.quoteCreate).at(-1);
  return o.outcome === 'succeeded' ? `Cotización ${o.payload.result.quoteNumber} emitida.` : 'No pude emitir la cotización todavía.';
});
const REAL = 'REAL';

function plan(sc) {
  const turn1 = sc.delivery
    ? [ws(() => [...sc.items.map((i) => ({ op: 'add_item', ...i })), { op: 'set_delivery_destination', commune: sc.delivery }]), read(CAPABILITY_IDS.shippingQuote, { destination: { commune: sc.delivery }, basis: 'order', items: sc.items }), respond((v) => `Opciones de despacho a ${sc.delivery}: ${offers(v).map((o) => `${o.carrierName} ${o.serviceType}`).join(' o ')}. ¿Cuál prefieres?`)]
    : [ws(() => [...sc.items.map((i) => ({ op: 'add_item', ...i })), { op: 'exclude_shipping' }]), respond('Perfecto, sin despacho. ¿Te preparo la cotización?')];
  const turn2 = sc.delivery
    ? [ws((v) => { const o = offers(v).find((x) => x.carrierName === 'Fixture Courier'); return [{ op: 'select_shipping_offer', carrierName: o.carrierName, serviceType: o.serviceType, ownerNetClp: o.price.ownerNet.amount }]; }), read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), REAL]
    : [read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), REAL];
  const turn3 = sc.ambiguous ? [propose, REAL] : [propose, outcome];
  const turn4 = sc.ambiguous ? [propose, outcome] : [];
  const texts = [
    `Hola, quiero cotizar ${sc.items.map((i) => `${i.quantity} ${i.productId}`).join(', ')}${sc.delivery ? ` con despacho a ${sc.delivery}` : ', sin despacho'}.`,
    sc.delivery ? 'Prefiero Fixture Courier, servicio NORMAL.' : 'Sí, prepárala.',
    sc.confirmation,
    ...(sc.ambiguous ? ['CONFIRMO'] : []),
  ];
  return { steps: [...turn1, ...turn2, ...turn3, ...turn4], texts };
}

// ---- the hybrid provider: scripted, except at REAL ----------------------------------------------
class Hybrid {
  providerId = 'openai-compatible.deepseek-v4-flash';
  routes = new Map();
  fake = new FakeModelProvider((request) => this.#scripted(request));

  #route(request) {
    const taskId = request.context.sections.task.find((i) => i.kind === 'task').content.taskId;
    return this.routes.get(taskId);
  }

  #scripted(request) {
    const route = this.#route(request);
    if (!route) return { type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'not part of this experiment' } };
    const step = route.steps[route.next++];
    if (!step) return { type: 'provider_error', message: `no scripted step ${route.next}` };
    return { type: 'structured', data: step(new ContextView(request)) };
  }

  async invoke(request, signal) {
    const route = this.#route(request);
    if (!route || route.steps[route.next] !== REAL) return this.fake.invoke(request, signal);
    const preview = previewOf(new ContextView(request));
    // The offer Sales renders for the snapshot the model saw: what @7 must copy, and what @6 is compared with.
    const expected = preview?.status === 'ready' && preview.snapshot && preview.presentation ? renderOfferMessage(preview.snapshot, preview.presentation.reference) : null;
    if (expected === null) {
      route.next += 1;
      route.sc.invalid = `no presentable preview (status ${preview?.status}, issuable ${preview?.issuable})`;
      return new FakeModelProvider([{ type: 'structured', data: { type: 'respond', content: 'escenario inválido' } }]).invoke(request, signal);
    }
    if (preview.presentation.offerMessage !== undefined && preview.presentation.offerMessage !== expected) throw new Error('quote.preview@3 offerMessage is not renderOfferMessage(snapshot, reference)');
    if (exhausted()) throw Object.assign(new Error('budget exhausted'), { budget: true });
    const segment = route.segment ?? (route.segment = { calls: 0, kind: (route.realSegments = (route.realSegments ?? 0) + 1) === 1 ? 'offer' : 'represent' });
    segment.calls += 1;
    const started = performance.now();
    let response;
    let error = null;
    try {
      response = await real.invoke(request, signal);
    } catch (e) {
      error = e;
    }
    const latencyMs = Math.round(performance.now() - started);
    budget.calls += 1;
    if (response) {
      budget.inputTokens += response.usage.inputTokens;
      budget.outputTokens += response.usage.outputTokens;
      budget.usd = (budget.inputTokens * USD_PER_M_INPUT + budget.outputTokens * USD_PER_M_OUTPUT) / 1e6;
    }
    saveBudget();
    const decision = response ? (response.structuredData ?? (() => { try { return JSON.parse(response.content ?? ''); } catch { return null; } })()) : null;
    const content = typeof decision?.content === 'string' ? decision.content.trim() : null;
    const record = {
      scenario: route.sc.id, n: route.sc.n, profile: route.profile, kind: segment.kind, segmentCall: segment.calls, latencyMs, error: error ? String(error.message ?? error) : null,
      finishReason: response?.finishReason ?? null, modelId: response?.modelId ?? null, inputTokens: response?.usage.inputTokens ?? 0, outputTokens: response?.usage.outputTokens ?? 0,
      json: decision !== null, decisionType: decision?.type ?? null, rawChars: response?.content?.length ?? 0,
      exact: decision?.type === 'respond' && content === expected, expectedSha256: sha(expected), presentedSha256: content === null ? null : sha(content), expectedChars: expected.length, presentedChars: content?.length ?? null,
      diff: decision?.type === 'respond' && content !== expected ? firstDiff(expected, content ?? '') : null,
      raw: decision === null ? (response?.content ?? '').slice(0, 600) : null,
    };
    appendFileSync(CALLS, `${JSON.stringify(record)}\n`);
    appendFileSync(TEXTS, `${JSON.stringify({ scenario: record.scenario, profile: record.profile, kind: record.kind, segmentCall: record.segmentCall, expected, presented: decision?.type === 'respond' ? content : null })}\n`);
    route.sc.calls.push(record);
    if (decision?.type === 'respond' || decision?.type === 'wait' || decision?.type === 'request_handoff' || segment.calls >= 3) {
      route.next += 1;
      route.segment = null;
    }
    if (error) throw error;
    return response;
  }
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return { at: i, expected: a.slice(Math.max(0, i - 20), i + 40), presented: b.slice(Math.max(0, i - 20), i + 40), lengthDelta: b.length - a.length };
}

// ---- run ----------------------------------------------------------------------------------------
const admin = async (sql) => {
  const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};
const arms = [];
for (const profile of PROFILES) {
  const dbName = `r4_canary_fid_${LABEL.toLowerCase()}_${profile.split('@')[1]}_${randomBytes(4).toString('hex')}`;
  await admin(`create database ${dbName}`);
  const dbUrl = ADMIN_DATABASE_URL.replace(/\/postgres$/, `/${dbName}`);
  const canary = loadCanaryEnvironment({
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'r4-fidelity-experiment-identity-key-000000000001',
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: dbUrl, R4_LOG_LEVEL: 'silent',
    R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '5000000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '15',
    R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '2', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '10000', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900',
  });
  await initCanary(canary, logger);
  arms.push({ profile, dbName, dbUrl, canary, pool: new pg.Pool({ connectionString: dbUrl, max: 2 }) });
}
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
const versionOf = (label) => {
  const p = SALES_PRODUCTION_PROFILES.find((x) => profileLabel(x) === label);
  return p ? { profile: label, fingerprint: profileFingerprint(p), agentVersion: salesProductionAgentVersion(p) } : { profile: label };
};
const hybrid = new Hybrid();
const summary = {
  label: LABEL, startedAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0, node: process.version,
  model: { ...config, providerId: real.providerId }, profiles: PROFILES.map(versionOf), args, scenarios: [],
};

for (let n = FIRST; n < FIRST + COUNT; n += 1) {
  // A paired scenario starts only if every arm can make its call.
  if (exhausted(PROFILES.length)) break;
  // Counterbalanced: the arm that goes first alternates with n.
  for (const arm of n % 2 === 0 ? arms : [...arms].reverse()) {
    const sc = { ...scenario(n, AMBIGUOUS_EVERY > 0 && n % AMBIGUOUS_EVERY === 0), calls: [] };
    const owned = owners(sc);
    const runtime = await startCanaryRuntime(arm.canary, {
      modelProvider: hybrid, catalog: owned.catalog, shipping: owned.shipping, quotes: owned.quotes,
      worker: { databaseUrl: arm.dbUrl, logLevel: 'silent', dbPoolMax: 3, workerId: `fidelity:${sc.id}`, leaseDurationMs: 300_000, heartbeatIntervalMs: 30_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1, execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 600_000, modelCallTimeoutMs: 180_000, maxWriteActions: 50 }, context: { budget: { mode: 'unbounded' } } },
      scheduler: null, captureFile: join(tmpdir(), `r4-fidelity-${arm.dbName}-${sc.id}.jsonl`), logger, isolationCheckMs: 50,
    });
    const { steps, texts } = plan(sc);
    let taskId = null;
    try {
      for (const [i, text] of texts.entries()) {
        const sent = await sendSynthetic(arm.canary, { conversation: sc.id, text }, logger);
        if (i === 0) {
          taskId = sent.taskId;
          hybrid.routes.set(taskId, { sc, profile: arm.profile, steps, next: 0, segment: null });
        }
        for (let c = 0; c < 40; c += 1) if ((await runtime.worker.worker.runOnce()).kind === 'idle') break;
        await runtime.delivery.tick();
      }
    } catch (e) {
      sc.error = String(e.message ?? e);
    } finally {
      await runtime.close();
    }
    const q = async (sql) => (taskId ? (await arm.pool.query(sql, [taskId])).rows : []);
    const verdicts = (await q('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1 order by decided_at')).map((r) => `${r.outcome}:${r.reason_code}`);
    const runs = (await q('select status, termination_code from agent_runs where task_id = $1 order by created_at')).map((r) => `${r.status}:${r.termination_code ?? ''}`);
    const handoffs = (await q('select count(*)::int as n from human_requests where task_id = $1'))[0]?.n ?? 0;
    const entry = { id: sc.id, n, profile: arm.profile, lines: sc.items.length, items: sc.items, delivery: sc.delivery, variant: sc.items.some((i) => /KB-COMP/.test(i.productId)), renamed: Object.keys(sc.renames).length > 0, taxRate: sc.taxRate, confirmation: sc.confirmation, ambiguous: sc.ambiguous, invalid: sc.invalid ?? null, error: sc.error ?? null, calls: sc.calls, verdicts, issued: owned.quotes.quotes?.length ?? null, runs, handoffs };
    summary.scenarios.push(entry);
    appendFileSync(SAMPLES, `${JSON.stringify(entry)}\n`);
    say(`${arm.profile} ${sc.id} calls=${sc.calls.length} json=${sc.calls.map((c) => (c.json ? 'Y' : 'N')).join(',')} exact=${sc.calls.map((c) => (c.exact ? 'Y' : 'N')).join(',')} verdicts=${verdicts.join(',')} budget=${budget.calls}/${budget.usd.toFixed(3)}`);
  }
}
for (const arm of arms) {
  await arm.pool.end();
  await admin(`drop database if exists ${arm.dbName} with (force)`);
}
summary.finishedAt = new Date().toISOString();
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
say(`done ${JSON.stringify(budget)}`);
