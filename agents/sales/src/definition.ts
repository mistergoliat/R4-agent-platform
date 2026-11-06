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
 * - 6: v5 with the offer reference and the conversational confirmation read by
 *      quote.create@4 — run only by sales-production@6 (R4-J3E-B).
 * - 7: v6 with the offer message rendered by Sales (quote.preview@3), presented
 *      exactly, and quote.create@5 — run only by sales-production@7 (R4-J3E-C1).
 * - 8: v7 plus the rules of the Customer reads and the identity verification
 *      (scope identity.verify) — run only by sales-production@8 (R4-J4-R4).
 */
export const SALES_AGENT_DEFINITION_FILES = Object.freeze({ 3: 'sales.agent.json', 4: 'sales.v4.agent.json', 5: 'sales.v5.agent.json', 6: 'sales.v6.agent.json', 7: 'sales.v7.agent.json', 8: 'sales.v8.agent.json' } as const);
/**
 * (R4-J5 F1) Candidate definitions: NOT `*.agent.json`, so no bootstrap, platform or harness registers them (they
 * would also become the registry's "latest"). Only the isolated canary registers one, in its own database, for the
 * profile pinned to it (sales-production@12 → v12). Owner decision B: not registered in production.
 * (ADR-045) v13 = v4 + the catalog.discover guidance, for the lane profile sales-production@13 only; registered in
 * production solely by `production:sales:bootstrap --lane`, never by the plain bootstrap.
 * (R4 Quote E2E) v14 = v12 + the same catalog.discover line, for the quote lane profile sales-production@14 only;
 * registered like v13 (`--lane`), and only when that profile is the selected one.
 */
export const SALES_CANDIDATE_DEFINITION_FILES = Object.freeze({ 12: 'candidates/sales.v12.candidate.json', 13: 'candidates/sales.v13.candidate.json', 14: 'candidates/sales.v14.candidate.json' } as const);
export type SalesAgentDefinitionVersion = keyof typeof SALES_AGENT_DEFINITION_FILES | keyof typeof SALES_CANDIDATE_DEFINITION_FILES;
/** The pack's current definition (what non-production compositions, which register every capability, run). */
export const SALES_AGENT_LATEST_VERSION: SalesAgentDefinitionVersion = 4;

export function isSalesCandidateDefinition(version: SalesAgentDefinitionVersion): version is keyof typeof SALES_CANDIDATE_DEFINITION_FILES {
  return Object.hasOwn(SALES_CANDIDATE_DEFINITION_FILES, version);
}

/** One of the pack's AgentDefinitions (default: the latest), validated with the platform's own schema. It carries no provider, model or secret. */
export function loadSalesAgentDefinition(version: SalesAgentDefinitionVersion = SALES_AGENT_LATEST_VERSION): AgentDefinition {
  const file = isSalesCandidateDefinition(version) ? SALES_CANDIDATE_DEFINITION_FILES[version] : SALES_AGENT_DEFINITION_FILES[version];
  const definition = agentDefinitionSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')));
  if (definition.version !== version) throw new Error(`${file} declares version ${definition.version}, expected ${version}`);
  return definition;
}
