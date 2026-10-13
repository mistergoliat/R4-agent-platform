import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';

/** Directory holding the pack's `*.agent.json` files (point the API's R4_AGENT_DEFINITIONS_DIR here, or at the repo's `agents/`). */
export const SALES_AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));
export const SALES_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Every published Sales definition version and its file. A registered
 * version is immutable (the registry refuses edited content): a change is a
 * new version in a new file, never an edit of an existing one.
 *
 * - 3: the definition production profiles v1 and v2 run.
 * - 4: v3 plus the shipping.quote guidance (basis reference/order, offers,
 *      failures) — run by sales-production@3 (R4-J2D).
 * - 5: v4 plus the shipping choice, quote request, quote.preview and
 *      autonomous quote.create@3 guidance — run only by sales-production@5
 *      (R4-J3E). Not the latest: non-production compositions keep v4.
 */
export const SALES_AGENT_DEFINITION_FILES = Object.freeze({ 3: 'sales.agent.json', 4: 'sales.v4.agent.json', 5: 'sales.v5.agent.json' } as const);
export type SalesAgentDefinitionVersion = keyof typeof SALES_AGENT_DEFINITION_FILES;
/** The pack's current definition (what non-production compositions, which register every capability, run). */
export const SALES_AGENT_LATEST_VERSION: SalesAgentDefinitionVersion = 4;

/** One of the pack's AgentDefinitions (default: the latest), validated with the platform's own schema. It carries no provider, model or secret. */
export function loadSalesAgentDefinition(version: SalesAgentDefinitionVersion = SALES_AGENT_LATEST_VERSION): AgentDefinition {
  const definition = agentDefinitionSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../${SALES_AGENT_DEFINITION_FILES[version]}`, import.meta.url)), 'utf8')));
  if (definition.version !== version) throw new Error(`${SALES_AGENT_DEFINITION_FILES[version]} declares version ${definition.version}, expected ${version}`);
  return definition;
}
