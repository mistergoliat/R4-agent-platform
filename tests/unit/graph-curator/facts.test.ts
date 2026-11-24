import { describe, expect, it } from 'vitest';
import { withFacts, type CatalogFact } from '@r4-graph/curator';

const sheet = (specs: Record<string, string>): CatalogFact => ({ name: 'Barra Power | HWM', active: true, sellable: true, category: null, price: 1, specs });
const fact = (subject: string, field: string, value: string) => ({ subject, field, value, recordedBy: 'oidc:pm', recordedAt: '2026-11-24T00:00:00.000Z' });

describe('facts answered in R4 (ADR-058 Decision 10)', () => {
  it('a fact fills a field the sheet lacks and is listed for the store; the sheet wins when it declares it', () => {
    const catalog = new Map<string, CatalogFact | 'not_found' | 'failed'>([['P1', sheet({ Perfiles: '60x60' })], ['P2', 'not_found'], ['P3', 'failed']]);
    const { catalog: merged, notices } = withFacts(catalog, [fact('P1', 'Largo de agarre', '131 cm'), fact('P1', 'Perfiles', '50x50'), fact('P2', 'x', 'y'), fact('P3', 'x', 'y'), fact('nope', 'x', 'y')]);
    expect((merged.get('P1') as CatalogFact).specs).toEqual({ Perfiles: '60x60', 'Largo de agarre': '131 cm' });
    expect(notices.map((n) => [n.rule, n.productKey, n.evidence.field])).toEqual([['FACT_NOT_IN_SHEET', 'P1', 'Largo de agarre']]);
    expect(notices[0]!.summary).toBe('Barra Power: «Largo de agarre: 131 cm» está en R4, falta cargarlo en la ficha de la tienda');
    expect(catalog.get('P1')).toEqual(sheet({ Perfiles: '60x60' })); // the input is not mutated
  });
});
