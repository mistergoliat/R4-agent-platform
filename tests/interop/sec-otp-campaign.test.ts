import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CiaVerificationConfirmClient, loadCiaVerificationConfirmConfig, type CiaConfirmCallTelemetry, type CustomerIdentityCallTelemetry, type CustomerIdentityFetch } from '@r4-adapters/identity-http';
import type { CustomerProfileCallTelemetry } from '@r4-adapters/customer-http';
import { IdentityVerificationStore, PLATFORM_MARKERS, RESUME_SOURCE, type ConfirmPort, type IdentityVerificationInspection } from '@r4-adapters/identity-verification';
import { CapabilityInvoker, CapabilityRegistry, type CapabilityRegistration, type WriteCapabilityRegistration } from '@r4/capability-runtime';
import type { Observation, TrustedExecutionContext } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { ActionPolicyEngine } from '@r4/policy-engine';
import { composeSyntheticCustomerCapabilities, composeSyntheticIdentityVerificationCapabilities } from '../../agents/sales/src/capabilities/customer-synthetic.js';
import { CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID } from '../../agents/sales/src/capabilities/customer-v2.js';
import { IDENTITY_SCOPES, IDENTITY_VERIFICATION_ACTION_POLICY, IDENTITY_VERIFICATION_CAPABILITY_IDS } from '../../agents/sales/src/capabilities/identity-verification.js';
import { notification } from '@r4-adapters/whatsapp-cloud/testing';
import { FakeClock, idsFrom } from '../support/deterministic.js';
import { governedWrite } from '../support/governed.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';
import { CANARY_PHONE_ID, LiveOpsTestbed, OPERATOR, keyOf } from '../support/live-ops.js';

// R4-J4 SEC-S7: the synthetic end-to-end campaign of SEC-OTP with real R4 components and synthetic CIA/CP:
// - CIA: its own composition root from a clean, built checkout at 7525395 (R4_INTEROP_CIA_DIR), real
//   PostgreSQL, the CIA's HTTP account-provider double, OTP to the CIA's fake mailbox only;
// - CP: the compiled service of a clean checkout at bbd766e (R4_INTEROP_CP_DIR), synthetic source,
//   auth enforce, grant mode required, the CIA JWKS pinned;
// - R4: a signed synthetic webhook through the real gateway, ChannelIngress, the locked inspected
//   transaction and VerificationInspector; the real confirm dispatcher with the real CIA confirm client
//   (channel-integration credential); the real TemporalRuntime resume; identity.start_verification@1 through
//   the real ActionPolicyEngine and ActionExecutor; identity.verification_status@1 and customer.*@3/@2 through
//   the real CapabilityInvoker. The model is not part of the campaign (no profile registers these capabilities).
// Opt-in (npm run test:interop). Without the checkouts the file FAILS (NOT_RUN). No real customer, mailbox,
// shop, OTP or host. Kinds of evidence: E2E (nothing altered), FAULT (one hop or resource altered by the test).

const CIA_DIR = process.env.R4_INTEROP_CIA_DIR ?? '';
const CP_DIR = process.env.R4_INTEROP_CP_DIR ?? '';
if (!existsSync(path.join(CIA_DIR, 'dist', 'src', 'app.js')) || !existsSync(path.join(CP_DIR, 'dist', 'src', 'index.js'))) {
  throw new Error('NOT_RUN: R4_INTEROP_CIA_DIR (CIA 7525395) and R4_INTEROP_CP_DIR (CP bbd766e) must point to clean, built checkouts');
}
const CIA_DATABASE_URL = process.env.R4_INTEROP_CIA_DATABASE_URL ?? 'postgres://cia:cia_local_only@127.0.0.1:55433/cia';
const DRIVER = path.join(import.meta.dirname, 'support', 'cia-synthetic-instance.mjs');
const WORK = mkdtempSync(path.join(tmpdir(), 'r4-s7-campaign-'));
const RUN = randomBytes(3).toString('hex');

const token = (label: string, bytes = 24) => `synthetic-${label}-${randomBytes(bytes).toString('hex')}`;
const CIA_TOKENS = { 'r4-sales': { agent: token('cia-r4-agent'), channel: token('cia-r4-channel') }, 'other-consumer': { agent: token('cia-other-agent'), channel: token('cia-other-channel') } };
const CP_TOKEN = token('cp-r4-sales');
const KEYS = `k0:${randomBytes(32).toString('base64')}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

type Account = { email: string; customerId: number; shopId: 1; active: boolean; guest: boolean; deleted: boolean };
const account = (email: string, customerId: number): Account => ({ email, customerId, shopId: 1, active: true, guest: false, deleted: false });
// CP's synthetic source knows these customers: 900000201 (history present), 900000202 (none), 900000302 (empty).
const ACCOUNTS = [account('valid@synthetic.test', 900000201), account('other@synthetic.test', 900000202), account('history@synthetic.test', 900000201), account('replace@synthetic.test', 900000202)];

// ---- evidence and leak surfaces ------------------------------------------------------------------
const evidence: Record<string, unknown>[] = [];
const record = (scenario: string, kind: 'E2E' | 'FAULT', result: Record<string, unknown>) => evidence.push({ scenario, kind, ...result });
const codesSeen = new Set<string>();
const gatewayLog: string[] = [];
const identityEvents: CustomerIdentityCallTelemetry[] = [];
const profileEvents: CustomerProfileCallTelemetry[] = [];
const confirmEvents: CiaConfirmCallTelemetry[] = [];
const observations: Observation[] = [];

// ---- processes (CIA through its driver, CP compiled) -----------------------------------------------
const children: ChildProcess[] = [];
type Cia = { baseUrl: string; code: (email: string) => Promise<string>; addAccount: (a: Account) => Promise<void>; close: () => Promise<void> };

async function startCia(options: Record<string, unknown> = {}): Promise<Cia> {
  const child = fork(DRIVER, [], {
    env: { ...process.env, CIA_DIR, CIA_INSTANCE: JSON.stringify({ databaseUrl: CIA_DATABASE_URL, schema: `r4_s7_${randomBytes(5).toString('hex')}`, providerToken: token('provider'), accounts: ACCOUNTS, tokens: CIA_TOKENS, channelAccountRefs: [CANARY_PHONE_ID], ...options }) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
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
      codesSeen.add(reply.code);
      return reply.code;
    },
    addAccount: async (a) => void (await ask({ op: 'add_account', account: a })),
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
async function startCp(jwks: { keys: unknown[] }): Promise<Cp> {
  const registry = path.join(WORK, 'registry.json');
  writeFileSync(registry, JSON.stringify({ version: 1, principals: [{ principalId: 'r4-sales', scopes: ['customer.sales_context.read'], tokenSha256: [sha(CP_TOKEN)] }] }));
  const verifier = path.join(WORK, 'verifier.json');
  writeFileSync(verifier, JSON.stringify({ synthetic: true, iss: 'https://cia.synthetic.test', aud: 'customer-profile', typ: 'cia-grant+jwt', algorithms: ['ES256'], supportedClaimsVersions: [1], maxTtlSeconds: 300, clockSkewSeconds: 60, maxProofAgeSeconds: 7_776_000, maxTokenBytes: 2048, jwks }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(CP_DIR, 'dist', 'src', 'index.js')], {
    cwd: WORK,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port),
      CRM_DB_HOST: '127.0.0.1', CRM_DB_PORT: '1', CRM_DB_USER: 'none', CRM_DB_PASSWORD: 'none',
      PRESTASHOP_DB_HOST: '127.0.0.1', PRESTASHOP_DB_PORT: '1', PRESTASHOP_DB_USER: 'none', PRESTASHOP_DB_PASSWORD: 'none',
      PRESTASHOP_ORDER_STATE_LANG_ID: '1', PRESTASHOP_CARRIER_LANG_ID: '1', PRESTASHOP_CARRIER_SHOP_ID: '1',
      CUSTOMER_PROFILE_API_AUTH_MODE: 'enforce', CUSTOMER_PROFILE_PRINCIPAL_REGISTRY_FILE: registry,
      CUSTOMER_PROFILE_SALES_CONTEXT_ENABLED: 'true', CUSTOMER_PROFILE_SALES_CONTEXT_SOURCE: 'synthetic',
      CUSTOMER_PROFILE_CUSTOMER_GRANT_MODE: 'required', CUSTOMER_PROFILE_CUSTOMER_GRANT_VERIFIER_FILE: verifier,
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
const lastDecision = (cp: Cp) => /outcome: '(\w+)'/.exec(cp.out().split("event: 'customer_grant_decision'").at(-1)!)?.[1] ?? null;

// ---- R4: one environment per CIA instance ------------------------------------------------------------
/** A fault hop in front of the CIA confirm route only (FAULT evidence): never alters a request body. */
interface ConfirmFaults { unavailable: number; cutAfterApplied: number; readonly keys: string[] }

interface Environment {
  readonly cia: Cia;
  readonly bed: LiveOpsTestbed;
  readonly store: IdentityVerificationStore;
  readonly faults: ConfirmFaults;
  readonly options: { readonly requested: 'full'; readonly codeKeys: string; readonly confirm: ConfirmPort };
  start(conv: Conversation, email: string): Promise<{ outcome: string; errorCode: string | null }>;
  status(conv: Conversation): Promise<Record<string, unknown>>;
  context(conv: Conversation): Promise<Observation>;
  history(conv: Conversation): Promise<Observation>;
  dispatcherOn(): void;
}

const env = (cia: Cia) => ({
  R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: cia.baseUrl, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: CIA_TOKENS['r4-sales'].agent, R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '3000',
  R4_CUSTOMER_PROFILE_BASE_URL: cp.baseUrl, R4_CUSTOMER_PROFILE_BEARER_TOKEN: CP_TOKEN, R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
  R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: CIA_TOKENS['r4-sales'].channel,
});

async function environment(cia: Cia, options: { resendIntervalMs?: number } = {}): Promise<Environment> {
  const faults: ConfirmFaults = { unavailable: 0, cutAfterApplied: 0, keys: [] };
  const confirmFetch: CustomerIdentityFetch = async (url, init) => {
    faults.keys.push(init.headers['idempotency-key'] ?? '');
    if (faults.unavailable > 0) {
      faults.unavailable -= 1;
      const synthetic = new Response(JSON.stringify({ error: { code: 'dependency_unavailable', retryable: true } }), { status: 503, headers: { 'content-type': 'application/json' } });
      return { status: synthetic.status, headers: synthetic.headers, body: synthetic.body };
    }
    const response = await fetch(url, init);
    if (faults.cutAfterApplied > 0) {
      faults.cutAfterApplied -= 1;
      await response.arrayBuffer();
      throw new TypeError('connection cut after the CIA applied the attempt');
    }
    return { status: response.status, headers: response.headers, body: response.body };
  };
  const confirm = new CiaVerificationConfirmClient({ config: loadCiaVerificationConfirmConfig(env(cia)), fetch: confirmFetch, onCall: (e) => confirmEvents.push(e) });
  const inspectionOptions = { requested: 'full' as const, codeKeys: KEYS, confirm, dispatcher: { pollMs: 100 } };
  const logger = pino({ level: 'info' }, new Writable({ write(chunk: Buffer, _enc, done) { gatewayLog.push(chunk.toString()); done(); } }));
  const bed = await LiveOpsTestbed.start({ identityVerification: inspectionOptions, autonomy: true, percent: 100, gatewayLogger: logger });
  const store = new IdentityVerificationStore(bed.pool);
  const transport = (url: string, init: RequestInit) => fetch(url, init);
  const identity = composeSyntheticIdentityVerificationCapabilities({ env: env(cia), bindings: bed.store, pool: bed.pool, fetch: transport, ...(options.resendIntervalMs ? { resendIntervalMs: options.resendIntervalMs } : {}) });
  const customer = composeSyntheticCustomerCapabilities({ env: env(cia), bindings: bed.store, fetch: transport, onIdentityCall: (e) => identityEvents.push(e), onProfileCall: (e) => profileEvents.push(e) });
  const registry = new CapabilityRegistry();
  for (const c of [...customer, ...identity.reads]) registry.register(c as CapabilityRegistration<unknown, unknown>);
  for (const w of identity.writes) registry.registerWrite(w as WriteCapabilityRegistration<unknown, unknown>);
  const policy = new ActionPolicyEngine(IDENTITY_VERIFICATION_ACTION_POLICY);
  const clock = new FakeClock(new Date().toISOString());
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock: { now: () => new Date() }, logger: createSilentLogger() });
  const read = async (conv: Conversation, capabilityId: string, version: number) => {
    const context: TrustedExecutionContext = { taskId: conv.taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 1, correlationId: `s7-${randomBytes(4).toString('hex')}`, grantedScopes: ['customer.read', IDENTITY_SCOPES.verify] };
    const observation = await invoker.invoke({ capabilityId, capabilityVersion: version, arguments: {} }, context);
    observations.push(observation);
    return observation;
  };
  const e: Environment = {
    cia, bed, store, faults, options: inspectionOptions,
    start: async (conv, email) => {
      const outcome = await governedWrite({ registry, policy, taskId: conv.taskId, capabilityId: IDENTITY_VERIFICATION_CAPABILITY_IDS.start, args: { email }, grantedScopes: [IDENTITY_SCOPES.verify] });
      if (outcome.stage !== 'executed') return { outcome: outcome.stage, errorCode: null };
      return { outcome: outcome.report.outcome, errorCode: outcome.report.errorCode };
    },
    status: async (conv) => (await read(conv, IDENTITY_VERIFICATION_CAPABILITY_IDS.status, 1)).payload as Record<string, unknown>,
    context: (conv) => read(conv, 'customer.get_context', 3),
    history: (conv) => read(conv, CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID, 2),
    dispatcherOn: () => bed.gateway.inspection?.start(),
  };
  e.dispatcherOn();
  return e;
}

interface Conversation { readonly wa: string; readonly key: string; readonly taskId: string; readonly bindingId: string }
let subjects = 0;
const nextWa = () => `5691700${String(++subjects).padStart(4, '0')}`;
let counter = 0;
const eventId = () => `wamid.SECS7.${RUN}.${++counter}`;

async function open(e: Environment, text = 'hola, quiero ver mis compras'): Promise<Conversation> {
  const wa = nextWa();
  expect((await e.bed.customer(wa, eventId(), text)).status).toBe(200);
  const binding = await e.bed.store.findOpenBinding('whatsapp', keyOf(wa));
  return { wa, key: keyOf(wa), taskId: binding!.taskId!, bindingId: binding!.bindingId };
}
async function say(e: Environment, conv: Pick<Conversation, 'wa'>, text: string): Promise<string> {
  const id = eventId();
  expect((await e.bed.customer(conv.wa, id, text)).status).toBe(200);
  return id;
}
async function current(e: Environment, conv: Conversation): Promise<Conversation> {
  const binding = await e.bed.store.findOpenBinding('whatsapp', conv.key);
  return { ...conv, taskId: binding!.taskId!, bindingId: binding!.bindingId };
}
const latest = (e: Environment, conv: Conversation) => e.store.latestForBinding(conv.bindingId);
async function until<T>(probe: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`condition not reached: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const settled = (e: Environment, conv: Conversation, check: (state: string, outcome: string | null) => boolean) =>
  until(() => latest(e, conv), (x) => x !== null && check(x.state, x.ciaOutcome));
const persisted = async (e: Environment, providerEventId: string) => (await e.bed.rows<{ content_sha256: string }>('select content_sha256 from inbound_events where provider_event_id = $1', [providerEventId]))[0]?.content_sha256;
const confirmCalls = () => confirmEvents.length;
const wrongCodeFor = (code: string) => (code === '111111' ? '222222' : '111111');

/** The full declare-email → start → OTP sequence of a conversation; returns the code. */
async function startAndRead(e: Environment, conv: Conversation, email: string): Promise<string> {
  await say(e, conv, `mi correo es ${email}`);
  expect(await e.start(conv, email)).toEqual({ outcome: 'applied', errorCode: null });
  return e.cia.code(email);
}

let cia: Cia;
let fastCia: Cia;
let cp: Cp;
let main: Environment;
let fast: Environment;

beforeAll(async () => {
  cia = await startCia();
  // A second instance with SHORTER OTP timings through the CIA's own settings option (the contract's
  // values are 600 s / 60 s): used only for the expired-code and replacement scenarios.
  fastCia = await startCia({ otp: { ttlSeconds: 20, maxAttempts: 5, resendSeconds: 1 } });
  const jwks = (await (await fetch(`${cia.baseUrl}/.well-known/jwks.json`)).json()) as { keys: unknown[] };
  cp = await startCp(jwks);
  main = await environment(cia);
  fast = await environment(fastCia, { resendIntervalMs: 1_000 });
  record('setup', 'E2E', { cia: '7525395', cp: 'bbd766e', kids: jwks.keys.map((k) => (k as { kid: string }).kid), fastCiaOtp: { ttlSeconds: 20, resendSeconds: 1 } });
}, 240_000);

afterAll(async () => {
  await Promise.allSettled([main?.bed.close(), fast?.bed.close()]);
  await Promise.allSettled([cp?.close(), cia?.close(), fastCia?.close()]);
  for (const child of children) if (child.exitCode === null) child.kill();
  if (process.env.R4_INTEROP_SEC_OTP_EVIDENCE) writeFileSync(process.env.R4_INTEROP_SEC_OTP_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
}, 120_000);

describe('A. existing account: webhook → expectation → e-mail → OTP → interception → confirm → link → resolve → grant → Customer Profile', () => {
  it('runs end to end with nothing altered', async () => {
    const conv = await open(main);
    expect((await main.history(conv)).payload).toEqual({ identity: 'unavailable', reason: 'not_linked' });
    const code = await startAndRead(main, conv, 'valid@synthetic.test');
    const expectation = await latest(main, conv);
    expect(expectation).toMatchObject({ state: 'awaiting_code' });
    const id = await say(main, conv, `mi código es ${code}`);
    expect(await persisted(main, id)).toBe(sha(`mi código es ${PLATFORM_MARKERS.codeReceived}`));
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    const resumed = await until(() => main.bed.rows<{ text: string }>(`select m.content->>'text' as text from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id where i.task_id = $1 and i.source_ref = $2`, [conv.taskId, RESUME_SOURCE]), (rows) => rows.length > 0);
    expect(resumed.map((r) => r.text)).toEqual([PLATFORM_MARKERS.updateAvailable]);
    expect(await main.status(conv)).toEqual({ status: 'account_linked' });
    const before = decisionsOf(cp);
    const context = await main.context(conv);
    expect(context).toMatchObject({ outcome: 'succeeded', payload: { identity: 'verified', purchaseHistory: 'present' } });
    expect(decisionsOf(cp)).toBe(before + 1);
    expect(lastDecision(cp)).toBe('accepted');
    expect((await main.history(conv)).payload).toMatchObject({ identity: 'verified', meaning: 'purchased_historically_not_ownership' });
    record('A existing account', 'E2E', { confirm: 'linked', status: 'account_linked', context: context.payload, cp: 'accepted', resume: 'marker without outcome' });
  });
});

describe('B. onboarding: no_eligible_account → onboarding_required → simulated account creation → new OTP → linked → resolve → Customer Profile', () => {
  it('runs end to end; the consumed challenge is never reused and onboarding grants nothing', async () => {
    const conv = await open(main);
    // Letters only: inside a protection window, 4–8 digit runs (also inside an e-mail) are redacted (OA-07).
    const email = `nuevo-${RUN.replace(/[0-9]/g, (d) => String.fromCharCode(103 + Number(d)))}@synthetic.test`;
    const code = await startAndRead(main, conv, email);
    await say(main, conv, code);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'no_eligible_account');
    const onboarding = await main.status(conv);
    expect(onboarding).toEqual({ status: 'onboarding_required', onboarding: { available: false } });
    const before = decisionsOf(cp);
    expect((await main.context(conv)).payload).toEqual({ identity: 'unavailable', reason: 'not_linked' });
    // The account is created in the synthetic PROVIDER (the shop), not in the CIA and not by R4.
    await main.cia.addAccount(account(email, 900000302));
    // AT-ONB-06: still not linked until a NEW challenge is confirmed.
    expect((await main.context(conv)).payload).toEqual({ identity: 'unavailable', reason: 'not_linked' });
    expect(decisionsOf(cp)).toBe(before);
    // The CIA resend interval (contract 60 s) and R4's local guard apply to the new start.
    await new Promise((r) => setTimeout(r, 61_000));
    const second = await startAndRead(main, conv, email);
    expect(second).not.toBe(code);
    await say(main, conv, `el código es ${second}`);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    expect(await main.status(conv)).toEqual({ status: 'account_linked' });
    expect((await main.context(conv)).payload).toMatchObject({ identity: 'verified', purchaseHistory: 'none' });
    expect((await main.history(conv)).payload).toMatchObject({ identity: 'verified', items: [] });
    record('B onboarding', 'E2E', { first: 'no_eligible_account', status: onboarding, afterCreationWithoutNewChallenge: 'not_linked', second: 'linked', context: 'verified' });
  }, 180_000);
});

describe('C. security', () => {
  it('a wrong code: invalid_code (code_rejected, 4 attempts left), then the right code links', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'other@synthetic.test');
    await say(main, conv, wrongCodeFor(code));
    await settled(main, conv, (s, o) => s === 'awaiting_code' && o === 'invalid_code');
    expect(await main.status(conv)).toEqual({ status: 'code_rejected', attemptsRemaining: 4 });
    await say(main, conv, code);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    record('C wrong code', 'E2E', { first: 'invalid_code(4)', then: 'linked' });
  });

  it('an expired code is redacted, never sent; the challenge expires (verification_expired)', async () => {
    const conv = await open(fast);
    const code = await startAndRead(fast, conv, 'valid@synthetic.test');
    const calls = confirmCalls();
    await new Promise((r) => setTimeout(r, 21_000));
    const id = await say(fast, conv, code);
    expect(await persisted(fast, id)).toBe(sha(PLATFORM_MARKERS.numberWithheld));
    await (fast.bed.gateway.inspection as unknown as IdentityVerificationInspection).dispatcher!.sweepOnce();
    expect(await fast.status(conv)).toEqual({ status: 'verification_expired' });
    expect(confirmCalls()).toBe(calls);
    record('C expired code', 'E2E', { inbound: 'withheld', confirmCalls: 0, status: 'verification_expired' });
  }, 60_000);

  it('a duplicated code: three re-deliveries → one capture and one confirm; the same code again after linking is never sent', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'history@synthetic.test');
    const calls = confirmCalls();
    const id = eventId();
    const body = notification(CANARY_PHONE_ID, { messages: [{ id, from: conv.wa, text: code, timestamp: Math.floor(Date.now() / 1000) }] });
    expect((await Promise.all([main.bed.webhook(body), main.bed.webhook(body), main.bed.webhook(body)])).map((r) => r.status)).toEqual([200, 200, 200]);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    expect(confirmCalls()).toBe(calls + 1);
    await say(main, conv, code);
    await new Promise((r) => setTimeout(r, 500));
    expect(confirmCalls()).toBe(calls + 1);
    record('C duplicated code', 'E2E', { redeliveries: 3, captures: 1, confirms: 1, afterLinked: 'withheld, not sent' });
  });

  it('a binding change (task terminal, new conversation task) cancels the expectation; the old code is redacted and never sent', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'replace@synthetic.test');
    const calls = confirmCalls();
    await main.bed.api.temporal.cancelTask(conv.taskId, OPERATOR);
    await say(main, conv, 'hola de nuevo');
    const now = await current(main, conv);
    expect(now.bindingId).not.toBe(conv.bindingId);
    expect(await latest(main, conv)).toMatchObject({ state: 'cancelled', closedReason: 'binding_not_current' });
    const id = await say(main, conv, code);
    expect(await persisted(main, id)).toBe(sha(PLATFORM_MARKERS.numberWithheld));
    expect(confirmCalls()).toBe(calls);
    expect(await main.status(now)).toEqual({ status: 'none' });
    record('C binding change', 'E2E', { expectation: 'cancelled(binding_not_current)', code: 'withheld', confirms: 0, newBindingStatus: 'none' });
  });

  it('a task cancellation alone: the code is redacted, not captured, not sent', async () => {
    const conv = await open(fast);
    const code = await startAndRead(fast, conv, 'other@synthetic.test');
    const calls = confirmCalls();
    await fast.bed.api.temporal.cancelTask(conv.taskId, OPERATOR);
    const id = await say(fast, conv, code);
    expect(await persisted(fast, id)).toBe(sha(PLATFORM_MARKERS.numberWithheld));
    expect(confirmCalls()).toBe(calls);
    record('C task cancelled', 'E2E', { code: 'withheld', confirms: 0 });
  });

  it('a replacement: start A, start B, the code of A → A cancelled, confirmed against B, invalid_code; then B\'s code links', async () => {
    const conv = await open(fast);
    const codeA = await startAndRead(fast, conv, 'history@synthetic.test');
    const a = await latest(fast, conv);
    await new Promise((r) => setTimeout(r, 1_200));
    const codeB = await startAndRead(fast, conv, 'history@synthetic.test');
    expect(await fast.store.expectation(fast.bed.pool, a!.expectationId)).toMatchObject({ state: 'cancelled', closedReason: 'superseded' });
    await say(fast, conv, codeA);
    await settled(fast, conv, (s, o) => s === 'awaiting_code' && o === 'invalid_code');
    await say(fast, conv, codeB);
    await settled(fast, conv, (s, o) => s === 'confirmed' && o === 'linked');
    record('C replacement', 'E2E', { a: 'cancelled(superseded)', codeOfA: 'invalid_code against B', codeOfB: 'linked' });
  }, 60_000);

  it('a restart during confirmation: a pending code survives a gateway restart; a CIA answer lost after applying is replayed with the same key', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'valid@synthetic.test');
    await main.bed.gateway.inspection?.stop();
    const keysBefore = main.faults.keys.length;
    let pending: unknown;
    try {
      await say(main, conv, code);
      pending = await main.bed.rows('select r.state from identity_verification.responses r join identity_verification.expectations e using (expectation_id) where e.binding_id = $1', [conv.bindingId]);
      main.faults.cutAfterApplied = 1;
    } finally {
      // The restart itself: a new gateway over the same database (later scenarios need its dispatcher either way).
      await main.bed.recomposeGateway(main.options);
      main.dispatcherOn();
    }
    expect(pending).toEqual([{ state: 'pending' }]);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    const keys = main.faults.keys.slice(keysBefore);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
    record('C restart during confirmation', 'FAULT', { pendingAcrossRestart: true, cutAfterApplied: 1, attemptsWithOneKey: keys.length, outcome: 'linked' });
  });

  it('the CIA temporarily unavailable (503, 503): backoff with the same key, then linked', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'other@synthetic.test');
    main.faults.unavailable = 2;
    const keysBefore = main.faults.keys.length;
    await say(main, conv, code);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    expect(new Set(main.faults.keys.slice(keysBefore)).size).toBe(1);
    record('C CIA unavailable', 'FAULT', { injected503: 2, outcome: 'linked' });
  });

  it('ambiguous messages: an order number is withheld without spending an attempt (code_needed); the code then links', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'history@synthetic.test');
    const calls = confirmCalls();
    const id = await say(main, conv, `mi pedido es ${wrongCodeFor(code)}`);
    expect(await persisted(main, id)).toBe(sha(`mi pedido es ${PLATFORM_MARKERS.numberWithheld}`));
    expect(await main.status(conv)).toEqual({ status: 'code_needed' });
    expect(confirmCalls()).toBe(calls);
    await say(main, conv, code);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    record('C ambiguous', 'E2E', { order: 'withheld', status: 'code_needed', attemptsSpent: 0, then: 'linked' });
  });

  it('an inspector failure with protection known withholds the whole message (fail closed); after recovery the code links', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'valid@synthetic.test');
    await main.bed.rows('alter table identity_verification.responses rename to responses_fault');
    let id: string;
    try {
      id = await say(main, conv, `el código es ${code}`);
    } finally {
      await main.bed.rows('alter table identity_verification.responses_fault rename to responses');
    }
    expect(await persisted(main, id)).toBe(sha(PLATFORM_MARKERS.messageWithheld));
    await say(main, conv, code);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    record('C inspector failure', 'FAULT', { inbound: 'messageWithheld', capture: false, recovery: 'linked' });
  });

  it('a persistence failure aborts the inbound transaction (500, nothing persisted); the provider re-delivery captures once', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'other@synthetic.test');
    const id = eventId();
    const body = notification(CANARY_PHONE_ID, { messages: [{ id, from: conv.wa, text: code, timestamp: Math.floor(Date.now() / 1000) }] });
    await main.bed.rows(`alter table inbound_events add constraint sec_s7_fault check (provider_event_id <> '${id}') not valid`);
    try {
      expect((await main.bed.webhook(body)).status).toBe(500);
    } finally {
      await main.bed.rows('alter table inbound_events drop constraint sec_s7_fault');
    }
    expect(await persisted(main, id)).toBeUndefined();
    expect(await main.bed.rows('select 1 from identity_verification.responses where provider_event_id = $1', [id])).toEqual([]);
    expect((await main.bed.webhook(body)).status).toBe(200);
    await settled(main, conv, (s, o) => s === 'confirmed' && o === 'linked');
    record('C persistence failure', 'FAULT', { first: 500, persisted: 'nothing', redelivery: 200, outcome: 'linked' });
  });

  it('AT-24: five wrong codes → locked; a sixth is never sent', async () => {
    const conv = await open(main);
    const code = await startAndRead(main, conv, 'replace@synthetic.test');
    const wrong = wrongCodeFor(code);
    for (let i = 0; i < 5; i += 1) {
      const before = confirmCalls();
      await say(main, conv, wrong);
      await until(() => Promise.resolve(confirmCalls()), (n) => n === before + 1);
      await until(() => latest(main, conv), (x) => x !== null && x.state !== 'processing');
    }
    await settled(main, conv, (s) => s === 'rejected');
    expect(await main.status(conv)).toEqual({ status: 'verification_locked' });
    const calls = confirmCalls();
    await say(main, conv, code);
    await new Promise((r) => setTimeout(r, 500));
    expect(confirmCalls()).toBe(calls);
    record('C AT-24 lock', 'E2E', { wrongCodes: 5, status: 'verification_locked', sixth: 'not sent' });
  });

  it('rollback with protection open: no gateway without the inspector; protect_only refuses starts and never captures', async () => {
    const conv = await open(main);
    await say(main, conv, 'mi correo es valid@synthetic.test');
    await expect(main.bed.recomposeGateway(undefined)).rejects.toMatchObject({ code: 'identity_verification_protection_active' });
    await main.bed.recomposeGateway({ requested: 'protect_only', codeKeys: null });
    try {
      expect(await main.start(conv, 'valid@synthetic.test')).toEqual({ outcome: 'rejected', errorCode: 'verification_disabled' });
    } finally {
      await main.bed.recomposeGateway(main.options);
      main.dispatcherOn();
    }
    record('C rollback with protection', 'E2E', { absent: 'refused (identity_verification_protection_active)', protectOnly: 'start refused' });
  });

  it('AT-25: confirm with the agent credential and start with the channel credential are refused by the CIA (403)', async () => {
    const context = { channel: 'whatsapp', channelAccountRef: CANARY_PHONE_ID, subjectRef: nextWa(), sessionRef: randomUUID(), subjectAssurance: 'provider_signed' };
    const post = (route: string, bearer: string, body: unknown) =>
      fetch(`${cia.baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, 'idempotency-key': `s7-${randomBytes(10).toString('hex')}` }, body: JSON.stringify(body) }).then((r) => r.status);
    expect(await post('/v1/identity/verifications', CIA_TOKENS['r4-sales'].channel, { schemaVersion: 1, context, verificationPurpose: 'link_commercial_account', email: 'valid@synthetic.test', purposes: ['sales_context'] })).toBe(403);
    expect(await post('/v1/identity/verifications/confirm', CIA_TOKENS['r4-sales'].agent, { schemaVersion: 1, context, verificationId: 'Vf0SyntheticChallenge1', code: '123456' })).toBe(403);
    record('C AT-25 credentials', 'E2E', { startWithChannelCredential: 403, confirmWithAgentCredential: 403 });
  });

  it('alternative inputs are inventoried as gates (BA-01…BA-06): none of them is exercised with an OTP', () => {
    const app = readFileSync(path.join(import.meta.dirname, '..', '..', 'apps', 'api', 'src', 'app.ts'), 'utf8');
    const routes = [...app.matchAll(/app\.(post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    expect(routes).toContain('POST /v1/tasks/:id/inputs');
    record('C alternative inputs', 'E2E', { protectedRoute: 'POST /v1/channels/:channel/webhook', gates: routes, otpSentThroughThem: 0 });
  });
});

describe('AT-12: sweep N-15 — no code anywhere in R4 after both paths', () => {
  it('no OTP (as sent, spaced, hyphenated or full-width) in any R4 table, the gateway log, observations or telemetry; no sealed code left', async () => {
    const variants = [...codesSeen].flatMap((c) => [c, `${c.slice(0, 3)} ${c.slice(3)}`, `${c.slice(0, 3)}-${c.slice(3)}`, [...c].map((d) => String.fromCharCode(0xff10 + Number(d))).join('')]);
    expect(codesSeen.size).toBeGreaterThan(10);
    // Timestamps (microseconds), UUIDs and hex digests are machine identifiers whose digit runs could
    // collide with a 6-digit code by chance: they are removed, and a code must stand alone between non-digits.
    const scrub = (text: string) =>
      text
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::\d{2})?)?/g, ' ')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' ')
        .replace(/[0-9a-f]{32,}/gi, ' ')
        .replace(/\\?"(?:pid|time|hostname|durationMs|latencyMs|attempts|lease_generation|received_seq|version)\\?":\s*[^,}]*/g, ' ');
    const contains = (text: string, variant: string) => new RegExp(`(?<![0-9０-９])${variant.replace(/\s/g, '\\s')}(?![0-9０-９])`, 'u').test(text);
    for (const e of [main, fast]) {
      const tables = await e.bed.rows<{ s: string; t: string }>(`select table_schema as s, table_name as t from information_schema.tables where table_schema in ('public', 'sales', 'identity_verification') and table_type = 'BASE TABLE'`);
      let dump = '';
      for (const { s, t } of tables) dump += `${(await e.bed.rows<{ j: string | null }>(`select string_agg(row_to_json(x)::text, ' ') as j from "${s}"."${t}" x`))[0]?.j ?? ''}\n`;
      const clean = scrub(dump);
      for (const v of variants) expect(contains(clean, v), `a code variant in the R4 database`).toBe(false);
      expect((await e.bed.rows('select count(*)::int as n from identity_verification.responses where code_ciphertext is not null'))[0]).toEqual({ n: 0 });
    }
    const surfaces = JSON.stringify([gatewayLog, observations, identityEvents, profileEvents, confirmEvents]);
    const cleanSurfaces = scrub(surfaces);
    for (const v of variants) expect(contains(cleanSurfaces, v), 'a code variant in a log, observation or telemetry').toBe(false);
    for (const secret of [CIA_TOKENS['r4-sales'].agent, CIA_TOKENS['r4-sales'].channel, CP_TOKEN, KEYS.slice(3)]) expect(surfaces.includes(secret)).toBe(false);
    expect(gatewayLog.length).toBeGreaterThan(20);
    record('AT-12 sweep N-15', 'E2E', { codesChecked: codesSeen.size, variants: variants.length, gatewayLogLines: gatewayLog.length, observations: observations.length, sealedLeft: 0 });
  });
});
