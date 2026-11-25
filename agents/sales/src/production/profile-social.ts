import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';
import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { META_CHANNEL_ID, META_CONTRACT_REF } from '@r4-adapters/meta';
import { SALES_SOCIAL_AGENT_ID } from '../ids.js';
import { SALES_WEB_PROFILE_V1 } from './profile-web.js';

/**
 * (ADR-060 M1) Pesín in Meta direct messages: Messenger on the store's Facebook Page and Instagram Direct on the linked
 * professional account, one `meta` channel served by its own gateway and worker. The reads of the web chat (Catalog V2
 * with Discover and per-variant sellability, Shipping) and consultations to the team without pausing; NO writes (no
 * workspace, Quote, Checkout, Customer or payment): the contact buys in the store with the product's link. Its own
 * definition line, `sales-social`, whose instructions adapt to the surface the adapter names: on Instagram a training
 * buddy first, on Messenger a sales advisor. Media the channel cannot represent is told to the agent, never held.
 */
export const SALES_SOCIAL_PROFILE_V1: ProductionProfile = Object.freeze({
  profileId: 'sales-social',
  version: 1,
  description: 'Pesín in Meta direct messages (Messenger and Instagram Direct): Catalog V2 read-only including Discover and per-variant sellability; Shipping read-only; consultations to the team without pause; no writes (no workspace, Quote, Checkout, Customer or payment); the contact buys in the store with the product link.',
  domains: { ...SALES_WEB_PROFILE_V1.domains },
  channel: { id: META_CHANNEL_ID, status: 'REAL', contractRef: META_CONTRACT_REF },
  capabilities: [...SALES_WEB_PROFILE_V1.capabilities],
  unsupportedContent: 'inform_agent',
} satisfies ProductionProfile);

export const SALES_SOCIAL_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_SOCIAL_PROFILE_V1]);
const SALES_SOCIAL_AGENT_VERSIONS: Readonly<Record<string, number>> = Object.freeze({ 'sales-social@1': 1 });

export function salesSocialProfile(label: string): ProductionProfile | null {
  return SALES_SOCIAL_PROFILES.find((p) => profileLabel(p) === label) ?? null;
}

export function isSalesSocialProfile(profile: ProductionProfile): boolean {
  return salesSocialProfile(profileLabel(profile)) !== null;
}

/** The sales-social definition version a social profile pins (null for any other profile). */
export function salesSocialAgentVersion(profile: ProductionProfile): number | null {
  return SALES_SOCIAL_AGENT_VERSIONS[profileLabel(profile)] ?? null;
}

export function loadSalesSocialAgentDefinition(version = 1): AgentDefinition {
  const definition = agentDefinitionSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../../candidates/sales-social.v${version}.candidate.json`, import.meta.url)), 'utf8')));
  if (definition.agentId !== SALES_SOCIAL_AGENT_ID || definition.version !== version) throw new Error(`sales-social.v${version}.candidate.json does not declare ${SALES_SOCIAL_AGENT_ID}@${version}`);
  return definition;
}
