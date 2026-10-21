import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerProfileHttpClient, type CustomerProfileCallTelemetry } from '@r4-adapters/customer-http';
import { CustomerIdentityHttpClient, loadCustomerIdentityHttpConfig, type CustomerIdentityCallTelemetry } from '@r4-adapters/identity-http';
import type { CustomerIdentityResolver, IdentityResolution } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry, type CapabilityRegistration } from '@r4/capability-runtime';
import type { Observation, TrustedExecutionContext } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { PostgresProductionStore, type Pool } from '@r4/persistence-postgres';
import type { Platform } from '@r4/api';
import { composeSyntheticCustomerCapabilities } from '../../agents/sales/src/capabilities/customer-synthetic.js';
import { CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID, customerContextV2Capability, customerPurchaseHistoryV1Capability } from '../../agents/sales/src/capabilities/customer-v2.js';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { FakeClock, idsFrom } from '../support/deterministic.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';

// R4-J4-R3 (R3.8): the R4 → CIA → Customer Profile campaign, three real synthetic services:
// - CIA: its own composition root from a clean, built checkout at 7525395 (R4_INTEROP_CIA_DIR),
//   real PostgreSQL, the CIA's HTTP account-provider double, OTP to a fake mailbox only, real ES256;
// - Customer Profile: the COMPILED service of a clean, built checkout at bbd766e
//   (R4_INTEROP_CP_DIR), synthetic source, auth enforce, grant mode required, the CIA JWKS pinned
//   before it starts, principal r4-sales;
// - R4: the two Customer capabilities from the synthetic composition, invoked through the real
//   CapabilityRegistry/CapabilityInvoker, the subject coming from real task bindings in R4's
//   PostgreSQL (ProductionStore.openBinding + attachTask, the authorized test support).
// Opt-in (npm run test:interop); never part of `npm test`. Without the checkouts this file FAILS:
// a scenario that did not run is NOT_RUN, never a pass. No real customer, mailbox, shop or host.
//
// Kinds of evidence, kept apart:
//   E2E          R4 → CIA → CP as composed, nothing altered;
//   FAULT        the same three services with ONE hop deliberately altered by the test (a stub
//                resolver, a proxy or a stopped service) to prove a refusal;
//   ADAPTER      one adapter against one real service, outside the capability flow.

const CIA_DIR = process.env.R4_INTEROP_CIA_DIR ?? '';
const CP_DIR = process.env.R4_INTEROP_CP_DIR ?? '';
if (!existsSync(path.join(CIA_DIR, 'dist', 'src', 'app.js')) || !existsSync(path.join(CP_DIR, 'dist', 'src', 'index.js'))) {
  throw new Error('NOT_RUN: R4_INTEROP_CIA_DIR (CIA 7525395) and R4_INTEROP_CP_DIR (CP bbd766e) must point to clean, built checkouts');
}
const CIA_DATABASE_URL = process.env.R4_INTEROP_CIA_DATABASE_URL ?? 'postgres://cia:cia_local_only@127.0.0.1:55433/cia';
const DRIVER = path.join(import.meta.dirname, 'support', 'cia-synthetic-instance.mjs');
const WORK = mkdtempSync(path.join(tmpdir(), 'r4-r3-campaign-'));

const token = (label: string, bytes = 24) => `synthetic-${label}-${randomBytes(bytes).toString('hex')}`;
const CIA_TOKENS = {
  'r4-sales': { agent: token('cia-r4-agent'), channel: token('cia-r4-channel') },
  'other-consumer': { agent: token('cia-other-agent'), channel: token('cia-other-channel') },
};
const CP_TOKEN = token('cp-r4-sales'); // ≥ 43 printable characters, synthetic
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const R4_CUSTOMER_ID = '100000000000001';

type Account = { email: string; customerId: number; shopId: 1; active: boolean; guest: boolean; deleted: boolean };
const account = (email: string, customerId: number, extra: Partial<Account> = {}): Account => ({ email, customerId, shopId: 1, active: true, guest: false, deleted: false, ...extra });
const ACCOUNTS = [
  account('valid@synthetic.test', 900000201),
  account('other@synthetic.test', 900000202),
  account('dup@synthetic.test', 900000203),
  account('dup@synthetic.test', 900000204),
  account('guest@synthetic.test', 900000207, { guest: true }),
  account('inactive@synthetic.test', 900000208, { active: false }),
  account('history@synthetic.test', 900000301),
  account('empty@synthetic.test', 900000302),
  account('paged@synthetic.test', 900000308),
  account('broken@synthetic.test', 900000309),
  account('notfound@synthetic.test', 900000310),
];

// ---- telemetry and leak capture ------------------------------------------------------------------
const identityEvents: CustomerIdentityCallTelemetry[] = [];
const profileEvents: CustomerProfileCallTelemetry[] = [];
const observations: Observation[] = [];
const issuedGrants: string[] = [];
const evidence: Record<string, unknown>[] = [];
const record = (scenario: string, kind: 'E2E' | 'FAULT' | 'ADAPTER', result: Record<string, unknown>) => evidence.push({ scenario, kind, ...result });

// ---- processes -------------------------------------------------------------------------------------
const children: ChildProcess[] = [];
type Cia = { baseUrl: string; code: (email: string) => Promise<string>; close: () => Promise<void> };

async function startCia(options: { grantTtlSeconds?: number } = {}): Promise<Cia> {
  const child = fork(DRIVER, [], {
    env: {
      ...process.env,
      CIA_DIR,
      CIA_INSTANCE: JSON.stringify({ databaseUrl: CIA_DATABASE_URL, schema: `r4_r3_${randomBytes(5).toString('hex')}`, providerToken: token('provider'), accounts: ACCOUNTS, tokens: CIA_TOKENS, ...options }),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (process.env.R4_INTEROP_DEBUG) process.stdout.write(chunk); });
  let next = 0;
  const ask = (message: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      const listener = (reply: Record<string, unknown>) => {
        if (reply.id !== id) return;
        child.off('message', listener);
        resolve(reply);
      };
      child.on('message', listener);
      child.send({ ...message, id });
    });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    child.once('message', (m: { baseUrl: string }) => resolve(m.baseUrl));
    child.once('exit', (code) => reject(new Error(`CIA exited (${code}): ${stderr}`)));
  });
  return {
    baseUrl,
    code: async (email) => {
      const reply = await ask({ op: 'code', email });
      if (typeof reply.code !== 'string') throw new Error('no OTP in the synthetic mailbox');
      return reply.code;
    },
    close: async () => {
      if (child.exitCode === null) await ask({ op: 'close' });
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

type Cp = { baseUrl: string; out: () => string; close: () => Promise<void> };
const CP_VERIFIER = { synthetic: true, iss: 'https://cia.synthetic.test', aud: 'customer-profile', typ: 'cia-grant+jwt', algorithms: ['ES256'], supportedClaimsVersions: [1], maxTtlSeconds: 300, clockSkewSeconds: 60, maxProofAgeSeconds: 7_776_000, maxTokenBytes: 2048 };

async function startCp(mode: 'required' | 'disabled', jwks: { keys: unknown[] }): Promise<Cp> {
  const registry = path.join(WORK, 'registry.json');
  writeFileSync(registry, JSON.stringify({ version: 1, principals: [{ principalId: 'r4-sales', scopes: ['customer.sales_context.read'], tokenSha256: [sha(CP_TOKEN)] }] }));
  const verifier = path.join(WORK, `verifier-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(verifier, JSON.stringify({ ...CP_VERIFIER, jwks }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(CP_DIR, 'dist', 'src', 'index.js')], {
    cwd: WORK,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port),
      // Unreachable placeholders: config requires them; the synthetic route never opens them.
      CRM_DB_HOST: '127.0.0.1', CRM_DB_PORT: '1', CRM_DB_USER: 'none', CRM_DB_PASSWORD: 'none',
      PRESTASHOP_DB_HOST: '127.0.0.1', PRESTASHOP_DB_PORT: '1', PRESTASHOP_DB_USER: 'none', PRESTASHOP_DB_PASSWORD: 'none',
      PRESTASHOP_ORDER_STATE_LANG_ID: '1', PRESTASHOP_CARRIER_LANG_ID: '1', PRESTASHOP_CARRIER_SHOP_ID: '1',
      CUSTOMER_PROFILE_API_AUTH_MODE: 'enforce', CUSTOMER_PROFILE_PRINCIPAL_REGISTRY_FILE: registry,
      CUSTOMER_PROFILE_SALES_CONTEXT_ENABLED: 'true', CUSTOMER_PROFILE_SALES_CONTEXT_SOURCE: 'synthetic',
      ...(mode === 'required' ? { CUSTOMER_PROFILE_CUSTOMER_GRANT_MODE: 'required', CUSTOMER_PROFILE_CUSTOMER_GRANT_VERIFIER_FILE: verifier } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (out.includes('Customer Profile service started')) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
    child.once('exit', (code) => {
      clearInterval(timer);
      reject(new Error(`CP exited (${code}): ${out}`));
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    out: () => out,
    close: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill();
      await exited;
    },
  };
}

const decisionsOf = (cp: Cp) => cp.out().split("event: 'customer_grant_decision'").length - 1;
const lastDecision = (cp: Cp) => {
  const block = cp.out().split("event: 'customer_grant_decision'").at(-1)!;
  return { outcome: /outcome: '(\w+)'/.exec(block)?.[1] ?? null, reason: /reason: '(\w+)'/.exec(block)?.[1] ?? null };
};

// ---- CIA flows (synthetic start/confirm by a channel-integration principal of the test) ------------
const CONTEXT = { channel: 'whatsapp', channelAccountRef: R4_CUSTOMER_ID, subjectAssurance: 'provider_signed' } as const;
async function ciaPost(cia: Cia, route: string, bearer: string, body: unknown, idempotent = true) {
  const response = await fetch(`${cia.baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...(idempotent ? { 'idempotency-key': `r3-${randomBytes(8).toString('hex')}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
type Subject = { subjectRef: string; sessionRef: string };
async function verify(cia: Cia, who: Subject, email: string, options: { confirm?: boolean; purposes?: string[]; consumer?: 'r4-sales' | 'other-consumer' } = {}): Promise<string> {
  const consumer = options.consumer ?? 'r4-sales';
  const context = { ...CONTEXT, ...who };
  const started = await ciaPost(cia, '/v1/identity/verifications', CIA_TOKENS[consumer].agent, { schemaVersion: 1, context, verificationPurpose: 'link_commercial_account', email, purposes: options.purposes ?? ['sales_context', 'purchase_history'] });
  if (started.status !== 202) throw new Error(`start: ${JSON.stringify(started)}`);
  if (options.confirm === false) return 'not_confirmed';
  const confirmed = await ciaPost(cia, '/v1/identity/verifications/confirm', CIA_TOKENS[consumer].channel, { schemaVersion: 1, context, verificationId: started.body.verificationId, code: await cia.code(email) });
  return String(confirmed.body.outcome);
}
async function ciaResolve(cia: Cia, who: Subject, purposes: string[], consumer: 'r4-sales' | 'other-consumer' = 'r4-sales') {
  return ciaPost(cia, '/v1/identity/resolve', CIA_TOKENS[consumer].agent, { schemaVersion: 1, context: { ...CONTEXT, ...who }, purposes }, false);
}

// ---- R4: real tasks and bindings, the synthetic composition, the real invoker ---------------------
let db: TestDatabase;
let platform: Platform;
let pool: Pool;
let store: PostgresProductionStore;
let cia: Cia;
let shortCia: Cia;
let cp: Cp;
let cpDisabled: Cp;
let jwks: { keys: unknown[] };

async function boundTask(recipientRef: string | null): Promise<{ taskId: string; subject: Subject | null }> {
  const taskId = (await platform.tasks.createTask({ request: validTaskBody(), requestedBy: { kind: 'service', ref: 'r4-j4-r3-campaign' }, correlationId: `r3-${randomBytes(4).toString('hex')}` })).view.task.taskId;
  if (recipientRef === null) return { taskId, subject: null };
  const bindingId = randomUUID();
  await store.openBinding({ bindingId, channel: 'whatsapp', conversationKey: sha(`${recipientRef}:${bindingId}`), accountRef: R4_CUSTOMER_ID, recipientRef, autonomy: 'excluded', eligibilityReason: 'r4-j4-r3-campaign', rolloutFingerprint: 'campaign', profile: 'r4-j4-r3-campaign', profileFingerprint: 'campaign' });
  await store.attachTask(bindingId, taskId);
  return { taskId, subject: { subjectRef: recipientRef, sessionRef: bindingId } };
}

let subjects = 0;
const nextRecipient = () => `1555577${String(++subjects).padStart(4, '0')}`;

function env(overrides: Record<string, string> = {}) {
  return {
    R4_CUSTOMER_MODE: 'synthetic',
    R4_CUSTOMER_IDENTITY_BASE_URL: cia.baseUrl,
    R4_CUSTOMER_IDENTITY_BEARER_TOKEN: CIA_TOKENS['r4-sales'].agent,
    R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '3000',
    R4_CUSTOMER_PROFILE_BASE_URL: cp.baseUrl,
    R4_CUSTOMER_PROFILE_BEARER_TOKEN: CP_TOKEN,
    R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
    ...overrides,
  };
}

/** The real fetch, recording every grant that leaves R4 (for the leak checks). */
const recordingFetch = (url: string, init: RequestInit) => {
  const grant = (init.headers as Record<string, string> | undefined)?.['x-customer-access-grant'];
  if (grant) issuedGrants.push(grant);
  return fetch(url, init);
};

function invokerOf(capabilities: readonly unknown[]) {
  const registry = new CapabilityRegistry();
  for (const capability of capabilities) registry.register(capability as CapabilityRegistration<unknown, unknown>);
  const clock = new FakeClock(new Date().toISOString());
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock: { now: () => new Date() }, logger: createSilentLogger() });
  const invoke = async (taskId: string, capabilityId: string, capabilityVersion: number, args: Record<string, unknown> = {}) => {
    const context: TrustedExecutionContext = { taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 1, correlationId: `r3-${randomBytes(4).toString('hex')}`, grantedScopes: ['customer.read'] };
    const observation = await invoker.invoke({ capabilityId, capabilityVersion, arguments: args }, context);
    observations.push(observation);
    return observation;
  };
  return {
    context: (taskId: string) => invoke(taskId, 'customer.get_context', 2),
    history: (taskId: string, args: Record<string, unknown> = {}) => invoke(taskId, CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID, 1, args),
  };
}

const composed = (overrides: Record<string, string> = {}) =>
  invokerOf(composeSyntheticCustomerCapabilities({ env: env(overrides), bindings: store, fetch: recordingFetch, onIdentityCall: (e) => identityEvents.push(e), onProfileCall: (e) => profileEvents.push(e) }));

/** The same composition with one hop deliberately altered (FAULT evidence). */
function withResolver(alter: (real: CustomerIdentityResolver) => CustomerIdentityResolver) {
  const real = new CustomerIdentityHttpClient({ config: loadCustomerIdentityHttpConfig(env()), fetch: (url, init) => recordingFetch(url, init).then((r) => ({ status: r.status, headers: r.headers, body: r.body })), onCall: (e) => identityEvents.push(e) });
  const profile = new CustomerProfileHttpClient({ config: { baseUrl: cp.baseUrl, bearerToken: CP_TOKEN, timeoutMs: 3000, lifecycle: 'synthetic' }, fetch: (url, init) => recordingFetch(url, init).then((r) => ({ status: r.status, headers: r.headers, body: r.body })), onCall: (e) => profileEvents.push(e) });
  const deps = { bindings: store, identity: alter(real), profile };
  return invokerOf([customerContextV2Capability(deps), customerPurchaseHistoryV1Capability(deps)]);
}

let r4: ReturnType<typeof composed>;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
  pool = openPool(db.url);
  store = new PostgresProductionStore(pool);
  cia = await startCia();
  shortCia = await startCia({ grantTtlSeconds: 3 });
  jwks = (await (await fetch(`${cia.baseUrl}/.well-known/jwks.json`)).json()) as { keys: unknown[] };
  const shortJwks = (await (await fetch(`${shortCia.baseUrl}/.well-known/jwks.json`)).json()) as { keys: unknown[] };
  expect(shortJwks).toEqual(jwks); // same synthetic seed and kid: one pinned key serves both instances
  [cp, cpDisabled] = await Promise.all([startCp('required', jwks), startCp('disabled', jwks)]);
  r4 = composed();
  record('setup', 'E2E', { kids: jwks.keys.map((k) => (k as { kid: string }).kid), cia: '7525395', cp: 'bbd766e' });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([cp?.close(), cpDisabled?.close(), cia?.close(), shortCia?.close()]);
  for (const child of children) if (child.exitCode === null) child.kill();
  await pool?.end();
  await platform?.close();
  await db?.drop();
  if (process.env.R4_INTEROP_EVIDENCE) writeFileSync(process.env.R4_INTEROP_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
}, 120_000);

const payloadOf = (o: Observation) => o.payload as Record<string, unknown> | null;
const failureOf = (o: Observation) => (o.error?.details ?? {}) as Record<string, unknown>;

describe('E2E: R4 → CIA → Customer Profile (nothing altered)', () => {
  it('1/5. a linked customer: CIA issues a grant, CP verifies it, the capability answers verified', async () => {
    const { taskId, subject } = await boundTask(nextRecipient());
    expect(await verify(cia, subject!, 'valid@synthetic.test')).toBe('linked');
    const before = decisionsOf(cp);
    const observation = await r4.context(taskId);
    record('1 valid link (get_context@2)', 'E2E', { outcome: observation.outcome, payload: observation.payload, cp: lastDecision(cp) });
    expect(observation).toMatchObject({ outcome: 'succeeded', payload: { identity: 'verified', purchaseHistory: 'present' } });
    expect(decisionsOf(cp)).toBe(before + 1);
    expect(lastDecision(cp)).toEqual({ outcome: 'accepted', reason: null });
    expect(Date.parse(String(payloadOf(observation)!.validUntil))).toBeLessThanOrEqual(Date.now() + 300_000 + 60_000);
  });

  it('2. no binding: anonymous, with no call to the CIA or CP', async () => {
    const { taskId } = await boundTask(null);
    const calls = identityEvents.length;
    const observation = await r4.context(taskId);
    record('2 no binding', 'E2E', { payload: observation.payload });
    expect(observation.payload).toEqual({ identity: 'unavailable', reason: 'anonymous' });
    expect(identityEvents.length).toBe(calls);
  });

  it('3. a subject with no link: not_linked, no CP call', async () => {
    const { taskId } = await boundTask(nextRecipient());
    const before = decisionsOf(cp);
    const observation = await r4.context(taskId);
    record('3 no link', 'E2E', { payload: observation.payload, ciaStatus: identityEvents.at(-1)!.resolutionStatus });
    expect(observation.payload).toEqual({ identity: 'unavailable', reason: 'not_linked' });
    expect(decisionsOf(cp)).toBe(before);
  });

  it('4. OTP sent but never confirmed: not_verified, no CP call', async () => {
    const { taskId, subject } = await boundTask(nextRecipient());
    await verify(cia, subject!, 'other@synthetic.test', { confirm: false });
    const observation = await r4.context(taskId);
    record('4 OTP not confirmed', 'E2E', { payload: observation.payload, ciaStatus: identityEvents.at(-1)!.resolutionStatus });
    expect(observation.payload).toEqual({ identity: 'unavailable', reason: 'not_verified' });
  });

  it('6. an e-mail of two eligible accounts: the CIA links nothing and R4 answers not_verified', async () => {
    const { taskId, subject } = await boundTask(nextRecipient());
    const outcome = await verify(cia, subject!, 'dup@synthetic.test');
    const observation = await r4.context(taskId);
    record('6 duplicate e-mail', 'E2E', { confirmOutcome: outcome, ciaStatus: identityEvents.at(-1)!.resolutionStatus, payload: observation.payload });
    expect(outcome).toBe('ambiguous');
    expect(identityEvents.at(-1)!.resolutionStatus).toBe('ambiguous');
    expect(observation.payload).toEqual({ identity: 'unavailable', reason: 'not_verified' });
  });

  it('7. guest and inactive accounts: the CIA links nothing; nothing reaches CP', async () => {
    for (const email of ['guest@synthetic.test', 'inactive@synthetic.test']) {
      const { taskId, subject } = await boundTask(nextRecipient());
      const before = decisionsOf(cp);
      const outcome = await verify(cia, subject!, email);
      const observation = await r4.context(taskId);
      record(`7 ${email.split('@')[0]} account`, 'E2E', { confirmOutcome: outcome, ciaStatus: identityEvents.at(-1)!.resolutionStatus, payload: observation.payload });
      expect(outcome).toBe('ineligible_account');
      expect(identityEvents.at(-1)!.resolutionStatus).toBe('not_authorized');
      expect(observation.payload).toEqual({ identity: 'unavailable', reason: 'not_authorized' });
      expect(decisionsOf(cp)).toBe(before);
    }
  });

  it('8. a purpose that was never verified: no grant for it, no CP call', async () => {
    const { taskId, subject } = await boundTask(nextRecipient());
    expect(await verify(cia, subject!, 'history@synthetic.test', { purposes: ['sales_context'] })).toBe('linked');
    const before = decisionsOf(cp);
    const observation = await r4.history(taskId);
    record('8 purpose not granted', 'E2E', { ciaStatus: identityEvents.at(-1)!.resolutionStatus, payload: observation.payload });
    expect(identityEvents.at(-1)!.resolutionStatus).toBe('not_verified'); // CIA plane C: no recent proof for this purpose
    expect(observation.payload).toEqual({ identity: 'unavailable', reason: 'not_verified' });
    expect(decisionsOf(cp)).toBe(before);
    expect((await r4.context(taskId)).payload).toMatchObject({ identity: 'verified' }); // the verified purpose still works
  });

  it('17/18/20. history: available, empty and paginated', async () => {
    const history = await boundTask(nextRecipient());
    expect(await verify(cia, history.subject!, 'history@synthetic.test')).toBe('linked');
    const normal = await r4.history(history.taskId, { limit: 10 });
    expect(normal.payload).toMatchObject({ identity: 'verified', meaning: 'purchased_historically_not_ownership', quantityBasis: 'gross_units_not_net_of_returns', page: { offset: 0, returned: 3, hasMore: false, nextOffset: null } });

    const empty = await boundTask(nextRecipient());
    expect(await verify(cia, empty.subject!, 'empty@synthetic.test')).toBe('linked');
    expect((await r4.history(empty.taskId)).payload).toMatchObject({ identity: 'verified', items: [], page: { returned: 0, hasMore: false } });

    const paged = await boundTask(nextRecipient());
    expect(await verify(cia, paged.subject!, 'paged@synthetic.test')).toBe('linked');
    const first = await r4.history(paged.taskId, { limit: 2 });
    expect(first.payload).toMatchObject({ page: { offset: 0, returned: 2, hasMore: true, nextOffset: 2 } });
    const second = await r4.history(paged.taskId, { offset: 2, limit: 2 });
    expect(second.payload).toMatchObject({ page: { offset: 2, returned: 1, hasMore: false, nextOffset: null } });
    record('17/18/20 history available, empty, paginated', 'E2E', { normal: normal.payload, first: (first.payload as { page: unknown }).page, second: (second.payload as { page: unknown }).page });
  });

  it('19. an incomplete history is a failure (temporarily_unavailable), never a partial list; not_on_file stays an answer', async () => {
    const broken = await boundTask(nextRecipient());
    expect(await verify(cia, broken.subject!, 'broken@synthetic.test')).toBe('linked');
    const failed = await r4.history(broken.taskId);
    expect(failed).toMatchObject({ outcome: 'failed', payload: null });
    expect(failureOf(failed)).toMatchObject({ category: 'temporarily_unavailable', code: 'history_unavailable' });
    const missing = await boundTask(nextRecipient());
    expect(await verify(cia, missing.subject!, 'notfound@synthetic.test')).toBe('linked');
    expect((await r4.context(missing.taskId)).payload).toEqual({ identity: 'unavailable', reason: 'not_on_file' });
    record('19 incomplete history / not_on_file', 'E2E', { failed: failureOf(failed) });
  });

  it('21. revocation after issuance: the next invocation resolves not_linked; the grant already issued is accepted by CP until exp (v1, DM-06)', async () => {
    const { taskId, subject } = await boundTask(nextRecipient());
    expect(await verify(cia, subject!, 'empty@synthetic.test')).toBe('linked');
    const held = await ciaResolve(cia, subject!, ['sales_context']);
    expect((await r4.context(taskId)).payload).toMatchObject({ identity: 'verified' });
    expect((await ciaPost(cia, '/v1/identity/links/revoke', CIA_TOKENS['r4-sales'].agent, { schemaVersion: 1, context: { ...CONTEXT, ...subject }, reason: 'customer_request' })).status).toBe(200);
    const after = await r4.context(taskId);
    expect(after.payload).toEqual({ identity: 'unavailable', reason: 'not_linked' });
    // ADAPTER: the grant held before the revocation is still valid at CP until its exp (no revocation list in v1).
    const direct = new CustomerProfileHttpClient({ config: { baseUrl: cp.baseUrl, bearerToken: CP_TOKEN, timeoutMs: 3000, lifecycle: 'synthetic' }, fetch: (url, init) => fetch(url, init).then((r) => ({ status: r.status, headers: r.headers, body: r.body })) });
    const grant = held.body.grant as { token: string; expiresAt: string; purposes: ('sales_context' | 'purchase_history')[] };
    issuedGrants.push(grant.token);
    expect(await direct.getSalesContext(String(held.body.customerRef), grant)).toMatchObject({ status: 'available' });
    record('21 revocation after issuance', 'E2E', { afterRevocation: after.payload, heldGrantAtCp: 'accepted until exp' });
  });

  it('23. two tasks, two subjects, concurrently: each task reads only its own customer', async () => {
    const a = await boundTask(nextRecipient());
    const b = await boundTask(nextRecipient());
    expect(await verify(cia, a.subject!, 'valid@synthetic.test')).toBe('linked'); // 900000201: has purchases
    expect(await verify(cia, b.subject!, 'other@synthetic.test')).toBe('linked'); // 900000202: none
    const [ra, rb, ra2] = await Promise.all([r4.context(a.taskId), r4.context(b.taskId), r4.context(a.taskId)]);
    record('23 subject isolation', 'E2E', { a: ra.payload, b: rb.payload });
    expect(ra.payload).toMatchObject({ identity: 'verified', purchaseHistory: 'present' });
    expect(ra2.payload).toMatchObject({ identity: 'verified', purchaseHistory: 'present' });
    expect(rb.payload).toMatchObject({ identity: 'verified', purchaseHistory: 'none' });
  });
});

describe('FAULT: one hop deliberately altered, the refusal happens before any data reaches a capability', () => {
  // One subject linked once (the CIA rate-limits verifications per e-mail); every test then opens a NEW
  // task and binding for that subject, as a returning customer in a new conversation (new session).
  let shared: Subject | null = null;
  async function linked() {
    if (shared === null) {
      const first = await boundTask(nextRecipient());
      expect(await verify(cia, first.subject!, 'valid@synthetic.test')).toBe('linked');
      shared = first.subject!;
    }
    return boundTask(shared.subjectRef);
  }

  it('9. a real grant issued to another consumer: CP rejects it (consumer_mismatch) and R4 fails unauthorized', async () => {
    const { taskId } = await linked();
    // The other consumer's own conversation with the same customer (CIA throttles OTPs per subject).
    const foreignSubject = { subjectRef: nextRecipient(), sessionRef: 'bnd_other_consumer_0001' };
    expect(await verify(cia, foreignSubject, 'valid@synthetic.test', { consumer: 'other-consumer' })).toBe('linked');
    const foreign = await ciaResolve(cia, foreignSubject, ['sales_context'], 'other-consumer');
    expect(foreign.body).toMatchObject({ status: 'verified', customerRef: 'prestashop_customer:900000201' });
    const r = withResolver((real) => ({ resolve: async (s, p, o) => ({ ...(await real.resolve(s, p, o)), grant: foreign.body.grant }) as IdentityResolution }));
    const observation = await r.context(taskId);
    record('9 grant of another consumer', 'FAULT', { failure: failureOf(observation), cp: lastDecision(cp) });
    expect(failureOf(observation)).toMatchObject({ category: 'unauthorized' });
    expect(lastDecision(cp)).toEqual({ outcome: 'rejected', reason: 'consumer_mismatch' });
  });

  it('10. a real grant of one account presented for another: CP rejects it (customer_mismatch)', async () => {
    const { taskId } = await linked();
    const r = withResolver((real) => ({ resolve: async (s, p, o) => ({ ...(await real.resolve(s, p, o)), customerRef: 'prestashop_customer:900000202' }) as IdentityResolution }));
    const observation = await r.context(taskId);
    record('10 grant of another account', 'FAULT', { failure: failureOf(observation), cp: lastDecision(cp) });
    expect(failureOf(observation)).toMatchObject({ category: 'unauthorized' });
    expect(lastDecision(cp)).toEqual({ outcome: 'rejected', reason: 'customer_mismatch' });
  });

  it('11/15. a tampered grant: CP rejects it (bad_signature); R4 never reads it as a verified identity', async () => {
    const { taskId } = await linked();
    const r = withResolver((real) => ({
      resolve: async (s, p, o) => {
        const resolution = await real.resolve(s, p, o);
        if (resolution.status !== 'verified') return resolution;
        const [h, c, sig] = resolution.grant.token.split('.');
        return { ...resolution, grant: { ...resolution.grant, token: `${h}.${c}.${sig!.slice(0, 10)}${sig![10] === 'A' ? 'B' : 'A'}${sig!.slice(11)}` } };
      },
    }));
    const observation = await r.context(taskId);
    record('11 tampered grant', 'FAULT', { failure: failureOf(observation), cp: lastDecision(cp) });
    expect(observation).toMatchObject({ outcome: 'failed', payload: null });
    expect(failureOf(observation)).toMatchObject({ category: 'unauthorized' });
    expect(lastDecision(cp)).toEqual({ outcome: 'rejected', reason: 'bad_signature' });
  });

  it('12. a grant that expires before R4 uses it: incoherent_grant in R4, nothing sent to CP', async () => {
    const { taskId, subject } = await boundTask(nextRecipient());
    expect(await verify(shortCia, subject!, 'valid@synthetic.test')).toBe('linked');
    const shortResolver = new CustomerIdentityHttpClient({ config: loadCustomerIdentityHttpConfig(env({ R4_CUSTOMER_IDENTITY_BASE_URL: shortCia.baseUrl })), fetch: (url, init) => fetch(url, init).then((r) => ({ status: r.status, headers: r.headers, body: r.body })) });
    const r = withResolver(() => ({
      resolve: async (s, p, o) => {
        const resolution = await shortResolver.resolve(s, p, o);
        if (resolution.status === 'verified') {
          issuedGrants.push(resolution.grant.token);
          while (Date.now() <= Date.parse(resolution.grant.expiresAt)) await new Promise((done) => setTimeout(done, 100));
        }
        return resolution;
      },
    }));
    const before = decisionsOf(cp);
    const observation = await r.context(taskId);
    record('12 expired grant', 'FAULT', { failure: failureOf(observation) });
    expect(failureOf(observation)).toMatchObject({ category: 'contract_violation', code: 'incoherent_grant' });
    expect(decisionsOf(cp)).toBe(before);
  }, 30_000);

  it('13. CIA unavailable: temporarily_unavailable, no CP call', async () => {
    const { taskId } = await linked();
    const before = decisionsOf(cp);
    const observation = await composed({ R4_CUSTOMER_IDENTITY_BASE_URL: `http://127.0.0.1:${await freePort()}` }).context(taskId);
    record('13 CIA unavailable', 'FAULT', { failure: failureOf(observation) });
    expect(failureOf(observation)).toMatchObject({ category: 'temporarily_unavailable', code: 'identity_unreachable' });
    expect(decisionsOf(cp)).toBe(before);
  });

  it('14. CP unavailable: temporarily_unavailable after a verified resolution', async () => {
    const { taskId } = await linked();
    const observation = await composed({ R4_CUSTOMER_PROFILE_BASE_URL: `http://127.0.0.1:${await freePort()}` }).context(taskId);
    record('14 CP unavailable', 'FAULT', { failure: failureOf(observation) });
    expect(failureOf(observation)).toMatchObject({ category: 'temporarily_unavailable', code: 'profile_unreachable' });
  });

  it('16. a CP that does not verify grants (service_scope_only) is refused: contract_violation', async () => {
    const { taskId } = await linked();
    const observation = await composed({ R4_CUSTOMER_PROFILE_BASE_URL: cpDisabled.baseUrl }).context(taskId);
    record('16 CP service_scope_only', 'FAULT', { failure: failureOf(observation) });
    expect(failureOf(observation)).toMatchObject({ category: 'contract_violation', code: 'authorization_basis_insufficient' });
  });

  it('22. a CP answer carrying a prohibited field (injected by a proxy) is refused before the capability sees it', async () => {
    const { taskId } = await linked();
    const proxy: Server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const upstream = httpRequest(`${cp.baseUrl}${req.url}`, { method: req.method, headers: req.headers }, (up) => {
          const body: Buffer[] = [];
          up.on('data', (c: Buffer) => body.push(c));
          up.on('end', () => {
            const json = JSON.parse(Buffer.concat(body).toString('utf8')) as Record<string, unknown>;
            const leaked = JSON.stringify({ ...json, account: { ...(json.account as object), email: 'valid@synthetic.test' } });
            res.writeHead(up.statusCode ?? 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(leaked);
          });
        });
        upstream.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    try {
      const observation = await composed({ R4_CUSTOMER_PROFILE_BASE_URL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` }).context(taskId);
      record('22 CP with prohibited data', 'FAULT', { failure: failureOf(observation) });
      expect(observation).toMatchObject({ outcome: 'failed', payload: null });
      expect(failureOf(observation)).toMatchObject({ category: 'contract_violation', code: 'sensitive_field_present' });
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((done) => proxy.close(() => done()));
    }
  });
});

describe('ADAPTER: Customer Profile adapter against the real CP with real CIA grants', () => {
  it('8b. a real grant without the purpose is refused by R4 before the network; forced to CP, CP rejects it (purpose_not_granted)', async () => {
    const { subject } = await boundTask(nextRecipient());
    expect(await verify(cia, subject!, 'history@synthetic.test')).toBe('linked');
    const resolved = await ciaResolve(cia, subject!, ['sales_context']);
    const grant = resolved.body.grant as { token: string; expiresAt: string; purposes: ('sales_context' | 'purchase_history')[] };
    issuedGrants.push(grant.token);
    const client = new CustomerProfileHttpClient({ config: { baseUrl: cp.baseUrl, bearerToken: CP_TOKEN, timeoutMs: 3000, lifecycle: 'synthetic' }, fetch: (url, init) => fetch(url, init).then((r) => ({ status: r.status, headers: r.headers, body: r.body })) });
    await expect(client.getPurchaseHistory(String(resolved.body.customerRef), grant, { offset: 0, limit: 10 })).rejects.toMatchObject({ category: 'validation', code: 'grant_purpose_not_covered' });
    await expect(client.getPurchaseHistory(String(resolved.body.customerRef), { ...grant, purposes: ['purchase_history'] }, { offset: 0, limit: 10 })).rejects.toMatchObject({ category: 'unauthorized' });
    expect(lastDecision(cp)).toEqual({ outcome: 'rejected', reason: 'purpose_not_granted' });
    record('8b purpose not covered (adapter)', 'ADAPTER', { cp: lastDecision(cp) });
  });

  it('a duplicated grant header, sent raw to the real CP, is rejected (malformed): R4 always sends one', async () => {
    const { subject } = await boundTask(nextRecipient());
    expect(await verify(cia, subject!, 'other@synthetic.test')).toBe('linked');
    const resolved = await ciaResolve(cia, subject!, ['sales_context']);
    const grantToken = (resolved.body.grant as { token: string }).token;
    issuedGrants.push(grantToken);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${cp.baseUrl}/v1/capabilities/customer/sales-context`, { method: 'POST', headers: { authorization: `Bearer ${CP_TOKEN}`, 'content-type': 'application/json', 'x-customer-access-grant': [grantToken, grantToken] } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ customerRef: resolved.body.customerRef, purpose: 'sales_context' }));
    });
    expect(status).toBe(403);
    expect(lastDecision(cp)).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(new Set(issuedGrants.filter((g) => g === grantToken)).size).toBe(1);
  });
});

describe('24. nothing sensitive leaks into R4 observations, telemetry or logs', () => {
  it('no JWS segment, e-mail, channel subject, customerRef or binding id in any observation or adapter event', () => {
    const r4Surface = JSON.stringify([observations, identityEvents, profileEvents]);
    expect(issuedGrants.length).toBeGreaterThan(5);
    for (const grant of issuedGrants) for (const segment of grant.split('.')) expect(r4Surface).not.toContain(segment);
    for (const secret of ['@synthetic.test', 'prestashop_customer', '15555770', R4_CUSTOMER_ID, CP_TOKEN, CIA_TOKENS['r4-sales'].agent]) expect(r4Surface).not.toContain(secret);
    expect(observations.length).toBeGreaterThan(15);
    record('24 no leak', 'E2E', { observations: observations.length, identityEvents: identityEvents.length, profileEvents: profileEvents.length, grantsChecked: issuedGrants.length });
  });

  it('the compiled CP never logged a grant, e-mail or customerRef either', () => {
    for (const out of [cp.out(), cpDisabled.out()]) {
      for (const grant of issuedGrants) for (const segment of grant.split('.')) expect(out).not.toContain(segment);
      expect(out).not.toContain('prestashop_customer:');
      expect(out).not.toContain('@synthetic.test');
    }
  });
});
