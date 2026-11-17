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
  SALES_PRODUCTION_PROFILE_V19,
  SALES_PRODUCTION_PROFILE_V19_GATE,
  SALES_PRODUCTION_PROFILE_V20,
  SALES_PRODUCTION_PROFILE_V20_GATE,
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
 * (owner decision 2026-11-17) sales-production@20 is @19 pinned to definition v20 = v19 plus the Don Pesín voice and
 * three wording edits. Every control of @19 applies to @20; @19 stays fully valid as the rollback.
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

describe('@20 is @19 pinned to definition v20, a lane (and isolated canary) profile only; @19 stays the rollback', () => {
  const v20 = SALES_PRODUCTION_PROFILE_V20;
  const v19 = SALES_PRODUCTION_PROFILE_V19;
  it('same domains, channel, capabilities and composed capability versions as @19; serves sales@20', () => {
    expect(v20.version).toBe(20);
    expect(v20.domains).toEqual(v19.domains);
    expect(v20.channel).toEqual(v19.channel);
    expect(v20.capabilities).toEqual(v19.capabilities);
    expect(ids('sales-production@20')).toEqual(ids('sales-production@19'));
    expect(ids('sales-production@20')).toEqual(expect.arrayContaining(['quote.preview@4', 'quote.create@6']));
    expect(profileFingerprint(v20)).not.toBe(profileFingerprint(v19));
    expect(salesProductionAgentVersion(v20)).toBe(20);
    expect(salesProductionAgentVersion(v19)).toBe(19);
    expect(composed('sales-production@20').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 20 }]);
    expect(composed('sales-production@19').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 19 }]);
  });

  it('every @19 control applies to @20 too (policy, intent guard, PDF, notice, lane, canary, F1 limits, write ceiling, promotions)', () => {
    for (const label of ['sales-production@19', 'sales-production@20']) {
      for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES]) expect(set.has(label)).toBe(true);
      expect(SALES_HUMAN_REQUEST_NOTICE_PROFILES).toContain(label);
      expect(SALES_LANE_PROFILES.map(profileLabel)).toContain(label);
      expect(CANARY_PROFILES.map(profileLabel)).toContain(label);
    }
    expect(salesCommercialEligibility(v20)).toEqual(salesCommercialEligibility(v19));
    expect(salesCommercialEligibility(v20)).toEqual({ policyVersion: 'F1-COMMERCIAL-POLICY-v2', shippingAllowed: true });
    expect(salesCommercialEligibility(v20, true)).toEqual(salesCommercialEligibility(v19, true));
    expect(salesProductionActionPolicy(v20)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(isQuoteLaneProfile(v20)).toBe(true);
    expect(() => assertF1CanaryWriteCeiling(0, 'sales-production@20')).toThrow(/maxWriteActions/);
    expect(() => composeSalesProductionWorker({ ...options('sales-production@20'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxGrossClp: SALES_F1_CANARY_LIMITS.maxGrossClp + 1 } })).toThrow(/sales-production@20 runs within the owner-approved canary limits/);
  });

  it('lane and canary only: never a production profile; selectable as the lane', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@20');
    expect(() => selectedSalesProductionProfile(env('sales-production@20').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@20').config, { lane: true })).toBe(v20);
    expect(selectedSalesProductionProfile(env('sales-production@19').config, { lane: true })).toBe(v19);
  });

  it('gate: @19 items (except its registration and authorization) plus the voice L3, the @20 registration and the authorization', () => {
    expect(SALES_PRODUCTION_PROFILE_V20_GATE.every((g) => g.blocking)).toBe(true);
    const inherited = SALES_PRODUCTION_PROFILE_V19_GATE.filter((g) => g.id !== 'profile-19-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V20_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'voice-l3', 'profile-20-registered', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V20_GATE.at(-1)!.requirement).toMatch(/@19 kept as rollback/);
  });
});

describe('definition v20 = v19 plus exactly the owner-approved edits (no rule dropped)', () => {
  const v19 = loadSalesAgentDefinition(19);
  const v20 = loadSalesAgentDefinition(20);
  const personaPrefix = '## Don Pesín: cómo conversas\n\n';
  const voiceEnd = '\n\nTodas las reglas operativas, de evidencia, autorización y mensajes exactos que siguen están vigentes.\n\n';

  it('the voice section comes first, titled, with the five tone examples and the closing line', () => {
    expect(v20.instructions.startsWith(personaPrefix)).toBe(true);
    const voice = v20.instructions.slice(0, v20.instructions.indexOf(voiceEnd));
    expect(voice).toContain('Eres Don Pesín, el asesor virtual de PesasChile.');
    expect(voice).toContain('Ejemplos de tono (los productos, precios y datos siempre salen de lecturas actuales, nunca de estos ejemplos)');
    expect(voice.match(/^- En vez de: /gm)).toHaveLength(5);
    expect(voice.match(/^ {2}Mejor: /gm)).toHaveLength(5);
    expect(voice).toContain('- En vez de: "Hola, bienvenido a PesasChile. ¿En qué le puedo ayudar el día de hoy?"\n  Mejor: "¡Hola! Soy Don Pesín. ¿Qué andas buscando?"');
    expect(voice).toContain('- En vez de: "Muchas gracias a usted por contactarnos. Quedo atento a cualquier otra consulta."\n  Mejor: "¡De nada! Cualquier cosa, me escribes por acá."');
  });

  it('after the voice section, the instructions are v19 with exactly three sentence edits', () => {
    const rest = v20.instructions.slice(v20.instructions.indexOf(voiceEnd) + voiceEnd.length);
    const edits: readonly (readonly [string, string])[] = [
      ['Never call a product the best one.', 'You may recommend one product as your pick, always with its reason from verified data; never claim it is objectively the best.'],
      ['say that the PDF follows in this conversation only in that case', 'say in natural Spanish that the PDF arrives right here in this chat (for example "el PDF te llega acá mismo"; never "el PDF sigue en esta conversación") only in that case'],
      ['ask the customer to choose again.', 'ask the customer to choose again. When the customer changes or adds items to a selection whose previous quote was without delivery, ask whether it stays without delivery like the previous one before asking for a commune.'],
    ];
    let expected = v19.instructions;
    for (const [from, to] of edits) {
      expect(expected.split(from)).toHaveLength(2);
      expected = expected.replace(from, () => to);
    }
    expect(rest).toBe(expected);
    // Every v19 line survives except the three edited bullets, which keep their prefixes.
    const lines19 = v19.instructions.split('\n');
    const lines20 = rest.split('\n');
    expect(lines20.length).toBe(lines19.length);
    const edited = ['- When the customer chooses one of the shipping.quote', '- catalog.discover: ', '- quote.create: '];
    expect(lines19.filter((l) => !lines20.includes(l)).map((l) => edited.find((p) => l.startsWith(p)))).toEqual(edited);
  });

  it('the voice section is the owner-tested persona verbatim plus only the two added examples', () => {
    const voice = v20.instructions.slice(0, v20.instructions.indexOf(voiceEnd) + voiceEnd.trimEnd().length);
    const added = '\n- En vez de: "Hola, bienvenido a PesasChile. ¿En qué le puedo ayudar el día de hoy?"\n  Mejor: "¡Hola! Soy Don Pesín. ¿Qué andas buscando?"\n- En vez de: "Muchas gracias a usted por contactarnos. Quedo atento a cualquier otra consulta."\n  Mejor: "¡De nada! Cualquier cosa, me escribes por acá."';
    expect(voice.split(added)).toHaveLength(2);
    const persona = voice.replace(added, '');
    expect(persona.split('\n').filter((l) => l.startsWith('- En vez de: '))).toHaveLength(3);
    expect(persona.endsWith('Todas las reglas operativas, de evidencia, autorización y mensajes exactos que siguen están vigentes.')).toBe(true);
  });

  it('every other field equals v19; only version, description and instructions change', () => {
    const { instructions: _a, version, description, ...rest20 } = v20;
    const { instructions: _b, version: _c, description: description19, ...rest19 } = v19;
    expect(version).toBe(20);
    expect(description).not.toBe(description19);
    expect(description).toMatch(/^R4 F1 \(sales-production@20\): definition v19 verbatim/);
    expect(rest20).toEqual(rest19);
  });

  it('v19 is unchanged on disk (the rollback definition)', () => {
    const raw = JSON.parse(readFileSync(join(SALES_AGENT_DIR, 'candidates/sales.v19.candidate.json'), 'utf8')) as { version: number; instructions: string };
    expect(raw.version).toBe(19);
    expect(raw.instructions).toBe(v19.instructions);
    expect(raw.instructions.startsWith('You are the sales advisor of a fitness-equipment store')).toBe(true);
    expect(raw.instructions).toContain('Never call a product the best one.');
  });

  it('is a candidate file: the plain bootstrap never registers it', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@20');
  });
});
