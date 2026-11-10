import { describe, expect, it } from 'vitest';
import { guardIntentReply, parseConfirmation } from '@r4-sales/agent';

/**
 * (sales-production@19, owner decision 2026-11-10) The agent interprets the customer's acceptance in natural language;
 * the platform's deterministic guard refuses only what is certainly not an acceptance. The closed grammar of @6–@18 is
 * unchanged.
 */
describe('intent guard (r4-sales-intent-guard-es-v1)', () => {
  it.each(['si', 'sí', 'si porfa', 'sí, dale', 'dale', 'oka', 'ok, me parece', 'perfecto', 'sí, emítelas', 'si emitela pls', 'mándamela', 'listo, gracias', 'sí! 👍', 'de una', 'ya po, emítela'])('lets the agent accept %j', (text) => {
    expect(guardIntentReply(text)).toMatchObject({ confirmed: true });
  });

  it.each([
    ['¿y con despacho?', 'disqualified'], ['incluye despacho?', 'disqualified'], ['no', 'disqualified'], ['no gracias', 'disqualified'],
    ['mejor 2', 'disqualified'], ['cámbiala por la de 16 kg', 'disqualified'], ['agrégale otra', 'disqualified'], ['sácale una', 'disqualified'],
    ['espera', 'disqualified'], ['lo pienso y te aviso', 'disqualified'], ['después veo', 'disqualified'], ['quizás', 'disqualified'],
    ['sí, pero sin IVA', 'disqualified'], ['en vez de la HWM la otra', 'disqualified'], ['', 'empty'], ['x'.repeat(401), 'too_long'],
  ])('never takes %j as acceptance (%s)', (text, reason) => {
    expect(guardIntentReply(text)).toEqual({ confirmed: false, reason });
  });

  it('the closed grammar of @6–@18 is unchanged (it still refuses the natural replies of the first canary)', () => {
    for (const text of ['si', 'si emitela pls', 'sí, emítelas']) expect(parseConfirmation(text).confirmed).toBe(false);
    for (const text of ['Sí, emítela.', 'confirmo']) expect(parseConfirmation(text).confirmed).toBe(true);
  });
});
