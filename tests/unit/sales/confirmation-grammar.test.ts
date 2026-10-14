import { describe, expect, it } from 'vitest';
import { CONFIRMATION_GRAMMAR_VERSION, formatClp, offerReference, parseConfirmation, presentsOffer } from '@r4-sales/agent';

/**
 * R4-J3E-B: the closed confirmation grammar. Positive cases must parse as a
 * whole; every negative case must be refused — the examples are test cases,
 * not keywords.
 */
describe('confirmation grammar r4-sales-confirmation-es-v1', () => {
  it('is versioned', () => {
    expect(CONFIRMATION_GRAMMAR_VERSION).toBe('r4-sales-confirmation-es-v1');
  });

  it.each([
    'Sí, confirmo esa cotización. Emítela por favor.',
    'Confirmo la cotización.',
    'Sí, emítela.',
    'CONFIRMO',
    'confirmo',
    'Si confirmo',
    'Ok, confirmo esta cotización',
    'Dale, emítela por favor',
    'De acuerdo, confirmo.',
    'Perfecto, confirmo la cotización, gracias',
    'Sí por favor, emítela',
    'Confirmo y emítela',
    'Emite la cotización por favor',
    '  sí,   CONFIRMO  !! ',
  ])('accepts %j', (text) => {
    expect(parseConfirmation(text)).toMatchObject({ confirmed: true });
  });

  it.each([
    ['No confirmo.', 'disqualified'],
    ['¿Qué pasa si confirmo?', 'disqualified'],
    ['Confirmo, pero cambia la dirección.', 'disqualified'],
    ['Todavía no.', 'disqualified'],
    ['Cotiza otro producto', 'disqualified'],
    ['Confirmo?', 'disqualified'],
    ['¿Confirmo?', 'disqualified'],
    ['no', 'disqualified'],
    ['Espera, confirmo después', 'disqualified'],
    ['Creo que confirmo', 'disqualified'],
    ['Mejor no', 'disqualified'],
    ['Confirmo, cambia el despacho', 'disqualified'],
    ['Sí', 'not_a_confirmation'],
    ['Dale', 'not_a_confirmation'],
    ['Ok', 'not_a_confirmation'],
    ['Perfecto, gracias', 'not_a_confirmation'],
    ['Quiero la cotización', 'not_a_confirmation'],
    ['Confirmo la dirección', 'not_a_confirmation'],
    ['Confirmo el pedido', 'not_a_confirmation'],
    ['Puedes emitirla', 'not_a_confirmation'],
    ['Confirmo la cotización de la bicicleta', 'not_a_confirmation'],
    ['Emítela a mi correo', 'not_a_confirmation'],
    ['Sí, emítela y agrega una barra', 'not_a_confirmation'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['!!!', 'empty'],
    [`Confirmo ${'por favor '.repeat(20)}`, 'too_long'],
  ])('refuses %j (%s)', (text, reason) => {
    expect(parseConfirmation(text)).toEqual({ confirmed: false, reason });
  });

  it('refuses a missing message', () => {
    expect(parseConfirmation(null)).toEqual({ confirmed: false, reason: 'empty' });
  });
});

describe('offer presentation binding', () => {
  const previewId = '5f57b2751489b1c0e82cb14423b583457fb932537e0a12e5570f0bc608332b1d';

  it('derives the reference from the previewId and the commercial version', () => {
    expect(offerReference(previewId, 3)).toBe('Q-5F57B2-3');
    expect(formatClp(52_980)).toBe('52.980');
    expect(formatClp(1_234_567)).toBe('1.234.567');
    expect(formatClp(990)).toBe('990');
  });

  it('requires the exact reference token and the gross total in the message', () => {
    const ok = 'Total: $52.980 (IVA incluido) · Ref. Q-5F57B2-3. ¿Emito la cotización?';
    expect(presentsOffer(ok, 'Q-5F57B2-3', 52_980)).toBe(true);
    expect(presentsOffer('Total $52980, referencia q-5f57b2-3', 'Q-5F57B2-3', 52_980)).toBe(true);
    expect(presentsOffer(ok, 'Q-5F57B2-4', 52_980), 'another commercial version').toBe(false);
    expect(presentsOffer(ok.replace('Q-5F57B2-3', 'Q-5F57B2-30'), 'Q-5F57B2-3', 52_980), 'a longer reference').toBe(false);
    expect(presentsOffer(ok, 'Q-AAAAAA-3', 52_980), 'another snapshot').toBe(false);
    expect(presentsOffer(ok, 'Q-5F57B2-3', 52_981), 'another total').toBe(false);
    expect(presentsOffer('Total: $152.980 · Ref. Q-5F57B2-3', 'Q-5F57B2-3', 52_980), 'a number containing the total').toBe(false);
    expect(presentsOffer(null, 'Q-5F57B2-3', 52_980)).toBe(false);
  });
});
