/**
 * ADR-031 (R4-J1E-R2) — bounded availability-wording compatibility of the
 * Sales commercial evidence validator.
 *
 * This is NOT a language parser and NOT an ontology: it is a closed list of
 * Spanish phrasings of "(not) available" observed in or expected from Sales
 * replies, over text already normalized by `normalizeText` (lowercase, no
 * diacritics). Anything not listed is simply not recognized: an honest reply
 * phrased otherwise is refused and corrected once (safe direction), never
 * accepted by guesswork. Extending it means adding a phrase here, with a test.
 */

/** Stated as currently not available / not purchasable. */
const NEGATED = new RegExp(
  [
    'sin (?:stock|existencias|disponibilidad)',
    'agotad[oa]s?',
    'fuera de stock',
    'no (?:esta|estan|se encuentra|se encuentran)? ?disponibles?',
    'no (?:es|son) (?:pedibles?|comprables?)',
    'no se puede[n]? (?:comprar|pedir)',
    'no (?:hay|haya|tenemos|queda|quedan|contamos con) (?:stock|existencias|disponibilidad)',
    'no (?:lo|la|los|las) tenemos',
    'inactiv[oa]s?',
    'no se vende[n]?',
  ]
    .map((p) => `\\b${p}\\b`)
    .join('|'),
  'u',
);

/** Stated as available (only meaningful when not negated in the same text). */
const AFFIRMED = /\b(disponibles?|con stock|en stock|(?:lo|la|los|las) tenemos|tenemos stock|hay stock|tiene stock)\b/u;

/** The text states the item is currently not available. */
export function negatesAvailability(text: string): boolean {
  return NEGATED.test(text);
}

/** The text presents the item as available (an affirmation not negated in the same text). */
export function affirmsAvailability(text: string): boolean {
  return AFFIRMED.test(text) && !NEGATED.test(text);
}

/**
 * A sentence that moves to another subject ("los otros…", "el resto…", or a
 * measure the product's name does not carry, e.g. "los de 16 kg") can never
 * qualify a product it does not name: it ends that product's local block.
 */
const OTHER_SUBJECT = /\b(otr[oa]s?|demas|resto)\b/u;
const MEASURE = /\b\d+(?:[.,]\d+)?(?:kg|cm|mm|lb|g)\b/gu;

export function shiftsSubject(text: string, productTokens: readonly string[]): boolean {
  if (OTHER_SUBJECT.test(text)) return true;
  return [...text.matchAll(MEASURE)].some((m) => !productTokens.includes(m[0]));
}
