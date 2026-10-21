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
/** At most this many separator characters may sit between two digits of the same (strong) run. */
const MAX_GAP = 3;
/** A weak link: at most this many connector characters (or one short word) between two digit groups. */
const MAX_WEAK_GAP = 8;
const MAX_LINK_WORD = 3;

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
  | 'ambiguous_digits'
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
  if (!only.submittable) return withheld('ambiguous_digits');
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
  /** Only an unambiguous strong run of 4–8 digits, alone in its cluster, may ever be submitted. */
  readonly submittable: boolean;
}

interface DigitGroup {
  readonly first: number;
  readonly last: number;
  readonly digits: string;
}

/** How two consecutive digit groups relate: `none` means they are separate numbers. */
type Link = 'strong' | 'weak' | 'none';

interface Segment {
  readonly groups: readonly DigitGroup[];
  readonly links: readonly Link[];
}

/**
 * Redaction is the union of three rules; only the first can produce a submittable candidate.
 *
 *  1. A strong run (groups joined by 1–MAX_GAP separators) of 4–8 digits is a candidate.
 *  2. A cluster (groups joined by strong or weak links: up to MAX_WEAK_GAP connector characters,
 *     or one word of at most MAX_LINK_WORD letters such as "y") with a weak link and 4–8 digits is
 *     redacted whole: "482 y 913", "482----913", "482 🙏 913".
 *  3. In a run or cluster of more than 8 digits, every window of consecutive groups totalling exactly
 *     six digits is redacted: "482913 1234", "482 913 1234". A phone or RUT written that way loses
 *     those digits while the conversation is protected (a stated cost: see the validation report).
 *
 * Overlapping spans merge, and a merged span is never submittable.
 */
function candidatesOf(units: readonly Unit[]): Candidate[] {
  const groups = digitGroupsOf(units);
  const links = groups.slice(1).map((group, index) => linkOf(units, groups[index], group));
  const spans: Candidate[] = [];
  for (const run of segmentsOf(groups, links, (link) => link === 'strong')) {
    const length = digitsOf(run.groups).length;
    if (length >= CANDIDATE_MIN_DIGITS && length <= CANDIDATE_MAX_DIGITS) spans.push(candidateOf(run.groups, true));
    else if (length > CANDIDATE_MAX_DIGITS) spans.push(...sixDigitWindows(run.groups));
  }
  for (const cluster of segmentsOf(groups, links, (link) => link !== 'none')) {
    if (!cluster.links.includes('weak')) continue;
    const length = digitsOf(cluster.groups).length;
    if (length >= CANDIDATE_MIN_DIGITS && length <= CANDIDATE_MAX_DIGITS) spans.push(candidateOf(cluster.groups, false));
    else if (length > CANDIDATE_MAX_DIGITS) spans.push(...sixDigitWindows(cluster.groups));
  }
  return merged(units, spans);
}

function digitGroupsOf(units: readonly Unit[]): DigitGroup[] {
  const groups: DigitGroup[] = [];
  let k = 0;
  while (k < units.length) {
    if (units[k]?.digit == null) {
      k += 1;
      continue;
    }
    const first = k;
    let digits = '';
    while (units[k]?.digit != null) {
      digits += units[k]?.digit ?? '';
      k += 1;
    }
    groups.push({ first, last: k - 1, digits });
  }
  return groups;
}

const LETTER = /^\p{L}\p{M}*$/u;

function linkOf(units: readonly Unit[], before: DigitGroup | undefined, after: DigitGroup): Link {
  if (!before) return 'none';
  const gap = units.slice(before.last + 1, after.first);
  if (gap.length <= MAX_GAP && gap.every(isSeparator)) return 'strong';
  if (gap.length > MAX_WEAK_GAP) return 'none';
  const words = gap.map((u) => (LETTER.test(u.text) ? 'w' : ' ')).join('').split(' ').filter((w) => w.length > 0);
  const [word, ...more] = words;
  return word === undefined || (more.length === 0 && word.length <= MAX_LINK_WORD) ? 'weak' : 'none';
}

function isSeparator(unit: Unit | undefined): boolean {
  return unit !== undefined && SEPARATOR.test(unit.text);
}

function segmentsOf(groups: readonly DigitGroup[], links: readonly Link[], joins: (link: Link) => boolean): Segment[] {
  const segments: Segment[] = [];
  let current: { groups: DigitGroup[]; links: Link[] } = { groups: [], links: [] };
  groups.forEach((group, index) => {
    const link = index === 0 ? undefined : links[index - 1];
    if (link !== undefined && !joins(link)) {
      segments.push(current);
      current = { groups: [], links: [] };
    } else if (link !== undefined) {
      current.links.push(link);
    }
    current.groups.push(group);
  });
  if (current.groups.length > 0) segments.push(current);
  return segments;
}

function digitsOf(groups: readonly DigitGroup[]): string {
  return groups.map((g) => g.digits).join('');
}

function candidateOf(groups: readonly DigitGroup[], submittable: boolean): Candidate {
  return { first: groups[0]?.first ?? 0, last: groups[groups.length - 1]?.last ?? 0, digits: digitsOf(groups), submittable };
}

function sixDigitWindows(groups: readonly DigitGroup[]): Candidate[] {
  const windows: Candidate[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    let total = 0;
    for (let j = i; j < groups.length && total < CODE_DIGITS; j += 1) {
      total += groups[j]?.digits.length ?? 0;
      if (total === CODE_DIGITS) windows.push(candidateOf(groups.slice(i, j + 1), false));
    }
  }
  return windows;
}

/** Overlapping spans become one span over all their units; a span that absorbed another is never submittable. */
function merged(units: readonly Unit[], spans: readonly Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const span of [...spans].sort((a, b) => a.first - b.first || b.last - a.last)) {
    const previous = out[out.length - 1];
    if (previous && span.first <= previous.last) {
      const last = Math.max(previous.last, span.last);
      const digits = units.slice(previous.first, last + 1).map((u) => u.digit ?? '').join('');
      out[out.length - 1] = { first: previous.first, last, digits, submittable: false };
    } else {
      out.push(span);
    }
  }
  return out;
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
