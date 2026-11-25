import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';
import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { META_CONTRACT_REF, type MetaSurface } from '@r4-adapters/meta';
import { SALES_FACEBOOK_AGENT_ID, SALES_INSTAGRAM_AGENT_ID } from '../ids.js';
import { SALES_WEB_PROFILE_V1 } from './profile-web.js';

/**
 * (ADR-060 M1, ADR-053: one agent per channel) Pesín in Meta direct messages, two agents of the same Sales pack:
 * sales-instagram (Instagram Direct, a training buddy first) and sales-facebook (Messenger on the Facebook Page, the
 * sales advisor). Each is its own channel, profile, definition line, gateway and worker, with its own versions and
 * metrics. Both carry the web chat's reads (Catalog V2 with Discover and per-variant sellability, Shipping) and
 * consultations to the team without pausing; NO writes (no workspace, Quote, Checkout, Customer or payment): the
 * contact buys in the store with the product's link. Media the channel cannot represent is told to the agent.
 */
const metaProfile = (surface: MetaSurface, profileId: string, description: string): ProductionProfile =>
  Object.freeze({
    profileId,
    version: 1,
    description,
    domains: { ...SALES_WEB_PROFILE_V1.domains },
    channel: { id: surface, status: 'REAL', contractRef: META_CONTRACT_REF },
    capabilities: [...SALES_WEB_PROFILE_V1.capabilities],
    unsupportedContent: 'inform_agent',
  } satisfies ProductionProfile);

export const SALES_INSTAGRAM_PROFILE_V1 = metaProfile('instagram', SALES_INSTAGRAM_AGENT_ID, 'Pesín in Instagram Direct, a training buddy first: Catalog V2 read-only including Discover and per-variant sellability; Shipping read-only; consultations to the team without pause; no writes; the contact buys in the store with the product link.');
export const SALES_FACEBOOK_PROFILE_V1 = metaProfile('facebook', SALES_FACEBOOK_AGENT_ID, 'Pesín in Messenger on the Facebook Page, the sales advisor: Catalog V2 read-only including Discover and per-variant sellability; Shipping read-only; consultations to the team without pause; no writes; the contact buys in the store with the product link.');

export const SALES_META_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_INSTAGRAM_PROFILE_V1, SALES_FACEBOOK_PROFILE_V1]);
/** The definition (agent id and version) each Meta profile pins. */
const SALES_META_AGENTS: Readonly<Record<string, { readonly agentId: string; readonly version: number }>> = Object.freeze({
  'sales-instagram@1': { agentId: SALES_INSTAGRAM_AGENT_ID, version: 1 },
  'sales-facebook@1': { agentId: SALES_FACEBOOK_AGENT_ID, version: 1 },
});

export function salesMetaProfile(label: string): ProductionProfile | null {
  return SALES_META_PROFILES.find((p) => profileLabel(p) === label) ?? null;
}

export function isSalesMetaProfile(profile: ProductionProfile): boolean {
  return salesMetaProfile(profileLabel(profile)) !== null;
}

/** The definition a Meta profile pins (null for any other profile). */
export function salesMetaAgentOf(profile: ProductionProfile): { readonly agentId: string; readonly version: number } | null {
  return SALES_META_AGENTS[profileLabel(profile)] ?? null;
}

export function loadSalesMetaAgentDefinition(agentId: string, version = 1): AgentDefinition {
  if (agentId !== SALES_INSTAGRAM_AGENT_ID && agentId !== SALES_FACEBOOK_AGENT_ID) throw new Error(`${agentId} is not a Sales Meta agent`);
  const definition = agentDefinitionSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../../candidates/${agentId}.v${version}.candidate.json`, import.meta.url)), 'utf8')));
  if (definition.agentId !== agentId || definition.version !== version) throw new Error(`${agentId}.v${version}.candidate.json does not declare ${agentId}@${version}`);
  return definition;
}
