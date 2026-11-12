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
import { signWebBody, verifyWebSignature } from '@r4-adapters/web';
import { migrateSales } from '@r4-sales/agent';
import { composeSalesProductionWorker, composeSalesWebGateway, runProductionBootstrap } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { waitFor } from '../support/worker.js';

/**
 * ADR-046, end to end in-process over a disposable database: a signed message from a (local) web edge enters the real
 * web gateway, opens a sales-web@1 task, the real production worker composition (scripted model, fixture owners) answers,
 * and the delivery owner submits the reply back to the edge, signed. The WhatsApp channel is not composed at all.
 */
const SECRET = 'w'.repeat(40);
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };

let db: TestDatabase;
let pool: Pool;
let gateway: GatewayPlatform;
let worker: WorkerPlatform;
let edge: Server;
const delivered: Array<{ body: Record<string, unknown>; signedOk: boolean }> = [];
const working: string[] = [];
const modelRequests: ModelRequest[] = [];
let env: Record<string, string>;

const inbound = async (events: unknown[], secret = SECRET) => {
  const body = JSON.stringify({ events });
  const ts = String(Date.now());
  const response = await gateway.app.inject({ method: 'POST', url: '/v1/channels/web/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-r4-web-timestamp': ts, 'x-r4-web-signature': signWebBody(secret, ts, body) } });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
};
const message = (eventId: string, text: string, context?: unknown) => ({ type: 'message', eventId, accountRef: 'shop-test', conversationRef: 'session-0001', occurredAt: new Date().toISOString(), text, ...(context ? { context } : {}) });

beforeAll(async () => {
  // The edge: records what R4 sends, after checking R4's signature, and deduplicates by R4's idempotency key.
  const seenKeys = new Map<string, string>();
  edge = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));
      const signedOk = verifyWebSignature(SECRET, headers, raw, 60_000).ok;
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (req.url === '/r4/v1/working') {
        working.push(String(body.eventId));
        res.writeHead(204).end();
        return;
      }
      delivered.push({ body, signedOk });
      const key = String(body.idempotencyKey);
      const id = seenKeys.get(key) ?? `edge-${seenKeys.size + 1}`;
      seenKeys.set(key, id);
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ messageId: id }));
    });
  });
  await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const port = (edge.address() as { port: number }).port;

  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  await migrateSales(pool);
  env = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-web@1', R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'k'.repeat(40),
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_DATABASE_URL: db.url,
    R4_WEB_ACCOUNT_REF: 'shop-test', R4_WEB_SHARED_SECRET: SECRET, R4_WEB_EDGE_URL: `http://127.0.0.1:${port}`,
  };
  const lines: string[] = [];
  expect(await runProductionBootstrap(env, { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(0);
  expect(lines.join(' ')).toMatch(/registered: sales-web@1/);

  const production = loadProductionConfig(env);
  gateway = await createGatewayPlatform(
    { databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', dbPoolMax: 4, gatewayId: 'web-gateway-test', dispatch: false, resumeAfterMs: 1000, workingSignal: true },
    composeSalesWebGateway({ pool, production, env }).bindings,
    { logger: createSilentLogger() },
  );
  await new PostgresProductionStore(pool).setControl({ scope: 'global', autonomyEnabled: true, reason: 'test', changedBy: 'test', correlationId: 'test' });
  const model = new FakeModelProvider((request) => {
    modelRequests.push(request);
    return { type: 'structured', data: { type: 'respond', content: 'Hola, te ayudo con esa barra.' } };
  });
  const composition = composeSalesProductionWorker({ pool, store: new PostgresProductionStore(pool), production, modelProvider: model, logger: createSilentLogger(), catalog: http(new FixtureCatalog() as CatalogPort), catalogDiscover: discover, shipping: http(new FixtureShipping() as ShippingService) });
  worker = await createWorkerPlatform(
    {
      databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 3, workerId: 'web-worker-1', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
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
  await new Promise((resolve) => edge?.close(resolve));
});

describe('web channel: edge → web gateway → sales-web@1 → edge', () => {
  it('a signed visitor message opens a sales-web@1 task with the unverified page hint, and the reply goes back to the session, signed', async () => {
    const received = await inbound([message('evt-web-0001', '¿tiene stock esta barra?', { page: 'product', productId: 647 })]);
    expect(received).toMatchObject({ status: 200, body: { ingested: 1 } });
    const tasks = (await pool.query<{ agent_id: string; agent_version: number }>('select agent_id, agent_version from agent_tasks')).rows;
    expect(tasks).toEqual([{ agent_id: 'sales-web', agent_version: 1 }]);
    await waitFor(() => working.length > 0);
    expect(working).toEqual(['evt-web-0001']);

    for (let i = 0; i < 20; i += 1) if ((await worker.worker.runOnce()).kind === 'idle') break;
    expect(JSON.stringify(modelRequests[0])).toContain('no verificado: el cliente está viendo la ficha del producto P647');

    await gateway.delivery.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ signedOk: true, body: { accountRef: 'shop-test', conversationRef: 'session-0001', text: 'Hola, te ayudo con esa barra.' } });
    expect((await pool.query<{ status: string }>('select status from outbound_messages')).rows).toEqual([{ status: 'accepted' }]);
  });

  it('a repeated event is a duplicate (no new input); a forged or stale signature is refused before anything is stored', async () => {
    const inputsBefore = (await pool.query('select 1 from task_inputs')).rowCount;
    expect(await inbound([message('evt-web-0001', '¿tiene stock esta barra?')])).toMatchObject({ status: 200, body: { duplicates: 1, ingested: 0 } });
    expect((await pool.query('select 1 from task_inputs')).rowCount).toBe(inputsBefore);
    expect((await inbound([message('evt-web-0002', 'hola')], 'x'.repeat(40))).status).toBe(401);
    const body = JSON.stringify({ events: [message('evt-web-0003', 'hola')] });
    const old = String(Date.now() - 3_600_000);
    const stale = await gateway.app.inject({ method: 'POST', url: '/v1/channels/web/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-r4-web-timestamp': old, 'x-r4-web-signature': signWebBody(SECRET, old, body) } });
    expect(stale.statusCode).toBe(401);
  });

  it('isolation: the web gateway knows no WhatsApp channel, and only a sales-web@1 worker makes it ready', async () => {
    const whatsapp = await gateway.app.inject({ method: 'POST', url: '/v1/channels/whatsapp/webhook', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(whatsapp.statusCode).toBe(404);
    worker.worker.start();
    await waitFor(async () => (await gateway.app.inject({ method: 'GET', url: '/ready/r4' })).statusCode === 200);
    const ready = await gateway.app.inject({ method: 'GET', url: '/ready/r4' });
    expect(ready.json<{ checks: { execution: { expected: { compatibility: string } } } }>().checks.execution.expected.compatibility).toMatch(/sales-web@1/);
    expect(ready.statusCode).toBe(200);
  });
});
