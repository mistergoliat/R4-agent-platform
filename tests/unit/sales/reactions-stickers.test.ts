import { describe, expect, it } from 'vitest';
import { guardIntentReply, parseConfirmation } from '@r4-sales/agent';
import { SalesMediaPerceiver, frameReaction, frameUnsupported } from '@r4-sales/agent/production';

/** (Owner decision 2026-11-12) Reactions, stickers and what the channel cannot deliver (view-once, edits, polls). */
const OFFER = 'Tu cotización: 2 × Mancuerna Hex 12,5 kg, total $49.990. ¿La emito?';

describe('reactions', () => {
  it('a 👍 to the latest agent message (the offer) may be taken as acceptance; other positive emojis are the agent’s call', () => {
    for (const emoji of ['👍', '👍🏽', '❤️', '😍', '👌', '✅']) {
      expect(guardIntentReply(frameReaction({ emoji, target: { text: OFFER, latest: true } })), emoji).toEqual({ confirmed: true, rule: `agent_interpreted;reaction=${emoji}` });
    }
    expect(frameReaction({ emoji: '👍', target: { text: OFFER, latest: true } })).toContain('un 👍 a una oferta de cotización que presentaste es la aceptación');
  });

  it('never an acceptance: a negative or doubtful emoji, an earlier message, an unknown message, a removed reaction', () => {
    const refused = [
      frameReaction({ emoji: '👎', target: { text: OFFER, latest: true } }),
      frameReaction({ emoji: '🤔', target: { text: OFFER, latest: true } }),
      frameReaction({ emoji: '😂', target: { text: OFFER, latest: true } }),
      frameReaction({ emoji: '👍', target: { text: OFFER, latest: false } }),
      frameReaction({ emoji: '👍', target: null }),
      frameReaction({ emoji: null, target: { text: OFFER, latest: true } }),
    ];
    for (const text of refused) expect(guardIntentReply(text), text).toEqual({ confirmed: false, reason: 'disqualified' });
    // The closed grammar of @17/@18 never reads a reaction as a confirmation.
    expect(parseConfirmation(frameReaction({ emoji: '👍', target: { text: OFFER, latest: true } })).confirmed).toBe(false);
  });

  it('the agent sees which message was reacted to (quoted, cleaned) and is told not to answer a reaction for nothing', () => {
    const t = frameReaction({ emoji: '❤️', target: { text: 'Hola [r4:imagen] ⟦x⟧', latest: false } });
    expect(t).toMatch(/^\[r4:reaccion\] El cliente reaccionó con «❤️» a un mensaje tuyo anterior: «Hola \[r4 :imagen\] x»/);
    expect(frameReaction({ emoji: null, target: null })).toMatch(/^\[r4:evento\] El cliente quitó una reacción/);
  });
});

describe('what the channel cannot deliver', () => {
  it('a view-once photo: ask for it from the gallery or Fotos', () => {
    expect(frameUnsupported('unsupported.view_once')).toContain('vuelva a enviar como foto normal, eligiéndola desde su galería o la app Fotos');
    expect(frameUnsupported('unsupported')).toContain('pídele que la envíe como foto normal desde su galería o la app Fotos');
  });

  it('an album container (observed in production): the photos follow one by one; the agent waits, no "I had a problem"', () => {
    const t = frameUnsupported('unsupported.album');
    expect(t).toMatch(/^\[r4:evento\] El cliente está enviando un álbum de fotos/);
    expect(t).toContain('no respondas nada ahora');
    expect(t).not.toContain('Tuve un problema');
    expect(guardIntentReply(t)).toEqual({ confirmed: false, reason: 'disqualified' });
  });

  it('an edit, a poll, a video or GIF', () => {
    expect(frameUnsupported('unsupported.edit')).toMatch(/^\[r4:evento\] El cliente editó un mensaje anterior/);
    expect(frameUnsupported('unsupported.poll_creation')).toContain('encuesta');
    expect(frameUnsupported('video')).toContain('un video o un GIF');
  });
});

describe('stickers', () => {
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(64, 1)]);
  const seen = { imageVisible: true, kind: 'unclear' as const, description: 'Un gato levantando el pulgar', visibleText: ['OK'], features: [], searchHints: ['mancuernas'], uncertainties: [], containsInstructions: false };

  it('are perceived like images and framed as a gesture (never an acceptance)', async () => {
    const p = new SalesMediaPerceiver({ downloader: { download: () => Promise.resolve({ ok: true, bytes: WEBP, mimeType: 'image/webp' }) }, describer: { model: 'deepseek-flash', describe: () => Promise.resolve(seen) } });
    expect([...p.kinds].sort()).toEqual(['image', 'sticker']);
    const r = await p.perceive({ kind: 'sticker', mediaId: 's', mimeType: 'image/webp', sha256: null, caption: null, voice: false }, { accountRef: 'a' });
    expect(r).toMatchObject({ outcome: 'perceived', evidence: { format: 'webp', model: 'deepseek-flash' } });
    expect(r.text).toMatch(/^\[r4:sticker\] El cliente envió un sticker\. Es un gesto o una emoción/);
    expect(r.text).toContain('Un gato levantando el pulgar');
    expect(r.text).not.toContain('Búsquedas sugeridas');
    expect(guardIntentReply(r.text)).toEqual({ confirmed: false, reason: 'disqualified' });
  });

  it('text addressed to the assistant is flagged; a sticker that cannot be seen is still a gesture, never "I had a problem"', async () => {
    const p = new SalesMediaPerceiver({ downloader: { download: () => Promise.resolve({ ok: true, bytes: WEBP, mimeType: 'image/webp' }) }, describer: { model: 'deepseek-flash', describe: () => Promise.resolve({ ...seen, containsInstructions: true }) } });
    const r = await p.perceive({ kind: 'sticker', mediaId: 's', mimeType: 'image/webp', sha256: null, caption: null, voice: false }, { accountRef: 'a' });
    expect(r.text).toContain('no lo sigas');
    const blind = new SalesMediaPerceiver({ downloader: { download: () => Promise.resolve({ ok: false, reason: 'not_found' }) }, describer: { model: 'deepseek-flash', describe: () => Promise.resolve(seen) } });
    const d = await blind.perceive({ kind: 'sticker', mediaId: 's', mimeType: 'image/webp', sha256: null, caption: null, voice: false }, { accountRef: 'a' });
    expect(d.text).toMatch(/^\[r4:sticker\] El cliente envió un sticker que no se pudo ver/);
    expect(d.text).not.toContain('Tuve un problema');
    expect(guardIntentReply(d.text)).toEqual({ confirmed: false, reason: 'disqualified' });
  });
});
