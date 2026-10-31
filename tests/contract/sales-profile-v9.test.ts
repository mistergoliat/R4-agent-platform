import { describe, expect, it } from 'vitest';
import { definitionContentHash } from '@r4/agent-registry';
import { fingerprint } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import { SALES_AGENT_DEFINITION_FILES, SALES_AGENT_LATEST_VERSION, loadSalesAgentDefinition, type AutonomousQuoteLimitsV6, type SalesAgentDefinitionVersion } from '@r4-sales/agent';
import { CANARY_PROFILES, loadCanaryEnvironment } from '@r4-sales/agent/canary';
import {
  SALES_PRODUCTION_AGENT_VERSIONS,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V8,
  SALES_PRODUCTION_PROFILE_V9,
  SALES_PRODUCTION_PROFILE_V9_GATE,
  SALES_PRODUCTION_V8_ACTION_POLICY,
  composeSalesGateway,
  composeSalesProductionWorker,
  isAutonomousQuoteProfile,
  isConfirmedIntentProfile,
  isCustomerIdentityProfile,
  isDeterministicOfferProfile,
  salesActionPolicyFor,
  salesProductionAgentVersion,
} from '@r4-sales/agent/production';

/**
 * R4-J5 contract: sales-production@9 = sales-production@8 in every respect except the definition it runs
 * (v9 = v8 plus the guidance of the authorized Despacho Directo $1 shipping promotion, decided by Shipping).
 * @1–@8 and definitions v3–v8 are pinned byte-for-byte; nothing selects @9 in production.
 */
const PINNED = {
  profiles: {
    'sales-production@1': 'bd30523fba7cd17b2996af8205862e30c6756b4efb812777d00c2a5f9f84d313',
    'sales-production@2': '2430a3e05c384a61a581707a2d397bcf64a72a703e7e08abbc713535988da3a8',
    'sales-production@3': '847aa0efda66782e393305d62370b8ab130189d949b4622ca6449da0072a8d95',
    'sales-production@4': 'c905ca763b12ca55176788fc7c72ae0fe157e4cb3d569da4a2a85b3167f8c66b',
    'sales-production@5': 'a043636e3b9dbbc76fb654c180614ad4dbeadbe0fdb138af920a8ff571ee6918',
    'sales-production@6': '5ce5f37185b95f17e5a8ac9d0aefee761fcadbc5b50353753893591ec520cbbb',
    'sales-production@7': 'dc4d82dc74ef87203d567305c2cf700cf1dc14fd0cb468bcf91fcbe3521a431d',
    'sales-production@8': 'f0f7544237d450ccbb441fd7cf902df63d33c849add5fd991dc395070fb218c4',
    'sales-production@9': 'f2858bcc0366280e10682e222e5e2ba45fff48044c644fc42063cd8467ea20a7',
  },
  definitions: {
    3: '44b5b0935c0c20d0304cc7c41a873e8b31252bce8a3c3df3bce8b64247db462a',
    4: 'c91f0e9da593a30cec1c0294f368cb3f922f2c8a261403e57acf47371aa3f020',
    5: '003402e257966e748f25737d59537c69da7729b41a0aef57b9cc603572fc2473',
    6: '2499d50f9297a44f1e3850ba60e4ef8f8a205f95261c8dcdee5dae43312eeff6',
    7: '1d593691a0308e47de55f3b35763be856a318e2b015600805f94141ae5c465e1',
    8: '1065b99836be5f66db05078e72b654531b30e8ae74400dcd7522e648d488e861',
    9: '83060ff0dce4417f154c39ee41265f605ddf67a41019320657a206770a5ee229',
  },
} as const;

const unused = () => Promise.reject(new Error('unused'));
const store = { readControls: unused, thread: unused, bindingByTask: unused, taskState: unused } as unknown as ProductionStore;
const production = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const V6_LIMITS: AutonomousQuoteLimitsV6 = { maxGrossClp: 250_000, maxLines: 3, maxUnitsPerLine: 5, maxQuotesPerConversation: 1, maxQuotesPerHour: 2, maxTotalUnits: 5, confirmationWindowSeconds: 900 };
const CUSTOMER_ENV = {
  R4_CUSTOMER_MODE: 'synthetic',
  R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787',
  R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001',
  R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500',
  R4_CUSTOMER_PROFILE_BASE_URL: 'http://127.0.0.1:3010',
  R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij',
  R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
};
const compose = (profile: string, customer: boolean = true) =>
  composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store,
    production: production(profile),
    modelProvider: { providerId: 'none', invoke: unused },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: V6_LIMITS,
    ...(customer ? { customer: { env: CUSTOMER_ENV } } : {}),
  });
const registered = (profile: string) =>
  Object.fromEntries(compose(profile).bindings.capabilities.list().map((c) => [`${c.capabilityId}@${c.version}`, fingerprint({ definition: compose(profile).bindings.capabilities.resolve(c.capabilityId, c.version)!.definition })]));

describe('A. sales-production@9 is @8 except the definition version', () => {
  it('@1–@8 fingerprints are unchanged and @9 is pinned', () => {
    expect(Object.fromEntries(SALES_PRODUCTION_PROFILES.map((p) => [profileLabel(p), profileFingerprint(p)]))).toEqual(PINNED.profiles);
  });

  it('every field of the profile but version and description is @8\'s own value', () => {
    const { version: v9, description: d9, ...rest9 } = SALES_PRODUCTION_PROFILE_V9;
    const { version: v8, description: d8, ...rest8 } = SALES_PRODUCTION_PROFILE_V8;
    expect([v8, v9]).toEqual([8, 9]);
    expect(rest9).toEqual(rest8);
    expect(d9).not.toBe(d8);
    expect(Object.isFrozen(SALES_PRODUCTION_PROFILE_V9)).toBe(true);
  });

  it('pins definition v9 for @9 and leaves every earlier pin as it was', () => {
    expect(SALES_PRODUCTION_AGENT_VERSIONS).toEqual({ 'sales-production@1': 3, 'sales-production@2': 3, 'sales-production@3': 4, 'sales-production@4': 4, 'sales-production@5': 5, 'sales-production@6': 6, 'sales-production@7': 7, 'sales-production@8': 8, 'sales-production@9': 9 });
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V9)).toBe(9);
    expect(SALES_PRODUCTION_PROFILES.map(profileLabel).at(-1)).toBe('sales-production@9');
  });

  it('runs exactly @8\'s composition: same capabilities and versions, same definitions, same policy and report', () => {
    for (const is of [isAutonomousQuoteProfile, isConfirmedIntentProfile, isDeterministicOfferProfile, isCustomerIdentityProfile]) expect(is(SALES_PRODUCTION_PROFILE_V9), is.name).toBe(true);
    expect(registered('sales-production@9')).toEqual(registered('sales-production@8'));
    expect(salesActionPolicyFor(SALES_PRODUCTION_PROFILE_V9)).toBe(SALES_PRODUCTION_V8_ACTION_POLICY);
    const [at8, at9] = [compose('sales-production@8'), compose('sales-production@9')];
    expect(at9.bindings.actionPolicy).toBe(at8.bindings.actionPolicy);
    expect(at9.report.profileFingerprint).toBe(PINNED.profiles['sales-production@9']);
    expect({ ...at9.report, profile: null, profileFingerprint: null }).toEqual({ ...at8.report, profile: null, profileFingerprint: null });
    // Fail-closed like @8: no Customer configuration refuses.
    expect(() => compose('sales-production@9', false)).toThrow(/refusing production composition: sales-production@9.*no R4_CUSTOMER_\* configuration/s);
  });

  it('the gateway composes the @8 inbound inspector for @9 too', () => {
    const env = {
      R4_WHATSAPP_APP_SECRET: 'app-secret-test-0001', R4_WHATSAPP_VERIFY_TOKEN: 'verify-token-test-0001', R4_WHATSAPP_ACCESS_TOKEN: 'access-token-test-0001',
      R4_WHATSAPP_PHONE_NUMBER_ID: '100000000000001', R4_WHATSAPP_GRAPH_BASE_URL: 'http://127.0.0.1:9',
      R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787', R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'synthetic-channel-confirm-token-0001',
      R4_PROD_VERIFICATION_CODE_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    };
    expect(typeof composeSalesGateway({ pool: {} as never, production: production('sales-production@9'), env }).bindings.inspection).toBe('function');
  });
});

describe('B. definition v9: v8 plus the promotion guidance, nothing else', () => {
  it('v3–v8 are byte-for-byte unchanged; v9 is registered, pinned and not the non-production default', () => {
    expect(SALES_AGENT_DEFINITION_FILES).toEqual({ 3: 'sales.agent.json', 4: 'sales.v4.agent.json', 5: 'sales.v5.agent.json', 6: 'sales.v6.agent.json', 7: 'sales.v7.agent.json', 8: 'sales.v8.agent.json', 9: 'sales.v9.agent.json' });
    const versions = Object.keys(PINNED.definitions).map(Number) as SalesAgentDefinitionVersion[];
    expect(Object.fromEntries(versions.map((v) => [v, definitionContentHash(loadSalesAgentDefinition(v))]))).toEqual(PINNED.definitions);
    expect(SALES_AGENT_LATEST_VERSION).toBe(4);
  });

  it('only the version, description and one instruction line differ from v8', () => {
    const { version: n8, description: d8, instructions: i8, ...rest8 } = loadSalesAgentDefinition(8);
    const { version: n9, description: d9, instructions: i9, ...rest9 } = loadSalesAgentDefinition(9);
    expect([n8, n9]).toEqual([8, 9]);
    expect(rest9).toEqual(rest8);
    expect(d9).not.toBe(d8);
    expect(d9).toMatch(/Shipping owner decides/);
    const l8 = i8.split('\n');
    const l9 = i9.split('\n');
    const at = l9.findIndex((l) => l.startsWith('- Despacho Directo promotion:'));
    expect(l9[at - 1]).toMatch(/^- shipping\.quote:/);
    expect([...l9.slice(0, at), ...l9.slice(at + 1)]).toEqual(l8);
  });

  it('the guidance explains the promotion, defers eligibility and price to Shipping and forbids promising them', () => {
    const line = loadSalesAgentDefinition(9).instructions.split('\n').find((l) => l.startsWith('- Despacho Directo promotion:'))!;
    for (const required of [
      /"Pesas Chile — Despacho Directo" at \$1 is an authorized store promotion, not a pricing error and not free shipping/,
      /CLP 120\.000 to CLP 499\.990/,
      /selected communes of the Región Metropolitana de Santiago/,
      /the Shipping owner holds the exact rule and the commune list, and alone decides whether an order qualifies/,
      /exists only when a current shipping\.quote \(basis=order\) for that selection and commune returns it/,
      /state its price exactly as returned \(\$1; never \$0, "free" or another amount\)/,
      /never promise or imply that an order qualifies, never state \$1 as the price of their delivery, and never decide eligibility yourself/,
      /If shipping\.quote fails or serviceable=false there is no shipping price: never fall back on the promotion or any amount/,
      /The quote carries exactly the Shipping amount of the chosen offer/,
    ]) expect(line).toMatch(required);
  });
});

describe('C. rollout: canary-ready, gated, selected by nothing', () => {
  const canaryEnv = (extra: Record<string, string> = {}) => ({
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@9', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false',
    R4_CANARY_DATABASE_URL: 'postgres://u:p@127.0.0.1:55432/r4_canary_j5', R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '250000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5',
    R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '1', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '2', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '5', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900', ...extra,
  });

  it('the isolated canary accepts @9 under the @8 rules (expired evidence excluded)', () => {
    expect(CANARY_PROFILES.map(profileLabel)).toEqual(['sales-production@4', 'sales-production@5', 'sales-production@6', 'sales-production@7', 'sales-production@8', 'sales-production@9']);
    expect(() => loadCanaryEnvironment(canaryEnv())).toThrow(/R4_CANARY_CONTEXT_EXPIRED_EVIDENCE=exclude/);
    expect(loadCanaryEnvironment(canaryEnv({ R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'exclude' }))).toMatchObject({ profile: SALES_PRODUCTION_PROFILE_V9, contextExpiredEvidence: 'exclude' });
  });

  it('the deployment gate is blocking and names the open promotion terms, the real-model check and the canary', () => {
    expect(SALES_PRODUCTION_PROFILE_V9_GATE.every((g) => g.blocking)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V9_GATE.map((g) => g.id)).toEqual(['v8-gate', 'j5-review', 'promotion-terms', 'real-model-compatibility', 'canary-evidence', 'explicit-authorization']);
  });
});
