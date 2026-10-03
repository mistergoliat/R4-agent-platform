import { describe, expect, it } from 'vitest';
import { SHIPPING_REFERENCE_WEIGHT_KG, SHIPPING_VAT_POLICY, deriveShippingGross, normalizeCommuneName, offerPriceOf, quotedBasisOf } from '@r4-adapters/domains';

describe('G. VAT policy: customer gross = round-half-up(owner net × 1.19)', () => {
  it('is explicit and versioned', () => {
    expect(SHIPPING_VAT_POLICY).toEqual({ id: 'cl-iva-19@r4-j2b', rate: 0.19, numerator: 119, denominator: 100 });
    expect(Object.isFrozen(SHIPPING_VAT_POLICY)).toBe(true);
  });

  it('derives representative owner nets exactly (real J2A owner amounts included)', () => {
    const cases: readonly [net: number, gross: number][] = [
      [0, 0],
      [1, 1], // Despacho Directo incentive: stays 1 CLP, never "free"
      [50, 60], // exact half (59.5) rounds up
      [3175, 3778],
      [3713, 4418],
      [4193, 4990],
      [5034, 5990],
      [8395, 9990],
      [20160, 23990],
      [46210, 54990],
      [35622, 42390],
    ];
    for (const [net, gross] of cases) expect(deriveShippingGross(net), String(net)).toEqual({ policy: 'cl-iva-19@r4-j2b', rate: 0.19, taxAmount: gross - net, grossAmount: gross });
  });

  it('keeps the owner net untouched next to the derived gross, and applies once', () => {
    const price = offerPriceOf(3175);
    expect(price).toEqual({ ownerNet: { amount: 3175, currency: 'CLP' }, tax: { policy: 'cl-iva-19@r4-j2b', rate: 0.19, amount: 603 }, customerGross: { amount: 3778, currency: 'CLP' }, grossDerivedBy: 'r4_shipping_adapter' });
    // A second application would be 4496: the price object never feeds its gross back as a net.
    expect(price.customerGross.amount).not.toBe(deriveShippingGross(3778).grossAmount);
    expect(price.customerGross.amount - price.ownerNet.amount).toBe(price.tax.amount);
  });

  it('preserves a non-integer owner net verbatim and still yields whole CLP gross', () => {
    expect(offerPriceOf(3712.857)).toMatchObject({ ownerNet: { amount: 3712.857 }, customerGross: { amount: 4418 } });
  });

  it('refuses a negative or non-finite net (never invents a price)', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => deriveShippingGross(bad), String(bad)).toThrow(RangeError);
  });
});

describe('shipping basis and commune normalization', () => {
  it('the reference basis is a fixed 1 kg, 1×1×1 cm package with no declared value', () => {
    expect(SHIPPING_REFERENCE_WEIGHT_KG).toBe(1);
    expect(quotedBasisOf({ type: 'reference' })).toEqual({ type: 'reference', weightKg: 1, declaredValue: null, dimensionsCm: { height: 1, width: 1, depth: 1, source: 'production_convention' } });
  });

  it('normalization is trim + diacritics + case only (no whitespace collapsing, no fuzzy rewriting)', () => {
    expect(normalizeCommuneName('  Ñuñoa ')).toBe('nunoa');
    expect(normalizeCommuneName('OLLAGÜE')).toBe('ollague');
    expect(normalizeCommuneName('Santiago  Centro')).toBe('santiago  centro');
    expect(normalizeCommuneName('San Migel')).toBe('san migel');
  });
});
