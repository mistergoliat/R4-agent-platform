#!/usr/bin/env node
// R4 identity HMAC rotation CLI. Prints counts only — never a key, a wa_id or a derived key value.
//
//   rotate.mjs plan       --env-file F [--env-file F] --new-key-file K
//   rotate.mjs apply      --env-file F [--env-file F] --new-key-file K --out LISTS
//   rotate.mjs verify     --env-file F [--env-file F] (--new-key-file K | --key-from-env)
//   rotate.mjs install    --env-file F [--env-file F] --new-key-file K --lists LISTS --old-env-file BACKUP [--old-env-file BACKUP]
//   rotate.mjs export-key --env-file F [--env-file F] --out K [--values-out V]   (V: the key and every list entry, one per line, for grep -F -f)
//
// The OLD key, the key lists and R4_PROD_ROLLOUT_PERCENT come from the env file(s) (parsed like the deployment reads
// them; the same variable twice is refused); the database from R4_ROTATION_DATABASE_URL (a restored copy) or else the
// env files' R4_DATABASE_URL. `apply` writes the recomputed lists to LISTS (0600); `install` writes the new key and those
// lists into the env files atomically and checks the result (no old value may survive). Errors print a code and a
// message only (never a database error detail, which could carry a derived key).
// Exit codes: 0 done; 1 failed (for apply: the transaction outcome is UNKNOWN); 2 usage; 3 apply refused and certainly
// rolled back (nothing changed). apply writes LISTS inside the transaction, before COMMIT is sent.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { MANAGED_VARS, applyRotation, envShapeProblems, installEnv, keyListsOf, parseEnvFile, planRotation, verifyRotation } from './rotation.mjs';

// pg from the deployment's own node_modules when the tool runs from a backup copy (R4_REPO), else next to the tool.
const pg = createRequire(process.env.R4_REPO ? join(process.env.R4_REPO, 'package.json') : import.meta.url)('pg');

const print = (stream, value) => stream.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
const fail = (message, code = 2) => {
  print(process.stderr, message);
  process.exit(code);
};

const [mode, ...rest] = process.argv.slice(2);
const args = { envFiles: [], newKeyFile: null, out: null, lists: null, oldEnvFiles: [], valuesOut: null, keyFromEnv: false };
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];
  if (a === '--key-from-env') args.keyFromEnv = true;
  else if (a === '--env-file') args.envFiles.push(rest[++i]);
  else if (a === '--new-key-file') args.newKeyFile = rest[++i];
  else if (a === '--out') args.out = rest[++i];
  else if (a === '--lists') args.lists = rest[++i];
  else if (a === '--old-env-file') args.oldEnvFiles.push(rest[++i]);
  else if (a === '--values-out') args.valuesOut = rest[++i];
  else fail(`unknown argument ${a}`);
}
if (!['plan', 'apply', 'verify', 'install', 'export-key'].includes(mode) || args.envFiles.length === 0) fail('usage: see the header of rotate.mjs');

const files = args.envFiles.map((f) => ({ name: f, text: readFileSync(f, 'utf8') }));
const env = Object.assign({}, ...files.map((f) => parseEnvFile(f.text)));
const shape = envShapeProblems(files);
let applyStarted = false;

try {
  if (mode === 'export-key') {
    if (!args.out) fail('export-key needs --out');
    if (shape.length > 0) fail(`refusing: ${shape.join('; ')}`, 1);
    writeFileSync(args.out, env.R4_PROD_IDENTITY_HASH_KEY ?? '', { mode: 0o600 });
    if (args.valuesOut) writeFileSync(args.valuesOut, `${[env.R4_PROD_IDENTITY_HASH_KEY ?? '', ...Object.values(keyListsOf(env)).flat()].filter((v) => v.length >= 32).join('\n')}\n`, { mode: 0o600 });
    print(process.stdout, { mode, written: args.out, present: Boolean(env.R4_PROD_IDENTITY_HASH_KEY) });
  } else if (mode === 'install') {
    if (!args.newKeyFile || !args.lists || args.oldEnvFiles.length === 0) fail('install needs --new-key-file, --lists and --old-env-file');
    const lists = parseEnvFile(readFileSync(args.lists, 'utf8'));
    const old = Object.assign({}, ...args.oldEnvFiles.map((f) => parseEnvFile(readFileSync(f, 'utf8'))));
    const next = { R4_PROD_IDENTITY_HASH_KEY: readFileSync(args.newKeyFile, 'utf8').trim() };
    for (const v of MANAGED_VARS.slice(1)) if (lists[v] !== undefined) next[v] = lists[v];
    const forbidden = [old.R4_PROD_IDENTITY_HASH_KEY ?? '', ...Object.values(keyListsOf(old)).flat()];
    print(process.stdout, { mode, files: installEnv(args.envFiles, next, forbidden), installed: Object.keys(next) });
  } else {
    const keyFromEnv = mode === 'verify' && args.keyFromEnv;
    if (!keyFromEnv && !args.newKeyFile) fail(`${mode} needs --new-key-file`);
    if (mode === 'apply' && !args.out) fail('apply needs --out (the recomputed key lists are written there, never printed)');
    const newKey = keyFromEnv ? env.R4_PROD_IDENTITY_HASH_KEY : readFileSync(args.newKeyFile, 'utf8').trim();
    const databaseUrl = process.env.R4_ROTATION_DATABASE_URL || env.R4_DATABASE_URL;
    if (!databaseUrl) fail('no database: set R4_ROTATION_DATABASE_URL or R4_DATABASE_URL in the env file');
    const client = new pg.Client({ connectionString: databaseUrl, application_name: 'r4-identity-rotation' });
    await client.connect();
    try {
      const params = { oldKey: env.R4_PROD_IDENTITY_HASH_KEY, newKey, lists: keyListsOf(env), rolloutPercent: env.R4_PROD_ROLLOUT_PERCENT };
      if (mode === 'plan') {
        const plan = await planRotation(client, params);
        const blockers = [...shape, ...plan.blockers];
        print(process.stdout, { mode, summary: plan.summary, blockers, ready: blockers.length === 0 });
        process.exitCode = blockers.length === 0 ? 0 : 1;
      } else if (mode === 'apply') {
        if (shape.length > 0) fail(`refusing: ${shape.join('; ')}`, 3);
        applyStarted = true;
        // The lists are written BEFORE the commit: whenever the database may be rotated, its lists exist.
        const result = await applyRotation(client, params, {
          beforeCommit: (r) => {
            const lines = Object.entries(r.newLists).filter(([name]) => params.lists[name].length > 0).map(([name, keys]) => `${name}=${keys.join(',')}`);
            writeFileSync(args.out, `${lines.join('\n')}\n`, { mode: 0o600 });
          },
        });
        print(process.stdout, { mode, summary: result.summary, rewritten: result.rewritten, listsWrittenTo: args.out });
      } else {
        const check = await verifyRotation(client, { newKey });
        const ok = check.unverifiedOpen === 0 && check.duplicateOpen === 0;
        print(process.stdout, { mode, ...check, ok });
        process.exitCode = ok ? 0 : 1;
      }
    } finally {
      await client.end();
    }
  }
} catch (error) {
  // Never the error detail (a unique violation would print the conflicting derived key).
  const certain = mode === 'apply' && (!applyStarted || error?.rolledBack === true);
  fail(`${mode} failed${certain ? ' (rolled back: nothing changed)' : mode === 'apply' ? ' (OUTCOME UNKNOWN: the commit may have happened)' : ''}: ${error?.code ? `[${error.code}] ` : ''}${String(error?.message ?? error).replace(/[0-9a-f]{32,}/g, '<hex>')}`, certain ? 3 : 1);
}
