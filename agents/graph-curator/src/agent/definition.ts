import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';

/**
 * ADR-058 G4: the graph-curator agent. Its definition is a candidate file (not *.agent.json), so the API's directory sync
 * never registers it implicitly: its own bootstrap does (graph:agent-bootstrap), like the web Sales agent.
 */
export const GRAPH_CURATOR_AGENT_ID = 'graph-curator';
export const GRAPH_CURATOR_AGENT_VERSION = 1;
export const TASK_CLASSIFY_PRODUCT = 'graph.classify_product';
export const GRAPH_CURATOR_CANDIDATES_DIR = fileURLToPath(new URL('../../candidates', import.meta.url));

export function loadGraphCuratorDefinition(version: number = GRAPH_CURATOR_AGENT_VERSION): AgentDefinition {
  const file = `${GRAPH_CURATOR_CANDIDATES_DIR}/${GRAPH_CURATOR_AGENT_ID}.v${version}.candidate.json`;
  return agentDefinitionSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
