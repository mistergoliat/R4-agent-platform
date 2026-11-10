import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V17, SALES_PRODUCTION_PROFILE_V17_GATE } from './profile-v17.js';

/**
 * Sales production profile, version 18 («F1 canary continuation and quote delivery», 2026-11-10). A quote lane
 * CANDIDATE, NOT deployed and NOT active. @17 is not changed retroactively: @18 is exactly @17 (same capabilities,
 * policy, F1 commercial policy and limits, single-flight issuance, F-ADV-2 notice) except that an
 * issued quote's own PDF follows it to the conversation: quote.create@5 settlement queues ONE platform notice per quote
 * carrying the bytes it just read from the Quote owner and verified against the owner's SHA-256 (never regenerated),
 * delivered by the single delivery owner to the conversation's own contact under the agent-output gates. A delivery
 * failure never touches the quote (it is never issued again). It runs definition v17: v16 verbatim except the last
 * sentence of the quote.create rule, which said the agent cannot share the document; now the platform sends it.
 */
export const SALES_PRODUCTION_PROFILE_V18: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V17,
  version: 18,
  description: 'Sales F1 quote lane candidate (successor of @17): @17 plus the issued quote\'s own PDF sent to the conversation as a document (platform notice, the owner\'s verified bytes, once per quote). Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance of the confirmed Sales-rendered offer, F1 policy and limits, kill switch; definition v17 (v16 with the document sentence). Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V18_PROFILE_LABEL = 'sales-production@18';

/** Profiles whose issued quotes send their PDF to the conversation; every other profile sends none. */
export const SALES_QUOTE_DOCUMENT_PROFILES: ReadonlySet<string> = new Set([SALES_QUOTE_LANE_V18_PROFILE_LABEL]);

/** What must be true before @18 is activated on the lane: everything @17 required, plus the document delivery items. */
export const SALES_PRODUCTION_PROFILE_V18_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V17_GATE.filter((g) => g.id !== 'profile-17-registered' && g.id !== 'explicit-authorization'),
  { id: 'core-0015', blocking: true, requirement: 'Core migration 0015 (outbound_documents) applied with a coordinated deploy of gateway, workers and scheduler (execution-contract compatibility)' },
  { id: 'document-delivery-l3', blocking: true, requirement: 'L3: an issued quote delivers exactly one PDF document whose bytes equal the Quote owner\'s (SHA-256), to the conversation\'s contact only; a delivery failure leaves the quote issued and is never retried as an issuance' },
  { id: 'profile-18-registered', blocking: true, requirement: 'identifier @18 verified free, then registered with production:sales:bootstrap --lane (registers the candidate definition v17)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @18, by exact SHA, allowlist only; @17 kept as rollback' },
] as const);
