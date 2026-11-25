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
 * ADR-060 M1 + ADR-053, end to end in-process over ONE disposable database: a signed Instagram DM and a signed Messenger
 * message enter their own gateways (instagram, facebook), open tasks of their own agents (sales-instagram@1,
 * sales-facebook@1), each agent's real production worker composition (scripted model, fixture owners) answers, and each
 * gateway's delivery owner sends its reply through the Page to a local Graph API. Nothing of WhatsApp or web is composed.
 */
const APP_SECRET = 'a'.repeat(40);
const PAGE = '1111111111';
const IG = '17840000000000001';
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };

let db: TestDatabase;
let pool: Pool;
let graph: Server;
const sent: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
const lanes: Record<'instagram' | 'facebook', { gateway: GatewayPlatform; worker: WorkerPlatform; requests: ModelRequest[] }> = {} as never;

const notify = async (channel: 'instagram' | 'facebook', mid: string, text: string, secret = APP_SECRET) => {
  const account = channel === 'instagram' ? IG : PAGE;
  const body = JSON.stringify({ object: channel === 'instagram' ? 'instagram' : 'page', entry: [{ id: account, time: Date.now(), messaging: [{ sender: { id: '2222222222' }, recipient: { id: account }, timestamp: Date.now(), message: { mid, text } }] }] });
  const signature = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  const response = await lanes[channel].gateway.app.inject({ method: 'POST', url: `/v1/channels/${channel}/webhook`, payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
};
const drain = async (channel: 'instagram' | 'facebook') => {
  for (let i = 0; i < 20; i += 1) if ((await lanes[channel].worker.worker.runOnce()).kind === 'idle') break;
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
  await new PostgresProductionStore(pool).setControl({ scope: 'global', autonomyEnabled: true, reason: 'test', changedBy: 'test', correlationId: 'test' });
  for (const channel of ['instagram', 'facebook'] as const) {
    const label = `sales-${channel}@1`;
    const env = {
      R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: label, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'k'.repeat(40),
      R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_DATABASE_URL: db.url,
      R4_META_PAGE_ID: PAGE, R4_META_INSTAGRAM_ACCOUNT_ID: IG, R4_META_PAGE_ACCESS_TOKEN: 'page-token', R4_WHATSAPP_APP_SECRET: APP_SECRET, R4_WHATSAPP_VERIFY_TOKEN: 'verify-me', R4_META_GRAPH_BASE_URL: `http://127.0.0.1:${port}`,
    };
    const lines: string[] = [];
    expect(await runProductionBootstrap(env, { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(0);
    expect(lines.join(' ')).toMatch(new RegExp(`\\(meta ${label}\\).*registered: ${label}`));
    const production = loadProductionConfig(env);
    const gateway = await createGatewayPlatform(
      { databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', dbPoolMax: 4, gatewayId: `${channel}-gateway-test`, dispatch: false, resumeAfterMs: 1000, workingSignal: true },
      composeSalesMetaGateway({ pool, production, env }).bindings,
      { logger: createSilentLogger() },
    );
    const requests: ModelRequest[] = [];
    const model = new FakeModelProvider((request) => {
      requests.push(request);
      return { type: 'structured', data: { type: 'respond', content: channel === 'instagram' ? 'Hola, ¿qué estás entrenando?' : 'Hola, te ayudo con eso.' } };
    });
    const composition = composeSalesProductionWorker({ pool, store: new PostgresProductionStore(pool), production, modelProvider: model, logger: createSilentLogger(), catalog: http(new FixtureCatalog() as CatalogPort), catalogDiscover: discover, shipping: http(new FixtureShipping() as ShippingService) });
    const worker = await createWorkerPlatform(
      {
        databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 3, workerId: `${channel}-worker-1`, leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
        execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 0 },
        context: { budget: { mode: 'unbounded' } },
      },
      composition.bindings,
      { logger: createSilentLogger() },
    );
    lanes[channel] = { gateway, worker, requests };
  }
}, 90_000);

afterAll(async () => {
  for (const lane of Object.values(lanes)) {
    await lane.worker.close().catch(() => undefined);
    await lane.gateway.close().catch(() => undefined);
  }
  await pool?.end().catch(() => undefined);
  await db?.drop().catch(() => undefined);
  await new Promise((resolve) => graph?.close(resolve));
});

describe('Meta channels: Instagram / Messenger → their own gateway → their own agent → Send API', () => {
  it('both gateways answer the webhook verification with the WhatsApp app verify token', async () => {
    for (const channel of ['instagram', 'facebook'] as const) {
      const ok = await lanes[channel].gateway.app.inject({ method: 'GET', url: `/v1/channels/${channel}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777` });
      expect([ok.statusCode, ok.body]).toEqual([200, '777']);
    }
    expect((await lanes.instagram.gateway.app.inject({ method: 'GET', url: '/v1/channels/instagram/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=777' })).statusCode).toBe(403);
  });

  it('a signed Instagram DM opens a sales-instagram@1 task; typing shows; the reply goes through the Page', async () => {
    expect(await notify('instagram', 'm_ig_1', 'hola, ¿cómo mejoro mi sentadilla?')).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect((await pool.query<{ agent_id: string; agent_version: number }>('select agent_id, agent_version from agent_tasks')).rows).toEqual([{ agent_id: 'sales-instagram', agent_version: 1 }]);
    await waitFor(() => sent.some((s) => s.body.sender_action === 'typing_on'));
    await drain('instagram');
    expect(JSON.stringify(lanes.instagram.requests.at(-1))).toContain('cómo mejoro mi sentadilla');
    await lanes.instagram.gateway.delivery.tick();
    expect(sent.filter((s) => s.body.message)).toEqual([{ url: `/v25.0/${PAGE}/messages`, auth: 'Bearer page-token', body: { recipient: { id: '2222222222' }, messaging_type: 'RESPONSE', message: { text: 'Hola, ¿qué estás entrenando?' } } }]);
  });

  it('a Messenger message is a sales-facebook@1 task of the facebook channel, answered by its own worker and gateway', async () => {
    expect(await notify('facebook', 'm_fb_1', 'hola, ¿tienen barras?')).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect((await pool.query<{ agent_id: string }>('select agent_id from agent_tasks order by created_at')).rows.map((r) => r.agent_id)).toEqual(['sales-instagram', 'sales-facebook']);
    expect((await lanes.instagram.worker.worker.runOnce()).kind).toBe('idle');
    await drain('facebook');
    await lanes.facebook.gateway.delivery.tick();
    expect(sent.filter((s) => s.body.message).map((s) => (s.body.message as { text: string }).text)).toEqual(['Hola, ¿qué estás entrenando?', 'Hola, te ayudo con eso.']);
    const conversations = await new PostgresProductionStore(pool).conversations(10);
    expect(conversations.map((c) => [c.channel, c.accountRef]).sort()).toEqual([['facebook', PAGE], ['instagram', IG]]);
    expect((await pool.query<{ status: string }>('select status from outbound_messages')).rows).toEqual([{ status: 'accepted' }, { status: 'accepted' }]);
  });

  it('a redelivered message is a duplicate; a forged signature, or the other channel\'s object, is refused', async () => {
    const inputs = (await pool.query('select 1 from task_inputs')).rowCount;
    expect(await notify('facebook', 'm_fb_1', 'hola, ¿tienen barras?')).toMatchObject({ status: 200, body: { duplicates: 1, ingested: 0 } });
    expect((await notify('facebook', 'm_fb_2', 'hola', 'x'.repeat(40))).status).toBe(401);
    expect((await pool.query('select 1 from task_inputs')).rowCount).toBe(inputs);
    expect((await lanes.facebook.gateway.app.inject({ method: 'POST', url: '/v1/channels/instagram/webhook', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
  });

  it('isolation: each gateway knows only its channel, and only its own agent\'s worker makes it ready', async () => {
    for (const channel of ['whatsapp', 'web']) expect((await lanes.instagram.gateway.app.inject({ method: 'POST', url: `/v1/channels/${channel}/webhook`, payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
    lanes.instagram.worker.worker.start();
    await waitFor(async () => (await lanes.instagram.gateway.app.inject({ method: 'GET', url: '/ready/r4' })).statusCode === 200);
    const ready = await lanes.instagram.gateway.app.inject({ method: 'GET', url: '/ready/r4' });
    expect(ready.json<{ checks: { execution: { expected: { compatibility: string } } } }>().checks.execution.expected.compatibility).toMatch(/sales-instagram@1/);
    expect((await lanes.facebook.gateway.app.inject({ method: 'GET', url: '/ready/r4' })).statusCode).toBe(503);
  });
});
