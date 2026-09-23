import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';

/** Directory holding `sales.agent.json` (point the API's R4_AGENT_DEFINITIONS_DIR here, or at the repo's `agents/`). */
export const SALES_AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));
export const SALES_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** The pack's AgentDefinition, validated with the platform's own schema. It carries no provider, model or secret. */
export function loadSalesAgentDefinition(): AgentDefinition {
  return agentDefinitionSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('../sales.agent.json', import.meta.url)), 'utf8')));
}
