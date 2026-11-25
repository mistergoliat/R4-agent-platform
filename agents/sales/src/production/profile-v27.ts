import type { ProductionProfile } from '@r4/live-ops';
import { DESK_DOMAIN, DESK_INGEST_CONTRACT_REF, DESK_OPPORTUNITY_CAPABILITY_ID } from '../capabilities/desk-opportunity.js';
import { SALES_PRODUCTION_PROFILE_V26, SALES_PRODUCTION_PROFILE_V26_GATE } from './profile-v26.js';

/**
 * (ADR-062 O1, all channels; owner 2026-11-25) Sales production profile, version 27: a quote lane CANDIDATE, NOT
 * active. @26 is not changed and stays the rollback: @27 is @26 plus desk.opportunity.record@1 (write, ALLOW,
 * autonomous) on its own REAL sales-desk domain, pinned to definition v27 = v26 plus the opportunity-record block.
 * The lane worker requires the desk ingest (R4_DESK_INGEST_URL, R4_DESK_INGEST_KEY). Everything else is @26's.
 */
export const SALES_PRODUCTION_PROFILE_V27: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V26,
  version: 27,
  description: 'Sales F1 quote lane candidate (successor of @26): @26 unchanged plus desk.opportunity.record@1, which records each sales opportunity in the sales desk (consultation, handoff, issued quote, or buying intent at the end), classified from closed lists; pinned to definition v27 (v26 plus the opportunity-record block).',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V26.domains,
    [DESK_DOMAIN]: { status: 'REAL', contractRef: DESK_INGEST_CONTRACT_REF, note: 'internal opportunity record in the sales desk; no customer contact, no money' },
  },
  capabilities: [...SALES_PRODUCTION_PROFILE_V26.capabilities, { capabilityId: DESK_OPPORTUNITY_CAPABILITY_ID, domain: DESK_DOMAIN, effect: 'write' as const, decision: 'ALLOW' as const }],
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V27_PROFILE_LABEL = 'sales-production@27';

/** What must be true before @27 is activated on the lane: what @26 requires, plus the desk ingest and the record L3. */
export const SALES_PRODUCTION_PROFILE_V27_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V26_GATE.filter((g) => g.id !== 'profile-26-registered' && g.id !== 'explicit-authorization'),
  { id: 'desk-ingest', blocking: true, requirement: 'the lane worker runs with R4_DESK_INGEST_URL and R4_DESK_INGEST_KEY (the key the desk verifies); it refuses to compose without them' },
  { id: 'write-budget', blocking: true, requirement: 'owner decision 2026-11-25 («sácale el límite de acciones»): the @27 lane worker runs R4_EXEC_MAX_WRITE_ACTIONS=200, the code ceiling SALES_F1_CANARY_MAX_WRITE_ACTIONS, as the web chat does (F-WA-2\'s 6 no longer applies to @27); the commercial limits, the confirmation and the quote.create authorization stay independent of it' },
  { id: 'opportunity-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA: records on consultation, handoff (before request_handoff), issued quote and buying intent at the end, none on a pure FAQ, never mentioned to the customer; the classification meets the owner threshold (evaluations/opportunity.ts, WhatsApp cases)' },
  { id: 'profile-27-registered', blocking: true, requirement: 'identifier @27 registered with production:sales:bootstrap --lane (registers the candidate definition v27)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @27, by exact SHA; @26 kept as rollback' },
] as const);
