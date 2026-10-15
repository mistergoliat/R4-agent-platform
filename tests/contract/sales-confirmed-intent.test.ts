import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ActionPolicyEngine } from '@r4/policy-engine';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import {
  AUTONOMOUS_QUOTE_CAPABILITY_IDS,
  AUTONOMOUS_QUOTE_LIMIT_ENV,
  AUTONOMOUS_QUOTE_LIMIT_ENV_V6,
  CAPABILITY_IDS,
  loadAutonomousQuoteLimitsV6,
  loadSalesAgentDefinition,
  type AutonomousQuoteLimits,
  type AutonomousQuoteLimitsV6,
} from '@r4-sales/agent';
import {
  SALES_PRODUCTION_ACTION_POLICY,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILE,
  SALES_PRODUCTION_PROFILE_V2_CANDIDATE,
  SALES_PRODUCTION_PROFILE_V3,
  SALES_PRODUCTION_PROFILE_V4,
  SALES_PRODUCTION_PROFILE_V5,
  SALES_PRODUCTION_PROFILE_V6,
  SALES_PRODUCTION_PROFILES,
  composeSalesProductionWorker,
  salesProductionAgentVersion,
} from '@r4-sales/agent/production';

/**
 * R4-J3E-B contract: sales-production@6 adds issuance on the customer's own
 * confirmation WITHOUT touching anything earlier. @1–@5 fingerprints and both
 * policy hashes are pinned to their values at J3E (`cc1e6c3`); @5 keeps
 * quote.create@3, quote.preview@1 and its five limits.
 */
const PINNED = {
  v1: 'bd30523fba7cd17b2996af8205862e30c6756b4efb812777d00c2a5f9f84d313',
  v2: '2430a3e05c384a61a581707a2d397bcf64a72a703e7e08abbc713535988da3a8',
  v3: '847aa0efda66782e393305d62370b8ab130189d949b4622ca6449da0072a8d95',
  v4: 'c905ca763b12ca55176788fc7c72ae0fe157e4cb3d569da4a2a85b3167f8c66b',
  v5: 'a043636e3b9dbbc76fb654c180614ad4dbeadbe0fdb138af920a8ff571ee6918',
  productionPolicy: '5dbbd0f2dbfbd2fedab45abd3d4cb204a966500c76383cd00e16d038bf3ecb9a',
  autonomousPolicy: '515ce98f81933f2dbbb1bb24530f24b85beea959c44d2cb6caa1c9f34aacdc4a',
};

const ROOT = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const V5_LIMITS: AutonomousQuoteLimits = { maxGrossClp: 250_000, maxLines: 3, maxUnitsPerLine: 5, maxQuotesPerConversation: 1, maxQuotesPerHour: 2 };
const V6_LIMITS: AutonomousQuoteLimitsV6 = { ...V5_LIMITS, maxTotalUnits: 5, confirmationWindowSeconds: 900 };
const compose = (profile: string, limits?: AutonomousQuoteLimits | AutonomousQuoteLimitsV6) =>
  composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: noStore,
    production: env(profile),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    ...(limits ? { autonomousQuoteLimits: limits } : {}),
  });

describe('A. earlier profiles and versions are unchanged', () => {
  it('@1–@5 fingerprints and both policy hashes equal J3E', () => {
    expect([SALES_PRODUCTION_PROFILE, SALES_PRODUCTION_PROFILE_V2_CANDIDATE, SALES_PRODUCTION_PROFILE_V3, SALES_PRODUCTION_PROFILE_V4, SALES_PRODUCTION_PROFILE_V5].map(profileFingerprint)).toEqual([PINNED.v1, PINNED.v2, PINNED.v3, PINNED.v4, PINNED.v5]);
    expect(new ActionPolicyEngine(SALES_PRODUCTION_ACTION_POLICY).identity.hash).toBe(PINNED.productionPolicy);
    expect(new ActionPolicyEngine(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY).identity.hash).toBe(PINNED.autonomousPolicy);
  });

  it('@5 still composes quote.create@3 and quote.preview@1 with exactly its five limits; @4 keeps quote.create@2 with approval', () => {
    const v5 = compose('sales-production@5', V5_LIMITS);
    expect(v5.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate)!.definition.version).toBe(3);
    expect(v5.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate, 4)).toBeUndefined();
    expect(v5.bindings.capabilities.resolve(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)!.definition.version).toBe(1);
    expect(Object.keys(AUTONOMOUS_QUOTE_LIMIT_ENV).sort()).toEqual(['maxGrossClp', 'maxLines', 'maxQuotesPerConversation', 'maxQuotesPerHour', 'maxUnitsPerLine']);
    const v4 = compose('sales-production@4');
    expect(v4.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate)!.definition).toMatchObject({ version: 2, approvalPolicy: 'required' });
    expect(v4.bindings.actionPolicy).toBe(SALES_PRODUCTION_ACTION_POLICY);
  });
});

describe('B. sales-production@6', () => {
  it('is @5 with the same domains, channel, capability list and policy; it runs Sales definition v6', () => {
    const { quote, ...rest } = SALES_PRODUCTION_PROFILE_V6.domains;
    const { quote: v5Quote, ...v5Rest } = SALES_PRODUCTION_PROFILE_V5.domains;
    expect(rest).toEqual(v5Rest);
    expect(quote).toMatchObject({ status: 'REAL', contractRef: v5Quote!.contractRef });
    expect(SALES_PRODUCTION_PROFILE_V6.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V5.capabilities);
    expect(SALES_PRODUCTION_PROFILE_V6.channel).toEqual(SALES_PRODUCTION_PROFILE_V5.channel);
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V6)).toBe(6);
    expect(SALES_PRODUCTION_PROFILES.map(profileLabel)).toEqual(['sales-production@1', 'sales-production@2', 'sales-production@3', 'sales-production@4', 'sales-production@5', 'sales-production@6', 'sales-production@7']);
    expect(new Set([...Object.values(PINNED).slice(0, 5), profileFingerprint(SALES_PRODUCTION_PROFILE_V6)]).size).toBe(6);
  });

  it('composes quote.create@4 and quote.preview@2 only with the extended limits, under the autonomous policy', () => {
    expect(() => compose('sales-production@6')).toThrow(/no autonomous quote limits were configured/);
    expect(() => compose('sales-production@6', V5_LIMITS)).toThrow(/needs the total-units limit and the confirmation window/);
    const v6 = compose('sales-production@6', V6_LIMITS);
    const registry = v6.bindings.capabilities;
    expect(registry.resolve(CAPABILITY_IDS.quoteCreate)!.definition).toMatchObject({ version: 4, riskClass: 'IRREVERSIBLE_WRITE', approvalPolicy: 'none', idempotency: 'key_required', writeRecovery: 'reconcile_before_retry' });
    expect(registry.resolve(CAPABILITY_IDS.quoteCreate, 3)).toBeUndefined();
    expect(registry.resolve(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)!.definition).toMatchObject({ version: 2, riskClass: 'READ' });
    expect(registry.resolve(CAPABILITY_IDS.workspaceUpdate)!.definition.version).toBe(2);
    expect(v6.bindings.actionPolicy).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(v6.report.writes).toEqual({ allow: [CAPABILITY_IDS.workspaceUpdate, CAPABILITY_IDS.quoteCreate], requireApproval: [], deny: [] });
  });

  it('the total-units limit and the confirmation window are required configuration with no default', () => {
    const full = Object.fromEntries(Object.entries(AUTONOMOUS_QUOTE_LIMIT_ENV_V6).map(([field, name]) => [name, String(V6_LIMITS[field as keyof AutonomousQuoteLimitsV6])]));
    expect(loadAutonomousQuoteLimitsV6(full)).toEqual(V6_LIMITS);
    for (const name of [AUTONOMOUS_QUOTE_LIMIT_ENV_V6.maxTotalUnits, AUTONOMOUS_QUOTE_LIMIT_ENV_V6.confirmationWindowSeconds]) {
      expect(() => loadAutonomousQuoteLimitsV6({ ...full, [name]: undefined }), name).toThrow(new RegExp(`${name} is required`));
    }
    expect(() => loadAutonomousQuoteLimitsV6({ ...full, R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '5' })).toThrow(/30\.\.86400/);
  });

  it('definition v6: same agent, scopes and budgets as v5; no recorded quote request; the offer reference is presented', () => {
    const { description: d5, instructions: _i5, version: v5, ...rest5 } = loadSalesAgentDefinition(5);
    const { description: d6, instructions: i6, version: v6, ...rest6 } = loadSalesAgentDefinition(6);
    expect([v5, v6]).toEqual([5, 6]);
    expect(rest6).toEqual(rest5);
    expect(d6).not.toBe(d5);
    expect(i6).toMatch(/presentation\.reference/);
    expect(i6).toMatch(/Do not use record_quote_request/);
    expect(i6).toMatch(/never claim or record it yourself/);
  });
});

describe('C. boundaries of the confirmation evidence', () => {
  const files = ['quote-v4', 'confirmation-grammar', 'offer-presentation'].map((f) => `agents/sales/src/capabilities/${f}.ts`);

  it('reads the conversation only through the structural thread port: no runtime package, no SQL on Core tables, no channel or email', () => {
    for (const file of files) {
      const code = source(file);
      const runtime = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]!).filter((m) => m.startsWith('@r4/'));
      expect(runtime.every((m) => m === '@r4/capability-runtime'), file).toBe(true);
      expect(code, file).not.toMatch(/task_inputs|memory_entries|outbound_messages|agent_run_steps|\.query\(|whatsapp|gmail|deliveries/i);
    }
    expect(source('agents/sales/src/production/composition.ts')).toMatch(/quoteCreateV4Capability\(\{[^}]*conversation: options\.store/);
  });

  it('the confirming message comes from the thread, never from capability input', () => {
    const v4 = source('agents/sales/src/capabilities/quote-v4.ts');
    expect(v4).toMatch(/import \{ quoteCreateV3Input, type QuoteCreateV3Input \} from '\.\/quote-v3\.js'/);
    expect(v4).toMatch(/deps\.conversation\.thread\(taskId\)/);
    expect(v4).not.toMatch(/quoteRequest\b.*customerWords/);
  });

  it('Sales stores no customer text for the evidence (0009 has hashes and ids only)', () => {
    const migration = source('agents/sales/migrations/0009_sales_quote_intent_evidence.sql');
    const columns = [...migration.matchAll(/^\s{2}([a-z0-9_]+)\s/gm)].map((m) => m[1]);
    expect(columns).toContain('confirmation_text_sha256');
    expect(columns.filter((c) => /text$|words|body|message/.test(c!))).toEqual([]);
    expect(migration).toMatch(/confirmation_input_id\s+uuid not null unique/);
  });
});
