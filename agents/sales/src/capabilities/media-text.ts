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
   * (Owner decisions 2026-11-12) A reaction to the agent's LATEST message (e.g. the offer just presented). The agent
   * interprets the emoji in context (no emoji list, positive or negative, decides; ambiguous → it asks). It can accept
   * only the exact message reacted to: the last line is `«emoji» REACTION_STEP_MARK
   * <stepId>`, the recorded respond step the platform resolved from the provider message id; quote.create requires that
   * step to be the offer it issues.
   */
  reactionToLatest: '[r4:reaccion-a-tu-ultimo-mensaje]',
});
/** Separates the emoji from the reacted step id on the last line of a reaction to the latest message. */
export const REACTION_STEP_MARK = '· mensaje';
export const UNCERTAIN_OPEN = '⟦';
export const UNCERTAIN_CLOSE = '⟧';
