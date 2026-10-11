/*
 * R4-DISCOVER-I1 — exports catalog.discover contract fixtures from the Catalog OWNER.
 *
 * Run FROM the catalog-service working directory (it imports the owner's code by path and
 * never writes there):
 *
 *   cd <MS-pesaschile-catalog-service>
 *   npx tsx <R4>/scripts/catalog-discover/export-fixtures.mts <R4>/adapters/domains/catalog/http/fixtures/discover
 *
 * Every answer is produced by the owner's REAL OperationalDiscoverService over its REAL J1 v2
 * commercial owner (in-memory reader) and the owner's SYNTHETIC agent catalog/index
 * (tests/contract/discover-agent/scenarios.ts). FAILED answers are shown as the owner's HTTP
 * route sends them (catalogDiscoverRoute DISCOVER_FAILURE_HTTP), never as 200.
 *
 * Output: scenarios/*.json (the owner's 24 V1-B2 agent scenarios), r4-multiturn/*.json (the
 * consolidated requests of R4's five-turn case), http-error-matrix.json, the owner's JSON
 * Schemas, MANIFEST.json (owner commit, LF hashes of the owner's contract sources, file hashes).
 * These are SYNTHETIC contract fixtures: not production data, not relevance gold.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const owner = process.cwd();
const outDir = resolve(process.argv[2] ?? 'discover-fixtures');
const imp = (rel: string) => import(pathToFileURL(join(owner, rel)).href);

await imp('tests/setup.ts'); // the owner's test-only environment; no database is contacted
const { agentScenarios, agentHarness } = await imp('tests/contract/discover-agent/scenarios.ts');
const { DISCOVER_FAILURE_HTTP, DISCOVER_REJECTION_HTTP } = await imp('src/interfaces/http/routes/catalogDiscoverRoute.ts');
const contract = await imp('src/application/catalog/discover-v1a/contracts.ts');
const agent = await imp('src/application/catalog/discover-v1a/agentContract.ts');
const { zodToJsonSchema } = await import(pathToFileURL(join(owner, 'node_modules/zod-to-json-schema/dist/esm/index.js')).href);

const sha = (text: string | Buffer) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const git = (args: string) => execSync(`git ${args}`, { cwd: owner }).toString().trim();
const lf = (path: string) => execSync(`git -c core.autocrlf=false show HEAD:${path}`, { cwd: owner });
const stable = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'scenarios'), { recursive: true });
mkdirSync(join(outDir, 'r4-multiturn'), { recursive: true });
const files: Record<string, string> = {};
const write = (rel: string, text: string) => {
  writeFileSync(join(outDir, rel), text);
  files[rel] = sha(JSON.stringify(JSON.parse(text)));
};

/** What the owner's route sends for an answer (catalogDiscoverRoute.sendAnswer). */
function httpOf(response: { status: string; requestId: string; error?: { code: string; issues?: { code: string; path: string }[] } }) {
  if (response.status !== 'FAILED') return { status: 200, body: response };
  const entry = DISCOVER_FAILURE_HTTP[response.error?.code ?? 'INTERNAL_ERROR'];
  const issues = response.error?.issues?.map((issue) => ({ code: issue.code, path: issue.path }));
  return { status: entry.status, body: { error: { code: entry.code, message: entry.message, correlationId: 'req-fixture', retryable: entry.retryable, requestId: response.requestId, ...(issues ? { issues } : {}) } } };
}

const scenarios: unknown[] = [];
for (const scenario of agentScenarios()) {
  const run = await scenario.run();
  const response = JSON.parse(run.wire);
  const rel = `scenarios/${String(scenario.id).padStart(2, '0')}-${scenario.key}.json`;
  write(rel, stable({
    id: scenario.id, key: scenario.key, title: scenario.title, request: run.request, http: httpOf(response),
    ownerConsumerExpectation: {
      status: scenario.expect.status ?? null, outcome: scenario.expect.outcome ?? null, labels: scenario.expect.labels ?? [], notLabels: scenario.expect.notLabels ?? [],
      allowed: scenario.expect.allowed ?? {}, forbidden: scenario.expect.forbidden ?? {}, answerAllowed: scenario.expect.answerAllowed ?? [], answerForbidden: scenario.expect.answerForbidden ?? [],
    },
  }));
  scenarios.push({ id: scenario.id, key: scenario.key, file: rel });
}

/** R4's five-turn case (R4-DISCOVER-I1 §7): the consolidated request R4 sends at each turn. */
const R4_TURNS = [
  { turn: 1, customer: 'Necesito una máquina para entrenar espalda', request: { schemaVersion: 1, need: 'máquina para entrenar espalda' } },
  { turn: 2, customer: 'Tengo poco espacio', request: { schemaVersion: 1, need: 'máquina para entrenar espalda poco espacio' } },
  { turn: 3, customer: 'Mi presupuesto es de $300.000', request: { schemaVersion: 1, need: 'máquina para entrenar espalda poco espacio', constraints: { maxUnitPriceClp: 300000 } } },
  { turn: 4, customer: 'Prefiero una polea', request: { schemaVersion: 1, need: 'polea para entrenar espalda poco espacio', constraints: { maxUnitPriceClp: 300000 } } },
  { turn: 5, customer: 'Puede costar hasta $400.000', request: { schemaVersion: 1, need: 'polea para entrenar espalda poco espacio', constraints: { maxUnitPriceClp: 400000 } } },
];
const multiTurn: unknown[] = [];
for (const turn of R4_TURNS) {
  const { service } = agentHarness();
  const response = JSON.parse(JSON.stringify(await service.discover(turn.request)));
  const rel = `r4-multiturn/turn-${turn.turn}.json`;
  write(rel, stable({ ...turn, http: httpOf(response) }));
  multiTurn.push({ turn: turn.turn, file: rel });
}

write('http-error-matrix.json', stable({
  failure: DISCOVER_FAILURE_HTTP,
  rejection: DISCOVER_REJECTION_HTTP,
  boundary: { unauthenticated: { status: 401, code: 'unauthorized' }, forbidden: { status: 403, code: 'forbidden' }, payloadTooLarge: { status: 413, code: 'payload_too_large' },
    unsupportedMediaType: { status: 415, code: 'unsupported_media_type' }, rateLimited: { status: 429, code: 'rate_limited' }, contractOutputInvalid: { status: 500, code: 'contract_output_invalid' } },
}));
write('request.schema.json', stable(zodToJsonSchema(agent.discoverAgentRequestSchema, { name: 'DiscoverAgentRequest' })));
write('response.tolerant.schema.json', stable(zodToJsonSchema(agent.discoverAgentResponseTolerantSchema, { name: 'DiscoverAgentResponseTolerant' })));

const sources = ['src/application/catalog/discover-v1a/agentContract.ts', 'src/application/catalog/discover-v1a/contracts.ts', 'src/interfaces/http/routes/catalogDiscoverRoute.ts',
  'src/domain/catalog/v2/contracts.ts', 'src/domain/catalog/v2/unitPriceBudget.ts', 'tests/contract/discover-agent/scenarios.ts', 'tests/contract/discover-agent/referenceConsumer.ts'];
writeFileSync(join(outDir, 'MANIFEST.json'), stable({
  capability: agent.DISCOVER_AGENT_CAPABILITY,
  schemaVersion: contract.DISCOVER_V1A_SCHEMA_VERSION,
  contractVersion: contract.DISCOVER_CONTRACT_VERSION,
  contractRevisions: contract.DISCOVER_CONTRACT_REVISIONS,
  route: 'POST /v2/catalog/discover',
  owner: {
    repository: 'MS-pesaschile-catalog-service',
    commit: git('rev-parse HEAD'),
    branch: git('rev-parse --abbrev-ref HEAD'),
    contractSourcesUncommitted: git(`status --porcelain -- ${sources.join(' ')}`).length > 0,
    contractSourcesLfSha256: Object.fromEntries(sources.map((path) => [path, sha(lf(path))])),
  },
  producedBy: 'owner OperationalDiscoverService + J1 v2 owner (in-memory) over the owner SYNTHETIC agent catalog; R4 scripts/catalog-discover/export-fixtures.mts',
  nature: 'SYNTHETIC contract fixtures: not production data, not relevance gold',
  scenarios,
  r4MultiTurn: multiTurn,
  hashRule: 'sha256(JSON.stringify(JSON.parse(file)))',
  files,
}));
process.stdout.write(`wrote ${scenarios.length} scenarios and ${multiTurn.length} R4 turns to ${outDir}\n`);
