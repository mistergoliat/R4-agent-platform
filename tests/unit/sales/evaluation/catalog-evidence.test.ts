import { describe, expect, it } from 'vitest';
import { SalesCatalogEvidenceEvaluator, SalesFixture, salesEvaluationDefinition } from '@r4-sales/agent/evaluations';

/**
 * sales-web@7 regressions (owner decision 2026-11-13; F1/F2): within one reply the agent neither re-reads a product
 * nor repeats Discover for the same need; an amount backed only by expired evidence is never stated as current; a card
 * needs an earlier observation showing the product sellable, and a card whose evidence has since expired is a
 * provisional recommendation, not a finding. Synthetic trajectories (P-keys as Catalog V2 issues them), no live data.
 */
const evaluator = new SalesCatalogEvidenceEvaluator();
const VALID_MS = 15_000; // Catalog V2 commercial window
let seq = 0;
const fixture = () => new SalesFixture({ id: `catalog-evidence-${(seq += 1)}` });

const product = (key: string, amount: number, sellability = 'sellable', variants: { itemKey: string; sellability: string; amount: number }[] = []) => ({
  status: 'found', productKey: key,
  facts: { name: `Producto ${key}`, variantOptions: variants.map((v) => ({ itemKey: v.itemKey, availability: { sellability: v.sellability }, price: { finalGross: { amount: v.amount, currency: 'CLP' } } })) },
  derived: { price: { kind: 'exact', finalGross: { amount, currency: 'CLP' }, regularGross: { amount, currency: 'CLP' } }, availability: { sellability } },
});
const discover = (need: string, candidates: { key: string; amount: number; status?: string; sellability?: string }[]) => ({
  need, status: 'COMPLETE',
  verified: candidates.map((c) => ({ productKey: c.key, itemKey: null, name: `Producto ${c.key}`, disposition: 'VERIFIED_MATCH', commercial: { status: c.status ?? 'OBSERVED', sellability: c.sellability ?? 'sellable', orderable: true, finalGrossClp: c.amount } })),
  possible: [],
});
const codes = (f: SalesFixture) => evaluator.evaluate(f.build()).findings.map((x) => x.code);
const metrics = (f: SalesFixture) => evaluator.evaluate(f.build()).metrics as Record<string, { value: number }>;

describe('sales.catalog_evidence_use — the sales-web@7 regressions', () => {
  it('is registered in the Sales evaluation definition, and every code it emits is in the taxonomy', () => {
    const definition = salesEvaluationDefinition();
    expect(definition.evaluators.some((e) => e.descriptor.ref.id === 'sales.catalog_evidence_use')).toBe(true);
    for (const code of evaluator.descriptor.emits) expect(definition.taxonomy.get(code)?.origin).toBe('sales');
  });

  it('flags the @6 loop: the same product read again in the same reply after its evidence expired', () => {
    const f = fixture().turn('cuánto cuesta todo esto');
    f.read('catalog.get_product_context', { productKey: 'P1538' }, product('P1538', 215_992), { validForMs: VALID_MS });
    f.advance(20_000);
    f.read('catalog.get_product_context', { productKey: 'P1538' }, product('P1538', 215_992), { validForMs: VALID_MS });
    f.respond('Te dejo el rack.\n[[P1538]]').wait();
    expect(codes(f)).toEqual(['catalog_reread_same_run']);
    expect(metrics(f).productRereadsSameRun!.value).toBe(1);
  });

  it('does not flag a product read once per reply, even when the next reply reads it again', () => {
    const f = fixture().turn('rack');
    f.read('catalog.get_product_context', { productKey: 'P1538' }, product('P1538', 215_992), { validForMs: VALID_MS });
    f.respond('Te dejo el rack.\n[[P1538]]').wait();
    f.turn('¿y su precio ahora?');
    f.read('catalog.get_product_context', { productKey: 'P1538' }, product('P1538', 215_992), { validForMs: VALID_MS });
    f.respond('Hoy está a $215.992.\n[[P1538]]').wait();
    expect(codes(f)).toEqual([]);
  });

  it('keeps Discover candidates as provisional recommendations: cards cited after their evidence expired are not a finding', () => {
    const f = fixture().turn('Un poco de todo');
    f.read('catalog.discover', { need: 'gimnasio en casa 3 x 3 m', limit: 8, constraints: { sellableOnly: true } }, discover('gimnasio en casa 3 x 3 m', [{ key: 'P1538', amount: 215_992 }, { key: 'P1161', amount: 419_990 }, { key: 'P82', amount: 89_990 }]), { validForMs: VALID_MS });
    f.advance(30_000);
    f.respond('Te propongo este set; puedes agregarlo completo.\n[[P1538]]\n[[P1161]]\n[[P82]]').wait();
    expect(codes(f)).toEqual([]);
    expect(metrics(f).provisionalCards!.value).toBe(3);
    expect(metrics(f).cardsCited!.value).toBe(3);
  });

  it('flags Discover repeated with the same need and constraints in the same reply (not a new need)', () => {
    const f = fixture().turn('fuerza');
    const args = { need: 'Barra y discos para entrenar fuerza en casa', limit: 6, constraints: { sellableOnly: true } };
    f.read('catalog.discover', args, discover(args.need, [{ key: 'P666', amount: 134_992 }]), { validForMs: VALID_MS });
    f.advance(20_000);
    f.read('catalog.discover', { ...args, need: 'barra y discos para entrenar  fuerza en casa' }, discover(args.need, [{ key: 'P666', amount: 134_992 }]), { validForMs: VALID_MS });
    f.read('catalog.discover', { ...args, need: 'banco regulable para casa' }, discover('banco', [{ key: 'P1447', amount: 55_990 }]), { validForMs: VALID_MS });
    f.respond('Te propongo la barra y el banco.\n[[P666]]\n[[P1447]]').wait();
    expect(codes(f)).toEqual(['discover_repeated_same_need']);
  });

  it('flags an amount stated as current when its only evidence had expired; a current read of the same amount clears it', () => {
    const expired = fixture().turn('precio de la barra');
    expired.read('catalog.get_product_context', { productKey: 'P32' }, product('P32', 119_992), { validForMs: VALID_MS });
    expired.advance(30_000);
    expired.respond('La barra está a $119.992 hoy.\n[[P32]]').wait();
    expect(codes(expired)).toEqual(['price_from_expired_evidence']);

    const current = fixture().turn('precio de la barra');
    current.read('catalog.get_product_context', { productKey: 'P32' }, product('P32', 119_992), { validForMs: VALID_MS });
    current.respond('La barra está a $119.992 hoy.\n[[P32]]').wait();
    expect(codes(current)).toEqual([]);
  });

  it('flags a card for a product no observation showed, or showed only as not sellable', () => {
    const f = fixture().turn('muéstrame discos');
    f.read('catalog.search', { query: 'discos' }, { results: [{ productKey: 'P145', name: 'Par Discos 10 kg', availability: { sellability: 'not_sellable' }, price: { finalGross: { amount: 45_990 } } }] }, { validForMs: VALID_MS });
    f.respond('Mira estos.\n[[P145]]\n[[P999]]').wait();
    expect(codes(f)).toEqual(['card_without_sellable_evidence', 'card_without_sellable_evidence']);
  });

  it('accepts a variant card with a quantity (the web cart flow) when that variant was shown sellable', () => {
    const f = fixture().turn('guantes talla M, dos pares');
    f.read('catalog.get_product_context', { productKey: 'P1675' }, product('P1675', 19_990, 'sellable', [{ itemKey: 'P1675-V463', sellability: 'sellable', amount: 19_990 }, { itemKey: 'P1675-V462', sellability: 'not_sellable', amount: 19_990 }]), { validForMs: VALID_MS });
    f.respond('Te dejo los de talla M.\n[[P1675-V463 x2]]').wait();
    expect(codes(f)).toEqual([]);
    const g = fixture().turn('talla S');
    g.read('catalog.get_product_context', { productKey: 'P1675' }, product('P1675', 19_990, 'sellable', [{ itemKey: 'P1675-V462', sellability: 'not_sellable', amount: 19_990 }]), { validForMs: VALID_MS });
    g.respond('Te dejo la S.\n[[P1675-V462]]').wait();
    expect(codes(g)).toEqual(['card_without_sellable_evidence']);
  });
});
