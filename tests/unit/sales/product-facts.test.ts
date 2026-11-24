import { describe, expect, it } from 'vitest';
import type { CatalogPort, CatalogProductContext } from '@r4-adapters/domains';
import { createSilentLogger } from '@r4/observability';
import { ProductFactsSource, catalogWithFacts, withFacts } from '../../../agents/sales/src/production/product-facts.js';

/** ADR-058 G5b: what a person answered once in R4 reaches Pesín as part of the product sheet (the store wins). */
const found = (specifications: { name: string; value: string }[]) => ({ status: 'found', productKey: 'P1', facts: { name: 'Barra Power', specifications } }) as unknown as CatalogProductContext;

describe('product facts in the sheets Pesín reads', () => {
  it('a fact fills a field the sheet lacks; the sheet wins on a field it declares (any case)', () => {
    const context = withFacts(found([{ name: 'Diámetro de manga', value: '50 mm' }, { name: 'Perfiles', value: '' }]), [
      { subject: 'P1', field: 'diámetro de manga', value: '49 mm' },
      { subject: 'P1', field: 'Largo de agarre', value: '131 cm' },
      { subject: 'P1', field: 'Perfiles', value: '60x60' },
    ]);
    expect(context.status === 'found' && context.facts.specifications).toEqual([
      { name: 'Diámetro de manga', value: '50 mm' }, { name: 'Perfiles', value: '' }, { name: 'Largo de agarre', value: '131 cm' }, { name: 'Perfiles', value: '60x60' },
    ]);
    const notFound = { status: 'not_found', productKey: 'P9' } as const;
    expect(withFacts(notFound, [{ subject: 'P9', field: 'x', value: 'y' }])).toBe(notFound);
  });

  it('the wrapped port adds the facts to product sheets and passes everything else through', async () => {
    const calls: string[] = [];
    const port = {
      search: () => { calls.push('search'); return Promise.resolve({ results: [] }); },
      getItemContext: () => { calls.push('item'); return Promise.resolve({ status: 'not_found' }); },
      getProductContext: () => Promise.resolve(found([])),
    } as unknown as CatalogPort;
    const wrapped = catalogWithFacts(port, { of: (k) => (k === 'P1' ? [{ subject: 'P1', field: 'Largo de agarre', value: '131 cm' }] : []) });
    const context = await wrapped.getProductContext('P1');
    expect(context.status === 'found' && context.facts.specifications).toEqual([{ name: 'Largo de agarre', value: '131 cm' }]);
    await wrapped.search({} as never);
    await wrapped.getItemContext({} as never);
    expect(calls).toEqual(['search', 'item']);
  });

  it('a failed read keeps the facts in use; a failed first read starts with none', async () => {
    let fail = false;
    let facts = [{ subject: 'P1', field: 'Perfiles', value: '50x50' }];
    const read = () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(facts));
    const source = await ProductFactsSource.load(read, createSilentLogger());
    expect(source.of('P1')).toEqual(facts);
    fail = true;
    facts = [];
    expect(await source.refresh()).toBe(false);
    expect(source.of('P1')).toHaveLength(1);
    const empty = await ProductFactsSource.load(() => Promise.reject(new Error('db down')), createSilentLogger());
    expect([empty.size, empty.of('P1')]).toEqual([0, []]);
  });
});
