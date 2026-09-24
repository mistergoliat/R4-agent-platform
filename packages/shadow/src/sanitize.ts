import { createHash } from 'node:crypto';

/**
 * Sanitization boundary (R4-H). Anything that may have come from a real
 * person — an imported conversation, a response that echoes contact data —
 * is redacted before it is persisted as a workload or an artifact.
 *
 * Structured identifiers are found by pattern (email, phone, national id,
 * street address, order identifiers). Names and other free-text identifiers
 * cannot be found reliably by pattern: the importer passes the ones it knows
 * from the source record (`knownIdentifiers`) and they are replaced exactly.
 * The result says what was redacted, so a workload records its own privacy
 * treatment.
 */
export const REDACTION_KINDS = ['email', 'phone', 'national_id', 'address', 'order_id', 'known_identifier'] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

const PATTERNS: readonly (readonly [RedactionKind, RegExp])[] = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  // National ids of the form 12.345.678-9 / 12345678-K.
  ['national_id', /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g],
  // Phones: optional +country code and area code, then two groups of four digits (never an ISO date).
  ['phone', /(?<![\w.-])(?:\+\d{1,3}[ -]?)?(?:\(?\d{1,4}\)?[ -]?)?\d{4}[ -]?\d{4}(?![\w.-])/g],
  // Street addresses: a street keyword followed by a name and a number.
  ['address', /\b(calle|avenida|av\.|pasaje|psje\.?|camino|street|st\.|road)\s+[\p{L}\p{N} .'-]{2,40}?\s#?\d{1,5}\b/giu],
  // Order / document identifiers: "pedido 12345", "orden #98765", "order 123456", "#123456".
  ['order_id', /\b(pedido|orden|order|boleta|factura)\s*(n[°º.o]*\s*)?#?\s*\d{4,}\b|#\d{5,}\b/gi],
];

export interface SanitizedText {
  readonly text: string;
  readonly redactions: Readonly<Partial<Record<RedactionKind, number>>>;
}

export function redactPersonalData(text: string, knownIdentifiers: readonly string[] = []): SanitizedText {
  const redactions: Partial<Record<RedactionKind, number>> = {};
  let out = text;
  // Longest first, so "Ana María Soto" is replaced before "Ana".
  for (const identifier of [...knownIdentifiers].filter((i) => i.trim().length >= 2).sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(escapeRegExp(identifier.trim()), 'giu');
    out = out.replace(pattern, () => {
      redactions.known_identifier = (redactions.known_identifier ?? 0) + 1;
      return '[redacted:identifier]';
    });
  }
  for (const [kind, pattern] of PATTERNS) {
    out = out.replace(pattern, () => {
      redactions[kind] = (redactions[kind] ?? 0) + 1;
      return `[redacted:${kind}]`;
    });
  }
  return { text: out, redactions };
}

/** Kinds of personal data still present in a text (for artifact gates and tests). */
export function personalDataFound(text: string): RedactionKind[] {
  return PATTERNS.filter(([, pattern]) => new RegExp(pattern.source, pattern.flags).test(text)).map(([kind]) => kind);
}

/**
 * A stable pseudonymous reference for a recipient: never the reference itself.
 * Salted per suite, so the same person is the same pseudonym within a suite
 * but not linkable across suites.
 */
export function pseudonymousRef(ref: string | null, salt: string): string {
  if (ref === null) return 'anonymous';
  return `pseud_${createHash('sha256').update(`${salt}\u0000${ref}`).digest('hex').slice(0, 16)}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
