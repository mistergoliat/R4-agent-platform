#!/usr/bin/env node
// R4-J4-R5 canary evidence: counts the rows of every text-like column of the canary database (schemas public, sales,
// identity_verification) that contain any of the given secrets. Secrets come from stdin, one per line, and are never
// printed; the output names only the columns with hits and the totals.
//
//   printf '%s\n' "$CODE" | DB=postgres://… node scripts/canary-j4/leakscan.mjs
import { readFileSync } from 'node:fs';
import process from 'node:process';
import pg from 'pg';

const secrets = readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
if (secrets.length === 0) throw new Error('no secret on stdin');
const db = new pg.Client({ connectionString: process.env.DB });
await db.connect();
const { rows: columns } = await db.query(
  `select table_schema as s, table_name as t, column_name as c from information_schema.columns
    where table_schema in ('public', 'sales', 'identity_verification')
      and data_type in ('text', 'json', 'jsonb', 'character varying', 'bytea')`,
);
let hits = 0;
for (const { s, t, c } of columns) {
  for (const secret of secrets) {
    const { rows } = await db.query(`select count(*)::int as n from "${s}"."${t}" where strpos("${c}"::text, $1) > 0`, [secret]);
    if (rows[0].n > 0) {
      hits += rows[0].n;
      process.stdout.write(`HIT ${s}.${t}.${c}: ${rows[0].n}\n`);
    }
  }
}
process.stdout.write(`${JSON.stringify({ database: db.database, columns: columns.length, secrets: secrets.length, hits })}\n`);
await db.end();
