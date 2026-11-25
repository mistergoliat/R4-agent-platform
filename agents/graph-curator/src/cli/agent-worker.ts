import { CapabilityRegistry } from '@r4/capability-runtime';
import { HttpCatalogAdapter, loadCatalogHttpConfig } from '@r4-adapters/catalog-http';
import { OpenAICompatibleModelProvider, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { createLogger } from '@r4/observability';
import { PostgresArtifactFacts, PostgresArtifacts, createPool } from '@r4/persistence-postgres';
import { loadWorkerConfig, runWorkerProcess } from '@r4/worker';
import { kindsCapability, productSheetCapability } from '../agent/capabilities.js';
import { kindVocabulary } from '../agent/classify.js';
import { GRAPH_CURATOR_AGENT_ID, GRAPH_CURATOR_AGENT_VERSION } from '../agent/definition.js';
import { PRODUCT_GRAPH_KIND } from '../graph.js';
import { readSignedGraph } from '../signed.js';

/**
 * `npm run graph:agent-worker` (ADR-058 G4): the graph-curator agent's own worker. It serves ONLY graph-curator tasks
 * (servedAgents), so it never claims a Sales task and no Sales worker claims its tasks. Read capabilities only: it
 * never writes; the curator validates its results and proposes. Env: the worker's (R4_DATABASE_URL, R4_WORKER_ID,
 * R4_EXEC_*, R4_MODEL_MAX_REQUESTS_PER_MINUTE), the model (R4_MODEL_*) and Catalog V2 (R4_CATALOG_V2_*).
 */
const config = loadWorkerConfig(process.env);
const model = loadOpenAICompatibleConfig(process.env);
if (!model) throw new Error('refusing: no model provider configured (R4_MODEL_*)');
const logger = createLogger({ service: 'r4-graph-curator-worker', level: 'info' });
const pool = createPool({ connectionString: process.env.R4_DATABASE_URL ?? '', logger, applicationName: 'r4-graph-curator-bindings', max: 2 });
const artifacts = new PostgresArtifacts(pool);
const facts = new PostgresArtifactFacts(pool);
const catalog = new HttpCatalogAdapter({ config: loadCatalogHttpConfig(process.env, { allowNetwork: true, source: 'v2' }), fetch: (u, init) => fetch(u, init) });

const capabilities = new CapabilityRegistry();
capabilities.register(productSheetCapability(catalog, async (key) => (await facts.current(PRODUCT_GRAPH_KIND, key)).map((f) => ({ subject: f.subject, field: f.field, value: f.value, recordedBy: f.recordedBy, recordedAt: f.recordedAt }))));
capabilities.register(kindsCapability(async () => { const signed = await readSignedGraph(artifacts); return signed ? kindVocabulary(signed.graph) : { kinds: [] }; }));

await runWorkerProcess(config, {
  modelProvider: new OpenAICompatibleModelProvider(model),
  capabilities,
  servedAgents: [{ agentId: GRAPH_CURATOR_AGENT_ID, version: GRAPH_CURATOR_AGENT_VERSION }],
});
logger.info({ event: 'graph_curator.worker.started', agent: `${GRAPH_CURATOR_AGENT_ID}@${GRAPH_CURATOR_AGENT_VERSION}` }, 'graph-curator worker started');
