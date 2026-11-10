/**
 * (R4-J3E-B) The deterministic grammar of an explicit quote confirmation in a
 * customer's own message (Spanish, Chile). Deliberately small and closed:
 * the WHOLE message must parse as
 *
 *   [AFFIRMATION] CONFIRMATION (CONNECTOR CONFIRMATION)* [COURTESY]
 *
 * after normalization (lowercase, no accents, punctuation as separators).
 * Anything else — a question, a negation, a condition, a change request, an
 * unknown word — is not a confirmation. There is no keyword search: "confirmo"
 * inside a longer sentence ("¿qué pasa si confirmo?", "confirmo, pero cambia
 * la dirección") does not parse. Ambiguity is a refusal, never a guess.
 */
export const CONFIRMATION_GRAMMAR_VERSION = 'r4-sales-confirmation-es-v1';

/** Messages longer than this are never a bare confirmation. */
const MAX_LENGTH = 160;

const AFFIRMATIONS: readonly (readonly string[])[] = [['si'], ['ok'], ['okay'], ['dale'], ['perfecto'], ['de', 'acuerdo'], ['listo'], ['claro'], ['si', 'claro'], ['si', 'por', 'favor']];
const OBJECT: readonly (readonly string[])[] = [[], ['la', 'cotizacion'], ['esa', 'cotizacion'], ['esta', 'cotizacion'], ['la'], ['esa'], ['esta']];
const CONFIRMATIONS: readonly (readonly string[])[] = [
  ...OBJECT.map((o) => ['confirmo', ...o]),
  ['emitela'],
  ['emitala'],
  ['emite', 'la', 'cotizacion'],
  ['emite', 'esa', 'cotizacion'],
  ['emite', 'esta', 'cotizacion'],
  ['ya', 'emitela'],
];
const CONNECTORS: readonly (readonly string[])[] = [[], ['y']];
const COURTESY: readonly (readonly string[])[] = [['por', 'favor'], ['porfa'], ['porfavor'], ['gracias'], ['por', 'favor', 'gracias']];

/** Signals that a message is NOT an unconditional confirmation, whatever else it says. */
const DISQUALIFIERS = /[?¿]|\b(no|nunca|todavia|aun|pero|aunque|si\s+es\s+que|cambia|cambiar|cambiame|otro|otra|otros|otras|despues|luego|espera|esperar|mejor|quizas|tal\s+vez|creo|primero|cuanto|cuando|que\s+pasa)\b/;

/**
 * (sales-production@19, owner decision «Activación @18, cierre @19 y decisiones R4-L», 2026-11-10) Quote issuance
 * follows the customer's commercial intent as the AGENT interprets it in natural language ("sí", "dale", "oka, me
 * parece", "sí, emítelas"…): no literal phrase is required. A quote is not a purchase, a payment or a reservation.
 * The platform keeps a deterministic guard on the customer's reply: a question, a negation, a hesitation or a change
 * request is never taken as acceptance, whatever the agent proposes. Every other control (the exact offer presented
 * and delivered, immediacy, the window, prices, stock, F1 limits, idempotency, concurrency) is unchanged.
 */
export const INTENT_GUARD_VERSION = 'r4-sales-intent-guard-es-v1';
const INTENT_MAX_LENGTH = 400;
const INTENT_DISQUALIFIERS = /\b(no|nop|nunca|todavia|aun|pero|aunque|si\s+es\s+que|cambi\w*|modific\w*|agreg\w*|sum[ae]\w*|quit\w*|sac[ao]\w*|en\s+vez|en\s+lugar|otro|otra|otros|otras|despues|luego|manana|espera|esperame|esperar|mejor|quizas|quiza|tal\s+vez|creo|pensarlo|pensar|lo\s+pienso|primero|cuanto|cuando|que\s+pasa|dudo|duda)\b/;

/** The deterministic guard of @19: never an acceptance when the reply asks, rejects, hesitates or asks for a change. */
export function guardIntentReply(text: string | null): ConfirmationVerdict {
  if (text === null || text.trim() === '') return { confirmed: false, reason: 'empty' };
  if (text.length > INTENT_MAX_LENGTH) return { confirmed: false, reason: 'too_long' };
  if (/[?¿]/.test(text)) return { confirmed: false, reason: 'disqualified' };
  const normalized = normalizeMessage(text);
  if (normalized === '') return { confirmed: false, reason: 'empty' };
  if (INTENT_DISQUALIFIERS.test(normalized)) return { confirmed: false, reason: 'disqualified' };
  return { confirmed: true, rule: 'agent_interpreted;guard=no_question_negation_hesitation_change' };
}

export type ConfirmationVerdict =
  | { readonly confirmed: true; readonly rule: string }
  | { readonly confirmed: false; readonly reason: 'empty' | 'too_long' | 'disqualified' | 'not_a_confirmation' };

export function normalizeMessage(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[!¡.,;:()"'*_~\-–—…👍🙏😊🙂✅]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parses one customer message. Pure and deterministic. */
export function parseConfirmation(text: string | null): ConfirmationVerdict {
  if (text === null || text.trim() === '') return { confirmed: false, reason: 'empty' };
  if (text.length > MAX_LENGTH) return { confirmed: false, reason: 'too_long' };
  // Questions are judged on the raw text (normalization removes "?").
  if (/[?¿]/.test(text)) return { confirmed: false, reason: 'disqualified' };
  const normalized = normalizeMessage(text);
  if (normalized === '') return { confirmed: false, reason: 'empty' };
  if (DISQUALIFIERS.test(normalized)) return { confirmed: false, reason: 'disqualified' };
  const tokens = normalized.split(' ');
  const rule = parse(tokens);
  return rule ? { confirmed: true, rule } : { confirmed: false, reason: 'not_a_confirmation' };
}

/** [AFFIRMATION] CONFIRMATION (CONNECTOR CONFIRMATION)* [COURTESY], consuming every token. */
function parse(tokens: readonly string[]): string | null {
  for (const affirmation of [[] as readonly string[], ...AFFIRMATIONS]) {
    if (!startsWith(tokens, 0, affirmation)) continue;
    const rest = confirmations(tokens, affirmation.length);
    for (const end of rest) {
      if (end === tokens.length) return label(affirmation, 'none');
      for (const courtesy of COURTESY) {
        if (startsWith(tokens, end, courtesy) && end + courtesy.length === tokens.length) return label(affirmation, courtesy.join('_'));
      }
    }
  }
  return null;
}

/** Every position reachable after one or more CONFIRMATIONs joined by CONNECTORs. */
function confirmations(tokens: readonly string[], start: number): number[] {
  const ends = new Set<number>();
  const visit = (at: number, first: boolean) => {
    for (const connector of first ? [[] as readonly string[]] : CONNECTORS) {
      if (!startsWith(tokens, at, connector)) continue;
      for (const confirmation of CONFIRMATIONS) {
        const from = at + connector.length;
        if (!startsWith(tokens, from, confirmation)) continue;
        const end = from + confirmation.length;
        if (ends.has(end)) continue;
        ends.add(end);
        visit(end, false);
      }
    }
  };
  visit(start, true);
  return [...ends].sort((a, b) => b - a);
}

function startsWith(tokens: readonly string[], at: number, phrase: readonly string[]): boolean {
  if (at + phrase.length > tokens.length) return false;
  return phrase.every((word, i) => tokens[at + i] === word);
}

function label(affirmation: readonly string[], courtesy: string): string {
  return `affirmation=${affirmation.join('_') || 'none'};courtesy=${courtesy}`;
}
