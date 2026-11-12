/**
 * (Inbound multimodal v1) The platform-authored headers of a participant input that came as a file, as the Sales pack
 * frames it (production/media-perception.ts), and the marks of a doubtful transcribed word. Pure constants: the intent
 * guard reads them without depending on the perception code.
 */
export const MEDIA_TEXT_HEADERS = Object.freeze({
  image: '[r4:imagen]',
  /** A transcript whose per-word confidence was measured: unsure words are marked with ⟦…⟧. */
  audio: '[r4:nota-de-voz]',
  /** A transcript without measured confidence: never certain enough to be an acceptance. */
  audioUnmeasured: '[r4:nota-de-voz-sin-confianza]',
  /** A forwarded or attached audio file (not recorded by the customer): content, never an acceptance. */
  audioForwarded: '[r4:audio-reenviado]',
  unavailable: '[r4:adjunto-no-procesado]',
  /** A reaction or a channel system event: not a message from the customer, never an acceptance. */
  event: '[r4:evento]',
  /** A sticker, described: a gesture or an emotion, never an acceptance. */
  sticker: '[r4:sticker]',
  /** A reaction to an earlier agent message (or an unknown one): never an acceptance. */
  reaction: '[r4:reaccion]',
  /**
   * (Owner decision 2026-11-12) A reaction to the agent's LATEST message (e.g. the offer just presented): the agent
   * interprets it (👍 accepts; other positive emojis are its call, asking when ambiguous); the guard lets only positive
   * emojis through. The emoji is the last line, between «».
   */
  reactionToLatest: '[r4:reaccion-a-tu-ultimo-mensaje]',
});
export const UNCERTAIN_OPEN = '⟦';
export const UNCERTAIN_CLOSE = '⟧';
