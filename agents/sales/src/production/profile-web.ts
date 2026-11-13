import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';
import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { WEB_CHANNEL_ID, WEB_EDGE_CONTRACT_REF } from '@r4-adapters/web';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS, SALES_WEB_AGENT_ID } from '../ids.js';
import { SALES_DOMAINS } from './profile.js';
import { SALES_PRODUCTION_PROFILE_V13 } from './profile-v13.js';

/**
 * (ADR-046) Sales on the store website chat, version 1. = sales-production@13 (Catalog V2 with Discover, Shipping
 * read-only; Customer, Quote, Checkout and payments unavailable) on the `web` channel, READ-ONLY: no workspace write
 * and no quote. The visitor buys in the store's own cart and checkout; R4 never holds a cart. Served by its own gateway
 * and worker (the profile carries one channel), never by the WhatsApp ones.
 */
export const SALES_WEB_PROFILE_V1: ProductionProfile = Object.freeze({
  profileId: 'sales-web',
  version: 1,
  description: 'Sales advisor on the store website chat: Catalog V2 read-only including Discover and per-variant sellability; Shipping read-only; no writes (no workspace, Quote, Checkout, Customer or payment).',
  domains: { ...SALES_PRODUCTION_PROFILE_V13.domains },
  channel: { id: WEB_CHANNEL_ID, status: 'REAL', contractRef: WEB_EDGE_CONTRACT_REF },
  capabilities: [
    { capabilityId: CAPABILITY_IDS.catalogSearch, domain: SALES_DOMAINS.catalog, effect: 'read' },
    { capabilityId: CAPABILITY_IDS.productContext, domain: SALES_DOMAINS.catalog, effect: 'read' },
    { capabilityId: LANE_CAPABILITY_IDS.catalogDiscover, domain: SALES_DOMAINS.catalog, effect: 'read' },
    { capabilityId: CAPABILITY_IDS.shippingQuote, domain: SALES_DOMAINS.shipping, effect: 'read' },
  ],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/**
 * (ADR-046 W2) sales-web@1 with product cards: the same reads and channel; its definition (sales-web@2) cites verified
 * catalog keys ([[P…]]) instead of URLs and the store renders each card in the visitor's browser. Still no write.
 */
export const SALES_WEB_PROFILE_V2: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V1,
  version: 2,
  description: 'sales-web@1 plus product cards rendered by the store from the catalog keys the advisor cites; no writes (the visitor adds to the store cart in the browser).',
} satisfies ProductionProfile);

/**
 * (ADR-046 W3, etapa 1) sales-web@2 presented as Don Pesín (an AI assistant) with reply buttons and the guided home-gym
 * set; the store renders the set total and adds the whole set in the visitor's browser. Same reads; still no write.
 */
export const SALES_WEB_PROFILE_V3: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V1,
  version: 3,
  description: 'sales-web@2 as Don Pesín with reply buttons and the guided home-gym set; no writes (the visitor adds to the store cart in the browser).',
} satisfies ProductionProfile);

/**
 * sales-web@3 whose definition verifies each cited product once per reply: the store cards and the set total carry the
 * current price and stock, so Catalog's short validity window no longer forces re-reads while a set is assembled.
 */
export const SALES_WEB_PROFILE_V4: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V1,
  version: 4,
  description: 'sales-web@3 verifying each cited product once per reply (the store cards carry price and stock); no writes.',
} satisfies ProductionProfile);

/** sales-web@4 with fixed home-gym budget ranges (up to large gyms) and up to five reply buttons. */
export const SALES_WEB_PROFILE_V5: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V1,
  version: 5,
  description: 'sales-web@4 with fixed home-gym budget ranges up to large gyms; no writes.',
} satisfies ProductionProfile);

/**
 * sales-web@5 that never hands the conversation off (no person attends the web chat yet: it shows the store contact
 * instead) and reads the chosen option, the cart and the Mi gym set from the browser note. Same reads; no write.
 */
export const SALES_WEB_PROFILE_V6: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V1,
  version: 6,
  description: 'sales-web@5 without handoffs (store contact instead) and with the chosen option, cart and Mi gym set as context; no writes.',
} satisfies ProductionProfile);

/**
 * Experimental, web QA only (owner decision 2026-11-13, F1). sales-web@6 whose cards may cite any product a catalog
 * observation of the conversation showed as sellable (a Discover candidate with OBSERVED commercial status or a search
 * result counts) as a provisional recommendation, without re-reading it or repeating Discover only because its price
 * and stock expired. Prices and stock stated in the text still need a current observation; the store card stays the
 * authority for price, stock and what can be bought. Same reads; no write.
 */
export const SALES_WEB_PROFILE_V7: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V1,
  version: 7,
  description: 'sales-web@6 citing products already shown as sellable as provisional recommendations, without re-reading them only because their price and stock expired; no writes.',
} satisfies ProductionProfile);

export const SALES_WEB_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_WEB_PROFILE_V1, SALES_WEB_PROFILE_V2, SALES_WEB_PROFILE_V3, SALES_WEB_PROFILE_V4, SALES_WEB_PROFILE_V5, SALES_WEB_PROFILE_V6, SALES_WEB_PROFILE_V7]);

/** The sales-web definition version each web profile pins. */
const SALES_WEB_AGENT_VERSIONS: Readonly<Record<string, number>> = Object.freeze({ 'sales-web@1': 1, 'sales-web@2': 2, 'sales-web@3': 3, 'sales-web@4': 4, 'sales-web@5': 5, 'sales-web@6': 6, 'sales-web@7': 7 });

export function salesWebProfile(label: string): ProductionProfile | null {
  return SALES_WEB_PROFILES.find((p) => profileLabel(p) === label) ?? null;
}

export function isSalesWebProfile(profile: ProductionProfile): boolean {
  return salesWebProfile(profileLabel(profile)) !== null;
}

/** The sales-web definition version a web profile pins (null for any other profile). */
export function salesWebAgentVersion(profile: ProductionProfile): number | null {
  return SALES_WEB_AGENT_VERSIONS[profileLabel(profile)] ?? null;
}

export function loadSalesWebAgentDefinition(version = 1): AgentDefinition {
  const definition = agentDefinitionSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../../candidates/sales-web.v${version}.candidate.json`, import.meta.url)), 'utf8')));
  if (definition.agentId !== SALES_WEB_AGENT_ID || definition.version !== version) throw new Error(`sales-web.v${version}.candidate.json does not declare ${SALES_WEB_AGENT_ID}@${version}`);
  return definition;
}
