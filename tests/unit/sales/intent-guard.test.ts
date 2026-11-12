import { describe, expect, it } from 'vitest';
import { frameImage, frameTranscript, frameUnavailable } from '@r4-sales/agent/production';
import { guardIntentReply, parseConfirmation } from '@r4-sales/agent';

/**
 * (sales-production@19, owner decision 2026-11-10) The agent interprets the customer's acceptance in natural language;
 * the platform's deterministic guard refuses only what is certainly not "issue this offer as presented". The closed
 * grammar of @6–@18 is unchanged. Cases from the first @18 canary and from the independent review of #66.
 */
describe('intent guard (r4-sales-intent-guard-es-v1)', () => {
  it.each([
    'si', 'sí', 'si porfa', 'sí, dale', 'dale', 'oka', 'ok, me parece', 'perfecto', 'sí, emítelas', 'si emitela pls', 'mándamela',
    'listo, gracias', 'sí, gracias', 'sí! 👍', 'de una', 'ya po, emítela', 'qué bueno, dale', 'sí, solo eso', 'sí, sin despacho',
    '👍', '👍🏽', '✅', '👌', '🙌🔥',
  ])('lets the agent accept %j', (text) => {
    expect(guardIntentReply(text)).toMatchObject({ confirmed: true });
  });

  it.each([
    // questions, with or without a question mark
    '¿y con despacho?', 'incluye despacho?', 'incluye despacho', 'y el despacho', 'y con despacho', 'cual es la garantía', 'que garantía tiene',
    'como pago', 'donde retiro', 'por que tan caro', 'tienen stock', 'hay descuento', 'puedo pagar en cuotas', 'se puede retirar',
    'aceptan tarjeta', 'me la pueden enviar', 'y si son 3', 'sí？',
    // negations and Chilean refusals
    'no', 'no gracias', 'nooo', 'nah', 'nel', 'nopo', 'nones', 'negativo', 'nada', 'paso', 'filo', 'olvídalo', 'déjalo', 'cancela',
    'ni cagando', 'ni ahí', 'ni loco', 'chao', 'gracias', 'gracias igual', 'ok gracias', 'está bien así',
    // hesitations and postponements
    'mmm', 'hmm', 'mmm ok', 'a ver', 'ya veremos', 'puede ser', 'capaz', 'talvez', 'kizas', 'igual', 'veamos', 'déjame ver', 'lo veo',
    'lo reviso', 'te aviso', 'te confirmo', 'te confirmo más rato', 'más rato', 'mas tarde', 'en un rato', 'un momento',
    'la próxima semana', 'lo consulto con mi señora', 'voy a consultar', 'nose', 'ns', 'ni idea', 'por ahora', 'jaja', 'jajaja que caro',
    'ok perooo', 'espera', 'lo pienso y te aviso', 'después veo', 'quizás',
    // price talk
    'muy caro', 'está caro', 'carísimo', 'fuera de mi presupuesto', 'me excede', 'rebaja', 'dame descuento', 'hazme precio',
    'precio especial', 'déjamela en 100 lucas', 'a 90.000', '$90.000', 'en 3 cuotas', 'con factura',
    // conditions and changes (another product, variant, colour, quantity)
    'si me haces descuento dale', 'si incluye despacho', 'si es con despacho', 'sí, con despacho', 'sí, con instalación', 'sí, sin la barra',
    'sí, solo la barra', 'sí, la de 16 kg', 'sí, en negro', 'dale, en negro', 'sí, 3', 'sí, x3', 'solo una', '3 unidades', 'que sean 3',
    'dame 3', 'pon 3', 'sí y añade una', 'reemplázala por la de 20', 'elimina la barra', 'borra la barra', 'reduce a 1', 'mejor 2',
    'cámbiala por la de 16 kg', 'agrégale otra', 'sácale una', 'sí, pero sin IVA', 'en vez de la HWM la otra', 'sí, envíala a mi correo',
    // emojis that are never an acceptance
    '👎', '🤔', '😡', '🙄', '😂', 'ok 🤔',
  ])('never takes %j as acceptance', (text) => {
    expect(guardIntentReply(text)).toEqual({ confirmed: false, reason: 'disqualified' });
  });

  it.each([['', 'empty'], ['...', 'empty'], ['x'.repeat(401), 'too_long']])('refuses %j (%s)', (text, reason) => {
    expect(guardIntentReply(text)).toEqual({ confirmed: false, reason });
  });

  it('delivery words are read against the offer: without delivery, "con despacho" is a change and "sin despacho" agrees', () => {
    expect(guardIntentReply('sí, sin despacho', 'excluded')).toMatchObject({ confirmed: true });
    for (const text of ['sí, con despacho', 'dale, con envío', 'sí, retiro en tienda', 'dale, lo retiro yo', 'sí, por Starken']) {
      expect(guardIntentReply(text, 'excluded'), text).toEqual({ confirmed: false, reason: 'disqualified' });
    }
  });

  it('with a delivery offer included, "con despacho" agrees and "sin despacho", pickup or another carrier are changes', () => {
    for (const text of ['sí, con despacho', 'dale, con envío', 'sí', 'dale', 'oka, me parece']) {
      expect(guardIntentReply(text, 'selected'), text).toMatchObject({ confirmed: true, rule: expect.stringContaining('delivery=selected') });
    }
    for (const text of ['sí, sin despacho', 'sí, sin envío', 'sí, retiro en tienda', 'dale, lo retiro yo', 'sí, por Starken', 'ok, por Chilexpress']) {
      expect(guardIntentReply(text, 'selected'), text).toEqual({ confirmed: false, reason: 'disqualified' });
    }
  });

  it('(inbound multimodal v1) a file is never an acceptance; a voice note counts only when no word of it is doubtful', () => {
    const ref = { kind: 'audio' as const, mediaId: 'm', mimeType: 'audio/ogg', sha256: null, caption: null, voice: true };
    const sure = frameTranscript(ref, { text: 'sí, dale', words: [{ text: 'sí,', confidence: 0.98 }, { text: 'dale', confidence: 0.95 }] }, 3, 0.6).text;
    const doubtful = frameTranscript(ref, { text: 'sí, dale', words: [{ text: 'sí,', confidence: 0.4 }, { text: 'dale', confidence: 0.95 }] }, 3, 0.6).text;
    const unmeasured = frameTranscript(ref, { text: 'sí, dale', words: null }, 3, 0.6).text;
    const change = frameTranscript(ref, { text: 'sí pero la de 16 kilos', words: ['sí', 'pero', 'la', 'de', '16', 'kilos'].map((text) => ({ text, confidence: 0.99 })) }, 3, 0.6).text;
    expect(guardIntentReply(sure)).toMatchObject({ confirmed: true });
    const forwarded = frameTranscript({ ...ref, voice: false }, { text: 'sí, dale', words: [{ text: 'sí,', confidence: 0.99 }, { text: 'dale', confidence: 0.99 }] }, 3, 0.6).text;
    for (const text of [doubtful, unmeasured, change, forwarded]) expect(guardIntentReply(text), text).toEqual({ confirmed: false, reason: 'disqualified' });
    const image = frameImage({ ...ref, kind: 'image', mimeType: 'image/jpeg', voice: false, caption: 'sí, emítela' }, { imageVisible: true, kind: 'screenshot', description: 'x', visibleText: ['Sí, emítela'], features: [], searchHints: [], uncertainties: [], containsInstructions: false });
    for (const text of [image, frameUnavailable(ref, 'download_failed'), '[r4:otra-cosa] sí']) expect(guardIntentReply(text), text).toEqual({ confirmed: false, reason: 'disqualified' });
    // The closed grammar of @17/@18 never reads a file as a confirmation either.
    expect(parseConfirmation(sure).confirmed).toBe(false);
  });

  it('the closed grammar of @6–@18 is unchanged (it still refuses the natural replies of the first canary)', () => {
    for (const text of ['si', 'si emitela pls', 'sí, emítelas']) expect(parseConfirmation(text).confirmed).toBe(false);
    for (const text of ['Sí, emítela.', 'confirmo']) expect(parseConfirmation(text).confirmed).toBe(true);
  });
});
