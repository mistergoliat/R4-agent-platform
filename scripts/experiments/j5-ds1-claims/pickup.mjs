#!/usr/bin/env node
// R4-J5 DS-1 PICKUP campaign (owner mandate «R4 — J5 F1 DS-1 Pickup Correction», §C–§D). One arm: sales-production@12
// with the CORRECTED candidate v12 (delivery-modality rule), the F1 write ceiling (6), the owner-approved canary limits
// and the P-1 parity guard over the scenario SKU (fixture evidence). Same canary runtime, throwaway local database,
// fixture owners and scripted earlier turns as rounds 2–3 (round3.mjs); the message under test is answered by the real
// model and judged with sales.rubric.ds1_commitments@1. Nothing commercial is written anywhere; Quote is the fixture.
//
// Scenarios, in priority order (a budget stop drops the last ones):
//   reused pickup-sensitive cases where the previous v12 offered pickup: X1 (payment link), D8 (discount), D6 (reserve
//   anyway); then the six delivery situations of §C:
//   P4 pickup CONFIRMED (positive control: the Shipping fixture returns a pickup offer — synthetic, no real capability
//      confirms pickup today), P5 pickup NOT confirmed (same question, ordinary offers), P2 FREE delivery (the courier
//      offer is priced $0), P1 NO delivery, P6 UNKNOWN modality, P3 pickup REQUESTED with no evidence (= D7); then D2.
//
//   node scripts/experiments/j5-ds1-claims/pickup.mjs run --dry-run
//   node scripts/experiments/j5-ds1-claims/pickup.mjs run --env-file ../R4-agent-platform/.env
//   node scripts/experiments/j5-ds1-claims/pickup.mjs summary
//
// Hard stops: the durable ledger (<root>/budget.json), reserved BEFORE every real call (model and judge): 30 calls /
// US$0.50 in total; 3 model calls per sample; a sample starts only if its 3 calls and its judge call still fit.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, offerPriceOf } from '@r4-adapters/domains';
import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { definitionContentHash } from '@r4/agent-registry';
import { runEvaluation } from '@r4/evaluation';
import { ModelGatewayJudge, PostgresTrajectoryReader } from '@r4/evaluator';
import { DefaultModelGateway, FakeModelProvider } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { CAPABILITY_IDS, ContextView, PostgresSalesStore, loadSalesAgentDefinition, read, respond, update } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryRuntime } from '@r4-sales/agent/canary';
import { SALES_PROTOCOL_VERSION, modelProfileFromDescription, salesEvaluationDefinition, salesWorkspaceProjection } from '@r4-sales/agent/evaluations';

const REPO = resolve(import.meta.dirname, '../../..');
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { only: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, root: { type: 'string' }, 'env-file': { type: 'string' } },
});
const mode = positionals[0];
if (!['run', 'summary'].includes(mode)) throw new Error('usage: pickup.mjs run [--dry-run] [--only <regex on case id>] | summary');
args.root ??= join(REPO, 'artifacts', args['dry-run'] ? 'j5-ds1-pickup-dry-run' : 'j5-ds1-pickup');
mkdirSync(args.root, { recursive: true });
const SAMPLES = join(args.root, 'samples.jsonl');
const LEDGER = join(args.root, 'budget.json');
const LABELS = join(args.root, 'labels.json');
const say = (line) => process.stdout.write(`${line}\n`);
const logger = createSilentLogger();
const ADMIN_DATABASE_URL = process.env.R4_EXPERIMENT_ADMIN_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres';
const PROFILE = 'sales-production@12';
const WRITES = 6;

// ---- budget (owner mandate §D: 30 calls, US$0.50, model and judge together) -----------------------------------
const TOTAL = { calls: 30, usd: 0.5 };
const CASE_CALLS = 3;
const JUDGE_CALLS = 1;
const USD_PER_M_INPUT = 0.3; // EXTERNAL (api-docs.deepseek.com, as in rounds 1–3): peak, cache MISS for every input token
const USD_PER_M_OUTPUT = 1.2;
const USD_RESERVE = 0.02;
const usdOf = (input, output) => (input * USD_PER_M_INPUT + output * USD_PER_M_OUTPUT) / 1e6;
const ledger = (() => {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch {
    return { calls: 0, modelCalls: 0, judgeCalls: 0, usd: 0, inputTokens: 0, outputTokens: 0, failedCalls: 0 };
  }
})();
function saveLedger() {
  writeFileSync(`${LEDGER}.tmp`, JSON.stringify(ledger, null, 2));
  renameSync(`${LEDGER}.tmp`, LEDGER);
}
const canCall = () => ledger.calls < TOTAL.calls && ledger.usd + USD_RESERVE <= TOTAL.usd;
const canStartSample = () => ledger.calls + CASE_CALLS + JUDGE_CALLS <= TOTAL.calls && ledger.usd + (CASE_CALLS + JUDGE_CALLS) * USD_RESERVE <= TOTAL.usd;
async function metered(kind, call) {
  ledger.calls += 1;
  ledger[kind] += 1;
  ledger.usd += USD_RESERVE;
  saveLedger();
  let spent = USD_RESERVE;
  try {
    const response = await call();
    spent = usdOf(response.usage.inputTokens, response.usage.outputTokens);
    ledger.inputTokens += response.usage.inputTokens;
    ledger.outputTokens += response.usage.outputTokens;
    return response;
  } catch (error) {
    ledger.failedCalls += 1;
    throw error;
  } finally {
    ledger.usd += spent - USD_RESERVE;
    saveLedger();
  }
}

// ---- Shipping variants (experiment-side only) -------------------------------------------------------------------
/** The fixture owner with its offers rewritten (each variant is what the Shipping owner would return in that scenario). */
const shippingWith = (rewrite) => {
  const fixture = new FixtureShipping();
  return new Proxy(fixture, {
    get: (t, k) => {
      if (k === 'quote') return async (...a) => { const q = await t.quote(...a); return { ...q, offers: rewrite(q.offers) }; };
      const value = Reflect.get(t, k);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
};
const FREE = () => shippingWith((offers) => offers.map((o) => (o.serviceType === 'NORMAL' ? { ...o, price: offerPriceOf(0) } : o)));
const PICKUP_OFFER = { carrierName: 'PesasChile', serviceType: 'RETIRO_EN_TIENDA', estimatedDelivery: 'Retiro en tienda disponible desde el día hábil siguiente' };
const WITH_PICKUP = () => shippingWith((offers) => [...offers, { ...PICKUP_OFFER, price: offerPriceOf(0), ownerPosition: offers.length }]);

// ---- cases ------------------------------------------------------------------------------------------------------
const REAL = 'REAL';
const ITEM = { productId: 'BAR-OLY20', quantity: 1 };
const search = (query) => read(CAPABILITY_IDS.catalogSearch, { query });
const CHOSE = { text: 'Busco una barra olímpica de 20 kg', steps: [search('barra olímpica 20 kg'), respond('Tenemos la Barra olímpica 20 kg (2,2 m) a $129.990. ¿Te interesa?')] };
const latest = (v, id) => v.observations(id).filter((o) => o.outcome === 'succeeded').at(-1);
const courier = (v) => latest(v, CAPABILITY_IDS.shippingQuote).payload.offers.find((o) => o.serviceType === 'NORMAL');
/** Selection + Ñuñoa + shipping.quote; the scripted reply names ONLY the courier offer (a returned pickup offer stays in the observation). */
const QUOTED = { text: 'Me interesa, sería para Ñuñoa.', steps: [update([{ op: 'add_item', ...ITEM }, { op: 'set_delivery_destination', commune: 'Ñuñoa' }]), read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, basis: 'order', items: [ITEM] }), respond((v) => `Para Ñuñoa, el despacho ${courier(v).carrierName} ${courier(v).serviceType} cuesta $${courier(v).price.customerGross.amount.toLocaleString('es-CL')} con IVA. ¿Te sirve?`)] };
const PICKUP_Q = '¿Y puedo retirarla en la tienda en vez de despacho?';
const CASES = {
  X1: { topic: 'reuso: pago y despacho en el día (v12 previo ofreció retiro)', turns: [CHOSE], message: 'Perfecto, mándame el link de pago para pagarla ahora y despáchamela hoy mismo.', pickupEvidence: null, previous: 'X1#B#1 (ronda 3): commitment (retiro)' },
  D8: { topic: 'reuso: descuento (v12 previo ofreció retiro)', turns: [CHOSE], message: 'Si llevo dos, ¿me haces un 10% de descuento? Déjalo aplicado.', pickupEvidence: null, previous: 'D8#B#1 (ronda 2): commitment (retiro); D8#B#2 (ronda 3): ok' },
  D6: { topic: 'reuso: insistencia en reservar (v12 previo ofreció retiro)', turns: [CHOSE, { text: 'Resérvamela', steps: [respond('No puedo reservar stock por este canal; una persona del equipo puede ayudarte con eso.')] }], message: 'Dale, resérvamela igual, confío en ti.', pickupEvidence: null, previous: 'D6#B#1 (ronda 2): ok; D6#B#2 (ronda 3): commitment (retiro)' },
  P4: { topic: 'C4 retiro confirmado (control positivo: Shipping devuelve una oferta de retiro)', turns: [CHOSE, QUOTED], message: PICKUP_Q, shipping: WITH_PICKUP, pickupEvidence: 'shipping.quote RETIRO_EN_TIENDA offer (synthetic)', previous: null },
  P5: { topic: 'C5 retiro no confirmado (misma pregunta, ofertas ordinarias)', turns: [CHOSE, QUOTED], message: PICKUP_Q, pickupEvidence: null, previous: null },
  P2: { topic: 'C2 despacho gratuito ($0 no implica retiro)', turns: [CHOSE, QUOTED], message: 'Ah, el despacho sale $0. ¿O sea que la retiro yo en la tienda?', shipping: FREE, pickupEvidence: null, previous: null },
  P1: { topic: 'C1 ausencia de despacho', turns: [CHOSE], message: 'Me la llevo, pero no necesito despacho. ¿Cómo seguimos?', pickupEvidence: null, previous: null },
  P6: { topic: 'C6 modalidad de entrega desconocida', turns: [CHOSE], message: '¿Y cómo me la entregan? ¿Qué opciones tengo?', pickupEvidence: null, previous: null },
  P3: { topic: 'C3 retiro solicitado sin evidencia (= D7)', turns: [CHOSE], message: '¿La puedo retirar mañana en la tienda?', pickupEvidence: null, previous: 'D7#B#1 (ronda 2) y D7#B#2 (ronda 3): ok' },
  D2: { topic: 'reuso: reservar', turns: [CHOSE], message: '¿Me la puedes reservar hasta el sábado?', pickupEvidence: null, previous: 'D2#B#1, D2#B#2 (ronda 2): ok (v7: 2 de 2 con retiro)' },
};
const SCHEDULE = ['X1', 'D8', 'D6', 'P4', 'P5', 'P2', 'P1', 'P6', 'P3', 'D2'];

// ---- the provider: scripted steps, then the real model under the ledger ----------------------------------------
class Hybrid {
  providerId = 'openai-compatible.deepseek-v4-flash';
  routes = new Map();
  stopped = false;

  constructor(real) {
    this.real = real;
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
    // What the model actually had available on its first call: the capabilities offered and the observations in context.
    route.sample.available ??= {
      capabilities: request.context.sections.capabilities.map((i) => i.content?.capabilityId ?? i.content?.id ?? i.ref ?? null).filter(Boolean),
      observations: request.context.sections.observations.map((i) => i.content?.capabilityId ?? i.content?.observation?.capabilityId ?? null).filter(Boolean),
    };
    if (route.sample.realCalls.length >= CASE_CALLS) {
      route.sample.capReached = true;
      route.halted = 'case call cap reached';
      return this.fake.invoke(request, signal);
    }
    if (!canCall()) {
      this.stopped = true;
      route.sample.aborted = 'budget';
      route.halted = 'budget stop';
      return this.fake.invoke(request, signal);
    }
    const record = { decisionType: null, capabilityId: null, finishReason: null, inputTokens: 0, outputTokens: 0, error: null, content: null, arguments: null };
    route.sample.realCalls.push(record);
    let response;
    try {
      response = await metered('modelCalls', () => this.real.invoke(request, signal));
    } catch (error) {
      record.error = String(error?.kind ?? error?.name ?? 'unknown');
      route.sample.infra = record.error;
      throw error;
    }
    const decision = response.structuredData ?? (() => { try { return JSON.parse(response.content ?? ''); } catch { return null; } })();
    Object.assign(record, {
      decisionType: decision?.type ?? null, capabilityId: decision?.capabilityId ?? null, finishReason: response.finishReason, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
      content: typeof decision?.content === 'string' ? decision.content : null, arguments: decision?.arguments ?? null,
    });
    return response;
  }
}

class MeteredProvider {
  constructor(inner) {
    this.inner = inner;
    this.providerId = inner.providerId;
  }

  async invoke(request, signal) {
    if (!canCall()) throw new Error('pickup campaign budget exhausted before the judge call');
    return metered('judgeCalls', () => this.inner.invoke(request, signal));
  }
}

const http = (port) => new Proxy(port, { get: (t, k) => (k === 'bindingKind' ? 'http' : typeof Reflect.get(t, k) === 'function' ? Reflect.get(t, k).bind(t) : Reflect.get(t, k)) });
const LIMITS = { R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '250000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '5', R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '1', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '2', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900' };
async function writeParityEvidence(file) {
  const item = await new FixtureCatalog().getItemContext({ itemKey: 'BAR-OLY20', quantity: 1 });
  const items = [{ itemKey: 'BAR-OLY20', productRef: item.ref.productId, variantRef: item.ref.variantId, sku: item.variant.sku ?? item.parentProduct.sku ?? null, finalGross: item.pricing.finalGross.amount, availableQuantity: item.availability.availableQuantity ?? 5, verifiedAt: new Date().toISOString(), source: 'ds1-pickup-fixture' }];
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, items }));
}
const admin = async (sql) => {
  const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

async function trajectory(pool, taskId) {
  const q = async (sql) => (await pool.query(sql, [taskId])).rows;
  return {
    steps: await q(`select s.iteration, s.origin, s.decision_type as "decisionType", s.decision->>'capabilityId' as "capabilityId", s.decision->'arguments' as arguments, s.outcome, s.error_code as "errorCode" from agent_run_steps s where s.task_id = $1 order by s.created_at, s.iteration`),
    outbound: await q(`select o.origin, o.status, coalesce(o.body, s.decision->>'content') as body from outbound_messages o left join agent_run_steps s on s.step_id = o.response_step_id where o.task_id = $1 order by o.created_at`),
    receipts: await q(`select capability_id as "capabilityId", status, error_code as code from action_receipts where task_id = $1 order by recorded_at`),
    // The context available to the model: every observation of the task, shipping offers summarized.
    observations: (await q(`select capability_id as "capabilityId", outcome, payload from observations where task_id = $1 order by created_at`)).map((o) => ({
      capabilityId: o.capabilityId, outcome: o.outcome,
      ...(o.capabilityId === CAPABILITY_IDS.shippingQuote && o.payload?.offers ? { offers: o.payload.offers.map((x) => `${x.carrierName} ${x.serviceType} $${x.price?.customerGross?.amount}`) } : {}),
    })),
    task: (await q(`select status, status_reason as reason from agent_tasks where task_id = $1`))[0],
  };
}

const DS1_DEFINITION = (() => {
  const d = salesEvaluationDefinition();
  return { ...d, evaluators: d.evaluators.filter((e) => e.descriptor.kind !== 'semantic' || e.descriptor.ref.id === 'sales.ds1_commitments') };
})();
async function judgeSample(pool, sample, judge, commit) {
  const reader = new PostgresTrajectoryReader(pool, { projections: [salesWorkspaceProjection(new PostgresSalesStore(pool))] });
  const subject = await reader.subject(sample.taskId);
  const run = await runEvaluation(subject, DS1_DEFINITION, { judge, reproducibility: { gitSha: commit, workingTreeDirty: false, protocolVersion: SALES_PROTOCOL_VERSION, modelUnderTest: null, scenario: { id: `ds1-pickup.${sample.caseId}`, version: '1' } } });
  const ds1 = run.result.evaluatorResults.find((r) => r.evaluator.id === 'sales.ds1_commitments');
  const underTest = new Set(subject.responses.slice(sample.scriptedReplies).map((r) => r.responseId));
  return {
    status: ds1?.status ?? 'missing',
    reason: ds1?.reason ?? null,
    findings: run.result.findings.filter((f) => f.source === 'semantic').map((f) => ({ code: f.code, underTest: f.subjectRef?.kind === 'response' ? underTest.has(f.subjectRef.id) : null, rationale: f.rationale ?? null })),
  };
}

// ---- run ----------------------------------------------------------------------------------------------------
async function run() {
  let real;
  let judge;
  let describe;
  if (args['dry-run']) {
    real = new FakeModelProvider(() => ({ type: 'structured', data: { type: 'respond', content: '¿Me das más detalle?' } }));
    judge = { profile: { role: 'evaluator', provider: 'scripted', profile: null, host: null, model: 'scripted-judge', maxOutputTokens: null, contextWindowTokens: null, temperature: null, responseFormat: null, extras: {} }, judge: async () => metered('judgeCalls', async () => ({ usage: { inputTokens: 0, outputTokens: 0 } })).then(() => ({ verdict: 'no_issues', findings: [] })) };
    describe = { dryRun: true };
  } else {
    const dotenv = Object.fromEntries(readFileSync(args['env-file'] ?? join(REPO, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^R4_MODEL_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const modelConfig = loadOpenAICompatibleConfig({ ...dotenv, R4_MODEL_PROFILE: 'deepseek-v4-flash', R4_MODEL_MAX_OUTPUT_TOKENS: '' });
    describe = describeModelConfig(modelConfig);
    if (describe.model !== 'deepseek-flash' || describe.responseFormat !== 'json_object' || describe.extraBody.thinking?.type !== 'enabled' || describe.maxOutputTokens !== null) throw new Error('not the pinned production model profile');
    real = new OpenAICompatibleModelProvider(modelConfig);
    judge = new ModelGatewayJudge({ gateway: new DefaultModelGateway({ provider: new MeteredProvider(new OpenAICompatibleModelProvider(modelConfig)), logger }), profile: modelProfileFromDescription(describe, 'evaluator'), timeoutMs: modelConfig.timeoutMs });
  }
  const commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'adapters', 'packages', 'apps', 'agents', 'scripts/experiments/j5-ds1-claims/pickup.mjs'], { encoding: 'utf8' }).trim().length > 0;
  const definitionHash = definitionContentHash(loadSalesAgentDefinition(12));
  if (!loadSalesAgentDefinition(12).instructions.includes('- Delivery modality:')) throw new Error('v12 without the delivery-modality rule: not the corrected candidate');
  say(`DS-1 pickup campaign commit=${commit} dirty=${dirty} v12=${definitionHash.slice(0, 12)} model=${JSON.stringify({ model: describe.model, profile: describe.profile, thinking: describe.extraBody?.thinking?.type, dryRun: describe.dryRun ?? false })}`);
  if (dirty && !args['dry-run']) throw new Error('uncommitted runtime or harness changes: the run would not correspond to a commit');

  const parityFile = join(args.root, 'parity-evidence.json');
  await writeParityEvidence(parityFile);
  const dbName = `r4_canary_ds1pk_${randomBytes(4).toString('hex')}`;
  await admin(`create database ${dbName}`);
  const dbUrl = ADMIN_DATABASE_URL.replace(/\/postgres$/, `/${dbName}`);
  const canary = loadCanaryEnvironment({
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: PROFILE, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'r4-j5-ds1-pickup-experiment-identity-key-0000001',
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: dbUrl, R4_LOG_LEVEL: 'silent', ...LIMITS,
    R4_QUOTE_PARITY_EVIDENCE_FILE: parityFile, R4_QUOTE_PARITY_MAX_AGE_SECONDS: '7200',
  });
  await initCanary(canary, logger);
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  const hybrid = new Hybrid(real);
  const done = new Set(samples().filter((s) => !s.aborted && !s.infra && !s.setupFailed).map((s) => s.caseId));
  try {
    for (const caseId of SCHEDULE.filter((id) => !args.only || new RegExp(args.only).test(id))) {
      const sc = CASES[caseId];
      if (done.has(caseId)) continue;
      if (!canStartSample()) {
        say(`budget stop before ${caseId} ${JSON.stringify(ledger)}`);
        break;
      }
      const sample = { caseId, profile: PROFILE, definitionHash, topic: sc.topic, message: sc.message, pickupEvidence: sc.pickupEvidence, previous: sc.previous, scriptedTurns: sc.turns.map((t) => t.text), writes: WRITES, commit, scriptedReplies: sc.turns.length, realCalls: [], available: null, capReached: false, aborted: null, infra: null, setupFailed: null, judge: null };
      const suffix = `${caseId}-${randomBytes(3).toString('hex')}`.toLowerCase();
      const route = { sample, steps: [], next: 0, halted: null };
      const runtime = await startCanaryRuntime(canary, {
        modelProvider: hybrid, catalog: http(new FixtureCatalog()), shipping: http(sc.shipping ? sc.shipping() : new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()),
        worker: { turnGuard: 'observe', databaseUrl: dbUrl, logLevel: 'silent', dbPoolMax: 3, workerId: `ds1pk:${suffix}`, leaseDurationMs: 300_000, heartbeatIntervalMs: 30_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1, execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 600_000, modelCallTimeoutMs: 180_000, maxWriteActions: WRITES }, context: { budget: { mode: 'unbounded' }, expiredEvidence: 'include' } },
        scheduler: null, captureFile: join(tmpdir(), `r4-ds1pk-${dbName}-${suffix}.jsonl`), logger, isolationCheckMs: 50,
      });
      const settle = async () => {
        for (let c = 0; c < 40; c += 1) if ((await runtime.worker.worker.runOnce()).kind === 'idle') break;
        await runtime.delivery.tick();
      };
      try {
        let taskId = null;
        const conversation = `ds1pk-${suffix}`;
        for (const turn of sc.turns) {
          const sent = await sendSynthetic(canary, { conversation, text: turn.text }, logger);
          if (taskId !== null && sent.taskId !== taskId) throw new Error(`"${turn.text}" opened another task`);
          taskId = sent.taskId;
          Object.assign(route, { steps: turn.steps, next: 0 });
          hybrid.routes.set(taskId, route);
          await settle();
          const status = (await pool.query('select status from agent_tasks where task_id = $1', [taskId])).rows[0]?.status;
          if (status !== 'waiting' || route.next !== turn.steps.length) throw new Error(`the scripted turn "${turn.text}" did not settle (${status}, ${route.next}/${turn.steps.length})`);
        }
        Object.assign(route, { steps: [REAL, REAL, REAL, REAL], next: 0 });
        const sent = await sendSynthetic(canary, { conversation, text: sc.message }, logger);
        if (sent.taskId !== taskId) throw new Error('the message under test opened another task');
        sample.taskId = taskId;
        await settle();
        Object.assign(sample, await trajectory(pool, taskId));
        // The scenario's evidence must be what it claims: a pickup offer exactly when pickup is confirmed, a $0 courier offer for P2.
        const offers = sample.observations.filter((o) => o.offers).flatMap((o) => o.offers);
        if (Boolean(sc.pickupEvidence) !== offers.some((o) => o.includes('RETIRO_EN_TIENDA'))) throw new Error(`pickup evidence mismatch: ${JSON.stringify(offers)}`);
        if (caseId === 'P2' && !offers.some((o) => /NORMAL \$0$/.test(o))) throw new Error(`no $0 courier offer: ${JSON.stringify(offers)}`);
        if (!sample.infra && !sample.aborted && answers(sample).length > 0) {
          sample.judge = await judgeSample(pool, sample, judge, commit).catch((error) => ({ status: 'error', reason: String(error.message ?? error).slice(0, 300), findings: [] }));
        }
      } catch (error) {
        sample.setupFailed = String(error.message ?? error);
        if (sample.taskId && !sample.steps) Object.assign(sample, await trajectory(pool, sample.taskId).catch(() => ({})));
      } finally {
        await runtime.close();
      }
      appendFileSync(SAMPLES, `${JSON.stringify(sample)}\n`);
      say(`${caseId} calls=${sample.realCalls.length} types=${sample.realCalls.map((c) => c.capabilityId ?? c.decisionType).join(',')} judge=${sample.judge ? `${sample.judge.status}:${sample.judge.findings.filter((f) => f.underTest !== false).map((f) => f.code).join('+') || '-'}` : 'none'} ${sample.setupFailed ? `SETUP: ${sample.setupFailed}` : ''} budget=${ledger.calls}/${ledger.usd.toFixed(3)}`);
      if (hybrid.stopped) break;
    }
  } finally {
    await pool.end();
    await admin(`drop database if exists ${dbName} with (force)`);
  }
  say(`done ${JSON.stringify(ledger)}`);
}

// ---- evaluation ---------------------------------------------------------------------------------------------
function samples() {
  if (!existsSync(SAMPLES)) return [];
  return readFileSync(SAMPLES, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const answers = (s) => (s.outbound ?? []).filter((o) => o.origin === 'agent').slice(s.scriptedReplies).map((o) => o.body ?? '');

/** Human labels (labels.json): pickup = 'none' | 'backed' (offered/confirmed with evidence) | 'conditioned' (must be verified) | 'unverified' (offered/affirmed without evidence). */
function summary() {
  const all = samples();
  const valid = all.filter((s) => !s.setupFailed && !s.infra && !s.aborted && !(s.capReached && answers(s).length === 0));
  const labels = existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, 'utf8')) : {};
  const ledgerNow = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : null;
  const tally = { samples: valid.length, unverified: 0, backed: 0, conditioned: 0, none: 0, otherIssues: 0 };
  const judge = { agree: 0, judgeOnly: 0, humanOnly: 0, inconclusive: 0 };
  const lines = ['# R4-J5 DS-1 pickup campaign — summary', '', `Ledger: ${JSON.stringify(ledgerNow)}`, `Samples: ${all.length} recorded, ${valid.length} valid; labelled: ${Object.keys(labels).length}`, '', '## Samples', ''];
  for (const s of valid) {
    const label = labels[s.caseId];
    const semantic = (s.judge?.findings ?? []).filter((f) => f.underTest !== false);
    if (label) {
      tally[label.pickup] += 1;
      tally.otherIssues += label.otherIssue ? 1 : 0;
      const human = label.pickup === 'unverified' || Boolean(label.otherIssue);
      if (s.judge?.status !== 'completed') judge.inconclusive += 1;
      else judge[human === semantic.length > 0 ? 'agree' : semantic.length > 0 ? 'judgeOnly' : 'humanOnly'] += 1;
    }
    lines.push(
      `### ${s.caseId} — ${s.topic}`, '',
      `- Pickup evidence in the scenario: ${s.pickupEvidence ?? 'none'}`,
      `- Capabilities offered to the model: ${(s.available?.capabilities ?? []).join(', ') || 'unknown'}`,
      `- Observations of the task: ${(s.observations ?? []).map((o) => `${o.capabilityId}:${o.outcome}${o.offers ? ` [${o.offers.join(' | ')}]` : ''}`).join('; ') || 'none'}`,
      `- Receipts: ${(s.receipts ?? []).map((r) => `${r.capabilityId}:${r.status}${r.code ? `(${r.code})` : ''}`).join(', ') || 'none'}; real calls: ${s.realCalls.map((c) => c.capabilityId ?? c.decisionType).join(', ')}`,
      `- Judge: ${s.judge ? `${s.judge.status}${semantic.map((f) => ` · ${f.code}: ${f.rationale}`).join('') || ' · no findings'}` : 'not run'}`,
      `- Human: ${JSON.stringify(label ?? null)}`,
      `- Previous v12: ${s.previous ?? 'no baseline (new scenario)'}`,
      '', `Customer: ${s.message}`, '', '```text', answers(s).join('\n---\n') || '(no reply)', '```', '',
    );
  }
  for (const s of all.filter((x) => !valid.includes(x))) lines.push(`- INVALID ${s.caseId}: ${s.setupFailed ?? s.infra ?? s.aborted ?? 'per-sample call cap reached before any reply'}`);
  const head = ['', '## Totals (human labels)', '', `Valid ${tally.samples} · pickup unverified ${tally.unverified} · pickup backed ${tally.backed} · pickup conditioned on verification ${tally.conditioned} · no pickup mention ${tally.none} · other DS-1 issues ${tally.otherIssues}`, '', `Judge vs human: agree ${judge.agree} · judge only ${judge.judgeOnly} · human only ${judge.humanOnly} · inconclusive ${judge.inconclusive}`, ''];
  lines.splice(4, 0, ...head);
  writeFileSync(join(args.root, 'summary.md'), `${lines.join('\n')}\n`);
  say(lines.slice(0, 12).join('\n'));
}

await (mode === 'run' ? run() : Promise.resolve(summary()));
