#!/usr/bin/env node
// R4-J4-R5 single-EC2 canary: one long-running synthetic CIA for the isolated sales-production@8 canary.
//
// Runs the CIA's own composition root (createCia) from a BUILT, clean CIA checkout (CIA_DIR, CIA 7525395):
// nothing of the CIA is copied or modified, and the CIA validates the configuration itself (synthetic mode,
// loopback database, loopback HTTP, loopback egress, .test e-mail domains, synthetic keys). Differences from the
// CIA's own `npm start`, all on the synthetic side:
//   - the account provider is the CIA's own synthetic HTTP double (tests/support/account-provider-double.ts) on
//     loopback, with the canary's synthetic accounts;
//   - the OTP goes to the CIA's fake e-mail sender (in memory). The canary operator reads a code from it through a
//     loopback-only mailbox endpoint guarded by a bearer token: GET /code?email=<synthetic address>.
//
// Credentials arrive as SHA-256 hashes only (the CIA stores no plaintext token); the mailbox token likewise.
//
//   CIA_DIR=<built CIA checkout> CIA_HOST_CONFIG=<0600 JSON> node scripts/canary-j4/cia-host.mjs
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { URL, pathToFileURL } from 'node:url';

const dir = process.env.CIA_DIR;
const options = JSON.parse(readFileSync(process.env.CIA_HOST_CONFIG, 'utf8'));
const load = (file) => import(pathToFileURL(join(dir, file)).href);
const { createCia } = await load('dist/src/app.js');
const { validateConfig } = await load('dist/src/config.js');
const { installEgressGuard } = await load('dist/src/isolation.js');
const { FakeEmailSender } = await load('dist/src/adapters/fake/email-sender.js');
const { AccountProviderDouble } = await load('tests/support/account-provider-double.ts');

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const log = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
const AGENT_SCOPES = ['identity.verification.start', 'identity.resolve', 'identity.link.revoke'];
// The R4 canary's synthetic channel (agents/sales/src/cli/canary/channel.ts): one-to-one conversations.
const CHANNELS = {
  'r4-synthetic': { channelAccountRefs: ['sales-canary'], subjectRefPattern: '^synthetic:[a-z0-9][a-z0-9._-]{0,63}$', displayName: 'el chat sintético del canary', minAssurance: 'provider_signed' },
};
const account = (a) => ({ shopId: 1, active: true, guest: false, deleted: false, ...a });

// The provider double's token never leaves this process.
const providerToken = `synthetic-provider-${randomBytes(24).toString('hex')}`;
const double = await new AccountProviderDouble(providerToken, options.accounts.map(account)).start(0);

const config = validateConfig({
  mode: 'synthetic',
  databaseUrl: options.databaseUrl,
  databaseSchema: options.schema,
  http: { host: '127.0.0.1', port: options.port },
  keySeed: options.keySeed,
  egressAllowHosts: LOOPBACK,
  allowedEmailDomains: ['synthetic.test'],
  deliveryIntervalMs: 1000,
  grant: { issuer: 'https://cia.synthetic.test', audience: 'customer-profile', keys: { activeKid: 'cia-synthetic-j4r5-k1', kids: ['cia-synthetic-j4r5-k1'] } },
  accountProvider: { kind: 'http', namespace: 'prestashop_customer', baseUrl: double.baseUrl, token: providerToken, timeoutMs: 1500 },
  emailSender: { kind: 'fake', deduplicates: false },
  credentials: [
    { tokenSha256: options.r4Sales.agentTokenSha256, consumerId: 'r4-sales', kind: 'agent', scopes: AGENT_SCOPES },
    { tokenSha256: options.r4Sales.channelTokenSha256, consumerId: 'r4-sales', kind: 'channel-integration', scopes: ['identity.verification.confirm'] },
  ],
  consumers: [{ id: 'r4-sales', purposes: ['sales_context', 'purchase_history'], providerScope: ['1'], channels: CHANNELS }],
});
installEgressGuard(config.egressAllowHosts);

const sender = new FakeEmailSender(false);
const cia = await createCia(config, {
  emailSender: sender,
  // Rate-limit decisions only (limit name and consumer; never an identifier).
  log: (event, fields) => { if (event.includes('rate_limited')) log(event, { limit: fields?.limit, consumer: fields?.consumer }); },
});
const baseUrl = await cia.http.listen({ host: config.http.host, port: config.http.port });

let delivering = false;
const deliver = async () => {
  if (delivering) return;
  delivering = true;
  try {
    await cia.delivery.runOnce();
  } catch (error) {
    log('delivery.failed', { error: error instanceof Error ? error.name : 'unknown' });
  } finally {
    delivering = false;
  }
};
const timer = setInterval(deliver, config.deliveryIntervalMs);

// The synthetic mailbox, for the canary operator only: loopback, bearer token, synthetic addresses only.
const mailboxHash = Buffer.from(options.mailboxTokenSha256, 'hex');
const authorized = (header) => {
  const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
  return token !== undefined && timingSafeEqual(createHash('sha256').update(token).digest(), mailboxHash);
};
const mailbox = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const email = url.searchParams.get('email') ?? '';
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  if (req.method !== 'GET' || url.pathname !== '/code') return send(404, { error: 'not_found' });
  if (!authorized(req.headers.authorization)) return send(401, { error: 'unauthorized' });
  if (!email.endsWith('@synthetic.test')) return send(400, { error: 'synthetic_address_only' });
  await deliver();
  const code = sender.codeFor(email);
  log('mailbox.read', { found: code !== undefined });
  return send(code === undefined ? 404 : 200, code === undefined ? { error: 'no_code' } : { code });
});
await new Promise((done) => mailbox.listen(options.mailboxPort, '127.0.0.1', done));
log('cia.started', { baseUrl, mailbox: `http://127.0.0.1:${options.mailboxPort}`, accounts: options.accounts.length });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(timer);
    mailbox.close();
    void Promise.allSettled([cia.close(), double.close()]).then(() => {
      log('cia.stopped');
      process.exit(0);
    });
  });
}
