import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_STATES, MASK, knowledgeTransitionScope, maskContact } from '@r4/persistence-postgres';

/** ADR-052 pure helpers: contact masking of the learning gaps' text, and the knowledge transition table. */
describe('ADR-052 maskContact', () => {
  it.each([
    ['escríbeme a ana.perez+ventas@example.cl mañana', `escríbeme a ${MASK} mañana`],
    ['mi número es 56912345678', `mi número es ${MASK}`],
    ['llamar al +56 9 1234 5678 o al (2) 2345-6789', `llamar al ${MASK} o al ${MASK}`],
    ['RUT 12.345.678-9', `RUT ${MASK}`],
    ['dos: a@b.co y 123456789', `dos: ${MASK} y ${MASK}`],
  ])('%s', (text, masked) => {
    expect(maskContact(text)).toBe(masked);
  });

  it.each(['cuesta 1.299.990', 'pedido 1234567', 'medidas 120 x 60 x 75 cm', 'sin datos', 'a@b', 'usuario @handle'])('keeps %s', (text) => {
    expect(maskContact(text)).toBe(text);
  });

  it('null stays null', () => {
    expect(maskContact(null)).toBeNull();
  });
});

describe('ADR-052 knowledge transitions', () => {
  const allowed: Record<string, string> = {
    'proposed>verified': 'knowledge.curate',
    'verified>signed': 'knowledge.sign',
    'proposed>retired': 'knowledge.curate',
    'verified>retired': 'knowledge.curate',
    'signed>retired': 'knowledge.curate',
  };
  it('exactly the documented transitions, each with its scope; everything else does not exist', () => {
    for (const from of KNOWLEDGE_STATES) {
      for (const to of KNOWLEDGE_STATES) expect(knowledgeTransitionScope(from, to), `${from}>${to}`).toBe(allowed[`${from}>${to}`] ?? null);
    }
  });
});
