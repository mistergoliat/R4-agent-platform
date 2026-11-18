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
  SALES_PRODUCTION_PROFILE_V20,
  SALES_PRODUCTION_PROFILE_V20_GATE,
  SALES_PRODUCTION_PROFILE_V21,
  SALES_PRODUCTION_PROFILE_V21_GATE,
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
 * (owner feedback 2026-11-17) sales-production@21 is @20 pinned to definition v21 = v20 plus the feedback edits (thanks,
 * greetings, capacity margin, open needs, jargon). Every control of @20 (and @19) applies to @21; @20 stays the rollback.
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

describe('@21 is @20 pinned to definition v21, a lane (and isolated canary) profile only; @20 stays the rollback', () => {
  const v21 = SALES_PRODUCTION_PROFILE_V21;
  const v20 = SALES_PRODUCTION_PROFILE_V20;
  it('same domains, channel, capabilities and composed capability versions as @20; serves sales@21', () => {
    expect(v21.version).toBe(21);
    expect(v21.domains).toEqual(v20.domains);
    expect(v21.channel).toEqual(v20.channel);
    expect(v21.capabilities).toEqual(v20.capabilities);
    expect(ids('sales-production@21')).toEqual(ids('sales-production@20'));
    expect(ids('sales-production@21')).toEqual(expect.arrayContaining(['quote.preview@4', 'quote.create@6']));
    expect(profileFingerprint(v21)).not.toBe(profileFingerprint(v20));
    expect(salesProductionAgentVersion(v21)).toBe(21);
    expect(salesProductionAgentVersion(v20)).toBe(20);
    expect(composed('sales-production@21').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 21 }]);
    expect(composed('sales-production@20').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 20 }]);
  });

  it('every @20 control applies to @21 too (policy, intent guard, PDF, notice, lane, canary, F1 limits, write ceiling, promotions)', () => {
    for (const label of ['sales-production@19', 'sales-production@20', 'sales-production@21']) {
      for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES]) expect(set.has(label)).toBe(true);
      expect(SALES_HUMAN_REQUEST_NOTICE_PROFILES).toContain(label);
      expect(SALES_LANE_PROFILES.map(profileLabel)).toContain(label);
      expect(CANARY_PROFILES.map(profileLabel)).toContain(label);
    }
    expect(salesCommercialEligibility(v21)).toEqual(salesCommercialEligibility(v20));
    expect(salesCommercialEligibility(v21)).toEqual({ policyVersion: 'F1-COMMERCIAL-POLICY-v2', shippingAllowed: true });
    expect(salesCommercialEligibility(v21, true)).toEqual(salesCommercialEligibility(v20, true));
    expect(salesProductionActionPolicy(v21)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(isQuoteLaneProfile(v21)).toBe(true);
    expect(() => assertF1CanaryWriteCeiling(0, 'sales-production@21')).toThrow(/maxWriteActions/);
    expect(() => composeSalesProductionWorker({ ...options('sales-production@21'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxGrossClp: SALES_F1_CANARY_LIMITS.maxGrossClp + 1 } })).toThrow(/sales-production@21 runs within the owner-approved canary limits/);
  });

  it('lane and canary only: never a production profile; selectable as the lane', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@21');
    expect(() => selectedSalesProductionProfile(env('sales-production@21').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@21').config, { lane: true })).toBe(v21);
    expect(selectedSalesProductionProfile(env('sales-production@20').config, { lane: true })).toBe(v20);
  });

  it('gate: @20 items (except its registration and authorization) plus the feedback L3, the @21 registration and the authorization', () => {
    expect(SALES_PRODUCTION_PROFILE_V21_GATE.every((g) => g.blocking)).toBe(true);
    const inherited = SALES_PRODUCTION_PROFILE_V20_GATE.filter((g) => g.id !== 'profile-20-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V21_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'feedback-l3', 'profile-21-registered', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V21_GATE.at(-1)!.requirement).toMatch(/@20 kept as rollback/);
  });
});


describe('definition v21 = v20 plus exactly the owner feedback edits of 2026-11-17 (no rule dropped)', () => {
  const v20 = loadSalesAgentDefinition(20);
  const v21 = loadSalesAgentDefinition(21);
  const greeting = '- En vez de: "Hola, bienvenido a PesasChile. ¿En qué le puedo ayudar el día de hoy?"\n  Mejor: "¡Hola! Soy Don Pesín. ¿Qué andas buscando?"';
  const thanks = '- En vez de: "Muchas gracias a usted por contactarnos. Quedo atento a cualquier otra consulta."\n  Mejor: "¡De nada! Cualquier cosa, me escribes por acá."';
  /** [from, to]: each `from` occurs exactly once in v20. */
  const EDITS: readonly (readonly [string, string])[] = [
    // 1. Thanks and goodbyes never end in silence.
    ['Complete the task (complete, in a turn without a reply) only when the conversation has clearly ended.', 'Thanks and goodbyes also get a reply: when the customer thanks you or says goodbye, reply briefly, thanking them warmly for contacting PesasChile in your own words (never a fixed formula), and wait. Never use complete after a customer message: leave the conversation open; the platform handles inactive conversations.'],
    // 2. Greeting as guidance; the literal greeting and thank-you examples out; the examples are never copied.
    [`\n${greeting}\n${thanks}`, '\n\nNunca copies los ejemplos de tono palabra por palabra: muestran el tono, no el texto.'],
    ['("con gusto le informo", "quedo atento a sus comentarios").', '("con gusto le informo", "quedo atento a sus comentarios").\n- Al saludar, da una bienvenida cálida a PesasChile con tus propias palabras, distinta cada vez, y pregunta qué necesita. Presentarte como Don Pesín es opcional, nunca una frase fija.'],
    // 3. Safety margin.
    ['say exactly that and never promise it.\n', 'say exactly that and never promise it.\n- Capacity and safety margin: when the customer\'s use (for example their body weight on a pull-up bar, or the load they plan) is at or near a product\'s stated maximum capacity, say plainly that it is at the limit with no margin and look for an option with more capacity; never present it as fitting.\n'],
    // 4. Ask before jumping to expensive gear.
    ['When you can, offer a concrete proposal instead of questioning.', 'When you can, offer a concrete proposal instead of questioning. For an open need without budget or context (for example "algo para espalda"), ask what they want to achieve, where they train and roughly how much they want to spend, or offer a simple option first, before recommending a high-priced machine.'],
    // 5. No internal jargon (the promotion rule itself is unchanged).
    ["- Reply in the customer's language, briefly and concretely.", "- Reply in the customer's language, briefly and concretely. Never expose platform or policy terms to the customer (for example \"no se puede cotizar formalmente\", policy names, codes or field names): say it in customer words; for example, that the product is on promotion but that offer cannot be left in a quote right now."],
  ];

  it('the instructions are v20 with exactly the listed edits', () => {
    let expected = v20.instructions;
    for (const [from, to] of EDITS) {
      expect(expected.split(from)).toHaveLength(2);
      expected = expected.replace(from, () => to);
    }
    expect(v21.instructions).toBe(expected);
  });

  it('every v20 line survives except the edited ones; only the greeting and thank-you examples are removed', () => {
    const lines20 = v20.instructions.split('\n');
    const lines21 = v21.instructions.split('\n');
    const removed = lines20.filter((l) => !lines21.includes(l));
    const extended = ['- Each customer message gets one clear reply', '- Ask only what materially changes the recommendation', "- Reply in the customer's language"];
    expect(removed.filter((l) => !extended.some((p) => l.startsWith(p)))).toEqual([...greeting.split('\n'), ...thanks.split('\n')]);
    expect(lines21.length).toBe(lines20.length - 4 + 4); // −4 example lines; +1 greeting rule, +1 capacity rule, +1 blank, +1 never-copy line
    expect(v21.instructions).not.toMatch(/¡Hola! Soy Don Pesín|Cualquier cosa, me escribes por acá|Complete the task \(complete/);
    expect(v21.instructions.match(/^- En vez de: /gm)).toHaveLength(3);
  });

  it('the voice section stays first and the operative rules after it are untouched by the voice edits', () => {
    expect(v21.instructions.startsWith('## Don Pesín: cómo conversas\n\n')).toBe(true);
    // The quote and promotion rules are unchanged (edit 5 changes wording to the customer, not the rule).
    for (const prefix of ['- quote.preview: ', '- quote.create: ', '- catalog.discover: ', '- shipping.quote: ', '- Despacho Directo promotion: ']) {
      const line = (s: string) => s.split('\n').find((l) => l.startsWith(prefix));
      expect(line(v21.instructions)).toBe(line(v20.instructions));
    }
  });

  it('every other field equals v20; only version, description and instructions change', () => {
    const { instructions: _a, version, description, ...rest21 } = v21;
    const { instructions: _b, version: _c, description: description20, ...rest20 } = v20;
    expect(version).toBe(21);
    expect(description).not.toBe(description20);
    expect(description).toMatch(/^R4 F1 \(sales-production@21\): definition v20/);
    expect(rest21).toEqual(rest20);
  });

  it('v20 is unchanged on disk (the rollback definition)', () => {
    const raw = JSON.parse(readFileSync(join(SALES_AGENT_DIR, 'candidates/sales.v20.candidate.json'), 'utf8')) as { version: number; instructions: string };
    expect(raw.version).toBe(20);
    expect(raw.instructions).toBe(v20.instructions);
    expect(raw.instructions).toContain(greeting);
    expect(raw.instructions).toContain('Complete the task (complete, in a turn without a reply) only when the conversation has clearly ended.');
  });

  it('is a candidate file: the plain bootstrap never registers it', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@21');
  });
});
