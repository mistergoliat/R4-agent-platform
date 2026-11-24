import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { QUOTE_RECOVERY_SOURCE_ID } from '@r4-sales/agent';
import { SALES_F1_CANARY_LIMITS, SALES_QUOTE_RECOVERY_PROFILES, composeSalesProductionWorker } from '@r4-sales/agent/production';

/**
 * (M3, owner mandate 2026-11-18) R4_SALES_QUOTE_RECOVERY takes effect on sales-production@22 only. Any other profile
 * ignores it with a warning (never refuses: the rollback to @21 must not depend on unsetting it), and the source is
 * read-only: its Quote port is `getQuote`, never an issuance.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };

function compose(profile: string, quoteRecovery: boolean) {
  const warnings: string[] = [];
  const logger = Object.assign(Object.create(createSilentLogger()) as ReturnType<typeof createSilentLogger>, { warn: (fields: { event?: string }) => void warnings.push(fields.event ?? '') });
  const composed = composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: noStore,
    production: env(profile),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
    logger,
    catalog: http(new FixtureCatalog() as CatalogPort),
    catalogDiscover: discover,
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: SALES_F1_CANARY_LIMITS,
    quoteRecovery,
  });
  return { recovery: (composed.bindings.contextSources ?? []).some((s) => s.id === QUOTE_RECOVERY_SOURCE_ID), warnings };
}

describe('quote recovery composition (M3, @22 only)', () => {
  it('the allowed set is exactly sales-production@22, @23, @24, @25 and @26', () => {
    expect([...SALES_QUOTE_RECOVERY_PROFILES]).toEqual(['sales-production@22', 'sales-production@23', 'sales-production@24', 'sales-production@25', 'sales-production@26']);
  });

  it('@22 composes the source when enabled, and not when disabled', () => {
    expect(compose('sales-production@22', true)).toEqual({ recovery: true, warnings: [] });
    expect(compose('sales-production@22', false)).toEqual({ recovery: false, warnings: [] });
  });

  it.each(['sales-production@21', 'sales-production@19'])('%s ignores the flag with a warning (the rollback keeps starting)', (profile) => {
    expect(compose(profile, true)).toEqual({ recovery: false, warnings: ['sales.quote_recovery.ignored'] });
    expect(compose(profile, false)).toEqual({ recovery: false, warnings: [] });
  });
});
