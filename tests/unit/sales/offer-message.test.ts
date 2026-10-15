import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OFFER_MESSAGE_MAX_CHARS, OFFER_TEMPLATE_VERSION, offerReference, parseConfirmation, presentsOffer, renderOfferMessage, type OfferContent } from '@r4-sales/agent';

/**
 * R4-J3E-C1: the offer message template r4-sales-offer-es-v1. Sales writes the
 * whole commercial message the customer confirms. The goldens pin the exact
 * text: any wording change is a new template version, never an edit.
 */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const ONE_LINE: OfferContent = {
  lines: [{ position: 1, description: 'Par Mancuernas Hexagonales 12.5kg | HWM®', attributes: [], quantity: 1, unitPrice: { amount: 47_990 }, amounts: { gross: 47_990 } }],
  shipping: { kind: 'selected', carrierName: 'Pesas Chile', serviceType: 'Despacho Directo', commune: 'Ñuñoa', region: 'Metropolitana de Santiago', amounts: { gross: 4_990 } },
  totals: { net: 44_521, tax: 8_459, gross: 52_980 },
};
const ONE_LINE_REF = offerReference('5f57b2751489b1c0e82cb14423b583457fb932537e0a12e5570f0bc608332b1d', 2);
const ONE_LINE_TEXT = [
  'Cotización lista para emitir (Ref. Q-5F57B2-2)',
  '',
  '1. Par Mancuernas Hexagonales 12.5kg | HWM®',
  'Cantidad: 1; precio unitario: $47.990; subtotal: $47.990',
  '',
  'Despacho: Pesas Chile, Despacho Directo, a Ñuñoa, Metropolitana de Santiago: $4.990',
  '',
  'Neto: $44.521',
  'IVA: $8.459',
  'Total: $52.980 (IVA incluido)',
  '',
  'Condiciones: montos en pesos chilenos, con IVA incluido salvo el neto. No incluye descuentos ni otros cargos. Al emitir se verifican de nuevo precios, stock y despacho: si algo cambió, no se emite y te presento la oferta actualizada. El número y la validez de la cotización se informan al emitirla.',
  '¿Emito esta cotización? Puedes responder: Sí, emítela.',
].join('\n');

const VARIANTS_NO_REGION: OfferContent = {
  lines: [
    { position: 1, description: 'Kettlebell de competición', attributes: [{ name: 'Peso', value: '12 kg' }], quantity: 2, unitPrice: { amount: 44_990 }, amounts: { gross: 89_980 } },
    { position: 2, description: 'Seguros para barra olímpica (par)', attributes: [{ name: 'Color', value: 'Rojo' }, { name: 'Material', value: 'Nylon' }], quantity: 3, unitPrice: { amount: 9_990 }, amounts: { gross: 29_970 } },
  ],
  shipping: { kind: 'selected', carrierName: 'Fixture Courier', serviceType: null, commune: 'Valparaíso', region: null, amounts: { gross: 1 } },
  totals: { net: 100_765, tax: 19_186, gross: 119_951 },
};
const EXCLUDED: OfferContent = {
  lines: [{ position: 1, description: 'Barra Z 1,2 m', attributes: [], quantity: 5, unitPrice: { amount: 39_990 }, amounts: { gross: 199_950 } }],
  shipping: { kind: 'excluded' },
  totals: { net: 168_025, tax: 31_925, gross: 199_950 },
};

describe('offer message r4-sales-offer-es-v1', () => {
  it('is versioned and renders exactly the golden text', () => {
    expect(OFFER_TEMPLATE_VERSION).toBe('r4-sales-offer-es-v1');
    expect(renderOfferMessage(ONE_LINE, ONE_LINE_REF)).toBe(ONE_LINE_TEXT);
  });

  it('pins the rendering of three shapes (one line; variants without service or region; delivery excluded)', () => {
    expect([renderOfferMessage(ONE_LINE, ONE_LINE_REF), renderOfferMessage(VARIANTS_NO_REGION, 'Q-ABCDEF-7'), renderOfferMessage(EXCLUDED, 'Q-000000-0')].map(sha256)).toEqual([
      sha256(ONE_LINE_TEXT),
      '427e5ead8a74fae4d63da6e5a9411f4b8f5c665823d087b33c4ab0e36d0b9777',
      'b4ab7a37b2ab324c6635f80d062ffd67e5857c5d16459ac172d186e4df7de50e',
    ]);
  });

  it('prints every element: variants, quantities, unit prices, subtotals, shipping or its exclusion, net, VAT, total, reference', () => {
    const variants = renderOfferMessage(VARIANTS_NO_REGION, 'Q-ABCDEF-7');
    expect(variants).toContain('1. Kettlebell de competición\nVariante: Peso: 12 kg\nCantidad: 2; precio unitario: $44.990; subtotal: $89.980');
    expect(variants).toContain('2. Seguros para barra olímpica (par)\nVariante: Color: Rojo; Material: Nylon\nCantidad: 3; precio unitario: $9.990; subtotal: $29.970');
    expect(variants).toContain('Despacho: Fixture Courier, a Valparaíso: $1\n');
    expect(variants).toContain('Neto: $100.765\nIVA: $19.186\nTotal: $119.951 (IVA incluido)');
    expect(variants.startsWith('Cotización lista para emitir (Ref. Q-ABCDEF-7)\n')).toBe(true);
    expect(renderOfferMessage(EXCLUDED, 'Q-000000-0')).toContain('\n\nDespacho: no incluido.\n\n');
  });

  it('does no arithmetic: changing one amount of the snapshot changes exactly that figure', () => {
    const changed = renderOfferMessage({ ...ONE_LINE, totals: { ...ONE_LINE.totals, tax: 8_460 } }, ONE_LINE_REF);
    expect(changed).toBe(ONE_LINE_TEXT.replace('IVA: $8.459', 'IVA: $8.460'));
  });

  it('fixed text carries no double quote, backslash or channel formatting mark; no leading or trailing whitespace', () => {
    for (const text of [renderOfferMessage(ONE_LINE, ONE_LINE_REF), renderOfferMessage(VARIANTS_NO_REGION, 'Q-ABCDEF-7'), renderOfferMessage(EXCLUDED, 'Q-000000-0')]) {
      expect(text).not.toMatch(/["\\*_~`]/);
      expect(text).toBe(text.trim());
      expect(text.split('\n').every((line) => line === line.trimEnd())).toBe(true);
      expect(text.length).toBeLessThan(OFFER_MESSAGE_MAX_CHARS);
    }
  });

  it('the confirmation it suggests is accepted by the closed grammar; the message itself is a valid quote.create@4 presentation', () => {
    const suggestion = /Puedes responder: (.+)$/.exec(ONE_LINE_TEXT)![1]!;
    expect(parseConfirmation(suggestion)).toMatchObject({ confirmed: true });
    expect(presentsOffer(ONE_LINE_TEXT, ONE_LINE_REF, 52_980)).toBe(true);
    // The message is not itself a confirmation (an agent quoting it could never count as one).
    expect(parseConfirmation(ONE_LINE_TEXT)).toMatchObject({ confirmed: false });
  });
});
