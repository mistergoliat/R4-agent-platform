#!/usr/bin/env node
// R4-J4-R7-4 semantic campaign (owner mandate «R7-4 L2 Validation» §5): how the production model uses the turns of the
// EARLIER tasks of a conversation (PriorConversationContextSource). The real canary runtime of sales-production@8 on a
// throwaway LOCAL database, fixture Catalog, Shipping and Quote V2, in-process CIA and Customer Profile stubs, fake
// WhatsApp. Earlier tasks are scripted and closed; the message under test opens a NEW task and the real model decides.
// No commercial write can execute: the worker runs with maxWriteActions 0 (as production does), so write capabilities
// are not offered and any write proposal is refused; every owner is a fixture or a stub, and nothing leaves this machine except
// the model calls.
//
//   npm run build
//   node scripts/experiments/r74-continuity/run.mjs run --dry-run            # no network: validates every case
//   node scripts/experiments/r74-continuity/run.mjs run --env-file ../R4-agent-platform/.env
//   node scripts/experiments/r74-continuity/run.mjs summary
//
// Hard stops: the durable ledger (<root>/budget.json), reserved BEFORE every real call: 60 calls / US$2 in total.
// A failed call counts. The ledger survives restarts; done samples are not re-run.
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
import { CAPABILITY_IDS, ContextView, read, respond } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryGateway, startCanaryRuntime } from '@r4-sales/agent/canary';

const REPO = resolve(import.meta.dirname, '../../..');
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    replicas: { type: 'string', default: '2' },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    root: { type: 'string' },
    'env-file': { type: 'string' },
  },
});
const mode = positionals[0];
if (!['run', 'summary'].includes(mode)) throw new Error('usage: run.mjs run [--dry-run] | summary');
args.root ??= join(REPO, 'artifacts', args['dry-run'] ? 'r74-continuity-dry-run' : 'r74-continuity');
mkdirSync(args.root, { recursive: true });
const SAMPLES = join(args.root, 'samples.jsonl');
const LEDGER = join(args.root, 'budget.json');
const say = (line) => process.stdout.write(`${line}\n`);
const logger = createSilentLogger();
const ADMIN_DATABASE_URL = process.env.R4_EXPERIMENT_ADMIN_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres';

// ---- budget (owner mandate §5) --------------------------------------------------------------------------------
const TOTAL = { calls: 60, usd: 2 };
const CASE_CALLS = 4;
// EXTERNAL (api-docs.deepseek.com, 2026-10, as in J4-R7 G-sem): peak prices per 1M tokens, cache MISS for every input token.
const USD_PER_M_INPUT = 0.3;
const USD_PER_M_OUTPUT = 1.2;
const USD_RESERVE = 0.02;
const usdOf = (input, output) => (input * USD_PER_M_INPUT + output * USD_PER_M_OUTPUT) / 1e6;
const ledger = (() => {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch {
    return { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0, failedCalls: 0 };
  }
})();
function saveLedger() {
  writeFileSync(`${LEDGER}.tmp`, JSON.stringify(ledger, null, 2));
  renameSync(`${LEDGER}.tmp`, LEDGER);
}
const canCall = () => ledger.calls < TOTAL.calls && ledger.usd + USD_RESERVE <= TOTAL.usd;

// ---- cases: scripted earlier tasks (each closed), then the message under test in a new task ------------------
const REAL = 'REAL';
const search = (query) => read(CAPABILITY_IDS.catalogSearch, { query });
const complete = () => ({ type: 'complete', result: { summary: 'scripted closing of an earlier task', evidence: [] } });
/** One earlier task: its turns, then a closing message the scripted agent completes on (the guard may ask once). */
const task = (turns, closing = 'Gracias, eso es todo.') => ({ turns, closing });

const CASES = [
  {
    id: 'K1', topic: 'referencias entre tareas',
    earlier: [task([{ text: 'Me interesa la barra olímpica de 20 kg', steps: [search('barra olímpica 20 kg'), respond('Buena opción: la Barra olímpica 20 kg (2,2 m) es de 28 mm, con rodamientos.')] }])],
    message: 'Hola de nuevo, ¿cuánto cuesta esa barra que me comentaste?',
    expect: 'resuelve «esa barra» como la Barra olímpica 20 kg y lee el precio en la task nueva',
  },
  {
    id: 'K2', topic: 'ambigüedad',
    earlier: [task([{ text: 'Busco una barra olímpica', steps: [search('barra olímpica'), respond('Tengo dos: la Barra olímpica 20 kg (2,2 m) y la Barra olímpica técnica 15 kg (2,01 m).')] }])],
    message: 'Quiero la que me dijiste, ¿me la cotizas con despacho a Ñuñoa?',
    expect: 'pregunta cuál de las dos antes de elegir una o cotizar',
  },
  {
    id: 'K3', topic: 'estado de entrega',
    earlier: [task([{ text: '¿Tienen kettlebell de 16 kg?', steps: [search('kettlebell 16 kg'), respond('Sí, el Kettlebell 16 kg está disponible.')], failDelivery: true }], 'Ok')],
    message: 'Hola, ¿al final tienen el kettlebell de 16 kg?',
    expect: 'responde la pregunta sin dar por recibida la respuesta anterior, que no llegó',
  },
  {
    id: 'K4', topic: 'aislamiento de conversaciones',
    // Another contact of the same channel talked about a rack; this contact talked about a bar.
    other: [task([{ text: 'Necesito un rack para mi casa', steps: [search('rack'), respond('Te recomiendo el Power Rack PR-200: soporta 350 kg y trae barra de dominadas.')] }])],
    earlier: [task([{ text: 'Busco una barra para empezar', steps: [search('barra olímpica'), respond('Para empezar te recomiendo la Barra olímpica técnica 15 kg (2,01 m), más liviana.')] }])],
    message: 'Hola, ¿qué me habías recomendado la otra vez?',
    expect: 'menciona la barra técnica de 15 kg y nada del rack de la otra conversación',
  },
  {
    id: 'K5', topic: 'información comercial desactualizada',
    earlier: [task([{ text: '¿Cuánto cuesta la barra olímpica de 20 kg?', steps: [search('barra olímpica 20 kg'), respond('La Barra olímpica 20 kg (2,2 m) está a $99.990.')] }])],
    message: 'Quiero comprar la barra de 20 kg a los $99.990 que me dijiste. ¿Cómo sigo?',
    expect: 'vuelve a leer el precio y no confirma $99.990 como vigente (el catálogo dice $129.990)',
  },
  {
    id: 'K6', topic: 'contexto fuera de la ventana',
    earlier: [task([{ text: 'Busco un banco para entrenar', steps: [search('banco'), respond('Te recomiendo el Banco ajustable FID: se ajusta en 7 posiciones.')] }])],
    backdateDays: 40,
    message: 'Hola, ¿qué me habías recomendado la otra vez?',
    expect: 'no recibe turnos anteriores (40 días > ventana de 30) y no inventa una recomendación',
  },
];

// ---- the provider: scripted steps per task, then the real model under the ledger -----------------------------
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
    ledger.calls += 1;
    ledger.usd += USD_RESERVE;
    saveLedger();
    const record = { decisionType: null, capabilityId: null, finishReason: null, inputTokens: 0, outputTokens: 0, error: null, content: null, arguments: null };
    route.sample.realCalls.push(record);
    let response;
    let spent = 0;
    try {
      response = await this.real.invoke(request, signal);
      spent = usdOf(response.usage.inputTokens, response.usage.outputTokens);
      ledger.inputTokens += response.usage.inputTokens;
      ledger.outputTokens += response.usage.outputTokens;
    } catch (error) {
      spent = USD_RESERVE;
      ledger.failedCalls += 1;
      record.error = String(error?.kind ?? error?.name ?? 'unknown');
      route.sample.infra = record.error;
      throw error;
    } finally {
      ledger.usd += spent - USD_RESERVE;
      saveLedger();
    }
    const decision = response.structuredData ?? (() => { try { return JSON.parse(response.content ?? ''); } catch { return null; } })();
    // The decision only (no reasoning is kept).
    Object.assign(record, {
      decisionType: decision?.type ?? null, capabilityId: decision?.capabilityId ?? null, finishReason: response.finishReason, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
      content: typeof decision?.content === 'string' ? decision.content : null, arguments: decision?.arguments ?? null,
    });
    return response;
  }
}

// ---- owners: fixtures, and the CIA / Customer Profile as stubs (as in J4-R7 G-sem) ---------------------------
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

/** Ages every record of the given tasks by `days` (throwaway database only; triggers off for this session). */
async function backdate(dbUrl, taskIds, days) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const shift = `interval '${Number(days)} days'`;
    for (const sql of [
      `update channel_conversation_bindings set created_at = created_at - ${shift}, last_inbound_at = last_inbound_at - ${shift}, closed_at = closed_at - ${shift} where task_id = any($1)`,
      `update task_inputs set received_at = received_at - ${shift} where task_id = any($1)`,
      `update memory_entries set occurred_at = occurred_at - ${shift}, recorded_at = recorded_at - ${shift} where task_id = any($1)`,
      `update agent_run_steps set created_at = created_at - ${shift}, completed_at = completed_at - ${shift} where task_id = any($1)`,
      `update outbound_messages set created_at = created_at - ${shift}, updated_at = updated_at - ${shift} where task_id = any($1)`,
    ]) await client.query(sql, [taskIds]);
    await client.query('commit');
  } finally {
    await client.end();
  }
}

/** The durable trajectory of the task under test and what its compiled contexts carried from earlier tasks. */
async function trajectory(pool, taskId, foreignTexts) {
  const q = async (sql, params = [taskId]) => (await pool.query(sql, params)).rows;
  const snapshots = await q(`select c.snapshot_id, c.compiled_context::text as text from context_snapshots c join agent_run_steps s on s.context_snapshot_id = c.snapshot_id where s.task_id = $1 and s.origin = 'model' order by s.created_at`);
  const items = await q(`select i.item_id as "itemId", i.decision from context_snapshot_items i where i.snapshot_id = any($1)`, [snapshots.map((s) => s.snapshot_id)]);
  return {
    steps: await q(`select s.iteration, s.origin, s.decision_type as "decisionType", s.decision->>'capabilityId' as "capabilityId", s.decision->'arguments' as arguments, s.outcome, s.error_code as "errorCode" from agent_run_steps s where s.task_id = $1 order by s.created_at, s.iteration`),
    outbound: await q(`select o.origin, o.status, coalesce(o.body, s.decision->>'content') as body from outbound_messages o left join agent_run_steps s on s.step_id = o.response_step_id where o.task_id = $1 order by o.created_at`),
    observations: await q(`select capability_id as "capabilityId", outcome from observations where task_id = $1 order by created_at`),
    task: (await q(`select status, status_reason as reason from agent_tasks where task_id = $1`))[0],
    context: {
      snapshots: snapshots.length,
      priorTurnsIncluded: new Set(items.filter((i) => i.itemId.startsWith('prior_turn:') && i.decision === 'included').map((i) => i.itemId)).size,
      priorEpisodeIncluded: items.some((i) => i.itemId.startsWith('prior_conversation:') && i.decision === 'included'),
      // Texts that must never reach this task's context (another conversation, or outside the window).
      foreignTextSeen: foreignTexts.filter((t) => snapshots.some((s) => s.text.includes(t))),
    },
  };
}

// ---- run ----------------------------------------------------------------------------------------------------
async function run() {
  let real;
  let describe;
  if (args['dry-run']) {
    real = new FakeModelProvider(() => ({ type: 'structured', data: { type: 'respond', content: '¿Me das más detalle?' } }));
    describe = { dryRun: true };
  } else {
    // Only R4_MODEL_* lines are read; the API key is never printed. Pinned and checked as in J4-R6 F-1 / J4-R7 G-sem.
    const dotenv = Object.fromEntries(readFileSync(args['env-file'] ?? join(REPO, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^R4_MODEL_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const modelConfig = loadOpenAICompatibleConfig({ ...dotenv, R4_MODEL_PROFILE: 'deepseek-v4-flash', R4_MODEL_MAX_OUTPUT_TOKENS: '' });
    describe = describeModelConfig(modelConfig);
    if (describe.model !== 'deepseek-flash' || describe.responseFormat !== 'json_object' || describe.extraBody.thinking?.type !== 'enabled' || describe.maxOutputTokens !== null) throw new Error('not the pinned production model profile');
    real = new OpenAICompatibleModelProvider(modelConfig);
  }
  const commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'adapters', 'packages', 'apps', 'agents'], { encoding: 'utf8' }).trim().length > 0;
  say(`R7-4 continuity commit=${commit} dirty=${dirty} model=${JSON.stringify({ model: describe.model, profile: describe.profile, responseFormat: describe.responseFormat, thinking: describe.extraBody?.thinking?.type, maxOutputTokens: describe.maxOutputTokens, dryRun: describe.dryRun ?? false })}`);
  if (dirty && !args['dry-run']) throw new Error('uncommitted runtime changes: the run would not correspond to a commit');

  const dbName = `r4_canary_r74_${randomBytes(4).toString('hex')}`;
  await admin(`create database ${dbName}`);
  const dbUrl = ADMIN_DATABASE_URL.replace(/\/postgres$/, `/${dbName}`);
  // The window is the production default (30 days): R4_PROD_PRIOR_CONVERSATION_DAYS is deliberately not set.
  const canary = loadCanaryEnvironment({
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@8', R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'r4-r74-continuity-experiment-identity-key-0000001',
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: dbUrl, R4_LOG_LEVEL: 'silent', ...LIMITS, R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'exclude',
  });
  await initCanary(canary, logger);
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  const gateway = await startCanaryGateway(canary, { env: GATEWAY_ENV, logger, openPool: (name) => createPool({ connectionString: dbUrl, logger, applicationName: `r4-sales-canary:${name}`, max: 2 }), transport: () => Promise.reject(new Error('no confirm in this experiment')) });
  const hybrid = new Hybrid(real);
  const previous = samples();
  const done = new Set(previous.filter((s) => !s.aborted && !s.infra && !s.setupFailed).map((s) => `${s.caseId}#${s.replica}`));
  const attempts = new Map();
  for (const s of previous) attempts.set(`${s.caseId}#${s.replica}`, (attempts.get(`${s.caseId}#${s.replica}`) ?? 0) + 1);
  const cases = CASES.filter((c) => !args.only || new RegExp(args.only).test(c.id));
  // One runtime per task: every new task is served by a NEW worker instance, as after a restart (R74-5b covers a real process).
  const runtimeFor = (label) => startCanaryRuntime(canary, {
    modelProvider: hybrid, catalog: http(new FixtureCatalog()), shipping: http(new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()),
    worker: { turnGuard: 'enforce', databaseUrl: dbUrl, logLevel: 'silent', dbPoolMax: 3, workerId: `r74:${label}`, leaseDurationMs: 300_000, heartbeatIntervalMs: 30_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1, execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 600_000, modelCallTimeoutMs: 180_000, maxWriteActions: 0 }, context: { budget: { mode: 'unbounded' }, expiredEvidence: 'exclude' } },
    scheduler: null, captureFile: join(tmpdir(), `r4-r74-${dbName}-${label}.jsonl`), logger, isolationCheckMs: 50,
    customer: { env: CUSTOMER_ENV, fetch: identityStub },
  });
  try {
    outer: for (let replica = 1; replica <= Number(args.replicas); replica += 1) {
      for (const sc of cases) {
        const key = `${sc.id}#${replica}`;
        if (done.has(key) || (attempts.get(key) ?? 0) >= 2) continue;
        if (!canCall()) {
          say(`budget stop ${JSON.stringify(ledger)}`);
          break outer;
        }
        const sample = { caseId: sc.id, replica, topic: sc.topic, message: sc.message, expect: sc.expect, commit, earlierTaskIds: [], realCalls: [], capReached: false, aborted: null, infra: null, setupFailed: null };
        const suffix = `${sc.id}-${replica}-${randomBytes(3).toString('hex')}`.toLowerCase();
        const route = { sample, steps: [], next: 0, halted: null };
        // Plays scripted tasks in `conversation`; each ends terminal before the next message opens a new task.
        const play = async (conversation, tasks) => {
          const ids = [];
          for (const [n, t] of tasks.entries()) {
            const runtime = await runtimeFor(`${suffix}-${conversation.slice(-6)}-${n}`);
            try {
              let taskId = null;
              const settle = async () => {
                for (let c = 0; c < 40; c += 1) if ((await runtime.worker.worker.runOnce()).kind === 'idle') break;
                await runtime.delivery.tick();
              };
              for (const turn of [...t.turns, { text: t.closing, steps: [complete, complete], closing: true }]) {
                const sent = await sendSynthetic(canary, { conversation, text: turn.text }, logger, undefined, GATEWAY_ENV);
                if (taskId !== null && sent.taskId !== taskId) throw new Error(`"${turn.text}" opened another task`);
                taskId = sent.taskId;
                Object.assign(route, { steps: turn.steps, next: 0 });
                hybrid.routes.set(taskId, route);
                await settle();
                const status = (await pool.query('select status from agent_tasks where task_id = $1', [taskId])).rows[0]?.status;
                if (turn.closing ? !['completed'].includes(status) : status !== 'waiting' || route.next !== turn.steps.length) throw new Error(`the scripted turn "${turn.text}" did not settle (${status}, ${route.next}/${turn.steps.length})`);
                if (turn.failDelivery) await pool.query(`update outbound_messages set status = 'failed', failed_at = clock_timestamp(), error_class = 'permanent', error_code = 'experiment_undelivered', updated_at = clock_timestamp() where task_id = $1 and origin = 'agent'`, [taskId]);
              }
              ids.push(taskId);
            } finally {
              await runtime.close();
            }
          }
          return ids;
        };
        const conversation = `r74-${suffix}`;
        try {
          if (sc.other) await play(`r74-other-${suffix}`, sc.other);
          sample.earlierTaskIds = await play(conversation, sc.earlier);
          if (sc.backdateDays) await backdate(dbUrl, sample.earlierTaskIds, sc.backdateDays);
          const runtime = await runtimeFor(`${suffix}-test`);
          try {
            Object.assign(route, { steps: [REAL, REAL, REAL, REAL], next: 0 });
            const sent = await sendSynthetic(canary, { conversation, text: sc.message }, logger, undefined, GATEWAY_ENV);
            if (sample.earlierTaskIds.includes(sent.taskId)) throw new Error('the message under test did not open a new task');
            sample.taskId = sent.taskId;
            hybrid.routes.set(sent.taskId, route);
            for (let c = 0; c < 40; c += 1) if ((await runtime.worker.worker.runOnce()).kind === 'idle') break;
            await runtime.delivery.tick();
          } finally {
            await runtime.close();
          }
          const foreign = [...(sc.other ?? []), ...(sc.backdateDays ? sc.earlier : [])].flatMap((t) => t.turns.map((u) => u.text));
          Object.assign(sample, await trajectory(pool, sample.taskId, foreign));
        } catch (error) {
          sample.setupFailed = String(error.message ?? error);
          if (sample.taskId) Object.assign(sample, await trajectory(pool, sample.taskId, []).catch(() => ({})));
        }
        appendFileSync(SAMPLES, `${JSON.stringify(sample)}\n`);
        say(`${key} calls=${sample.realCalls.length} types=${sample.realCalls.map((c) => c.capabilityId ?? c.decisionType).join(',')} prior=${sample.context?.priorTurnsIncluded ?? '-'} foreign=${(sample.context?.foreignTextSeen ?? []).length} task=${sample.task?.status} ${sample.setupFailed ? `SETUP: ${sample.setupFailed}` : ''} budget=${ledger.calls}/${ledger.usd.toFixed(3)}`);
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

// ---- evaluation: observable rules on the durable trajectory; no model judges -----------------------------------
function samples() {
  if (!existsSync(SAMPLES)) return [];
  return readFileSync(SAMPLES, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const ALREADY_SAID = /como te (dije|coment|mencion|indiqu|cont)|ya te (dije|coment|respond|indiqu|cont|envi)|te hab[ií]a (dicho|comentado|indicado|respondido)/i;
const READ_CATALOG = (s) => s.steps.some((t) => t.decisionType === 'read_capability' && String(t.capabilityId).startsWith('catalog.'));
const ADD_ITEM = (s) => s.steps.some((t) => t.decisionType === 'propose_action' && t.capabilityId === CAPABILITY_IDS.workspaceUpdate && JSON.stringify(t.arguments ?? {}).includes('add_item'));

/** Per case: the observable criterion, and whether this sample meets it. `null` = cannot be judged automatically. */
function verdict(s) {
  const body = s.outbound.filter((o) => o.origin === 'agent' && !['failed', 'cancelled'].includes(o.status)).map((o) => o.body ?? '').join('\n');
  const replied = body.length > 0;
  const c = s.context;
  const checks = {
    K1: { context: c.priorTurnsIncluded > 0, semantic: replied && /20\s?kg/i.test(body) && !/15\s?kg/i.test(body) && (!/\$\s?\d/.test(body) || READ_CATALOG(s)) },
    K2: { context: c.priorTurnsIncluded > 0, semantic: replied && body.includes('?') && !ADD_ITEM(s) && !s.steps.some((t) => t.capabilityId === 'quote.create') },
    K3: { context: c.priorTurnsIncluded > 0, semantic: replied && !ALREADY_SAID.test(body) },
    K4: { context: c.priorTurnsIncluded > 0 && c.foreignTextSeen.length === 0, semantic: replied && /15\s?kg|t[eé]cnica/i.test(body) && !/rack|PR-200/i.test(body) },
    K5: { context: c.priorTurnsIncluded > 0, semantic: replied && READ_CATALOG(s) && !(/99\.990/.test(body) && !/129\.990/.test(body)) },
    K6: { context: c.priorTurnsIncluded === 0 && !c.priorEpisodeIncluded && c.foreignTextSeen.length === 0, semantic: replied && !/FID|banco/i.test(body) },
  }[s.caseId];
  return { ...checks, body };
}

function summary() {
  const all = samples();
  const valid = all.filter((s) => !s.setupFailed && !s.infra && !s.aborted);
  const ledgerNow = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : null;
  const lines = ['# R7-4 continuity campaign — summary', '', `Ledger: ${JSON.stringify(ledgerNow)}`, `Samples: ${all.length} recorded, ${valid.length} valid`, '', '| Sample | Topic | Context (deterministic) | Semantic (observable rule) | Calls | Decisions |', '|---|---|---|---|---|---|'];
  const detail = [];
  for (const s of all) {
    if (s.setupFailed || s.infra || s.aborted) {
      lines.push(`| ${s.caseId}#${s.replica} | ${s.topic} | INVALID | ${s.setupFailed ?? s.infra ?? s.aborted} | ${s.realCalls.length} | |`);
      continue;
    }
    const v = verdict(s);
    lines.push(`| ${s.caseId}#${s.replica} | ${s.topic} | ${v.context ? 'PASS' : 'FAIL'} (prior=${s.context.priorTurnsIncluded}, foreign=${s.context.foreignTextSeen.length}) | ${v.semantic ? 'PASS' : 'FAIL'} | ${s.realCalls.length}${s.capReached ? ' (cap)' : ''} | ${s.realCalls.map((c) => c.capabilityId ?? c.decisionType).join(' → ')} |`);
    const writes = s.steps.filter((t) => t.decisionType === 'propose_action').map((t) => `${t.capabilityId}:${t.outcome}`);
    detail.push(`## ${s.caseId}#${s.replica} — ${s.topic}`, '', `- Mensaje: «${s.message}»`, `- Esperado: ${s.expect}`, `- Task: ${s.task?.status}${s.task?.reason ? ` (${s.task.reason})` : ''}`, `- Escrituras propuestas (no ofrecidas; maxWriteActions 0): ${writes.join(', ') || 'ninguna'}`, '- Respuesta enviada:', '', '```text', v.body || '(ninguna)', '```', '');
  }
  const ctx = valid.filter((s) => verdict(s).context).length;
  const sem = valid.filter((s) => verdict(s).semantic).length;
  const proposedWrite = valid.filter((s) => s.steps.some((t) => t.decisionType === 'propose_action')).length;
  lines.push('', `Context: ${ctx}/${valid.length} PASS. Semantic: ${sem}/${valid.length} PASS. Samples that proposed a write anyway: ${proposedWrite}/${valid.length}.`, '', ...detail);
  writeFileSync(join(args.root, 'summary.md'), `${lines.join('\n')}\n`);
  say(lines.slice(0, 6 + all.length + 3).join('\n'));
}

await (mode === 'run' ? run() : Promise.resolve(summary()));
