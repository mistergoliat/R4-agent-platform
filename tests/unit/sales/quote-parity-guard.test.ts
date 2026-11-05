import { describe, expect, it } from 'vitest';
import { QUOTE_PARITY_ENV, assertQuoteParityConfigured, createQuoteParityGuard, loadQuoteParityGuard } from '@r4-sales/agent';

const NOW = new Date('2026-11-05T12:00:00Z');
const item = { itemKey: 'SKU-1', productRef: 'P1', variantRef: null, sku: 'ABC-1', finalGross: 10_990, availableQuantity: 4, verifiedAt: '2026-11-05T11:50:00Z', source: 'catalog-parity-run-1' };
const evidence = (items: unknown[] = [item]) => ({ schemaVersion: 1, items });
const line = { itemKey: 'SKU-1', productRef: 'P1', variantRef: null, sku: 'ABC-1', unitGross: 10_990, quantity: 2 };

describe('quote parity guard (R4-J5 F1, P-1): the evidence is untrusted input and fails closed', () => {
  it.each([
    ['missing field', evidence([{ ...item, sku: undefined }])],
    ['extra field', evidence([{ ...item, note: 'x' }])],
    ['negative price', evidence([{ ...item, finalGross: -1 }])],
    ['bad date', evidence([{ ...item, verifiedAt: 'yesterday' }])],
    ['duplicate item', evidence([item, item])],
    ['empty set', evidence([])],
    ['unknown schema', { schemaVersion: 2, items: [item] }],
  ])('refuses %s', (_, input) => {
    expect(() => createQuoteParityGuard({ evidence: input, maxAgeSeconds: 3600 })).toThrow(/refusing quote parity evidence/);
  });

  it.each([0, -5, 1.5, Number.NaN, 8 * 24 * 3600])('refuses max age %s', (maxAgeSeconds) => {
    expect(() => createQuoteParityGuard({ evidence: evidence(), maxAgeSeconds })).toThrow(/MAX_AGE_SECONDS/);
  });

  it('checks set membership, currency, identity, price and stock', () => {
    const g = createQuoteParityGuard({ evidence: evidence(), maxAgeSeconds: 3600 });
    expect(g.check(line, NOW)).toBeNull();
    expect(g.check({ ...line, quantity: 4 }, NOW)).toBeNull();
    expect(g.check({ ...line, itemKey: 'SKU-2' }, NOW)?.code).toBe('item_not_parity_verified');
    expect(g.check(line, new Date('2026-11-05T12:50:01Z'))?.code).toBe('item_parity_stale');
    expect(g.check(line, new Date('2026-11-05T11:00:00Z'))?.code).toBe('item_parity_stale');
    expect(g.check({ ...line, unitGross: 10_991 }, NOW)).toMatchObject({ code: 'item_parity_mismatch', details: { field: 'price', verified: 10_990, current: 10_991 } });
    expect(g.check({ ...line, sku: 'ABC-2' }, NOW)).toMatchObject({ code: 'item_parity_mismatch', details: { field: 'sku' } });
    expect(g.check({ ...line, productRef: 'P9' }, NOW)).toMatchObject({ code: 'item_parity_mismatch', details: { field: 'productRef' } });
    expect(g.check({ ...line, variantRef: 'V1' }, NOW)).toMatchObject({ code: 'item_parity_mismatch', details: { field: 'variantRef' } });
    expect(g.check({ ...line, quantity: 5 }, NOW)).toMatchObject({ code: 'item_parity_mismatch', details: { field: 'stock', verified: 4, current: 5 } });
  });

  it('a profile that requires the guard cannot compose without it; other profiles are unaffected', () => {
    const g = createQuoteParityGuard({ evidence: evidence(), maxAgeSeconds: 3600 });
    const required = new Set(['sales-production@99']);
    expect(() => assertQuoteParityConfigured('sales-production@99', null, required)).toThrow(/parity-verified SKU set/);
    expect(() => assertQuoteParityConfigured('sales-production@99', undefined, required)).toThrow(/parity-verified SKU set/);
    expect(() => assertQuoteParityConfigured('sales-production@99', g, required)).not.toThrow();
    expect(() => assertQuoteParityConfigured('sales-production@7', null, required)).not.toThrow();
  });

  it('the evidence in use is identified by a fingerprint: same evidence, same fingerprint; any change, another', () => {
    const a = createQuoteParityGuard({ evidence: evidence(), maxAgeSeconds: 3600 });
    expect(a).toMatchObject({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), items: 1, maxAgeSeconds: 3600 });
    expect(createQuoteParityGuard({ evidence: evidence(), maxAgeSeconds: 60 }).fingerprint).toBe(a.fingerprint);
    expect(createQuoteParityGuard({ evidence: evidence([{ ...item, finalGross: 10_991 }]), maxAgeSeconds: 3600 }).fingerprint).not.toBe(a.fingerprint);
  });

  it('loads from the environment: absent file = no guard; unreadable or invalid = refusal', () => {
    expect(loadQuoteParityGuard({})).toBeNull();
    const env = { [QUOTE_PARITY_ENV.file]: 'evidence.json', [QUOTE_PARITY_ENV.maxAgeSeconds]: '3600' };
    expect(loadQuoteParityGuard(env, () => JSON.stringify(evidence()))?.check(line, NOW)).toBeNull();
    expect(() => loadQuoteParityGuard(env, () => '{not json')).toThrow(/not readable JSON/);
    expect(() =>
      loadQuoteParityGuard(env, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/not readable JSON/);
    expect(() => loadQuoteParityGuard({ [QUOTE_PARITY_ENV.file]: 'evidence.json' }, () => JSON.stringify(evidence()))).toThrow(/MAX_AGE_SECONDS/);
  });
});
