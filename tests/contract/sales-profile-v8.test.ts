import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '@r4/contracts';
import { ActionPolicyEngine } from '@r4/policy-engine';
import { createSilentLogger } from '@r4/observability';
import { availableCapabilities, loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, loadSalesAgentDefinition, type AutonomousQuoteLimitsV6 } from '@r4-sales/agent';
import {
  CANARY_PROFILES,
} from '@r4-sales/agent/canary';
import {
  SALES_DOMAINS,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V7,
  SALES_PRODUCTION_PROFILE_V8,
  SALES_PRODUCTION_PROFILE_V8_GATE,
  SALES_PRODUCTION_V8_ACTION_POLICY,
  SALES_PRODUCTION_V8_CAPABILITY_VERSIONS,
  composeSalesGateway,
  composeSalesProductionWorker,
  salesActionPolicyFor,
  salesProductionAgentVersion,
} from '@r4-sales/agent/production';
import { composeSyntheticCustomerCapabilities, composeSyntheticIdentityVerificationCapabilities } from '../../agents/sales/src/capabilities/customer-synthetic.js';

/**
 * R4-J4-R4 contract: sales-production@8 = @7 plus the Customer reads and the channel identity verification,
 * composed fail-closed, synthetic owners only; @1–@7, definitions v3–v7 and both earlier policies untouched
 * (their fingerprints are pinned in sales-deterministic-offer.test.ts and are re-checked here for @7).
 */
const PINNED = {
  v7: 'dc4d82dc74ef87203d567305c2cf700cf1dc14fd0cb468bcf91fcbe3521a431d',
  autonomousPolicy: '515ce98f81933f2dbbb1bb24530f24b85beea959c44d2cb6caa1c9f34aacdc4a',
  v8: 'f0f7544237d450ccbb441fd7cf902df63d33c849add5fd991dc395070fb218c4',
  v8Policy: '9b710b4b778b4be16954258bae7b41ad68d6f3fbfd1647b37afd591f5867cfa6',
  capabilities: {
    'customer.get_context@3': '9f5389849d3bed251f1ec44c1b611ff96e1d6294ad1e10bbdde6ad977fae05f8',
    'customer.get_purchase_history@2': 'c34dbcdf5243c05fe8cd5199db2f3de21d07d107a4a5bddd8f9bb3978b3177b1',
    'identity.verification_status@1': '05bee05b3ff79db0c756eb41a035c6fee0b696b7c3a63422c809b2c36829bae2',
    'identity.start_verification@1': 'a9f4ec6fceb8d5795d7e3abaf2382d1b311c42cd9d6592a3259f16284675a9d0',
  },
};

const ROOT = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const unused = () => Promise.reject(new Error('unused'));
const store = { readControls: unused, thread: unused, bindingByTask: unused, taskState: unused } as unknown as ProductionStore;
const production = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const V6_LIMITS: AutonomousQuoteLimitsV6 = { maxGrossClp: 250_000, maxLines: 3, maxUnitsPerLine: 5, maxQuotesPerConversation: 1, maxQuotesPerHour: 2, maxTotalUnits: 5, confirmationWindowSeconds: 900 };
/** A complete synthetic worker configuration: loopback owners, synthetic credentials. */
const CUSTOMER_ENV = {
  R4_CUSTOMER_MODE: 'synthetic',
  R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787',
  R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001',
  R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500',
  R4_CUSTOMER_PROFILE_BASE_URL: 'http://127.0.0.1:3010',
  R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij',
  R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
};
const compose = (profile: string, extra: { customer?: { env: Record<string, string | undefined> }; store?: ProductionStore } = {}) =>
  composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: extra.store ?? store,
    production: production(profile),
    modelProvider: { providerId: 'none', invoke: unused },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: V6_LIMITS,
    ...(extra.customer ? { customer: extra.customer } : {}),
  });
const v8 = () => compose('sales-production@8', { customer: { env: CUSTOMER_ENV } });
const capabilityFingerprint = (c: { definition: unknown; recovery?: string }) => fingerprint({ definition: c.definition, recovery: c.recovery ?? null });

describe('A. sales-production@8: @7 plus Customer and identity verification, nothing else', () => {
  it('keeps every @7 domain, the channel and every @7 capability; adds exactly two REAL domains and three capabilities', () => {
    expect(profileFingerprint(SALES_PRODUCTION_PROFILE_V7)).toBe(PINNED.v7);
    expect(profileFingerprint(SALES_PRODUCTION_PROFILE_V8)).toBe(PINNED.v8);
    const { customer: c8, [SALES_DOMAINS.identity]: i8, ...rest8 } = SALES_PRODUCTION_PROFILE_V8.domains;
    const { customer: c7, ...rest7 } = SALES_PRODUCTION_PROFILE_V7.domains;
    expect(rest8).toEqual(rest7);
    expect(c7!.status).toBe('UNAVAILABLE');
    expect([c8!.status, i8!.status]).toEqual(['REAL', 'REAL']);
    expect(c8!.contractRef).toMatch(/customer-sales-context-v1-rc2.*bbd766e/);
    expect(i8!.contractRef).toMatch(/v1-d2.*synthetic interoperability only.*7525395/);
    expect(SALES_PRODUCTION_PROFILE_V8.channel).toEqual(SALES_PRODUCTION_PROFILE_V7.channel);
    expect(SALES_PRODUCTION_PROFILE_V8.capabilities.slice(0, SALES_PRODUCTION_PROFILE_V7.capabilities.length)).toEqual(SALES_PRODUCTION_PROFILE_V7.capabilities);
    expect(SALES_PRODUCTION_PROFILE_V8.capabilities.slice(SALES_PRODUCTION_PROFILE_V7.capabilities.length)).toEqual([
      { capabilityId: 'customer.get_purchase_history', domain: 'customer', effect: 'read' },
      { capabilityId: 'identity.verification_status', domain: 'customer-identity', effect: 'read' },
      { capabilityId: 'identity.start_verification', domain: 'customer-identity', effect: 'write', decision: 'ALLOW' },
    ]);
    expect(SALES_PRODUCTION_PROFILES.map(profileLabel).at(-1)).toBe('sales-production@8');
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V8)).toBe(8);
  });

  it('composes exactly the profile: the @7 capabilities at their @7 versions plus the four pinned versions', () => {
    const { bindings, report } = v8();
    const registered = bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();
    const at7 = compose('sales-production@7').bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`);
    expect(SALES_PRODUCTION_V8_CAPABILITY_VERSIONS).toEqual({ 'customer.get_context': 3, 'customer.get_purchase_history': 2, 'identity.start_verification': 1, 'identity.verification_status': 1 });
    expect(registered).toEqual([...at7, ...Object.entries(SALES_PRODUCTION_V8_CAPABILITY_VERSIONS).map(([id, v]) => `${id}@${v}`)].sort());
    expect(registered.sort()).toEqual(availableCapabilities(SALES_PRODUCTION_PROFILE_V8).map((id) => `${id}@${bindings.capabilities.resolve(id)!.definition.version}`).sort());
    expect(report.domains).toMatchObject({ customer: 'REAL', 'customer-identity': 'REAL' });
    expect(report.writes).toEqual({ allow: [CAPABILITY_IDS.workspaceUpdate, CAPABILITY_IDS.quoteCreate, 'identity.start_verification'], requireApproval: [], deny: [] });
    // The @7 quote path is the same registration: Customer is never one of its dependencies.
    for (const id of [CAPABILITY_IDS.quoteCreate, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, CAPABILITY_IDS.shippingQuote, CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.workspaceUpdate]) {
      expect(capabilityFingerprint(bindings.capabilities.resolve(id)!), id).toBe(capabilityFingerprint(compose('sales-production@7').bindings.capabilities.resolve(id)!));
    }
  });

  it('the four capability definitions are the synthetic compositions\' own, pinned', () => {
    const { bindings } = v8();
    const synthetic = [...composeSyntheticCustomerCapabilities({ env: CUSTOMER_ENV, bindings: store }), ...(({ reads, writes }) => [...reads, ...writes])(composeSyntheticIdentityVerificationCapabilities({ env: CUSTOMER_ENV, bindings: store, pool: {} as never }))];
    expect(Object.fromEntries(synthetic.map((c) => [`${c.definition.capabilityId}@${c.definition.version}`, capabilityFingerprint(c as never)]))).toEqual(PINNED.capabilities);
    // @8 registers exactly these definitions (the registry stores them normalized).
    for (const c of synthetic) expect(bindings.capabilities.resolve(c.definition.capabilityId, c.definition.version)!.definition).toMatchObject(c.definition);
  });
});

describe('B. the @8 action policy: @7 plus the approved OA-05 rule only', () => {
  it('only identity.start_verification is allowed autonomously; every @7 rule and risk class is unchanged', () => {
    expect(new ActionPolicyEngine(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY).identity.hash).toBe(PINNED.autonomousPolicy);
    expect(new ActionPolicyEngine(SALES_PRODUCTION_V8_ACTION_POLICY).identity.hash).toBe(PINNED.v8Policy);
    expect(SALES_PRODUCTION_V8_ACTION_POLICY.riskClasses).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.riskClasses);
    expect(SALES_PRODUCTION_V8_ACTION_POLICY.riskClasses.EXTERNAL_COMMUNICATION).toEqual({ autonomy: 'require_approval' });
    const { ['identity.start_verification']: start, ...others } = SALES_PRODUCTION_V8_ACTION_POLICY.capabilities!;
    expect(start).toEqual({ autonomy: 'allow' });
    expect(others).toEqual(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.capabilities);
    expect(salesActionPolicyFor(SALES_PRODUCTION_PROFILE_V8)).toBe(SALES_PRODUCTION_V8_ACTION_POLICY);
    expect(v8().bindings.actionPolicy).toBe(SALES_PRODUCTION_V8_ACTION_POLICY);
    // @1–@7 keep exactly what they ran.
    expect(compose('sales-production@7').bindings.actionPolicy).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    for (const profile of SALES_PRODUCTION_PROFILES.slice(0, 7)) expect(salesActionPolicyFor(profile)).not.toBe(SALES_PRODUCTION_V8_ACTION_POLICY);
  });
});

describe('C. fail-closed worker composition (each missing dependency refuses)', () => {
  it.each<[string, Parameters<typeof compose>[1], RegExp]>([
    ['no Customer configuration', {}, /no R4_CUSTOMER_\* configuration was provided/],
    ['no mode', { customer: { env: { ...CUSTOMER_ENV, R4_CUSTOMER_MODE: undefined } } }, /cannot compose Customer and identity verification/],
    ['real mode', { customer: { env: { ...CUSTOMER_ENV, R4_CUSTOMER_MODE: 'real' } } }, /R4_CUSTOMER_MODE=real is refused/],
    ['no CIA', { customer: { env: { ...CUSTOMER_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: undefined } } }, /missing R4_CUSTOMER_IDENTITY_BASE_URL/],
    ['no Customer Profile', { customer: { env: { ...CUSTOMER_ENV, R4_CUSTOMER_PROFILE_BASE_URL: undefined } } }, /missing R4_CUSTOMER_PROFILE_BASE_URL/],
    ['a non-loopback CIA', { customer: { env: { ...CUSTOMER_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'https://cia.pesaschile.cl' } } }, /loopback only/],
    ['a non-loopback Customer Profile', { customer: { env: { ...CUSTOMER_ENV, R4_CUSTOMER_PROFILE_BASE_URL: 'https://customer-profile.pesaschile.cl' } } }, /non-local Customer Profile URL/],
    ['a non-synthetic CIA credential', { customer: { env: { ...CUSTOMER_ENV, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'prod-r4-sales-agent-token-000000000001' } } }, /must be a synthetic credential/],
    ['a non-synthetic Customer Profile credential', { customer: { env: { ...CUSTOMER_ENV, R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'prod-r4-sales-cp-token-0123456789abcdefghijklmnop' } } }, /non-synthetic Customer Profile credential/],
    ['the gateway confirm credential in the worker', { customer: { env: { ...CUSTOMER_ENV, R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'synthetic-channel-confirm-0001' } } }, /must not receive R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN/],
    ['the gateway code keyring in the worker', { customer: { env: { ...CUSTOMER_ENV, R4_PROD_VERIFICATION_CODE_KEYS: 'k1:AAAA' } } }, /must not receive R4_PROD_VERIFICATION_CODE_KEYS/],
    ['no bindingByTask', { customer: { env: CUSTOMER_ENV }, store: { ...store, bindingByTask: undefined } as never }, /without bindings/],
    ['no taskState', { customer: { env: CUSTOMER_ENV }, store: { ...store, taskState: undefined } as never }, /without (bindings|taskState)/],
    ['no thread', { customer: { env: CUSTOMER_ENV }, store: { ...store, thread: undefined } as never }, /without bindings/],
  ])('refuses %s', (_name, extra, message) => {
    expect(() => compose('sales-production@8', extra)).toThrow(/refusing production composition: sales-production@8/);
    expect(() => compose('sales-production@8', extra)).toThrow(message);
  });

  it('@1–@7 never compose Customer or identity, with or without a Customer configuration', () => {
    for (const profile of SALES_PRODUCTION_PROFILES.slice(0, 7)) {
      expect(profile.domains.customer?.status, profileLabel(profile)).toBe('UNAVAILABLE');
      expect(Object.keys(profile.domains), profileLabel(profile)).not.toContain(SALES_DOMAINS.identity);
    }
    const at7 = compose('sales-production@7', { customer: { env: CUSTOMER_ENV } }).bindings.capabilities.list().map((c) => c.capabilityId);
    expect(at7.filter((id) => /^customer\.|^identity\./.test(id))).toEqual([]);
  });

  it('the worker composition never composes the gateway inspection; the CLI checks the identity-verification schema before running @8', () => {
    const cli = source('agents/sales/src/cli/production.ts');
    expect(cli.match(/await assertSalesProductionPrerequisites\(selectedSalesProductionProfile\(production\.config\), pool\);/g)).toHaveLength(2);
    expect(source('agents/sales/src/production/composition.ts')).toMatch(/if \(!\(await identityVerificationSchemaIsCurrent\(pool\)\)\) throw/);
  });
});

describe('D. fail-closed gateway composition: @8 never runs without the inspector in full', () => {
  const GATEWAY_ENV = {
    R4_WHATSAPP_APP_SECRET: 'app-secret-test-0001', R4_WHATSAPP_VERIFY_TOKEN: 'verify-token-test-0001', R4_WHATSAPP_ACCESS_TOKEN: 'access-token-test-0001',
    R4_WHATSAPP_PHONE_NUMBER_ID: '100000000000001', R4_WHATSAPP_GRAPH_BASE_URL: 'http://127.0.0.1:9',
    R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787', R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'synthetic-channel-confirm-token-0001',
    R4_PROD_VERIFICATION_CODE_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  };
  const gateway = (profile: string, env: Record<string, string | undefined>) => composeSalesGateway({ pool: {} as never, production: production(profile), env });

  it('composes the inspection factory with a complete gateway configuration', () => {
    expect(typeof gateway('sales-production@8', GATEWAY_ENV).bindings.inspection).toBe('function');
  });

  it.each<[string, Record<string, string | undefined>, RegExp]>([
    ['no code keyring', { ...GATEWAY_ENV, R4_PROD_VERIFICATION_CODE_KEYS: undefined }, /requires the inbound inspector in full but R4_PROD_VERIFICATION_CODE_KEYS is not set/],
    ['no confirm credential', { ...GATEWAY_ENV, R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: undefined }, /requires the CIA confirm client/],
    ['real mode', { ...GATEWAY_ENV, R4_CUSTOMER_MODE: 'real' }, /R4_CUSTOMER_MODE=real is refused/],
    ['a non-loopback CIA', { ...GATEWAY_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'https://cia.pesaschile.cl' }, /loopback only/],
  ])('refuses %s', (_name, env, message) => {
    expect(() => gateway('sales-production@8', env)).toThrow(message);
  });

  it('@7 gateways compose no inspection (exactly R4-I)', () => {
    expect(gateway('sales-production@7', GATEWAY_ENV).bindings.inspection).toBeUndefined();
  });
});

describe('E. definition v8 and what stays out of scope', () => {
  it('v8 is v7 plus one scope and the usage rules of the four capabilities; same agent, budgets and model requirements', () => {
    const { version: n7, description: d7, instructions: i7, capabilityScopes: s7, ...rest7 } = loadSalesAgentDefinition(7);
    const { version: n8, description: d8, instructions: i8, capabilityScopes: s8, ...rest8 } = loadSalesAgentDefinition(8);
    expect([n7, n8]).toEqual([7, 8]);
    expect(rest8).toEqual(rest7);
    expect(s8).toEqual([...s7, 'identity.verify']);
    expect(d8).not.toBe(d7);
    const lines = (text: string) => new Set(text.split('\n'));
    const removed = [...lines(i7)].filter((l) => !lines(i8).has(l));
    const added = [...lines(i8)].filter((l) => !lines(i7).has(l));
    expect(removed).toEqual(['- customer.get_context: when knowing the customer helps. The customer may be anonymous; that never blocks exploring products.']);
    expect(added.map((l) => l.slice(0, 40))).toEqual(['- customer.get_context, customer.get_pur', '- identity.start_verification, identity.']);
    expect(added.join('\n')).toMatch(/never require verification to explore or to quote/);
    expect(added.join('\n')).toMatch(/Never write, repeat or guess a verification code/);
  });

  it('the isolated canary tooling is unchanged (J4-R5 not started): it accepts @4–@7 only', () => {
    expect(CANARY_PROFILES.map(profileLabel)).toEqual(['sales-production@4', 'sales-production@5', 'sales-production@6', 'sales-production@7']);
  });

  it('the deployment gate is complete and blocking; real data stays J7', () => {
    expect(SALES_PRODUCTION_PROFILE_V8_GATE.every((g) => g.blocking)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V8_GATE.map((g) => g.id)).toEqual(['v7-gate', 'j4-r4-review', 'identity-migrations', 'gateway-inspector-full', 'binding-immutability', 'deployed-synthetic-owners', 'canary-evidence-policy', 'real-data', 'explicit-authorization']);
  });
});
