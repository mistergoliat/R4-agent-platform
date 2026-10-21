// R4-J4-R3 (R3.8): a real CIA instance for the R4 → CIA → CP campaign, in synthetic mode only.
//
// It runs the CIA's own composition root (createCia) from a BUILT, clean CIA checkout given by
// CIA_DIR (CIA 7525395: nothing of the CIA is copied or modified), with:
//   - real HTTP, a real PostgreSQL schema (CIA database, loopback) and the real ES256 signer;
//   - the CIA's own synthetic HTTP double of the account provider (tests/support/
//     account-provider-double.ts), loopback only, with the campaign's synthetic accounts;
//   - consumers `r4-sales` and `other-consumer` with credentials generated for the run;
//   - the fake e-mail sender: the OTP goes to an in-memory synthetic mailbox only.
// The CIA validates this configuration and refuses anything that is not synthetic.
//
// Forked with an IPC channel; the campaign reads OTPs from the synthetic mailbox through it. This
// is the CIA's start/confirm flow driven by a channel-integration principal generated for the test:
// it is NOT R4's WhatsApp ingress (SEC-OTP-01/02 remain out of scope).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.env.CIA_DIR;
const options = JSON.parse(process.env.CIA_INSTANCE);
const load = (file) => import(pathToFileURL(join(dir, file)).href);
const { createCia } = await load('dist/src/app.js');
const { validateConfig } = await load('dist/src/config.js');
const { FakeEmailSender } = await load('dist/src/adapters/fake/email-sender.js');
const { AccountProviderDouble } = await load('tests/support/account-provider-double.ts');
const pg = createRequire(join(dir, 'package.json'))('pg');

const sha = (token) => createHash('sha256').update(token).digest('hex');
const AGENT_SCOPES = ['identity.verification.start', 'identity.resolve', 'identity.link.revoke'];
const CHANNELS = {
  whatsapp: { channelAccountRefs: ['100000000000001'], subjectRefPattern: '^[0-9]{8,15}$', displayName: 'el chat sintético de prueba', minAssurance: 'provider_signed' },
};
const consumer = (id) => ({ id, purposes: ['sales_context', 'purchase_history'], providerScope: ['1'], channels: CHANNELS });
const credentials = (consumerId, tokens) => [
  { tokenSha256: sha(tokens.agent), consumerId, kind: 'agent', scopes: AGENT_SCOPES },
  { tokenSha256: sha(tokens.channel), consumerId, kind: 'channel-integration', scopes: ['identity.verification.confirm'] },
];

const double = await new AccountProviderDouble(options.providerToken, options.accounts).start(0);

const config = validateConfig({
  mode: 'synthetic',
  databaseUrl: options.databaseUrl,
  databaseSchema: options.schema,
  http: { host: '127.0.0.1', port: 0 },
  keySeed: 'synthetic-r4-j4-r3-campaign-key-seed-0001',
  egressAllowHosts: ['127.0.0.1', '::1', 'localhost'],
  allowedEmailDomains: ['synthetic.test'],
  deliveryIntervalMs: 1000,
  grant: { issuer: 'https://cia.synthetic.test', audience: 'customer-profile', keys: { activeKid: 'cia-synthetic-r3-k1', kids: ['cia-synthetic-r3-k1'] } },
  accountProvider: { kind: 'http', namespace: 'prestashop_customer', baseUrl: double.baseUrl, token: options.providerToken, timeoutMs: 1500 },
  emailSender: { kind: 'fake', deduplicates: false },
  credentials: [...credentials('r4-sales', options.tokens['r4-sales']), ...credentials('other-consumer', options.tokens['other-consumer'])],
  consumers: [consumer('r4-sales'), consumer('other-consumer')],
});

const sender = new FakeEmailSender(false);
const cia = await createCia(config, {
  emailSender: sender,
  // Only rate-limit decisions are surfaced (limit name and consumer; no identifier).
  log: (event, fields) => { if (event.includes('rate_limited')) process.stderr.write(`${JSON.stringify({ event, limit: fields?.limit, consumer: fields?.consumer })}
`); },
  ...(options.grantTtlSeconds === undefined ? {} : { settings: { grant: { ttlSeconds: options.grantTtlSeconds } } }),
});
const baseUrl = await cia.http.listen({ host: '127.0.0.1', port: 0 });
process.send({ type: 'ready', baseUrl });

process.on('message', async (message) => {
  if (message.op === 'code') {
    await cia.delivery.runOnce();
    process.send({ id: message.id, code: sender.codeFor(message.email) ?? null });
  } else if (message.op === 'close') {
    await cia.close();
    await double.close();
    const admin = new pg.Client({ connectionString: options.databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${options.schema}" CASCADE`);
    await admin.end();
    process.send({ id: message.id, closed: true });
    process.exit(0);
  }
});
