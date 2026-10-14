import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '@r4/contracts';
import { ActionPolicyEngine } from '@r4/policy-engine';
import { createSilentLogger } from '@r4/observability';
import { AutonomyControls, guardProductionWrites, loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, QUOTE_V2_NOT_FOUND_FINAL_AFTER_MS, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import { QuoteV2HttpClient, type QuoteFetch } from '@r4-adapters/quote-http';
import {
  AUTONOMOUS_QUOTE_CAPABILITY_IDS,
  CAPABILITY_IDS,
  loadSalesAgentDefinition,
  quoteCreateV2Capability,
  quoteCreateV3Capability,
  quoteCreateV4Capability,
  quotePreviewCapability,
  quotePreviewV2Capability,
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
  SALES_PRODUCTION_PROFILE_V7,
  SALES_PRODUCTION_PROFILES,
  composeSalesProductionWorker,
  killSwitchGuardedQuotes,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
} from '@r4-sales/agent/production';

/**
 * R4-J3E-C1 contract: sales-production@7 (deterministic offer, strict
 * settlement, kill-switch write guard) WITHOUT touching anything earlier.
 * Every pinned value below was computed on `main` 092715e (a temporary
 * worktree build) and is identical on this branch.
 */
const PINNED = {
  profiles: {
    v1: 'bd30523fba7cd17b2996af8205862e30c6756b4efb812777d00c2a5f9f84d313',
    v2: '2430a3e05c384a61a581707a2d397bcf64a72a703e7e08abbc713535988da3a8',
    v3: '847aa0efda66782e393305d62370b8ab130189d949b4622ca6449da0072a8d95',
    v4: 'c905ca763b12ca55176788fc7c72ae0fe157e4cb3d569da4a2a85b3167f8c66b',
    v5: 'a043636e3b9dbbc76fb654c180614ad4dbeadbe0fdb138af920a8ff571ee6918',
    v6: '5ce5f37185b95f17e5a8ac9d0aefee761fcadbc5b50353753893591ec520cbbb',
  },
  v7: 'dc4d82dc74ef87203d567305c2cf700cf1dc14fd0cb468bcf91fcbe3521a431d',
  productionPolicy: '5dbbd0f2dbfbd2fedab45abd3d4cb204a966500c76383cd00e16d038bf3ecb9a',
  autonomousPolicy: '515ce98f81933f2dbbb1bb24530f24b85beea959c44d2cb6caa1c9f34aacdc4a',
  capabilities: {
    'quote.create@2': 'f147e3b27002df58b01489995312391cee160c22b27af19a4b9b5a333a8bf7ef',
    'quote.create@3': 'f33b98c7e95b6116940eb38e4e2f9de5ec42fa88e9efc598afcf1e798a22e4c1',
    'quote.create@4': 'b7e144e9ad1b8d9aa3ab2aef2f06907f4bdc1f5579ab11a73d8d45ef944e58dd',
    'quote.preview@1': '44d28bae88873d84ce753bf73d7419130421a9320eebbc68894db2f82db08156',
    'quote.preview@2': '3ab91fae92941d4275c647ab5e7bf27a40c5471306e135cecf0142d9da308b94',
  },
};

const ROOT = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const V6_LIMITS: AutonomousQuoteLimitsV6 = { maxGrossClp: 250_000, maxLines: 3, maxUnitsPerLine: 5, maxQuotesPerConversation: 1, maxQuotesPerHour: 2, maxTotalUnits: 5, confirmationWindowSeconds: 900 };
const compose = (profile: string, limits?: AutonomousQuoteLimitsV6) =>
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

describe('A. earlier profiles, policies and capability versions are unchanged', () => {
  it('@1–@6 fingerprints and both policy hashes equal main', () => {
    expect([SALES_PRODUCTION_PROFILE, SALES_PRODUCTION_PROFILE_V2_CANDIDATE, SALES_PRODUCTION_PROFILE_V3, SALES_PRODUCTION_PROFILE_V4, SALES_PRODUCTION_PROFILE_V5, SALES_PRODUCTION_PROFILE_V6].map(profileFingerprint)).toEqual(Object.values(PINNED.profiles));
    expect(new ActionPolicyEngine(SALES_PRODUCTION_ACTION_POLICY).identity.hash).toBe(PINNED.productionPolicy);
    expect(new ActionPolicyEngine(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY).identity.hash).toBe(PINNED.autonomousPolicy);
  });

  it('quote.create@2/@3/@4 and quote.preview@1/@2 definitions equal main', () => {
    const d = {} as never;
    const caps = {
      'quote.create@2': quoteCreateV2Capability(d),
      'quote.create@3': quoteCreateV3Capability({ ...(d as object), limits: V6_LIMITS } as never),
      'quote.create@4': quoteCreateV4Capability({ ...(d as object), limits: V6_LIMITS, conversation: {} } as never),
      'quote.preview@1': quotePreviewCapability({ ...(d as object), limits: V6_LIMITS } as never),
      'quote.preview@2': quotePreviewV2Capability({ ...(d as object), limits: V6_LIMITS } as never),
    };
    expect(Object.fromEntries(Object.entries(caps).map(([k, c]) => [k, fingerprint({ definition: c.definition, recovery: (c as { recovery?: string }).recovery ?? null })]))).toEqual(PINNED.capabilities);
  });

  it('@6 still composes quote.create@4 and quote.preview@2 over the unguarded Quote port', () => {
    const v6 = compose('sales-production@6', V6_LIMITS);
    expect(v6.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate)!.definition.version).toBe(4);
    expect(v6.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate, 5)).toBeUndefined();
    expect(v6.bindings.capabilities.resolve(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)!.definition.version).toBe(2);
    expect(source('agents/sales/src/production/composition.ts')).toMatch(/quoteCreateV4Capability\(\{ store: sales, quotes: options\.quotes,/);
  });
});

describe('B. sales-production@7', () => {
  it('is @6 with the same domains (but the quote note), channel, capability list, policy and limits; it runs definition v7', () => {
    const { quote, ...rest } = SALES_PRODUCTION_PROFILE_V7.domains;
    const { quote: v6Quote, ...v6Rest } = SALES_PRODUCTION_PROFILE_V6.domains;
    expect(rest).toEqual(v6Rest);
    expect(quote).toMatchObject({ status: 'REAL', contractRef: v6Quote!.contractRef });
    expect(SALES_PRODUCTION_PROFILE_V7.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V6.capabilities);
    expect(SALES_PRODUCTION_PROFILE_V7.channel).toEqual(SALES_PRODUCTION_PROFILE_V6.channel);
    expect(profileFingerprint(SALES_PRODUCTION_PROFILE_V7)).toBe(PINNED.v7);
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V7)).toBe(7);
    expect(salesProductionActionPolicy(SALES_PRODUCTION_PROFILE_V7)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(SALES_PRODUCTION_PROFILES.map(profileLabel)).toEqual(['sales-production@1', 'sales-production@2', 'sales-production@3', 'sales-production@4', 'sales-production@5', 'sales-production@6', 'sales-production@7']);
  });

  it('composes quote.create@5 and quote.preview@3 only with the v6 limits, under the autonomous policy; only quote.create is an autonomous write', () => {
    expect(() => compose('sales-production@7')).toThrow(/no autonomous quote limits were configured/);
    const v7 = compose('sales-production@7', V6_LIMITS);
    const registry = v7.bindings.capabilities;
    expect(registry.resolve(CAPABILITY_IDS.quoteCreate)!.definition).toMatchObject({ version: 5, riskClass: 'IRREVERSIBLE_WRITE', approvalPolicy: 'none', idempotency: 'key_required', writeRecovery: 'reconcile_before_retry' });
    expect(registry.resolve(CAPABILITY_IDS.quoteCreate, 4)).toBeUndefined();
    expect(registry.resolve(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)!.definition).toMatchObject({ version: 3, riskClass: 'READ' });
    expect(registry.resolve(CAPABILITY_IDS.workspaceUpdate)!.definition.version).toBe(2);
    expect(v7.bindings.actionPolicy).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(v7.report.writes).toEqual({ allow: [CAPABILITY_IDS.workspaceUpdate, CAPABILITY_IDS.quoteCreate], requireApproval: [], deny: [] });
  });

  it('quote.create@5 declares the backoff a kill-switch hold needs: every attempt returns to worker admission, and the three in-run reconciliations outlast the owner not-found window', () => {
    const { definition } = compose('sales-production@7', V6_LIMITS).bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate)!;
    expect(definition.retryPolicy).toEqual({ maxAttempts: 3, initialBackoffMs: 20_000 });
    // Reconciliations fall due B, B + 2B and B + 2B + 4B after a held attempt (ActionRuntime.deferRetry doubles per attempt).
    const b = definition.retryPolicy.initialBackoffMs;
    expect(b + 2 * b + 4 * b).toBeGreaterThanOrEqual(definition.timeoutMs + QUOTE_V2_NOT_FOUND_FINAL_AFTER_MS);
  });

  it('definition v7: same agent, scopes, budgets and model requirements as v6; presents offerMessage exactly; no intent or stage router', () => {
    const { description: d6, instructions: _i6, version: v6, ...rest6 } = loadSalesAgentDefinition(6);
    const { description: d7, instructions: i7, version: v7, ...rest7 } = loadSalesAgentDefinition(7);
    expect([v6, v7]).toEqual([6, 7]);
    expect(rest7).toEqual(rest6);
    expect(d7).not.toBe(d6);
    expect(i7).toMatch(/your reply is presentation\.offerMessage exactly as given and nothing else/);
    expect(i7).toMatch(/never claim or record the confirmation yourself/);
    expect(i7).toMatch(/autonomy_disabled/);
    expect(i7).not.toMatch(/presentation\.totalText/);
    expect(i7).not.toMatch(/\bintent\b|\bstage\b/i);
  });
});

describe('C. boundaries', () => {
  it('quote.create@5 reads the conversation and the kill switch only through structural ports: no runtime package, no SQL, no channel or email', () => {
    const code = source('agents/sales/src/capabilities/quote-v5.ts');
    const runtime = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]!).filter((m) => m.startsWith('@r4/'));
    expect(runtime).toEqual(['@r4/capability-runtime']);
    expect(code).not.toMatch(/task_inputs|memory_entries|outbound_messages|agent_run_steps|\bautonomy_controls\b|\.query\(|whatsapp|gmail|deliveries/i);
    expect(code).toMatch(/deps\.conversation\.thread\(taskId\)/);
    expect(code).toMatch(/deps\.admission\.admit\(\)/);
    expect(code).toMatch(/import \{ quoteCreateV3Input, type QuoteCreateV3Input \} from '\.\/quote-v3\.js'/);
    // The composition passes the platform's own stores and controls, and the guarded port.
    expect(source('agents/sales/src/production/composition.ts')).toMatch(/quoteCreateV5Capability\(\{ store: sales, quotes, catalog, shipping: options\.shipping, limits, conversation: options\.store, admission: controls,/);
  });

  it('no new migration and no text column: the offer evidence reuses 0009 (hash) and 0008 (jsonb)', () => {
    expect(source('agents/sales/src/capabilities/quote-v5.ts')).not.toMatch(/offerMessage:/);
    expect(source('agents/sales/migrations/0009_sales_quote_intent_evidence.sql')).toMatch(/offer_text_sha256\s+text not null/);
  });
});

describe('D. the kill-switch write guard', () => {
  const controlsAt = (enabled: boolean) =>
    new AutonomyControls({ store: { readControls: () => Promise.resolve({ state: { globalEnabled: enabled, channels: {}, version: '1' }, records: [] }) } as unknown as ProductionStore, logger: createSilentLogger() });
  const NOT_FOUND = JSON.stringify({ operation: 'quote.create_and_issue', state: 'not_found', binding: null });
  const realClient = () => {
    const calls: string[] = [];
    const fetch: QuoteFetch = (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(NOT_FOUND), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    };
    return { client: new QuoteV2HttpClient({ config: { baseUrl: 'http://127.0.0.1:4020', bearerToken: 'r4-test-token-0123456789abcdef0123456789abcdef', timeoutMs: 1_000 }, fetch }), calls };
  };

  it('audit: guardProductionWrites over the real QuoteV2HttpClient breaks every READ (methods returned unbound to a class with private fields)', async () => {
    const { client } = realClient();
    const guarded = guardProductionWrites(client as QuoteV2Service, { domain: 'quote', writeOperations: ['createAndIssue'], controls: controlsAt(true), logger: createSilentLogger(), blocked: () => new Error('blocked') });
    await expect(guarded.lookupIdempotency('r4x_0123456789abcdef0123456789abcdef')).rejects.toThrow(TypeError);
  });

  it('killSwitchGuardedQuotes over the same client: reads go through while engaged; the mutation is refused before any request', async () => {
    const { client, calls } = realClient();
    const engaged = killSwitchGuardedQuotes(client, controlsAt(false), createSilentLogger());
    await expect(engaged.lookupIdempotency('r4x_0123456789abcdef0123456789abcdef')).resolves.toBeNull();
    await expect(engaged.createAndIssue({} as never, 'r4x_0123456789abcdef0123456789abcdef')).rejects.toMatchObject({ code: 'autonomy_disabled', category: 'temporarily_unavailable' });
    expect(calls).toEqual(['GET /v2/idempotency/current']);
  });
});
