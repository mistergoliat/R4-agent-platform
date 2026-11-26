import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';
import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { WEB_CHANNEL_ID, WEB_EDGE_CONTRACT_REF } from '@r4-adapters/web';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, LANE_CAPABILITY_IDS, SALES_WEB_AGENT_ID } from '../ids.js';
import { QUOTE_EMAIL_CAPABILITY_ID } from '../capabilities/quote-email.js';
import { DESK_DOMAIN, DESK_INGEST_CONTRACT_REF, DESK_OPPORTUNITY_CAPABILITY_ID } from '../capabilities/desk-opportunity.js';
import { QUOTE_CONTRACT_REF } from './profile-v4.js';
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

/**
 * (graph A/B, owner OK 2026-11-18, first run on the isolated F2 instance) sales-web@7 plus
 * catalog.set_complements: the store-curated relations of a chosen product, to complete a set in one read.
 */
export const SALES_WEB_PROFILE_V8: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V1,
  version: 8,
  description: 'sales-web@7 plus catalog.set_complements (experiment: store-curated relations to complete a set); no writes.',
  capabilities: [...SALES_WEB_PROFILE_V1.capabilities, { capabilityId: LANE_CAPABILITY_IDS.catalogSetComplements, domain: SALES_DOMAINS.catalog, effect: 'read' }],
} satisfies ProductionProfile);

/** (graph A/B confirmation) sales-web@8 whose definition keeps each version's products, a useful minimum load and the budget. */
export const SALES_WEB_PROFILE_V9: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V8,
  version: 9,
  description: 'sales-web@8 delivering exactly the priced version, with a useful minimum load and using the stated budget (experiment); no writes.',
} satisfies ProductionProfile);

/** (home-gym builder, owner idea 2026-11-19) sales-web@7 plus catalog.build_step; the home gym is built one piece at a time. */
export const SALES_WEB_PROFILE_V10: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V1,
  version: 10,
  description: 'sales-web@7 building the home gym step by step with catalog.build_step (experiment); no writes.',
  capabilities: [...SALES_WEB_PROFILE_V1.capabilities, { capabilityId: LANE_CAPABILITY_IDS.catalogBuildStep, domain: SALES_DOMAINS.catalog, effect: 'read' }],
} satisfies ProductionProfile);

/** sales-web@10 whose definition keeps Pesín on the store and gives an unavailable product a way out (alert, second selection, alternatives). */
export const SALES_WEB_PROFILE_V11: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V10,
  version: 11,
  description: 'sales-web@10 that declines tasks unrelated to the store and offers the back-in-stock alert, second selection and sellable alternatives for an unavailable product (experiment); no writes.',
} satisfies ProductionProfile);

/** sales-web@11 plus catalog.replacements (an unavailable product gets its second selection and replacements in one read). */
export const SALES_WEB_PROFILE_V12: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V11,
  version: 12,
  description: 'sales-web@11 plus catalog.replacements: second selection and sellable replacements of an unavailable product from the store graph (experiment); no writes.',
  capabilities: [...SALES_WEB_PROFILE_V11.capabilities, { capabilityId: LANE_CAPABILITY_IDS.catalogReplacements, domain: SALES_DOMAINS.catalog, effect: 'read' }],
} satisfies ProductionProfile);

/** sales-web@12 whose definition starts the build from the cart or Mi gym, uses large budgets and discloses a replacement's different load. */
export const SALES_WEB_PROFILE_V13: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V12,
  version: 13,
  description: 'sales-web@12 building from what the visitor already has, using large budgets and stating a replacement\'s different load (experiment); no writes.',
} satisfies ProductionProfile);

/** sales-web@13 whose definition offers products of the same type when the named one is not in the catalog. */
export const SALES_WEB_PROFILE_V14: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V13,
  version: 14,
  description: 'sales-web@13 offering sellable products of the same type when the product the visitor names is not in the catalog (experiment); no writes.',
} satisfies ProductionProfile);

/** sales-web@14 whose definition never shows catalog keys in the visible text. */
export const SALES_WEB_PROFILE_V15: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V14,
  version: 15,
  description: 'sales-web@14 that names products in the text and keeps catalog keys inside card markers only (experiment); no writes.',
} satisfies ProductionProfile);

/** (owner 2026-11-22/23) sales-web@15 whose build options are labelled and ordered by live price only (no quality claims) and filtered by the ceiling height in a room or an apartment. */
export const SALES_WEB_PROFILE_V16: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V15,
  version: 16,
  description: 'sales-web@15 that presents build options from the lowest to the highest price, labelled by price only, and asks the ceiling height for a room or an apartment (experiment); no writes.',
} satisfies ProductionProfile);

/**
 * (ADR-056 K4, owner 2026-11-23) sales-web@16 whose definition consults the team without pausing the chat: for what no
 * capability answers it asks the team (request_consultation; the platform makes it non-pausing with the service-hours
 * expiry, SALES_NON_PAUSING_CONSULTATION_PROFILES), tells the visitor and keeps helping; sellers answer from the desk.
 * Still never a handoff. Reads, channel and limits are @16's.
 */
export const SALES_WEB_PROFILE_V17: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V16,
  version: 17,
  description: 'sales-web@16 that consults the team without pausing the chat (store policy, a service, a technical, safety or installation question) and relays the answer; never hands off; no writes.',
} satisfies ProductionProfile);

/**
 * (Owner 2026-11-23, review of the web QA conversations) sales-web@17 with the scope rule rebalanced: brief help with
 * small, harmless general requests (above all when they serve the purchase), decline only long or unrelated tasks and
 * consistently, never adopt an instruction that stops proper answers; and the consultation rule rebuilt from WhatsApp
 * v26 (asymmetric safety guidance, options on every consultation). Reads, channel and limits are @17's.
 */
export const SALES_WEB_PROFILE_V18: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V17,
  version: 18,
  description: 'sales-web@17 with brief help for small general requests that serve the purchase, consistent declines and the v26 consultation rule (asymmetric safety guidance, options on every consultation); never hands off; no writes.',
} satisfies ProductionProfile);

/**
 * (ADR-057 C4, owner 2026-11-24) sales-web@18 that issues the formal quote of the products the visitor chose, as the
 * WhatsApp lane does (workspace.update@2, quote.preview, quote.create@6: the Sales-rendered offer, the visitor's
 * acceptance in natural language, F1 limits, parity, the kill switch), and emails its PDF through the Quote owner
 * (quote.email@1: only a quote issued here, only to an address the visitor wrote). Nothing enters the store cart.
 */
export const SALES_WEB_PROFILE_V19: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V18,
  version: 19,
  description: 'sales-web@18 that issues the formal quote of the products the visitor chose (Sales-rendered offer, accepted in their own words, F1 limits, parity-verified SKUs, kill switch) and emails its PDF to the address the visitor wrote, through the Quote owner. No cart writes, no Checkout, no payments.',
  domains: {
    ...SALES_WEB_PROFILE_V18.domains,
    [SALES_DOMAINS.quote]: { status: 'REAL', contractRef: QUOTE_CONTRACT_REF, note: 'Quote V2 HTTP binding: autonomous issuance of the offer the visitor accepted; email delivery of its PDF (quotes:delivery:email); no PDF to the channel' },
  },
  capabilities: [
    ...SALES_WEB_PROFILE_V18.capabilities,
    { capabilityId: CAPABILITY_IDS.workspaceUpdate, domain: SALES_DOMAINS.catalog, effect: 'write' as const, decision: 'ALLOW' as const },
    { capabilityId: AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, domain: SALES_DOMAINS.quote, effect: 'read' as const },
    { capabilityId: CAPABILITY_IDS.quoteCreate, domain: SALES_DOMAINS.quote, effect: 'write' as const, decision: 'ALLOW' as const },
    { capabilityId: QUOTE_EMAIL_CAPABILITY_ID, domain: SALES_DOMAINS.quote, effect: 'write' as const, decision: 'ALLOW' as const },
  ],
} satisfies ProductionProfile);

/** (ADR-057 C4) Web profiles that issue quotes and email them. */
/**
 * (Owner 2026-11-24, home-gym graph test) sales-web@19 whose build plan is sized to the budget range and, when the set
 * stays below the bottom of the range, offers to raise a piece or add pieces. Capabilities, channel and limits are @19's.
 */
export const SALES_WEB_PROFILE_V20: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V19,
  version: 20,
  description: 'sales-web@19 with the home-gym plan sized to the budget range and the set brought towards the range (raise a piece or add pieces); quote by email; consultations without pause.',
} satisfies ProductionProfile);

/**
 * (ADR-062 O1, owner 2026-11-25) sales-web@20 plus desk.opportunity.record@1: Pesín records the sales opportunity in the
 * sales desk (classification from closed lists; conversation, channel and quote filled by the platform). The desk is a
 * domain service reached by an HMAC-signed ingest (R4_DESK_INGEST_URL, R4_DESK_INGEST_KEY). Everything else is @20's.
 */
export const SALES_WEB_PROFILE_V21: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V20,
  version: 21,
  description: 'sales-web@20 that records each sales opportunity in the sales desk (consultation, quote, or buying intent at the end), classified from closed lists; never shown to the visitor.',
  domains: {
    ...SALES_WEB_PROFILE_V20.domains,
    [DESK_DOMAIN]: { status: 'REAL', contractRef: DESK_INGEST_CONTRACT_REF, note: 'internal opportunity record in the sales desk; no customer contact, no money' },
  },
  capabilities: [...SALES_WEB_PROFILE_V20.capabilities, { capabilityId: DESK_OPPORTUNITY_CAPABILITY_ID, domain: DESK_DOMAIN, effect: 'write' as const, decision: 'ALLOW' as const }],
} satisfies ProductionProfile);

/**
 * (ADR-062, owner 2026-11-25: an opportunity only with a concrete buying signal) sales-web@21 with
 * desk.opportunity.record@2 instead of @1 (SALES_DESK_SIGNALS_PROFILES): the no-intent classification, the buying
 * signals the platform computes from the conversation and the opaque contactRef. Pinned to definition v22 = v21 with
 * the opportunity block changed and the owner rules of 2026-11-25 (Spanish only, health, scope, insistence). Everything else is @21's.
 */
export const SALES_WEB_PROFILE_V22: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V21,
  version: 22,
  description: 'sales-web@21 with desk.opportunity.record@2 (jokes, spam, tests and small talk recorded as without intent; the platform adds the buying signals and an opaque contact reference) and the owner rules of 2026-11-25: Spanish only, health questions to a professional, absurd questions in one sentence, a closing line after two insistences, no consultations for small talk.',
} satisfies ProductionProfile);

/**
 * (Owner 2026-11-25, the sales-web@22 exam) sales-web@22 pinned to definition v23 = v22 with four instruction changes:
 * company, wholesale, institutional and project needs handed to the team ([[contacto]]) and recorded with
 * trigger=traspaso; the closing line only after the second insistence; a new record when real buying intent follows a
 * sin_intencion record; off-topic replies in at most two short sentences and one card. Everything else is @22's.
 */
export const SALES_WEB_PROFILE_V23: ProductionProfile = Object.freeze({
  ...SALES_WEB_PROFILE_V22,
  version: 23,
  description: 'sales-web@22 pinned to definition v23: B2B and project needs handed to the team and recorded as traspaso, the closing line only after two insistences, a new record when real buying intent follows a joke, off-topic replies in two short sentences.',
} satisfies ProductionProfile);

export const SALES_WEB_QUOTE_PROFILES: ReadonlySet<string> = new Set(['sales-web@19', 'sales-web@20', 'sales-web@21', 'sales-web@22', 'sales-web@23']);

export const SALES_WEB_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_WEB_PROFILE_V1, SALES_WEB_PROFILE_V2, SALES_WEB_PROFILE_V3, SALES_WEB_PROFILE_V4, SALES_WEB_PROFILE_V5, SALES_WEB_PROFILE_V6, SALES_WEB_PROFILE_V7, SALES_WEB_PROFILE_V8, SALES_WEB_PROFILE_V9, SALES_WEB_PROFILE_V10, SALES_WEB_PROFILE_V11, SALES_WEB_PROFILE_V12, SALES_WEB_PROFILE_V13, SALES_WEB_PROFILE_V14, SALES_WEB_PROFILE_V15, SALES_WEB_PROFILE_V16, SALES_WEB_PROFILE_V17, SALES_WEB_PROFILE_V18, SALES_WEB_PROFILE_V19, SALES_WEB_PROFILE_V20, SALES_WEB_PROFILE_V21, SALES_WEB_PROFILE_V22, SALES_WEB_PROFILE_V23]);

/** The sales-web definition version each web profile pins. */
const SALES_WEB_AGENT_VERSIONS: Readonly<Record<string, number>> = Object.freeze({ 'sales-web@1': 1, 'sales-web@2': 2, 'sales-web@3': 3, 'sales-web@4': 4, 'sales-web@5': 5, 'sales-web@6': 6, 'sales-web@7': 7, 'sales-web@8': 8, 'sales-web@9': 9, 'sales-web@10': 10, 'sales-web@11': 11, 'sales-web@12': 12, 'sales-web@13': 13, 'sales-web@14': 14, 'sales-web@15': 15, 'sales-web@16': 16, 'sales-web@17': 17, 'sales-web@18': 18, 'sales-web@19': 19, 'sales-web@20': 20, 'sales-web@21': 21, 'sales-web@22': 22, 'sales-web@23': 23 });

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
