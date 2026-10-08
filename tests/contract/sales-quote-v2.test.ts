import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ActionExecutor, CapabilityRegistry } from '@r4/capability-runtime';
import { ActionPolicyEngine } from '@r4/policy-engine';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import { CAPABILITY_IDS, SALES_ACTION_POLICY, quoteCreateV2Capability, quoteCreateV2Input, type PostgresSalesStore } from '@r4-sales/agent';
import {
  SALES_PRODUCTION_ACTION_POLICY,
  SALES_PRODUCTION_PROFILE,
  SALES_PRODUCTION_PROFILE_V2_CANDIDATE,
  SALES_PRODUCTION_PROFILE_V3,
  SALES_PRODUCTION_PROFILE_V4,
  SALES_PRODUCTION_V4_QUOTE_BINDING,
  composeSalesProductionWorker,
  salesProductionAgentVersion,
} from '@r4-sales/agent/production';

const ROOT = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const catalog = http(new FixtureCatalog() as CatalogPort);
const shipping = http(new FixtureShipping() as ShippingService);
const compose = (profile: string, quotes?: QuoteV2Service & { bindingKind: string }) =>
  composeSalesProductionWorker({ pool: { query: () => Promise.reject(new Error('no db')) } as never, store: noStore, production: env(profile), modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(), catalog: catalog, shipping: shipping, ...(quotes ? { quotes } : {}) });

describe('sales-production@4 (Quote V2 REAL) — composition', () => {
  it('is v3 plus Quote REAL only; v1–v3 fingerprints are untouched; it runs Sales definition v4', () => {
    const { [`quote`]: quote, ...rest } = SALES_PRODUCTION_PROFILE_V4.domains;
    const { quote: v3Quote, ...v3Rest } = SALES_PRODUCTION_PROFILE_V3.domains;
    expect(rest).toEqual(v3Rest);
    expect(v3Quote!.status).toBe('UNAVAILABLE');
    expect(quote).toMatchObject({ status: 'REAL' });
    expect(SALES_PRODUCTION_PROFILE_V4.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V3.capabilities);
    expect(SALES_PRODUCTION_PROFILE_V4.capabilities.find((c) => c.capabilityId === CAPABILITY_IDS.quoteCreate)).toMatchObject({ effect: 'write', decision: 'REQUIRE_APPROVAL' });
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V4)).toBe(4);
    // v1–v3 fingerprints stay frozen (asserted against fixed hex values in sales-profile-v2/v3.test.ts); v4 is distinct.
    expect(new Set([SALES_PRODUCTION_PROFILE, SALES_PRODUCTION_PROFILE_V2_CANDIDATE, SALES_PRODUCTION_PROFILE_V3, SALES_PRODUCTION_PROFILE_V4].map(profileFingerprint)).size).toBe(4);
    expect(profileLabel(SALES_PRODUCTION_PROFILE_V4)).toBe('sales-production@4');
  });

  it('Quote is unavailable unless the profile makes it REAL and a Quote V2 HTTP binding is provided', () => {
    const v3 = compose('sales-production@3');
    expect(v3.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate)).toBeUndefined();
    expect(() => compose('sales-production@4')).toThrow(/no Quote V2 binding/);
    // A fixture can never stand in for the production owner.
    expect(() => compose('sales-production@4', new FixtureQuoteV2Service())).toThrow(/no Quote V2 binding/);
    const v4 = compose('sales-production@4', http(new FixtureQuoteV2Service() as QuoteV2Service));
    const registered = v4.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate)!;
    expect(registered.definition).toMatchObject({ version: 2, riskClass: 'IRREVERSIBLE_WRITE', approvalPolicy: 'required', idempotency: 'key_required', writeRecovery: 'reconcile_before_retry' });
    expect(v4.bindings.capabilities.resolve(CAPABILITY_IDS.quoteCreate, 1)).toBeUndefined();
    expect(v4.report.writes.requireApproval).toEqual([CAPABILITY_IDS.quoteCreate]);
    expect(v4.report.domains.quote).toBe('REAL');
    expect(v4.bindings.actionPolicy).toBe(SALES_PRODUCTION_ACTION_POLICY);
  });

  it('declares exactly the minimum owner scopes and only owner routes without email, draft, cancel or override', () => {
    expect(SALES_PRODUCTION_V4_QUOTE_BINDING.principalScopes).toEqual(['quotes:create', 'quotes:read', 'quotes:document:read']);
    const client = source('adapters/domains/quote/http/src/client.ts');
    const routes = [...client.matchAll(/'(\/v2\/[^'`?]*)|`(\/v2\/[^`?]*)/g)].map((m) => (m[1] ?? m[2])!.replace(/\$\{[^}]+\}/g, '{id}'));
    expect([...new Set(routes)].sort()).toEqual(['/v2/idempotency/current', '/v2/operations/{id}', '/v2/quotes', '/v2/quotes/{id}', '/v2/quotes/{id}/document'].sort());
    expect(client).not.toMatch(/\/deliveries|\/cancel|\/drafts|\/issue\b|validityOverride/);
  });
});

describe('quote.create@2 — governance', () => {
  const quotes = new FixtureQuoteV2Service();
  const registry = new CapabilityRegistry();
  registry.registerWrite(quoteCreateV2Capability({ store: {} as PostgresSalesStore, quotes, catalog: new FixtureCatalog(), shipping: new FixtureShipping() }));
  const definition = registry.resolve(CAPABILITY_IDS.quoteCreate, 2)!.definition;
  const context = { taskId: '0190a0a0-0000-7000-8000-00000000b001', runId: '0190a0a0-0000-7000-8000-00000000b002', agentId: 'sales', agentVersion: 4, correlationId: 'c', grantedScopes: ['quote.create'], actor: { kind: 'service' as const, ref: 'sales-channel-ingress' }, identityAssurance: 'provisional' as const };
  const input = (approval?: { argumentsMatch: boolean }) => ({
    ...(approval ? { approval: { requestId: 'h1', proposalId: 'p1', capabilityId: CAPABILITY_IDS.quoteCreate, capabilityVersion: 2, argumentsMatch: approval.argumentsMatch } } : {}),
    proposal: { proposalId: 'p1', evidenceRefs: ['obs-1'] },
    agent: { agentId: 'sales', version: 4, capabilityScopes: ['quote.create'] },
    task: { taskId: context.taskId, status: 'running' as const },
    context,
    capability: { ...definition, writeRecovery: 'reconcile_before_retry' as const },
  });

  it('the production policy requires a human approval; approval must match the exact validated arguments', () => {
    const engine = new ActionPolicyEngine(SALES_PRODUCTION_ACTION_POLICY);
    expect(engine.evaluate(input())).toMatchObject({ outcome: 'require_approval' });
    expect(engine.evaluate(input({ argumentsMatch: false }))).toMatchObject({ outcome: 'deny', reasonCode: 'approval_scope_mismatch' });
    expect(engine.evaluate(input({ argumentsMatch: true }))).toMatchObject({ outcome: 'allow', reasonCode: 'human_approved' });
    expect(engine.evaluate({ ...input(), proposal: { proposalId: 'p1', evidenceRefs: [] } })).toMatchObject({ outcome: 'deny', reasonCode: 'evidence_required' });
  });

  it('even an autonomous policy cannot issue a V2 quote without approval (approvalPolicy=required on the capability)', () => {
    expect(new ActionPolicyEngine(SALES_ACTION_POLICY).evaluate(input())).toMatchObject({ outcome: 'require_approval', reasonCode: 'capability_requires_approval' });
  });

  it('a command without an ALLOW decision never reaches the handler (a rejected approval issues nothing)', async () => {
    const executor = new ActionExecutor({ registry, logger: createSilentLogger() });
    const command = { proposalId: 'p1', policyDecisionId: 'd1', capabilityId: CAPABILITY_IDS.quoteCreate, capabilityVersion: 2, riskClass: 'IRREVERSIBLE_WRITE', semantics: { recovery: 'reconcile_before_retry' }, executionKey: 'r4x_0123456789abcdef0123456789abcdef', taskId: context.taskId, runId: context.runId, executionId: 'e1', trustedContext: context, validatedArguments: {} };
    const report = await executor.attempt({ command: command as never, decision: { outcome: 'require_approval', decisionId: 'd1', proposalId: 'p1', capabilityId: CAPABILITY_IDS.quoteCreate, capabilityVersion: 2 } as never }, { attemptNumber: 1, kind: 'execute' });
    expect(report).toMatchObject({ outcome: 'unknown', errorCode: 'command_not_authorized' });
    expect(quotes.createCalls).toBe(0);
  });

  it('the model can state no quote identity, no owner totals, no URL and no unknown member; customer fields follow the owner kinds', () => {
    const line = { itemKey: 'BAR-OLY20', quantity: 1, unitPrice: { amount: 129_990, taxBasis: 'included', taxRate: '0.19' } };
    const valid = { workspaceVersion: 1, customer: { kind: 'guest' }, lines: [line], shipping: null, expectedTotals: { net: 109_235, tax: 20_755, gross: 129_990 }, currency: 'CLP' };
    expect(quoteCreateV2Input.safeParse(valid).success).toBe(true);
    for (const extra of [{ quoteId: 'q' }, { quoteNumber: 'PC-000001' }, { validityOverride: {} }, { documentUrl: 'http://127.0.0.1:4020/x' }, { idempotencyKey: 'k' }]) {
      expect(quoteCreateV2Input.safeParse({ ...valid, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    // Missing required customer facts are refused before any proposal exists; nothing is fabricated.
    expect(quoteCreateV2Input.safeParse({ ...valid, customer: { kind: 'person' } }).success).toBe(false);
    expect(quoteCreateV2Input.safeParse({ ...valid, customer: { kind: 'company', rut: '76.123.456-7' } }).success).toBe(false);
    expect(quoteCreateV2Input.safeParse({ ...valid, lines: [{ ...line, unitPrice: { ...line.unitPrice, taxBasis: 'excluded' } }] }).success).toBe(false);
    expect(quoteCreateV2Input.safeParse({ ...valid, lines: [{ ...line, unitPrice: { ...line.unitPrice, taxRate: 0.19 } }] }).success).toBe(false);
  });

  it('has no channel, email or PDF-rendering dependency and returns no owner URL', () => {
    const capability = source('agents/sales/src/capabilities/quote-v2.ts');
    const imports = [...capability.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../ids.js', '../workspace/store.js', './shipping-basis.js', '@r4-adapters/domains', '@r4/capability-runtime', 'node:crypto', 'zod'].sort());
    expect(capability).not.toMatch(/whatsapp|gmail|deliveries|pdfkit|puppeteer|127\.0\.0\.1|baseUrl/i);
  });
});
