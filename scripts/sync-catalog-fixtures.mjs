#!/usr/bin/env node
// Copies the Catalog owner's published v2 contract fixtures into R4, unchanged.
//
//   node scripts/sync-catalog-fixtures.mjs [path-to-catalog-service]
//
// Source of truth: <catalog-service>/contracts/catalog/v2/fixtures/MANIFEST.json.
// Every listed file is copied byte-for-byte and its hash verified against the
// owner manifest; any other fixture in R4's directory is deleted (R4 keeps no
// second definition). SOURCE.json records the owner commit and whether the
// owner's contract files had uncommitted changes when copied.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const owner = resolve(process.argv[2] ?? process.env.R4_CATALOG_OWNER_REPO ?? join(root, '..', 'MS', 'MS-pesaschile-catalog-service'));
const from = join(owner, 'contracts', 'catalog', 'v2', 'fixtures');
const to = join(root, 'adapters', 'domains', 'catalog', 'http', 'fixtures');

const hashOf = (text) => createHash('sha256').update(JSON.stringify(JSON.parse(text))).digest('hex');
const git = (...args) => execFileSync('git', ['-C', owner, ...args], { encoding: 'utf8' }).trim();

const manifestText = readFileSync(join(from, 'MANIFEST.json'), 'utf8');
const manifest = JSON.parse(manifestText);
if (manifest.schemaVersion !== 1) throw new Error(`owner manifest schemaVersion ${manifest.schemaVersion}; R4 speaks 1`);

const keep = new Set(['MANIFEST.json', 'SOURCE.json', 'README.md']);
for (const entry of readdirSync(to)) {
  const path = join(to, entry);
  if (statSync(path).isDirectory() || (!keep.has(entry) && entry.endsWith('.json'))) rmSync(path, { recursive: true, force: true });
}
for (const fixture of manifest.fixtures) {
  const text = readFileSync(join(from, fixture.file), 'utf8');
  if (hashOf(text) !== fixture.sha256) throw new Error(`${fixture.file}: owner file does not match the owner manifest`);
  copyFileSync(join(from, fixture.file), join(to, fixture.file));
}
copyFileSync(join(from, 'MANIFEST.json'), join(to, 'MANIFEST.json'));

const contractPaths = ['contracts/catalog/v2', 'src/domain/catalog/v2', 'src/application/catalog/v2', 'src/infrastructure/catalog/mysqlCatalogV2DataReader.ts', 'src/interfaces/http/routes/catalogV2Routes.ts', 'tests/support/catalogV2FixtureScenarios.ts'];
const source = {
  owner: manifest.owner,
  contract: manifest.contract,
  schemaVersion: manifest.schemaVersion,
  ownerCommit: git('rev-parse', 'HEAD'),
  ownerContractFilesUncommitted: git('status', '--porcelain', '--', ...contractPaths) !== '',
  manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  fixtures: manifest.fixtures.length,
  syncedWith: 'scripts/sync-catalog-fixtures.mjs',
};
writeFileSync(join(to, 'SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(source, null, 2)}\n`);
