import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { ActionPolicyEngine } from '@r4/policy-engine';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import {
  AUTONOMOUS_QUOTE_CAPABILITY_IDS,
  AUTONOMOUS_QUOTE_LIMIT_ENV,
  CAPABILITY_IDS,
  loadAutonomousQuoteLimits,
  loadSalesAgentDefinition,
  quoteCreateV2Capability,
  quoteCreateV3Capability,
  workspaceOperationSchema,
  workspaceOperationV2Schema,
  type AutonomousQuoteLimits,
  type PostgresSalesStore,
} from '@r4-sales/agent';
import {
  SALES_PRODUCTION_ACTION_POLICY,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILE,
  SALES_PRODUCTION_PROFILE_V2_CANDIDATE,
  SALES_PRODUCTION_PROFILE_V3,
  SALES_PRODUCTION_PROFILE_V4,
  SALES_PRODUCTION_PROFILE_V5,
  SALES_PRODUCTION_V4_QUOTE_BINDING,
  composeSalesProductionWorker,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
} from '@r4-sales/agent/production';

/**
 * R4-J3E contract: sales-production@5 adds autonomous quote issuance WITHOUT
 * touching anything earlier. @1–@4 fingerprints and SALES_PRODUCTION_ACTION_POLICY
 * are pinned to their values at main ef5a354 (@3 = the profile deployed on EC2).
 */
const PINNED = {
  v1: 'bd30523fba7cd17b2996af8205862e30c6756b4efb812777d00c2a5f9f84d313',
  v2: '2430a3e05c384a61a581707a2d397bcf64a72a703e7e08abbc713535988da3a8',
  v3: '847aa0efda66782e393305d62370b8ab130189d949b4622ca6449da0072a8d95',
  v4: 'c905ca763b12ca55176788fc7c72ae0fe157e4cb3d569da4a2a85b3167f8c66b',
  productionPolicy: '5dbbd0f2dbfbd2fedab45abd3d4cb204a966500c76383cd00e16d038bf3ecb9a',
};

const ROOT = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const LIMITS: AutonomousQuoteLimits = { maxGrossClp: 500_000, maxLines: 5, maxUnitsPerLine: 10, maxQuotesPerConversation: 2, maxQuotesPerHour: 20 };
const compose = (profile: string, limits?: AutonomousQuoteLimits) =>
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

describe('A. legacy profiles are unchanged', () => {
  it('@1–@4 fingerprints and the production action policy hash equal main', () => {
    expect([SALES_PRODUCTION_PROFILE, SALES_PRODUCTION_PROFILE_V2_CANDIDATE, SALES_PRODUCTION_PROFILE_V3, SALES_PRODUCTION_PROFILE_V4].map(profileFingerprint)).toEqual([PINNED.v1, PINNED.v2, PINNED.v3, PINNED.v4]);
    expect(new ActionPolicyEngine(SALES_PRODUCTION_ACTION_POLICY).identity.hash).toBe(PINNED.productionPolicy);
  });

  it('@3 and @4 compose exactly as before: workspace.update@1, quote.create@2 (v4) with approval, no quote.preview, the production policy object', () => {
    for (const label of ['sales-production@3', 'sales-production@4']) {
      const composed = compose(label);
      expect(composed.bindings.actionPolicy).toBe(SALES_PRODUCTION_ACTION_POLICY);
      expect(composed.bindings.capabilities.resolve(CAPABILITY_IDS.workspaceUpdate)!.definition.version).toBe(1);
      expect(composed.bindings.capabilities.resolve(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)).toBeUndefined();
      expect(composed.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate, 3)).toBeUndefined();
    }
    expect(compose('sales-production@4').bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate)!.definition).toMatchObject({ version: 2, approvalPolicy: 'required' });
    expect(compose('sales-production@4').report.writes.requireApproval).toEqual([CAPABILITY_IDS.quoteCreate]);
  });

  it('workspace.update@1 keeps its exact operation set; the new operations exist only in version 2', () => {
    expect(workspaceOperationSchema.options.map((o) => o.shape.op.value).sort()).toEqual(['add_item', 'clear_delivery_destination', 'record_fact', 'remove_item', 'replace_item', 'retract_fact', 'set_delivery_destination', 'set_item_quantity']);
    expect(workspaceOperationV2Schema.options.map((o) => o.shape.op.value).sort()).toEqual(['add_item', 'clear_delivery_destination', 'exclude_shipping', 'record_fact', 'record_quote_request', 'remove_item', 'replace_item', 'retract_fact', 'select_shipping_offer', 'set_delivery_destination', 'set_item_quantity']);
  });
});

describe('B. sales-production@5 composition', () => {
  it('is v4 plus autonomous quote.create and quote.preview; runs Sales definition v5', () => {
    const { quote, ...rest } = SALES_PRODUCTION_PROFILE_V5.domains;
    const { quote: v4Quote, ...v4Rest } = SALES_PRODUCTION_PROFILE_V4.domains;
    expect(rest).toEqual(v4Rest);
    expect(quote).toMatchObject({ status: 'REAL', contractRef: v4Quote!.contractRef });
    expect(SALES_PRODUCTION_PROFILE_V5.channel).toEqual(SALES_PRODUCTION_PROFILE_V4.channel);
    expect(SALES_PRODUCTION_PROFILE_V5.capabilities.filter((c) => c.capabilityId !== CAPABILITY_IDS.quoteCreate && c.capabilityId !== AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)).toEqual(SALES_PRODUCTION_PROFILE_V4.capabilities.filter((c) => c.capabilityId !== CAPABILITY_IDS.quoteCreate));
    expect(SALES_PRODUCTION_PROFILE_V5.capabilities.find((c) => c.capabilityId === CAPABILITY_IDS.quoteCreate)).toEqual({ capabilityId: CAPABILITY_IDS.quoteCreate, domain: 'quote', effect: 'write', decision: 'ALLOW' });
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V5)).toBe(5);
    expect(profileLabel(SALES_PRODUCTION_PROFILE_V5)).toBe('sales-production@5');
    expect(new Set([PINNED.v1, PINNED.v2, PINNED.v3, PINNED.v4, profileFingerprint(SALES_PRODUCTION_PROFILE_V5)]).size).toBe(5);
  });

  it('refuses to compose without configured limits; registers workspace.update@2, quote.preview and quote.create@3 only', () => {
    expect(() => compose('sales-production@5')).toThrow(/no autonomous quote limits were configured/);
    const v5 = compose('sales-production@5', LIMITS);
    const registry = v5.bindings.capabilities;
    expect(registry.resolve(CAPABILITY_IDS.workspaceUpdate)!.definition.version).toBe(2);
    expect(registry.resolve(CAPABILITY_IDS.workspaceUpdate, 1)).toBeUndefined();
    expect(registry.resolve(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)!.definition).toMatchObject({ riskClass: 'READ', owner: 'sales' });
    expect(registry.resolve(CAPABILITY_IDS.quoteCreate)!.definition).toMatchObject({ version: 3, riskClass: 'IRREVERSIBLE_WRITE', approvalPolicy: 'none', idempotency: 'key_required', writeRecovery: 'reconcile_before_retry', identityRequirement: 'provisional' });
    expect(registry.resolve(CAPABILITY_IDS.quoteCreate, 2)).toBeUndefined();
    expect(v5.bindings.actionPolicy).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(salesProductionActionPolicy(SALES_PRODUCTION_PROFILE_V5)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(v5.report.writes).toEqual({ allow: [CAPABILITY_IDS.workspaceUpdate, CAPABILITY_IDS.quoteCreate], requireApproval: [], deny: [] });
  });

  it('Sales definition v5: same agent, scopes and budgets as v4; only description and instructions differ', () => {
    const { description: d4, instructions: _i4, version: v4, ...rest4 } = loadSalesAgentDefinition(4);
    const { description: d5, instructions: i5, version: v5, ...rest5 } = loadSalesAgentDefinition(5);
    expect([v4, v5]).toEqual([4, 5]);
    expect(rest5).toEqual(rest4);
    expect(d5).not.toBe(d4);
    expect(i5).toMatch(/quote\.preview/);
    expect(i5).toMatch(/record_quote_request/);
    expect(i5).not.toMatch(/required contact data/);
  });
});

describe('C. the autonomous policy (ADR-034)', () => {
  const quotes = new FixtureQuoteV2Service();
  const registry = new CapabilityRegistry();
  registry.registerWrite(quoteCreateV2Capability({ store: {} as PostgresSalesStore, quotes, catalog: new FixtureCatalog(), shipping: new FixtureShipping() }));
  registry.registerWrite(quoteCreateV3Capability({ store: {} as PostgresSalesStore, quotes, catalog: new FixtureCatalog(), shipping: new FixtureShipping(), limits: LIMITS }));
  const v2 = registry.resolve(CAPABILITY_IDS.quoteCreate, 2)!.definition;
  const v3 = registry.resolve(CAPABILITY_IDS.quoteCreate, 3)!.definition;
  const context = { taskId: '0190a0a0-0000-7000-8000-00000000c001', runId: '0190a0a0-0000-7000-8000-00000000c002', agentId: 'sales', agentVersion: 5, correlationId: 'c', grantedScopes: ['quote.create'], actor: { kind: 'service' as const, ref: 'sales-channel-ingress' }, identityAssurance: 'provisional' as const };
  const input = (definition: typeof v3, overrides: Record<string, unknown> = {}) => ({
    proposal: { proposalId: 'p1', evidenceRefs: ['obs-1'] },
    agent: { agentId: 'sales', version: 5, capabilityScopes: ['quote.create'] },
    task: { taskId: context.taskId, status: 'running' as const },
    context,
    capability: { ...definition, writeRecovery: 'reconcile_before_retry' as const },
    ...overrides,
  });
  const autonomous = new ActionPolicyEngine(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);

  it('allows quote.create@3 without approval, but still demands provisional identity and cited evidence', () => {
    expect(autonomous.evaluate(input(v3))).toMatchObject({ outcome: 'allow', reasonCode: 'autonomous', rule: 'capabilities.quote.create.autonomy' });
    expect(autonomous.evaluate(input(v3, { proposal: { proposalId: 'p1', evidenceRefs: [] } }))).toMatchObject({ outcome: 'deny', reasonCode: 'evidence_required' });
    expect(autonomous.evaluate(input(v3, { context: { ...context, identityAssurance: 'none' } }))).toMatchObject({ outcome: 'deny' });
  });

  it('does not remove the approval requirement of quote.create@2, under any policy', () => {
    expect(autonomous.evaluate(input(v2))).toMatchObject({ outcome: 'require_approval', reasonCode: 'capability_requires_approval' });
    expect(new ActionPolicyEngine(SALES_PRODUCTION_ACTION_POLICY).evaluate(input(v2))).toMatchObject({ outcome: 'require_approval' });
    // And the production policy never lets @3 run without a human either.
    expect(new ActionPolicyEngine(SALES_PRODUCTION_ACTION_POLICY).evaluate(input(v3))).toMatchObject({ outcome: 'require_approval', reasonCode: 'risk_class_requires_approval' });
  });

  it('autonomy extends to no other write: every risk class keeps the platform default; only quote.create differs', () => {
    expect(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.riskClasses).toEqual(SALES_PRODUCTION_ACTION_POLICY.riskClasses);
    expect(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.capabilities).toEqual({ ...SALES_PRODUCTION_ACTION_POLICY.capabilities, [CAPABILITY_IDS.quoteCreate]: { autonomy: 'allow', minimumIdentity: 'provisional', requireEvidence: true } });
    for (const [riskClass, capabilityId] of [['IRREVERSIBLE_WRITE', 'quote.cancel'], ['EXTERNAL_COMMUNICATION', 'quote.deliver_email'], ['FINANCIAL', 'payment.charge'], ['PRIVILEGED', 'sales.discount.apply']] as const) {
      expect(autonomous.evaluate(input({ ...v3, capabilityId, riskClass })).outcome, capabilityId).not.toBe('allow');
    }
  });
});

describe('D. limits and boundaries', () => {
  it('every limit is required configuration (no code default)', () => {
    const full = { R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '500000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '5', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '10', R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '2', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '20' };
    expect(loadAutonomousQuoteLimits(full)).toEqual(LIMITS);
    for (const name of Object.values(AUTONOMOUS_QUOTE_LIMIT_ENV)) {
      expect(() => loadAutonomousQuoteLimits({ ...full, [name]: undefined }), name).toThrow(new RegExp(`${name} is required`));
      expect(() => loadAutonomousQuoteLimits({ ...full, [name]: '0' }), name).toThrow(new RegExp(name));
      expect(() => loadAutonomousQuoteLimits({ ...full, [name]: '1.5' }), name).toThrow(new RegExp(name));
    }
  });

  it('issuance and delivery stay separate: no email scope, no delivery route, no channel or Gmail dependency', () => {
    expect(SALES_PRODUCTION_V4_QUOTE_BINDING.principalScopes).toEqual(['quotes:create', 'quotes:read', 'quotes:document:read']);
    for (const file of ['agents/sales/src/capabilities/quote-v3.ts', 'agents/sales/src/capabilities/quote-preview.ts', 'agents/sales/src/capabilities/commercial-snapshot.ts', 'agents/sales/src/capabilities/workspace-v2.ts']) {
      const code = source(file);
      expect(code, file).not.toMatch(/whatsapp|gmail|deliveries|delivery:email|@r4\/task-runtime|@r4\/persistence-postgres|fetch\(/i);
    }
  });

  it('the harness is not extended: the new capabilities use only public capability-runtime and domain-port types', () => {
    const imports = (file: string) => [...source(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]!).filter((m) => m.startsWith('@r4/'));
    expect([...new Set(['quote-v3', 'quote-preview', 'workspace-v2', 'commercial-snapshot', 'autonomy-limits'].flatMap((f) => imports(`agents/sales/src/capabilities/${f}.ts`)))].sort()).toEqual(['@r4/capability-runtime', '@r4/contracts']);
  });
});
