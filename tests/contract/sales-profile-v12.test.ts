import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, SALES_AGENT_DIR, createQuoteParityGuard, loadSalesAgentDefinition, type AutonomousQuoteLimitsV6 } from '@r4-sales/agent';
import {
  SALES_CANARY_ONLY_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_F1_CANARY_MAX_WRITE_ACTIONS,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V7,
  SALES_PRODUCTION_PROFILE_V12,
  assertF1CanaryWriteCeiling,
  composeSalesProductionWorker,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';
import { CANARY_PROFILES, loadCanaryEnvironment, startCanaryRuntime } from '@r4-sales/agent/canary';

/**
 * R4-J5 F1 (owner decisions B and C, 2026-11-05): sales-production@12, the F1 quote canary profile. It composes only in
 * the isolated canary (never selectable by a production worker), runs definition v12 (derived from v7, without
 * Customer), requires the P-1 parity guard, and refuses autonomous limits or a write ceiling looser than approved.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const evidence = { schemaVersion: 1, items: [{ itemKey: 'BAR-OLY20', productRef: '105', variantRef: null, sku: 'SC-BO20-28', finalGross: 129_990, availableQuantity: 5, verifiedAt: new Date().toISOString(), source: 'contract-test' }] };
const parity = createQuoteParityGuard({ evidence, maxAgeSeconds: 3600 });
const compose = (options: { canary?: boolean; limits?: AutonomousQuoteLimitsV6; parity?: boolean }) =>
  composeSalesProductionWorker({
    ...(options.canary === false ? {} : { canary: true }),
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: noStore,
    production: env('sales-production@12'),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: options.limits ?? SALES_F1_CANARY_LIMITS,
    ...(options.parity === false ? {} : { quoteParity: parity }),
  });

describe('A. @12 is a canary-only profile: no production worker can select it', () => {
  it('is in the canary list only, pinned to definition v12, under the autonomous policy, with @7 domains and capabilities', () => {
    expect(SALES_PRODUCTION_PROFILES.map(profileLabel)).not.toContain('sales-production@12');
    expect(SALES_CANARY_ONLY_PROFILES.map(profileLabel)).toEqual(['sales-production@12']);
    expect(CANARY_PROFILES.map(profileLabel)).toContain('sales-production@12');
    expect(() => selectedSalesProductionProfile(env('sales-production@12').config)).toThrow(/is not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@12').config, { canary: true })).toBe(SALES_PRODUCTION_PROFILE_V12);
    expect(() => compose({ canary: false })).toThrow(/is not a Sales production profile/);
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V12)).toBe(12);
    expect(salesProductionActionPolicy(SALES_PRODUCTION_PROFILE_V12)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(SALES_PRODUCTION_PROFILE_V12.domains).toEqual(SALES_PRODUCTION_PROFILE_V7.domains);
    expect(SALES_PRODUCTION_PROFILE_V12.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V7.capabilities);
    expect(profileFingerprint(SALES_PRODUCTION_PROFILE_V12)).not.toBe(profileFingerprint(SALES_PRODUCTION_PROFILE_V7));
  });

  it('composes the deterministic offer (quote.preview@3, quote.create@5) and nothing of Customer, CIA, Checkout or cart', () => {
    const registry = compose({}).bindings.capabilities;
    expect(registry.resolve(CAPABILITY_IDS.quoteCreate)!.definition.version).toBe(5);
    expect(registry.resolve(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)!.definition.version).toBe(3);
    expect(registry.resolve(CAPABILITY_IDS.workspaceUpdate)!.definition.version).toBe(2);
    const ids = registry.list().map((c) => c.capabilityId);
    expect(ids.filter((id) => /customer|identity|checkout|cart|payment/i.test(id))).toEqual([]);
  });
});

describe('B. the F1 gate is enforced in code', () => {
  it('quote.create is never composed without the P-1 parity guard', () => {
    expect(() => compose({ parity: false })).toThrow(/parity-verified SKU set/);
  });

  it('autonomous limits may be stricter than the approved canary values, never looser', () => {
    expect(() => compose({ limits: { ...SALES_F1_CANARY_LIMITS, maxGrossClp: 100_000, maxQuotesPerHour: 1 } })).not.toThrow();
    for (const key of Object.keys(SALES_F1_CANARY_LIMITS) as (keyof AutonomousQuoteLimitsV6)[]) {
      expect(() => compose({ limits: { ...SALES_F1_CANARY_LIMITS, [key]: SALES_F1_CANARY_LIMITS[key] + 1 } }), key).toThrow(new RegExp(`looser: ${key}=`));
    }
  });

  it('the approved values are the J3E owner values (decision C), the write ceiling 6', () => {
    expect(SALES_F1_CANARY_LIMITS).toEqual({ maxGrossClp: 250_000, maxLines: 3, maxUnitsPerLine: 5, maxTotalUnits: 5, maxQuotesPerConversation: 1, maxQuotesPerHour: 2, confirmationWindowSeconds: 900 });
    expect(SALES_F1_CANARY_MAX_WRITE_ACTIONS).toBe(6);
    for (const ok of [1, 6]) expect(() => assertF1CanaryWriteCeiling(ok)).not.toThrow();
    for (const bad of [0, 7, 1.5, Number.NaN]) expect(() => assertF1CanaryWriteCeiling(bad), String(bad)).toThrow(/between 1 and 6/);
  });
});

describe('B2. the isolated canary runtime applies the gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r4-v12-'));
  const file = join(dir, 'parity.json');
  writeFileSync(file, JSON.stringify(evidence));
  const limitsEnv = { R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '250000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '5', R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '1', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '2', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900' };
  const canaryEnv = (extra: Record<string, string>) => loadCanaryEnvironment({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@12', R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false', R4_CANARY_DATABASE_URL: 'postgres://r4:x@127.0.0.1:55432/r4_canary_v12_contract', ...limitsEnv, ...extra });

  it('loads the parity evidence from the environment, and refuses an unreadable or invalid one', () => {
    expect(canaryEnv({ R4_QUOTE_PARITY_EVIDENCE_FILE: file, R4_QUOTE_PARITY_MAX_AGE_SECONDS: '3600' }).quoteParity?.fingerprint).toBe(parity.fingerprint);
    expect(canaryEnv({}).quoteParity).toBeNull();
    expect(() => canaryEnv({ R4_QUOTE_PARITY_EVIDENCE_FILE: join(dir, 'missing.json'), R4_QUOTE_PARITY_MAX_AGE_SECONDS: '3600' })).toThrow(/not readable JSON/);
    expect(() => canaryEnv({ R4_QUOTE_PARITY_EVIDENCE_FILE: file, R4_QUOTE_PARITY_MAX_AGE_SECONDS: '0' })).toThrow(/MAX_AGE_SECONDS/);
  });

  it('refuses a worker whose write ceiling is outside 1..6, before touching any database', async () => {
    const canary = canaryEnv({ R4_QUOTE_PARITY_EVIDENCE_FILE: file, R4_QUOTE_PARITY_MAX_AGE_SECONDS: '3600' });
    for (const maxWriteActions of [0, 7]) {
      await expect(startCanaryRuntime(canary, { worker: { databaseUrl: canary.databaseUrl, execution: { maxWriteActions } }, scheduler: null, logger: createSilentLogger() } as never), String(maxWriteActions)).rejects.toThrow(/between 1 and 6/);
    }
  });
});

describe('C. definition v12 (decision B: derived from v7; explicit exception to cumulative versioning)', () => {
  const v7 = loadSalesAgentDefinition(7);
  const v12 = loadSalesAgentDefinition(12);

  it('is a candidate, not a declared definition: no bootstrap, platform or harness registers it, and it never becomes "latest"', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@12');
    expect(Math.max(...loaded.filter((e) => e.definition.agentId === 'sales').map((e) => e.definition.version))).toBe(8);
  });

  it('excludes Customer Profile, CIA, Checkout, cart and the unadjudicated G-sem block; no customer scope', () => {
    expect(v12.instructions).not.toMatch(/customer\.get_context|customer\.get_purchase_history|identity\.|checkout\.|cart\./i);
    expect(v12.capabilityScopes).toEqual(['catalog.read', 'shipping.read', 'sales.workspace.write', 'quote.create']);
  });

  it('is v7 plus exactly the approved changes: extended DS-1, the promotion clause, minus the Customer line', () => {
    const added = v12.instructions.split('\n').filter((l) => !v7.instructions.split('\n').includes(l));
    const removed = v7.instructions.split('\n').filter((l) => !v12.instructions.split('\n').includes(l));
    expect(removed.map((l) => l.slice(0, 40))).toEqual(['- A proposal is not an effect. Say somet', '- customer.get_context: when knowing the']);
    expect(added.map((l) => l.slice(0, 40))).toEqual(['- A proposal is not an effect. Never say', '- Do not offer to record, write down, re', '- Delivery modality: no delivery ("sin d', '- Despacho Directo promotion: PesasChile']);
  });

  it('the extended DS-1 covers explicit claims, implicit confirmations, unavailable operations and unverified commercial conditions', () => {
    expect(v12.instructions).toMatch(/Never say that you recorded, saved, reserved, modified or scheduled anything/);
    expect(v12.instructions).toMatch(/never confirm a requested change \("done", "listo", "ok, two units"\)/);
    expect(v12.instructions).toMatch(/Do not offer to record, write down, reserve or schedule anything/);
    expect(v12.instructions).toMatch(/store pickup, discounts, payment terms or any other commercial condition/);
  });
});

/**
 * «R4 — J5 F1 DS-1 Pickup Correction» (owner, 2026-11-05): rounds 2–3 showed v12 offering store pickup with no
 * evidence, always next to «sin despacho». The rule is evidence-conditioned, not a word ban: pickup may be offered when
 * a capability confirms it. These pin what the text distinguishes; the model's behaviour is measured by the campaign
 * (scripts/experiments/j5-ds1-claims/pickup.mjs).
 */
describe('D. delivery modality: no delivery, free delivery and store pickup are distinct', () => {
  const v12 = loadSalesAgentDefinition(12).instructions;
  const rule = v12.split('\n').find((l) => l.startsWith('- Delivery modality:'))!;

  it('is one rule, in the Truth and evidence block, right after the DS-1 offer rule', () => {
    const lines = v12.split('\n');
    expect(lines.filter((l) => l.startsWith('- Delivery modality:'))).toHaveLength(1);
    expect(lines[lines.indexOf(rule) - 1]).toMatch(/^- Do not offer to record, write down, reserve or schedule anything/);
    expect(lines.indexOf(rule)).toBeLessThan(lines.indexOf('Sales workspace'));
  });

  it('1. no delivery is not pickup', () => {
    expect(rule).toMatch(/no delivery \("sin despacho", exclude_shipping\) only means the quote carries no shipping; it does not mean store pickup/);
  });

  it('2. a delivery offer priced at $0 is not pickup', () => {
    expect(rule).toMatch(/neither does a delivery offer priced at \$0/);
  });

  it('3 and 5. requested or unconfirmed pickup: say it has to be verified, offer what can be done', () => {
    expect(rule).toMatch(/If the customer asks for pickup and no observation confirms it, say it has to be verified first and offer what you can do instead/);
  });

  it('4. confirmed pickup may be offered: the rule is conditioned on evidence, not a word ban', () => {
    expect(rule).toMatch(/Present store pickup as available only when an observation of a capability available to you confirms it/);
    expect(rule).toMatch(/then offer it like any other returned option/);
    expect(v12).not.toMatch(/never (say|mention|use|write)[^.]*\b(pickup|retiro|retirar)\b/i);
  });

  it('6. unknown modality: no delivery condition is invented', () => {
    expect(rule).toMatch(/Never invent delivery conditions: modality, place, date or cost\./);
  });

  it('keeps every other commercial and DS-1 rule: without this line, v12 is byte for byte the pre-correction text (main 34f4230)', () => {
    const without = v12.split('\n').filter((l) => l !== rule).join('\n');
    expect(createHash('sha256').update(without).digest('hex')).toBe('70aac1b2de0fb7cb8c34956470de95f4eb0203d5123b8377ef0a6f8d9b55cd48');
  });
});
