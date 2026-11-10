import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { profileLabel } from '@r4/live-ops';
import { SALES_CANARY_ONLY_PROFILES, SALES_LANE_PROFILES, SALES_PRODUCTION_PROFILES, SALES_PRODUCTION_PROFILE_V7, SALES_PRODUCTION_PROFILE_V12, SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V14, salesCatalogSourceOf } from '@r4-sales/agent/production';
import { CANARY_PROFILES } from '@r4-sales/agent/canary';
import { canaryCatalogConfig, canaryCatalogSource } from '../../../agents/sales/src/cli/canary/command.js';

/**
 * R4-CATALOG-V2 isolation (§5): only the isolated canary can bind Catalog V2, by an explicit choice; the F1 canary (@12)
 * binds V2 only; the production composition (sales-production@3 and every production profile) keeps reading
 * R4_CATALOG_* (V1) and cannot be switched to V2 by configuration.
 *
 * (ADR-045, owner decision: the E1 lane on the existing number) The ONLY production profile that binds V2 is the lane
 * profile sales-production@13, and it is the profile — never a variable — that decides it.
 */
const V1_ENV = { R4_CATALOG_BASE_URL: 'http://127.0.0.1:4010', R4_CATALOG_API_KEY: 'j'.repeat(24), R4_CATALOG_TIMEOUT_MS: '2500' };
const V2_ENV = { R4_CATALOG_V2_BASE_URL: 'http://127.0.0.1:4011', R4_CATALOG_V2_API_KEY: 'k'.repeat(24), R4_CATALOG_V2_TIMEOUT_MS: '5000' };
const canaryOf = (profile: typeof SALES_PRODUCTION_PROFILE_V7) => ({ profile, production: { config: { allowNetwork: false } } }) as never;

describe('the canary chooses its Catalog explicitly (R4_CANARY_CATALOG_SOURCE)', () => {
  it('unset keeps v1 for the existing canary profiles (nothing changes for them); v2 is opt-in', () => {
    expect(canaryCatalogSource({}, SALES_PRODUCTION_PROFILE_V7)).toBe('v1');
    expect(canaryCatalogSource({ R4_CANARY_CATALOG_SOURCE: 'v2' }, SALES_PRODUCTION_PROFILE_V7)).toBe('v2');
    expect(canaryCatalogConfig({ ...V1_ENV, ...V2_ENV }, canaryOf(SALES_PRODUCTION_PROFILE_V7))).toEqual({ baseUrl: 'http://127.0.0.1:4010', apiKey: V1_ENV.R4_CATALOG_API_KEY, timeoutMs: 2500 });
  });

  it('the F1 canary (@12) binds Catalog V2 only, and only when it says so', () => {
    expect(() => canaryCatalogSource({}, SALES_PRODUCTION_PROFILE_V12)).toThrow(/binds Catalog V2 only/);
    expect(() => canaryCatalogSource({ R4_CANARY_CATALOG_SOURCE: 'v1' }, SALES_PRODUCTION_PROFILE_V12)).toThrow(/binds Catalog V2 only/);
    expect(canaryCatalogConfig({ ...V1_ENV, ...V2_ENV, R4_CANARY_CATALOG_SOURCE: 'v2' }, canaryOf(SALES_PRODUCTION_PROFILE_V12))).toEqual({ source: 'v2', baseUrl: 'http://127.0.0.1:4011', apiKey: V2_ENV.R4_CATALOG_V2_API_KEY, timeoutMs: 5000 });
  });

  it('(Quote V2 lane canary) the isolated canary runs the quote lane @14, on Catalog V2 only (never @13 or @15)', () => {
    expect(CANARY_PROFILES.map(profileLabel)).toContain('sales-production@14');
    expect(CANARY_PROFILES.map(profileLabel)).not.toEqual(expect.arrayContaining(['sales-production@13']));
    expect(CANARY_PROFILES.map(profileLabel)).not.toContain('sales-production@15');
    expect(() => canaryCatalogSource({}, SALES_PRODUCTION_PROFILE_V14)).toThrow(/binds Catalog V2 only/);
    expect(canaryCatalogSource({ R4_CANARY_CATALOG_SOURCE: 'v2' }, SALES_PRODUCTION_PROFILE_V14)).toBe('v2');
  });

  it('a chosen V2 with incomplete V2 variables is refused even when V1 is fully configured (no silent fallback)', () => {
    expect(() => canaryCatalogConfig({ ...V1_ENV, R4_CANARY_CATALOG_SOURCE: 'v2' }, canaryOf(SALES_PRODUCTION_PROFILE_V12))).toThrow(/missing R4_CATALOG_V2_BASE_URL, R4_CATALOG_V2_API_KEY, R4_CATALOG_V2_TIMEOUT_MS/);
    expect(() => canaryCatalogConfig({ ...V1_ENV, R4_CANARY_CATALOG_SOURCE: 'v2' }, canaryOf(SALES_PRODUCTION_PROFILE_V7))).toThrow(/catalog_config_incomplete|missing R4_CATALOG_V2/);
  });

  it('refuses an unknown source value', () => {
    for (const value of ['V2', 'catalog-v2', 'both', '2']) expect(() => canaryCatalogSource({ R4_CANARY_CATALOG_SOURCE: value }, SALES_PRODUCTION_PROFILE_V7), value).toThrow(/must be "v1" or "v2"/);
  });
});

describe('the production composition cannot be switched to Catalog V2 by configuration', () => {
  const ROOT = fileURLToPath(new URL('../../../agents/sales/src', import.meta.url));
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? sources(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
  const nonCanary = sources(ROOT).filter((file) => !relative(ROOT, file).replaceAll('\\', '/').startsWith('cli/canary/'));

  it('no Sales source outside the canary CLI reads the V2 variables or the canary source selector; only the lane files name them (refusals, contract refs)', () => {
    const reads = /env(\.|\[['"])R4_CATALOG_V2_|R4_CANARY_CATALOG_SOURCE|CATALOG_V2_ENV/;
    expect(nonCanary.filter((file) => reads.test(readFileSync(file, 'utf8'))).map((f) => relative(ROOT, f))).toEqual([]);
    const named = nonCanary.filter((file) => /R4_CATALOG_V2_/.test(readFileSync(file, 'utf8'))).map((f) => relative(ROOT, f).replaceAll('\\', '/')).sort();
    expect(named).toEqual(['production/composition.ts', 'production/profile-v13.ts']);
  });

  it('every Catalog configuration the production CLI loads takes its source from the profile (salesCatalogSourceOf), never a literal or a variable', () => {
    const production = readFileSync(join(ROOT, 'cli', 'production.ts'), 'utf8');
    const calls = [...production.matchAll(/loadCatalogHttpConfig\(process\.env, \{([^}]*)\}/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThan(0);
    expect(production.match(/loadCatalogHttpConfig\(/g)?.length).toBe(calls.length);
    for (const options of calls) expect(options, options).toMatch(/^ allowNetwork: production\.config\.allowNetwork, source: salesCatalogSourceOf\((profile|workerProfile\(production\))\) $/);
  });

  it('salesCatalogSourceOf: v1 for every production and canary profile; v2 only for the lane profiles @13, @14 and @15', () => {
    for (const p of [...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES]) expect(salesCatalogSourceOf(p), profileLabel(p)).toBe('v1');
    expect(SALES_LANE_PROFILES.map(profileLabel)).toEqual(['sales-production@13', 'sales-production@14', 'sales-production@15', 'sales-production@16', 'sales-production@17', 'sales-production@18']);
    expect(salesCatalogSourceOf(SALES_PRODUCTION_PROFILE_V13)).toBe('v2');
  });
});
