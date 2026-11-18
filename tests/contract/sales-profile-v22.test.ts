import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { SALES_AGENT_DIR, loadSalesAgentDefinition } from '@r4-sales/agent';
import { CANARY_PROFILES } from '@r4-sales/agent/canary';
import {
  SALES_AUTONOMOUS_QUOTE_PROFILES,
  SALES_CANARY_ONLY_PROFILES,
  SALES_CONFIRMED_INTENT_PROFILES,
  SALES_DETERMINISTIC_OFFER_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_F1_SHIPPING_PROFILES,
  SALES_HUMAN_REQUEST_NOTICE_PROFILES,
  SALES_INTENT_ACCEPTANCE_PROFILES,
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V21,
  SALES_PRODUCTION_PROFILE_V21_GATE,
  SALES_PRODUCTION_PROFILE_V22,
  SALES_PRODUCTION_PROFILE_V22_GATE,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  assertF1CanaryWriteCeiling,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  salesCommercialEligibility,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * (owner feedback 2026-11-17 on live @21) sales-production@22 is @21 pinned to definition v22 = v21 plus the feedback edits
 * (earlier facts, the $1 delivery wording, a person for quotes beyond the limits). Every control of @21 (and @19) applies to
 * @22; @21 stays the rollback.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const options = (profile: string) => ({
  pool: { query: () => Promise.reject(new Error('no db')) } as never,
  store: noStore,
  production: env(profile),
  modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
  logger: createSilentLogger(),
  catalog: http(new FixtureCatalog() as CatalogPort),
  catalogDiscover: discover,
  shipping: http(new FixtureShipping() as ShippingService),
  quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
  autonomousQuoteLimits: SALES_F1_CANARY_LIMITS,
});
const composed = (profile: string) => composeSalesProductionWorker(options(profile));
const ids = (profile: string) => composed(profile).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();

describe('@22 is @21 pinned to definition v22, a lane (and isolated canary) profile only; @21 stays the rollback', () => {
  const v22 = SALES_PRODUCTION_PROFILE_V22;
  const v21 = SALES_PRODUCTION_PROFILE_V21;
  it('same domains, channel, capabilities and composed capability versions as @21; serves sales@22', () => {
    expect(v22.version).toBe(22);
    expect(v22.domains).toEqual(v21.domains);
    expect(v22.channel).toEqual(v21.channel);
    expect(v22.capabilities).toEqual(v21.capabilities);
    expect(ids('sales-production@22')).toEqual(ids('sales-production@21'));
    expect(ids('sales-production@22')).toEqual(expect.arrayContaining(['quote.preview@4', 'quote.create@6']));
    expect(profileFingerprint(v22)).not.toBe(profileFingerprint(v21));
    expect(salesProductionAgentVersion(v22)).toBe(22);
    expect(salesProductionAgentVersion(v21)).toBe(21);
    expect(composed('sales-production@22').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 22 }]);
    expect(composed('sales-production@21').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 21 }]);
  });

  it('every @21 control applies to @22 too (policy, intent guard, PDF, notice, lane, canary, F1 limits, write ceiling, promotions)', () => {
    for (const label of ['sales-production@19', 'sales-production@20', 'sales-production@21', 'sales-production@22']) {
      for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES]) expect(set.has(label)).toBe(true);
      expect(SALES_HUMAN_REQUEST_NOTICE_PROFILES).toContain(label);
      expect(SALES_LANE_PROFILES.map(profileLabel)).toContain(label);
      expect(CANARY_PROFILES.map(profileLabel)).toContain(label);
    }
    expect(salesCommercialEligibility(v22)).toEqual(salesCommercialEligibility(v21));
    expect(salesCommercialEligibility(v22)).toEqual({ policyVersion: 'F1-COMMERCIAL-POLICY-v2', shippingAllowed: true });
    expect(salesCommercialEligibility(v22, true)).toEqual(salesCommercialEligibility(v21, true));
    expect(salesProductionActionPolicy(v22)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(isQuoteLaneProfile(v22)).toBe(true);
    expect(() => assertF1CanaryWriteCeiling(0, 'sales-production@22')).toThrow(/maxWriteActions/);
    expect(() => composeSalesProductionWorker({ ...options('sales-production@22'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxGrossClp: SALES_F1_CANARY_LIMITS.maxGrossClp + 1 } })).toThrow(/sales-production@22 runs within the owner-approved canary limits/);
  });

  it('lane and canary only: never a production profile; selectable as the lane', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@22');
    expect(() => selectedSalesProductionProfile(env('sales-production@22').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@22').config, { lane: true })).toBe(v22);
    expect(selectedSalesProductionProfile(env('sales-production@21').config, { lane: true })).toBe(v21);
  });

  it('gate: @21 items (except its registration and authorization) plus the second feedback L3, the @22 registration and the authorization', () => {
    expect(SALES_PRODUCTION_PROFILE_V22_GATE.every((g) => g.blocking)).toBe(true);
    const inherited = SALES_PRODUCTION_PROFILE_V21_GATE.filter((g) => g.id !== 'profile-21-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V22_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'feedback-2-l3', 'profile-22-registered', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V22_GATE.at(-1)!.requirement).toMatch(/@21 kept as rollback/);
  });
});



describe('definition v22 = v21 plus exactly the owner feedback edits on live @21 (no rule dropped)', () => {
  const v21 = loadSalesAgentDefinition(21);
  const v22 = loadSalesAgentDefinition(22);
  /** [from, to]: each `from` occurs exactly once in v21. */
  const EDITS: readonly (readonly [string, string])[] = [
    // 1. Facts from earlier conversations still apply.
    ['Never ask again for something already stated; if something seems inconsistent, confirm it.', 'Never ask again for something already stated; if something seems inconsistent, confirm it. Facts the customer stated earlier, including in earlier conversations shown in the context (body weight, budget, space, goals, experience), still apply to every recommendation, including the capacity and safety-margin rule; confirm them briefly only if they may have changed.'],
    // 2. No defensive line about the $1 delivery (the never-free rules stay).
    ['It is not a pricing error and not free shipping.', 'It is not a pricing error and not free shipping. These are facts for you, not lines for the customer: never tell the customer that it is not free or not a pricing error; just state the $1 price and the promotion range.'],
    // 3. A person offered when a quote exceeds the autonomous limits; request_handoff only when the customer accepts.
    ['limitBreaches means the quote exceeds what can be issued without a human: say so and offer a human.', 'limitBreaches means the quote exceeds what can be issued without a person: say it plainly in customer words (for example that a quote of that size has to be prepared by a person of the team) and offer to connect them with a person of the team. If they accept, use request_handoff in that turn, with a summary of the selection and why it needs a person, without writing a reply first: the platform itself tells the customer that a person of the team will continue in this chat. Never say or imply that someone was notified or will contact them unless you requested the handoff.'],
  ];

  it('the instructions are v21 with exactly the listed edits', () => {
    let expected = v21.instructions;
    for (const [from, to] of EDITS) {
      expect(expected.split(from)).toHaveLength(2);
      expected = expected.replace(from, () => to);
    }
    expect(v22.instructions).toBe(expected);
  });

  it('every v21 line is kept except the three extended bullets; no line is added or removed', () => {
    const lines21 = v21.instructions.split('\n');
    const lines22 = v22.instructions.split('\n');
    expect(lines22.length).toBe(lines21.length);
    const extended = ['- Before asking, use what is already known', '- Despacho Directo promotion: ', '- quote.preview: '];
    expect(lines21.filter((l) => !lines22.includes(l)).map((l) => extended.find((p) => l.startsWith(p)))).toEqual(extended);
  });

  it('the never-free rules stay; the handoff is the kernel decision request_handoff, never claimed before it is requested', () => {
    expect(v22.instructions).toContain('A $1 Despacho Directo offer is a real commercial incentive, not free shipping.');
    expect(v22.instructions).toContain('($1; never $0, "free" or another amount)');
    const preview = v22.instructions.split('\n').find((l) => l.startsWith('- quote.preview: '))!;
    expect(preview).toContain('use request_handoff in that turn');
    expect(preview).toContain('Never say or imply that someone was notified or will contact them unless you requested the handoff.');
    expect(preview).not.toContain('request_consultation');
  });

  it('every other field equals v21; only version, description and instructions change', () => {
    const { instructions: _a, version, description, ...rest22 } = v22;
    const { instructions: _b, version: _c, description: description21, ...rest21 } = v21;
    expect(version).toBe(22);
    expect(description).not.toBe(description21);
    expect(description).toMatch(/^R4 F1 \(sales-production@22\): definition v21/);
    expect(rest22).toEqual(rest21);
  });

  it('v21 is unchanged on disk (the rollback definition)', () => {
    const raw = JSON.parse(readFileSync(join(SALES_AGENT_DIR, 'candidates/sales.v21.candidate.json'), 'utf8')) as { version: number; instructions: string };
    expect(raw.version).toBe(21);
    expect(raw.instructions).toBe(v21.instructions);
    expect(raw.instructions).toContain('limitBreaches means the quote exceeds what can be issued without a human: say so and offer a human.');
  });

  it('is a candidate file: the plain bootstrap never registers it', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@22');
  });
});
