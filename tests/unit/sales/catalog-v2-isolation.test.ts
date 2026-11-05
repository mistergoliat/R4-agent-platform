import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SALES_PRODUCTION_PROFILE_V7, SALES_PRODUCTION_PROFILE_V12 } from '@r4-sales/agent/production';
import { canaryCatalogConfig, canaryCatalogSource } from '../../../agents/sales/src/cli/canary/command.js';

/**
 * R4-CATALOG-V2 isolation (§5): only the isolated canary can bind Catalog V2, by an explicit choice; the F1 canary (@12)
 * binds V2 only; the production composition (sales-production@3 and every production profile) keeps reading
 * R4_CATALOG_* (V1) and cannot be switched to V2 by configuration.
 */
const V1_ENV = { R4_CATALOG_BASE_URL: 'http://127.0.0.1:4010', R4_CATALOG_API_KEY: 'v1-key-0123456789abcdef', R4_CATALOG_TIMEOUT_MS: '2500' };
const V2_ENV = { R4_CATALOG_V2_BASE_URL: 'http://127.0.0.1:4011', R4_CATALOG_V2_API_KEY: 'v2-key-0123456789abcdef', R4_CATALOG_V2_TIMEOUT_MS: '5000' };
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

  it('no Sales source outside the canary CLI reads the V2 variables or the canary source selector', () => {
    expect(nonCanary.filter((file) => /R4_CATALOG_V2_|R4_CANARY_CATALOG_SOURCE|CATALOG_V2_ENV/.test(readFileSync(file, 'utf8'))).map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('every Catalog configuration the production CLI loads is the default source (v1)', () => {
    const production = readFileSync(join(ROOT, 'cli', 'production.ts'), 'utf8');
    const calls = production.match(/loadCatalogHttpConfig\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => /source/.test(c))).toEqual([]);
  });
});
