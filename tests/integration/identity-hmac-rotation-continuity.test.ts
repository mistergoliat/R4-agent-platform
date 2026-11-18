import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompiledContext } from '@r4/contracts';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { createPlatform } from '@r4/api';
import { CaseIdleCloser, PRIOR_CONVERSATION_SOURCE_ID } from '@r4/live-ops';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, ContextView, QUOTE_RECOVERY_SOURCE_ID, SALES_AGENT_DIR, read, respond, type ScriptedStep } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryRuntime, type CanaryEnvironment } from '@r4-sales/agent/canary';
import { SALES_F1_CANARY_LIMITS } from '@r4-sales/agent/production';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { databaseUrlFor, testAdminDatabaseUrl } from '../support/env.js';
import { RECONCILIATION_POLICY, freezeTemporalClock } from '../support/temporal.js';

/**
 * Identity HMAC rotation on TODAY's conversation model (sales-production@22, quote recovery #85, case idle close #97,
 * prior-conversation carry-over): an isolated canary (real ingress, worker, delivery; scripted model; fixture owners)
 * builds a conversation with an issued quote, an idle-closed case and a newer case, plus a second tester. Then, with the
 * runtime stopped, the operator tools rotate the key (rotate.mjs) and prove continuity (continuity.mjs, which runs the
 * BUILT code's lineage queries: `npm run build` first). After the restart under the new key and the recomputed lists:
 * the next message lands on the same binding and task and the agent is shown the earlier quote; after another idle
 * close the new case still carries the lineage; the rollback (keys swapped) proves the same continuity; and a binding
 * opened under the old key after the rotation is caught.
 *
 * R4_ROTATION_REHEARSAL_DB=<name>: also leaves a copy of the seeded database (taken at the snapshot point, before the
 * rotation) under that name for ops/r4-identity-rotation/local-rehearsal.sh, which drops it.
 */
const run = promisify(execFile);
const logger = createSilentLogger();
const OLD = 'r4-test-rotation-old-identity-key-000000000001';
const NEW = 'r4-test-rotation-new-identity-key-000000000002';
const ROTATE = join(process.cwd(), 'ops', 'r4-identity-rotation', 'rotate.mjs');
const CONTINUITY = join(process.cwd(), 'ops', 'r4-identity-rotation', 'continuity.mjs');
const keyOf = (k: string, c: string) => createHmac('sha256', k).update(`r4-synthetic\u0000sales-canary\u0000synthetic:${c}`, 'utf8').digest('hex');

let db: TestDatabase | null = null;
afterEach(async () => {
  await db?.drop();
  db = null;
});

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };
const L = SALES_F1_CANARY_LIMITS;
function canaryEnv(url: string, key: string, allowlist: string): Record<string, string> {
  return {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@22', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: key, R4_PROD_ROLLOUT_ALLOWLIST: allowlist,
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: url, R4_LOG_LEVEL: 'silent', R4_SALES_QUOTE_RECOVERY: 'enabled',
    R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: String(L.maxGrossClp), R4_AUTONOMOUS_QUOTE_MAX_LINES: String(L.maxLines), R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: String(L.maxUnitsPerLine),
    R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: String(L.maxTotalUnits), R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: String(L.maxQuotesPerConversation),
    R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: String(L.maxQuotesPerHour), R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: String(L.confirmationWindowSeconds),
  };
}

class Router {
  readonly #routes = new Map<string, { steps: ScriptedStep[]; next: number }>();
  readonly script: FakeModelScript = (request) => {
    const taskId = (request.context!.sections.task.find((i) => i.kind === 'task')!.content as { taskId: string }).taskId;
    const route = this.#routes.get(taskId);
    const step = route?.steps[route.next++];
    if (!step) return Promise.resolve({ type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'script done' } });
    return Promise.resolve({ type: 'structured', data: step(new ContextView(request)) });
  };
  route(taskId: string, steps: readonly ScriptedStep[]): void {
    const route = this.#routes.get(taskId);
    if (route) route.steps.push(...steps);
    else this.#routes.set(taskId, { steps: [...steps], next: 0 });
  }
}

const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('not used here')) };
const ws = (operations: unknown[]): ScriptedStep => () => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations } });
const latest = (v: ContextView, id: string) => v.observations(id).filter((o) => o.outcome === 'succeeded').at(-1)!;
const preview = (v: ContextView) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload as { previewId: string; presentation: { offerMessage: string } };
const propose: ScriptedStep = (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: preview(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] });
const ISSUE = [ws([{ op: 'add_item', productId: 'BAR-EZ', quantity: 2 }]), ws([{ op: 'exclude_shipping' }]), read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), respond((v) => preview(v).presentation.offerMessage), propose, respond('Listo, te envié la cotización.')];

type Shown = { quotes?: { quoteNumber: string; earlierTask: boolean }[] } | undefined;
type Prior = { earlierTasks: number; turnsShown: number } | undefined;
/** An answer that records the quote-recovery state and the earlier-conversation episode the agent was shown. */
function shown(): { step: ScriptedStep; seen: () => { recovery: Shown; prior: Prior }[] } {
  const seen: { recovery: Shown; prior: Prior }[] = [];
  return {
    step: (v) => {
      const context: CompiledContext = v.context;
      const all = Object.values(context.sections).flat() as { sourceId?: string; content?: unknown }[];
      const prior = all.find((i) => i.sourceId === PRIOR_CONVERSATION_SOURCE_ID && (i.content as { event?: string }).event === 'conversation.earlier_tasks')?.content as Prior;
      seen.push({ recovery: context.sections.authoritativeState.find((i) => i.sourceId === QUOTE_RECOVERY_SOURCE_ID)?.content as Shown, prior });
      return respond('Sigo contigo.')(v);
    },
    seen: () => seen,
  };
}

async function canary(url: string, key: string, allowlist: string, router: Router, quotes: FixtureQuoteV2Service) {
  const env: CanaryEnvironment = loadCanaryEnvironment(canaryEnv(url, key, allowlist));
  const runtime = await startCanaryRuntime(env, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(new FixtureCatalog()), catalogDiscover: discover, shipping: http(new FixtureShipping()), quotes: http(quotes),
    worker: {
      databaseUrl: url, logLevel: 'silent', dbPoolMax: 3, workerId: 'rotation', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
      execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 6 },
      context: { budget: { mode: 'unbounded' } },
    },
    scheduler: { databaseUrl: url, logLevel: 'silent', dbPoolMax: 2, owner: 'rotation:scheduler', leaseMs: 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY },
    captureFile: join(mkdtempSync(join(tmpdir(), 'r4-rotation-')), 'capture.jsonl'), logger, isolationCheckMs: 50,
  });
  const drain = async () => {
    for (let i = 0; i < 40; i += 1) {
      const fired = (await runtime.scheduler?.scheduler.runOnce())?.kind === 'fired';
      if ((await runtime.worker.worker.runOnce()).kind === 'idle' && !fired) break;
    }
    await runtime.delivery.tick();
    await runtime.delivery.tick();
  };
  const say = async (from: string, text: string, steps: readonly ScriptedStep[]) => {
    const { taskId } = (await sendSynthetic(env, { conversation: from, text }, logger)) as { taskId: string };
    router.route(taskId, steps);
    await drain();
    return taskId;
  };
  return { env, say, close: () => runtime.close() };
}

async function rows<T>(sql: string): Promise<T[]> {
  const pool = openPool(db!.url);
  try {
    return (await pool.query(sql)).rows as T[];
  } finally {
    await pool.end();
  }
}

/** (#97) The gateway's idle-case sweep, 25 h of temporal time after the newest input. */
async function idleClose(): Promise<number> {
  const pool = openPool(db!.url);
  const platform = await createPlatform({ databaseUrl: db!.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 2 }, { logger });
  try {
    const at = (await pool.query<{ at: Date }>('select max(received_at) as at from task_inputs')).rows[0]!.at;
    await freezeTemporalClock(pool, new Date(at.getTime() + 25 * 3_600_000));
    return (await new CaseIdleCloser({ store: new PostgresProductionStore(pool), temporal: platform.temporal, channel: 'r4-synthetic', idleForMs: 24 * 3_600_000, logger }).sweep()).closed;
  } finally {
    await platform.close();
    await pool.end();
  }
}

async function tool(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { env: { ...process.env, R4_ROTATION_DATABASE_URL: db!.url } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
const lastJson = (stdout: string) => JSON.parse(stdout.slice(stdout.lastIndexOf('\n{') + 1)) as Record<string, unknown>;

describe('identity HMAC rotation keeps today\'s conversation continuity (sales-production@22)', { timeout: 300_000 }, () => {
  it('same binding and task, recovered quote and carried turns after the rotation, lineage across a later idle close, the same after a rollback; a stale-key binding is caught', async () => {
    db = await createTestDatabase('r4_it_rotation_canary');
    const dir = mkdtempSync(join(tmpdir(), 'r4-rotation-continuity-'));
    const oldList = [keyOf(OLD, 'owner'), keyOf(OLD, 'tester')].join(',');
    const router = new Router();

    const quotes = new FixtureQuoteV2Service();
    await initCanary(loadCanaryEnvironment(canaryEnv(db.url, OLD, oldList)), logger);

    // Before: the owner gets a quote, the case closes idle (#97), the owner comes back (new case with lineage); a tester talks once.
    let c = await canary(db.url, OLD, oldList, router, quotes);
    const tester = await c.say('tester', 'hola', [respond('Hola, ¿en qué te ayudo?')]);
    const first = await c.say('owner', 'Quiero 2 barras Z, sin despacho', ISSUE.slice(0, 4));
    await c.say('owner', 'si dale', ISSUE.slice(4));
    await c.close();
    expect(await idleClose()).toBe(2);
    c = await canary(db.url, OLD, oldList, router, quotes);
    const back = shown();
    const second = await c.say('owner', 'hola de nuevo', [back.step]);
    expect(second).not.toBe(first);
    expect(back.seen()[0]!.recovery?.quotes).toEqual([expect.objectContaining({ quoteNumber: 'PC-000001', earlierTask: true })]);
    await c.close(); // production stopped

    // The deployment's env files: the main one (key, rollout list) and the lane one (lane list: the owner).
    const prod = join(dir, 'production.env');
    const lane = join(dir, 'production-lane.env');
    writeFileSync(prod, `R4_PROD_IDENTITY_HASH_KEY='${OLD}'\nR4_PROD_ROLLOUT_PERCENT=0\nR4_PROD_ROLLOUT_ALLOWLIST='${oldList}'\nOTHER='kept'\n`);
    writeFileSync(lane, `R4_PROD_POLICY_PROFILE=sales-production@22\nR4_PROD_LANE_ALLOWLIST='${keyOf(OLD, 'owner')}'\n`);
    writeFileSync(join(dir, 'production.env.backup'), readFileSync(prod, 'utf8'));
    writeFileSync(join(dir, 'production-lane.env.backup'), readFileSync(lane, 'utf8'));
    writeFileSync(join(dir, 'new.key'), NEW);
    writeFileSync(join(dir, 'old.key'), OLD);
    const envs = ['--env-file', prod, '--env-file', lane];
    const snap = join(dir, 'continuity.json');

    const snapshot = await tool(CONTINUITY, ['snapshot', ...envs, '--out', snap, '--repo', process.cwd()]);
    expect(snapshot.stderr).toBe('');
    expect(lastJson(snapshot.stdout)).toMatchObject({ subjects: 2, open: 1, withEarlierTasks: 1, withQuotes: 1, unverifiedBindings: 0, listedSubjects: { R4_PROD_ROLLOUT_ALLOWLIST: 2, R4_PROD_LANE_ALLOWLIST: 1 } });
    if (process.env.R4_ROTATION_REHEARSAL_DB) {
      const name = process.env.R4_ROTATION_REHEARSAL_DB;
      const admin = openPool(testAdminDatabaseUrl());
      try {
        await admin.query(`drop database if exists ${name} with (force)`);
        await admin.query(`create database ${name} template ${db.name}`);
      } finally {
        await admin.end();
      }
      writeFileSync(join(process.env.R4_ROTATION_REHEARSAL_DIR ?? dir, 'seed.env'), `R4_DATABASE_URL=${databaseUrlFor(testAdminDatabaseUrl(), name)}\nR4_PROD_IDENTITY_HASH_KEY='${OLD}'\nR4_PROD_ROLLOUT_ALLOWLIST='${oldList}'\nR4_PROD_LANE_ALLOWLIST='${keyOf(OLD, 'owner')}'\n`);
    }

    // Rotate (apply, install, verify) and prove continuity before anything restarts.
    const lists = join(dir, 'lists.env');
    expect((await tool(ROTATE, ['plan', ...envs, '--new-key-file', join(dir, 'new.key')])).code).toBe(0);
    expect(lastJson((await tool(ROTATE, ['apply', ...envs, '--new-key-file', join(dir, 'new.key'), '--out', lists])).stdout)).toMatchObject({ rewritten: 3 });
    expect((await tool(ROTATE, ['install', ...envs, '--new-key-file', join(dir, 'new.key'), '--lists', lists, '--old-env-file', join(dir, 'production.env.backup')])).code).toBe(0);
    expect(lastJson((await tool(ROTATE, ['verify', ...envs, '--key-from-env'])).stdout)).toMatchObject({ ok: true, rewrittenVerified: 3 });
    const checked = await tool(CONTINUITY, ['check', ...envs, '--snapshot', snap, '--repo', process.cwd()]);
    expect(lastJson(checked.stdout)).toMatchObject({ subjects: 2, failures: [], ok: true });
    for (const secret of [OLD, NEW, keyOf(OLD, 'owner'), keyOf(NEW, 'owner'), 'synthetic:owner']) expect(snapshot.stdout + checked.stdout + readFileSync(snap, 'utf8')).not.toContain(secret);
    const newList = /^R4_PROD_ROLLOUT_ALLOWLIST='(.*)'$/m.exec(readFileSync(prod, 'utf8'))![1]!;
    expect(newList).toBe([keyOf(NEW, 'owner'), keyOf(NEW, 'tester')].join(','));
    expect(readFileSync(lane, 'utf8')).toContain(`R4_PROD_LANE_ALLOWLIST='${keyOf(NEW, 'owner')}'`);

    // Restart under the new key and the recomputed list: the owner's next message lands on the same binding and task,
    // and the agent is shown the earlier quote and the earlier conversation.
    c = await canary(db.url, NEW, newList, router, quotes);
    const after = shown();
    expect(await c.say('owner', 'sigo aquí', [after.step])).toBe(second);
    expect(after.seen()[0]!.recovery?.quotes).toEqual([expect.objectContaining({ quoteNumber: 'PC-000001', earlierTask: true })]);
    expect(back.seen()[0]!.prior).toMatchObject({ earlierTasks: 1 });
    expect(after.seen()[0]!.prior).toEqual(back.seen()[0]!.prior);
    const landed = await tool(CONTINUITY, ['check', ...envs, '--snapshot', snap, '--repo', process.cwd(), '--require-message']);
    expect(landed.stdout).toMatch(/#2 \[rollout_allowlist,lane_allowlist\] same open binding and task; earlier tasks 1; quotes 1; turns \d+; message after the snapshot: landed on the same binding and task/);
    expect(lastJson(landed.stdout)).toMatchObject({ testersWrote: 1, ok: true });

    // Another idle close: the next case (new binding, new key) still carries the lineage of both earlier tasks.
    await c.close();
    expect(await idleClose()).toBe(1);
    c = await canary(db.url, NEW, newList, router, quotes);
    const third = shown();
    const thirdTask = await c.say('owner', 'volví', [third.step]);
    expect([first, second]).not.toContain(thirdTask);
    expect(third.seen()[0]!.recovery?.quotes).toEqual([expect.objectContaining({ quoteNumber: 'PC-000001', earlierTask: true })]);
    expect(third.seen()[0]!.prior).toMatchObject({ earlierTasks: 2 });
    expect(await c.say('tester', 'hola otra vez', [respond('Hola de nuevo')])).not.toBe(tester);
    expect(await rows<{ autonomy: string }>(`select autonomy from channel_conversation_bindings where status = 'open' order by created_at`)).toEqual([{ autonomy: 'autonomous' }, { autonomy: 'autonomous' }]);
    const later = await tool(CONTINUITY, ['check', ...envs, '--snapshot', snap, '--repo', process.cwd()]);
    expect(later.stdout).toMatch(/#2 .*new case with lineage/);
    expect(lastJson(later.stdout)).toMatchObject({ ok: true });
    await c.close();

    // Rollback as rollback-production.sh does it (keys swapped; the old key and lists back into the env files, other
    // lines untouched): the same continuity under the old key, and the files equal the originals.
    const rotated = join(dir, 'rotated.env');
    writeFileSync(rotated, `R4_PROD_IDENTITY_HASH_KEY='${NEW}'\nR4_PROD_ROLLOUT_PERCENT=0\n${readFileSync(lists, 'utf8').replace(/^([A-Z0-9_]+)=(.*)$/gm, "$1='$2'")}`);
    expect(lastJson((await tool(ROTATE, ['apply', '--env-file', rotated, '--new-key-file', join(dir, 'old.key'), '--out', join(dir, 'back.env')])).stdout)).toMatchObject({ rewritten: 5 });
    writeFileSync(join(dir, 'production.env.rotated'), readFileSync(prod, 'utf8'));
    expect((await tool(ROTATE, ['install', ...envs, '--new-key-file', join(dir, 'old.key'), '--lists', join(dir, 'back.env'), '--old-env-file', join(dir, 'production.env.rotated')])).code).toBe(0);
    expect(readFileSync(prod, 'utf8')).toBe(readFileSync(join(dir, 'production.env.backup'), 'utf8'));
    expect(readFileSync(lane, 'utf8')).toBe(readFileSync(join(dir, 'production-lane.env.backup'), 'utf8'));
    expect(lastJson((await tool(ROTATE, ['verify', ...envs, '--key-from-env'])).stdout)).toMatchObject({ ok: true, rewrittenVerified: 5 });
    expect(lastJson((await tool(CONTINUITY, ['check', ...envs, '--snapshot', snap, '--repo', process.cwd()])).stdout)).toMatchObject({ ok: true });

    // The failure the check exists for: a process still on the other key opens a second binding for the same contact.
    await rows(`insert into channel_conversation_bindings (binding_id, channel, conversation_key, account_ref, recipient_ref, status, autonomy, eligibility_reason, rollout_fingerprint, profile, profile_fingerprint)
      values (gen_random_uuid(), 'r4-synthetic', '${keyOf(NEW, 'owner')}', 'sales-canary', 'synthetic:owner', 'open', 'excluded', 'not_in_cohort', 'x', 'sales-production@22', 'x')`);
    const caught = await tool(CONTINUITY, ['check', ...envs, '--snapshot', snap, '--repo', process.cwd()]);
    expect(caught.code).toBe(1);
    expect(lastJson(caught.stdout)).toMatchObject({ ok: false, failures: [expect.stringMatching(/^#2 .*opened for this contact under another key/)] });

  });
});
