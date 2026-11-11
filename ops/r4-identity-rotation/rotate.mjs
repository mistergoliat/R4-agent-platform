#!/usr/bin/env node
// R4 identity HMAC rotation CLI. Prints counts only — never a key, a wa_id or a derived key value.
//
//   node ops/r4-identity-rotation/rotate.mjs plan   --env-file ~/.config/r4/production.env [--env-file …] --new-key-file F
//   node ops/r4-identity-rotation/rotate.mjs apply  --env-file … --new-key-file F --out F.lists.env
//   node ops/r4-identity-rotation/rotate.mjs verify --env-file … --new-key-file F
//
// The OLD key and the key lists are read from the env file(s) (R4_PROD_IDENTITY_HASH_KEY, R4_PROD_ROLLOUT_ALLOWLIST,
// R4_PROD_ROLLOUT_DENYLIST, R4_PROD_LANE_ALLOWLIST); the database from R4_ROTATION_DATABASE_URL (a restored copy) or
// else the env file's R4_DATABASE_URL. `apply` writes the recomputed lists to --out (mode 0600) for the operator to
// install with the new key; it never prints them.

import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { applyRotation, keyListsOf, parseEnvFile, planRotation, verifyRotation } from './rotation.mjs';

const print = (stream, value) => stream.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);

const [mode, ...rest] = process.argv.slice(2);
const args = { envFiles: [], newKeyFile: null, out: null };
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i] === '--env-file') args.envFiles.push(rest[i + 1]);
  else if (rest[i] === '--new-key-file') args.newKeyFile = rest[i + 1];
  else if (rest[i] === '--out') args.out = rest[i + 1];
  else throw new Error(`unknown argument ${rest[i]}`);
}
if (!['plan', 'apply', 'verify'].includes(mode) || args.envFiles.length === 0 || !args.newKeyFile) {
  print(process.stderr, 'usage: rotate.mjs plan|apply|verify --env-file F [--env-file F] --new-key-file F [--out F]');
  process.exit(2);
}
if (mode === 'apply' && !args.out) {
  print(process.stderr, 'apply needs --out (the recomputed key lists are written there, never printed)');
  process.exit(2);
}
const env = Object.assign({}, ...args.envFiles.map((f) => parseEnvFile(readFileSync(f, 'utf8'))));
const oldKey = env.R4_PROD_IDENTITY_HASH_KEY;
const newKey = readFileSync(args.newKeyFile, 'utf8').trim();
const lists = keyListsOf(env);
const databaseUrl = process.env.R4_ROTATION_DATABASE_URL || env.R4_DATABASE_URL;
if (!databaseUrl) throw new Error('no database: set R4_ROTATION_DATABASE_URL or R4_DATABASE_URL in the env file');

const client = new pg.Client({ connectionString: databaseUrl, application_name: 'r4-identity-rotation' });
await client.connect();
try {
  if (mode === 'plan') {
    const plan = await planRotation(client, { oldKey, newKey, lists });
    print(process.stdout, { mode, summary: plan.summary, blockers: plan.blockers, ready: plan.blockers.length === 0 });
    process.exitCode = plan.blockers.length === 0 ? 0 : 1;
  } else if (mode === 'apply') {
    const result = await applyRotation(client, { oldKey, newKey, lists });
    const lines = Object.entries(result.newLists).filter(([name]) => (lists[name] ?? []).length > 0).map(([name, keys]) => `${name}=${keys.join(',')}`);
    writeFileSync(args.out, `${lines.join('\n')}\n`, { mode: 0o600 });
    print(process.stdout, { mode, summary: result.summary, rewritten: result.rewritten, listsWrittenTo: args.out });
  } else {
    const check = await verifyRotation(client, { newKey });
    print(process.stdout, { mode, ...check, ok: check.unverifiedOpen === 0 && check.duplicateOpen === 0 });
    process.exitCode = check.unverifiedOpen === 0 && check.duplicateOpen === 0 ? 0 : 1;
  }
} finally {
  await client.end();
}
