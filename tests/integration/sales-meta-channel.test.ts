import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGatewayPlatform, type GatewayPlatform } from '@r4/channel-gateway';
import { FakeModelProvider, type ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresProductionStore, type Pool } from '@r4/persistence-postgres';
import { loadProductionConfig } from '@r4/live-ops';
import { createWorkerPlatform, type WorkerPlatform } from '@r4/worker';
import { FixtureCatalog, FixtureShipping, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { migrateSales } from '@r4-sales/agent';
import { composeSalesMetaGateway, composeSalesProductionWorker, runProductionBootstrap } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { waitFor } from '../support/worker.js';

/**
 * ADR-060 M1, end to end in-process over a disposable database: a signed Messenger and an Instagram direct message enter
 * the real Meta gateway, open sales-social@1 tasks, the real production worker composition (scripted model, fixture
 * owners) answers, and the delivery owner sends the replies through the Page to a local Graph API. Nothing of the
 * WhatsApp or web gateways is composed.
 */
const APP_SECRET = 'a'.repeat(40);
const PAGE = '1111111111';
const IG = '17840000000000001';
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };

let db: TestDatabase;
let pool: Pool;
let gateway: GatewayPlatform;
let worker: WorkerPlatform;
let graph: Server;
const sent: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
const modelRequests: ModelRequest[] = [];

const notify = async (object: 'page' | 'instagram', account: string, mid: string, text: string, secret = APP_SECRET) => {
  const body = JSON.stringify({ object, entry: [{ id: account, time: Date.now(), messaging: [{ sender: { id: '2222222222' }, recipient: { id: account }, timestamp: Date.now(), message: { mid, text } }] }] });
  const signature = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  const response = await gateway.app.inject({ method: 'POST', url: '/v1/channels/meta/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
};
const drain = async () => {
  for (let i = 0; i < 20; i += 1) if ((await worker.worker.runOnce()).kind === 'idle') break;
};

beforeAll(async () => {
  // The Graph API: records what R4 sends through the Page and answers like the Send API.
  let n = 0;
  graph = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      sent.push({ url: req.url ?? '', auth: String(req.headers.authorization), body });
      n += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body.message ? { recipient_id: '2222222222', message_id: `mid.${n}` } : { recipient_id: '2222222222' }));
    });
  });
  await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
  const port = (graph.address() as { port: number }).port;

  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  await migrateSales(pool);
  const env = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-social@1', R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'k'.repeat(40),
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_DATABASE_URL: db.url,
    R4_META_PAGE_ID: PAGE, R4_META_INSTAGRAM_ACCOUNT_ID: IG, R4_META_PAGE_ACCESS_TOKEN: 'page-token', R4_WHATSAPP_APP_SECRET: APP_SECRET, R4_WHATSAPP_VERIFY_TOKEN: 'verify-me', R4_META_GRAPH_BASE_URL: `http://127.0.0.1:${port}`,
  };
  const lines: string[] = [];
  expect(await runProductionBootstrap(env, { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(0);
  expect(lines.join(' ')).toMatch(/\(meta sales-social@1\).*registered: sales-social@1/);

  const production = loadProductionConfig(env);
  gateway = await createGatewayPlatform(
    { databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', dbPoolMax: 4, gatewayId: 'meta-gateway-test', dispatch: false, resumeAfterMs: 1000, workingSignal: true },
    composeSalesMetaGateway({ pool, production, env }).bindings,
    { logger: createSilentLogger() },
  );
  await new PostgresProductionStore(pool).setControl({ scope: 'global', autonomyEnabled: true, reason: 'test', changedBy: 'test', correlationId: 'test' });
  const model = new FakeModelProvider((request) => {
    modelRequests.push(request);
    return { type: 'structured', data: { type: 'respond', content: 'Hola, ¿qué estás entrenando?' } };
  });
  const composition = composeSalesProductionWorker({ pool, store: new PostgresProductionStore(pool), production, modelProvider: model, logger: createSilentLogger(), catalog: http(new FixtureCatalog() as CatalogPort), catalogDiscover: discover, shipping: http(new FixtureShipping() as ShippingService) });
  worker = await createWorkerPlatform(
    {
      databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 3, workerId: 'meta-worker-1', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
      execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 0 },
      context: { budget: { mode: 'unbounded' } },
    },
    composition.bindings,
    { logger: createSilentLogger() },
  );
}, 60_000);

afterAll(async () => {
  await worker?.close().catch(() => undefined);
  await gateway?.close().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await db?.drop().catch(() => undefined);
  await new Promise((resolve) => graph?.close(resolve));
});

describe('Meta channel: Messenger / Instagram → Meta gateway → sales-social@1 → Send API', () => {
  it('answers the webhook verification with the WhatsApp app verify token', async () => {
    const ok = await gateway.app.inject({ method: 'GET', url: '/v1/channels/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777' });
    expect([ok.statusCode, ok.body]).toEqual([200, '777']);
    expect((await gateway.app.inject({ method: 'GET', url: '/v1/channels/meta/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=777' })).statusCode).toBe(403);
  });

  it('a signed Instagram DM opens a sales-social@1 task with the surface note; typing shows; the reply goes through the Page', async () => {
    expect(await notify('instagram', IG, 'm_ig_1', 'hola, ¿cómo mejoro mi sentadilla?')).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect((await pool.query<{ agent_id: string; agent_version: number }>('select agent_id, agent_version from agent_tasks')).rows).toEqual([{ agent_id: 'sales-social', agent_version: 1 }]);
    await waitFor(() => sent.some((s) => s.body.sender_action === 'typing_on'));
    await drain();
    expect(JSON.stringify(modelRequests.at(-1))).toContain('Canal informado por la plataforma: Instagram, mensaje directo.');
    await gateway.delivery.tick();
    const replies = sent.filter((s) => s.body.message);
    expect(replies).toEqual([{ url: `/v25.0/${PAGE}/messages`, auth: 'Bearer page-token', body: { recipient: { id: '2222222222' }, messaging_type: 'RESPONSE', message: { text: 'Hola, ¿qué estás entrenando?' } } }]);
    expect((await pool.query<{ status: string }>('select status from outbound_messages')).rows).toEqual([{ status: 'accepted' }]);
  });

  it('the same person on Messenger is another conversation, on the Page account', async () => {
    expect(await notify('page', PAGE, 'm_fb_1', 'hola, ¿tienen barras?')).toMatchObject({ status: 200, body: { ingested: 1 } });
    await drain();
    expect(JSON.stringify(modelRequests.at(-1))).toContain('Canal informado por la plataforma: Messenger de Facebook, mensaje directo.');
    await gateway.delivery.tick();
    expect((await pool.query('select 1 from agent_tasks')).rowCount).toBe(2);
    expect(sent.filter((s) => s.body.message)).toHaveLength(2);
  });

  it('a redelivered message is a duplicate; a forged signature is refused before anything is stored', async () => {
    const inputs = (await pool.query('select 1 from task_inputs')).rowCount;
    expect(await notify('page', PAGE, 'm_fb_1', 'hola, ¿tienen barras?')).toMatchObject({ status: 200, body: { duplicates: 1, ingested: 0 } });
    expect((await notify('page', PAGE, 'm_fb_2', 'hola', 'x'.repeat(40))).status).toBe(401);
    expect((await pool.query('select 1 from task_inputs')).rowCount).toBe(inputs);
  });

  it('isolation: the Meta gateway knows no WhatsApp or web channel, and only a sales-social@1 worker makes it ready', async () => {
    for (const channel of ['whatsapp', 'web']) expect((await gateway.app.inject({ method: 'POST', url: `/v1/channels/${channel}/webhook`, payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
    worker.worker.start();
    await waitFor(async () => (await gateway.app.inject({ method: 'GET', url: '/ready/r4' })).statusCode === 200);
    const ready = await gateway.app.inject({ method: 'GET', url: '/ready/r4' });
    expect(ready.json<{ checks: { execution: { expected: { compatibility: string } } } }>().checks.execution.expected.compatibility).toMatch(/sales-social@1/);
  });
});
