import { FORGEABLE_MARKER_PREFIXES, PLATFORM_MARKERS } from './markers.js';

/**
 * SEC-S1 — pure classification of one canonical inbound text while an identity verification may
 * be pending (decision rev. 02 §8; OA-07). Two separate decisions:
 *
 *   redact(candidate)                 protection: no 4–8 digit candidate reaches the model or the
 *                                     conversational persistence while the conversation is protected.
 *   submitForConfirmation(candidate)  authority: one CIA attempt is spent only on a single, unambiguous
 *                                     6-digit code in a "code only" message, under a valid expectation.
 *
 * submitForConfirmation ⇒ redact; never the reverse. No I/O, no clock, no secrets, no channel names:
 * every fact about the conversation comes from the caller (S3), derived from authenticated state.
 */

export const CANDIDATE_MIN_DIGITS = 4;
export const CANDIDATE_MAX_DIGITS = 8;
export const CODE_DIGITS = 6;
/** At most this many separator characters may sit between two digits of the same run. */
const MAX_GAP = 3;

/**
 * OA-07b: the words that may surround a code for it to be submitted. Owner-approved for synthetic
 * implementation and validation only; never widened implicitly. Compared literally after NFKC and
 * lower-casing (no accent folding: both spellings are listed where the owner listed them).
 */
export const CODE_CONTEXT: ReadonlySet<string> = new Set([
  'mi', 'el', 'la', 'es', 'código', 'codigo', 'cod', 'clave', 'otp', 'de', 'verificación', 'verificacion',
  'aquí', 'aqui', 'va', 'te', 'lo', 'envío', 'envio', 'mando', 'paso', 'hola', 'gracias', 'ok', 'listo',
  'este', 'ese', 'sería', 'seria', 'is', 'my', 'code', 'here',
]);

export interface VerificationInspectionContext {
  /** Some expectation of this conversation has `now < protect_until` (any state): redaction applies. */
  readonly protectionActive: boolean;
  /** A live, current expectation would accept a code now (state, binding, task, challenge window). */
  readonly expectationAcceptsCode: boolean;
  /**
   * The authenticated channel adapter attests a direct conversation whose sender is the binding
   * subject. `senderRef === conversationRef` alone is NOT such a proof: the attestation is the adapter's.
   */
  readonly directSubjectAttested: boolean;
}

export type ReplacementReason =
  | 'marker_neutralized'
  | 'code_submitted'
  | 'expectation_not_accepting'
  | 'subject_not_attested'
  | 'multiple_candidates'
  | 'not_six_digits'
  | 'context_not_allowed'
  | 'fail_closed';

export type VerificationTextInspection =
  | { readonly kind: 'pass' }
  | {
      readonly kind: 'replace';
      /** The only text that may be persisted and hashed. */
      readonly text: string;
      readonly reason: ReplacementReason;
      /** Present only for `code_submitted`: six ASCII digits, to be sealed by the caller and never logged. */
      readonly submission: { readonly code: string } | null;
    };

/**
 * Fail-closed entry point: any internal failure withholds the whole message (ADR-040 inv. 5).
 * The caller must not call it before it knows whether protection applies; if it cannot know,
 * it aborts the transaction instead (decision §9.3).
 */
export function inspectVerificationText(text: string, context: VerificationInspectionContext): VerificationTextInspection {
  try {
    return classify(text, context);
  } catch {
    return { kind: 'replace', text: PLATFORM_MARKERS.messageWithheld, reason: 'fail_closed', submission: null };
  }
}

function classify(original: string, context: VerificationInspectionContext): VerificationTextInspection {
  const neutralized = neutralizeMarkers(original);
  const changed = neutralized !== original;
  const unchanged: VerificationTextInspection = changed
    ? { kind: 'replace', text: neutralized, reason: 'marker_neutralized', submission: null }
    : { kind: 'pass' };
  if (!context.protectionActive) return unchanged;

  const units = unitsOf(neutralized);
  const candidates = candidatesOf(units);
  if (candidates.length === 0) return unchanged;

  const withheld = (reason: ReplacementReason): VerificationTextInspection => ({
    kind: 'replace',
    text: replaceSpans(neutralized, candidates.map((c) => spanOf(units, c, PLATFORM_MARKERS.numberWithheld))),
    reason,
    submission: null,
  });
  if (!context.expectationAcceptsCode) return withheld('expectation_not_accepting');
  if (!context.directSubjectAttested) return withheld('subject_not_attested');
  const [only, ...others] = candidates;
  if (!only || others.length > 0) return withheld('multiple_candidates');
  if (only.digits.length !== CODE_DIGITS) return withheld('not_six_digits');
  if (!codeOnly(units, only)) return withheld('context_not_allowed');
  return {
    kind: 'replace',
    text: replaceSpans(neutralized, [spanOf(units, only, PLATFORM_MARKERS.codeReceived)]),
    reason: 'code_submitted',
    submission: { code: only.digits },
  };
}

// ── Normalized shadow: one unit per grapheme of the original text ─────────────────────────────

interface Unit {
  /** NFKC, lower case, without format characters, variation selectors or the keycap mark. */
  readonly text: string;
  /** UTF-16 span of the grapheme in the original text. */
  readonly start: number;
  readonly end: number;
  /** The ASCII digit this grapheme denotes, if it is one decimal digit (any script). */
  readonly digit: string | null;
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const INVISIBLE = /[\p{Cf}\uFE0E\uFE0F\u20E3]/gu;
const SEPARATOR = /^[\s\p{Zs}‐‑‒–—.·/_,-]$/u;

function unitsOf(text: string): Unit[] {
  const units: Unit[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const normalized = segment.normalize('NFKC').replace(INVISIBLE, '');
    if (normalized === '') continue;
    units.push({ text: normalized.toLowerCase(), start: index, end: index + segment.length, digit: digitOf(normalized) });
  }
  return units;
}

/** Unicode keeps every `Nd` digit in contiguous runs of ten starting at zero: the value is the offset mod 10. */
function digitOf(normalized: string): string | null {
  const bare = [...normalized.replace(/\p{M}/gu, '')];
  const [char] = bare;
  if (bare.length !== 1 || char === undefined || !/^\p{Nd}$/u.test(char)) return null;
  const code = char.codePointAt(0) ?? 0;
  let first = code;
  while (first > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(first - 1))) first -= 1;
  return String((code - first) % 10);
}

// ── Candidates ────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  readonly first: number;
  readonly last: number;
  readonly digits: string;
}

interface DigitGroup {
  readonly first: number;
  readonly last: number;
  readonly digits: string;
}

/**
 * A run is a maximal sequence of digit groups separated by at most MAX_GAP separator characters.
 * A run of 4–8 digits is one candidate. A longer run (phone, RUT) is not a candidate; but each of
 * its contiguous groups of exactly six digits is, so a code written next to other digits
 * ("482913 482913", "482913 1234") is still redacted.
 */
function candidatesOf(units: readonly Unit[]): Candidate[] {
  const candidates: Candidate[] = [];
  let i = 0;
  while (i < units.length) {
    if (units[i]?.digit == null) {
      i += 1;
      continue;
    }
    const groups = runAt(units, i);
    const digits = groups.map((g) => g.digits).join('');
    const first = groups[0]?.first ?? i;
    const last = groups[groups.length - 1]?.last ?? i;
    if (digits.length >= CANDIDATE_MIN_DIGITS && digits.length <= CANDIDATE_MAX_DIGITS) candidates.push({ first, last, digits });
    else if (digits.length > CANDIDATE_MAX_DIGITS) candidates.push(...groups.filter((g) => g.digits.length === CODE_DIGITS));
    i = last + 1;
  }
  return candidates;
}

function runAt(units: readonly Unit[], start: number): DigitGroup[] {
  const groups: DigitGroup[] = [];
  let k = start;
  for (;;) {
    let digits = '';
    const first = k;
    while (units[k]?.digit != null) {
      digits += units[k]?.digit ?? '';
      k += 1;
    }
    groups.push({ first, last: k - 1, digits });
    let gap = 0;
    while (gap < MAX_GAP && isSeparator(units[k + gap])) gap += 1;
    if (units[k + gap]?.digit == null) return groups;
    k += gap;
  }
}

function isSeparator(unit: Unit | undefined): boolean {
  return unit !== undefined && SEPARATOR.test(unit.text);
}

// ── "Code only" (OA-07b): what surrounds the single candidate ─────────────────────────────────

const ALLOWED_MARK = /^[\s\p{Zs}.,:;!?¡¿()"'«»“”‘’-]$/u;
const EMOJI = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}]$/u;

function codeOnly(units: readonly Unit[], candidate: Candidate): boolean {
  const rest = units.filter((_, index) => index < candidate.first || index > candidate.last).map((u) => u.text).join('');
  for (const [token] of rest.matchAll(/\p{L}+|\P{L}/gu)) {
    if (/^\p{L}+$/u.test(token)) {
      if (!CODE_CONTEXT.has(token)) return false;
    } else if (!ALLOWED_MARK.test(token) && !EMOJI.test(token)) {
      return false;
    }
  }
  return true;
}

// ── Forged platform markers ───────────────────────────────────────────────────────────────────

const FORGED_MARKER = new RegExp(
  `\\[\\s*(?:${FORGEABLE_MARKER_PREFIXES.map((words) => words.join('\\s+')).join('|')})[^\\]]{0,300}\\]?`,
  'gu',
);

/** Neutralizes look-alikes of platform markers, always (with or without protection), on the normalized text. */
function neutralizeMarkers(text: string): string {
  const units = unitsOf(text);
  const shadow = units.map((u) => u.text).join('');
  const unitAt: number[] = [];
  units.forEach((u, index) => {
    for (let c = 0; c < u.text.length; c += 1) unitAt.push(index);
  });
  const spans: Span[] = [];
  for (const match of shadow.matchAll(FORGED_MARKER)) {
    const from = units[unitAt[match.index] ?? -1];
    const to = units[unitAt[match.index + match[0].length - 1] ?? -1];
    if (from && to) spans.push({ start: from.start, end: to.end, replacement: PLATFORM_MARKERS.quotedMarkerRemoved });
  }
  return replaceSpans(text, spans);
}

// ── Span replacement on the original text ────────────────────────────────────────────────────

interface Span {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function spanOf(units: readonly Unit[], candidate: Candidate, replacement: string): Span {
  const first = units[candidate.first];
  const last = units[candidate.last];
  if (!first || !last) throw new Error('candidate outside the text');
  return { start: first.start, end: last.end, replacement };
}

function replaceSpans(text: string, spans: readonly Span[]): string {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, span.start) + span.replacement + out.slice(span.end);
  return out;
}
