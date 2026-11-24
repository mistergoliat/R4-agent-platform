import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAgentDefinitions } from '@r4/api';
import { createLogger } from '@r4/observability';
import { GRAPH_CURATOR_AGENT_ID, GRAPH_CURATOR_AGENT_VERSION, loadGraphCuratorDefinition } from '../agent/definition.js';
import { GRAPH_MIGRATIONS_DIR } from '../run.js';

/**
 * `npm run graph:agent-bootstrap` (ADR-058 G4): registers the graph-curator agent definition (only it) in the
 * database named by R4_DATABASE_URL. Idempotent: an unchanged version is reported unchanged.
 */
const url = process.env.R4_DATABASE_URL;
if (!url) {
  process.stderr.write('R4_DATABASE_URL is required\n');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'r4-graph-curator-'));
try {
  writeFileSync(join(dir, `${GRAPH_CURATOR_AGENT_ID}.v${GRAPH_CURATOR_AGENT_VERSION}.agent.json`), JSON.stringify(loadGraphCuratorDefinition()));
  const report = await registerAgentDefinitions({ databaseUrl: url, directory: dir, agentIds: [GRAPH_CURATOR_AGENT_ID], migrationDirectories: [GRAPH_MIGRATIONS_DIR], logger: createLogger({ service: 'graph-agent-bootstrap', level: 'warn' }) });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`graph:agent-bootstrap failed: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/giu, '[redacted]').slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
