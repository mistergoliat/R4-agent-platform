import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';

/**
 * ADR-058 G4: the graph-curator agent. Its definition is a candidate file (not *.agent.json), so the API's directory sync
 * never registers it implicitly: its own bootstrap does (graph:agent-bootstrap), like the web Sales agent.
 */
export const GRAPH_CURATOR_AGENT_ID = 'graph-curator';
// v2 (G4b) adds the relation review; v3 (G7b) adds criteria and the explanation task. Older versions stay registered
// (definitions are immutable) and the worker keeps serving them, so a task created before an upgrade still finishes.
export const GRAPH_CURATOR_AGENT_VERSION = 3;
export const GRAPH_CURATOR_SERVED_VERSIONS: readonly number[] = [2, 3];
export const TASK_CLASSIFY_PRODUCT = 'graph.classify_product';
export const TASK_REVIEW_RELATIONS = 'graph.review_relations';
export const TASK_INTERPRET_EXPLANATION = 'graph.interpret_explanation';
/** ADR-058 Decision 11: the knowledge topic of the criteria people sign for the curator (Pesín does not read it). */
export const GRAPH_CRITERIA_TOPIC = 'grafo';
/** Token budget per task (the definition's maxTokens is the ceiling of both). */
export const CLASSIFY_TOKENS_PER_TASK = 40_000; // v3 instructions are longer (G7b): 30k ran out on the 3 calls of a classification
export const REVIEW_TOKENS_PER_TASK = 60_000;
export const INTERPRET_TOKENS_PER_TASK = 30_000;
export const GRAPH_CURATOR_CANDIDATES_DIR = fileURLToPath(new URL('../../candidates', import.meta.url));

export function loadGraphCuratorDefinition(version: number = GRAPH_CURATOR_AGENT_VERSION): AgentDefinition {
  const file = `${GRAPH_CURATOR_CANDIDATES_DIR}/${GRAPH_CURATOR_AGENT_ID}.v${version}.candidate.json`;
  return agentDefinitionSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
