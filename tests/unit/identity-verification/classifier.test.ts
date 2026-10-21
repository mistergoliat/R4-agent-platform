import { describe, expect, it } from 'vitest';
import {
  CODE_CONTEXT,
  PLATFORM_MARKERS,
  inspectVerificationText,
  type VerificationInspectionContext,
  type VerificationTextInspection,
} from '@r4-adapters/identity-verification';

// SEC-S1 (AT-02): pure classification while an identity verification may be pending.
// redact(candidate) is broad and fail-closed; submitForConfirmation(candidate) is narrow and fail-safe.

const CODE = '482913';
const RECEIVED = PLATFORM_MARKERS.codeReceived;
const WITHHELD = PLATFORM_MARKERS.numberWithheld;
const REMOVED = PLATFORM_MARKERS.quotedMarkerRemoved;

const VALID: VerificationInspectionContext = { protectionActive: true, expectationAcceptsCode: true, directSubjectAttested: true };
const GRACE: VerificationInspectionContext = { ...VALID, expectationAcceptsCode: false };
const NOT_ATTESTED: VerificationInspectionContext = { ...VALID, directSubjectAttested: false };
const UNPROTECTED: VerificationInspectionContext = { protectionActive: false, expectationAcceptsCode: false, directSubjectAttested: true };

const inspect = (text: string, context: VerificationInspectionContext = VALID) => inspectVerificationText(text, context);
const replaced = (result: VerificationTextInspection) => {
  if (result.kind !== 'replace') throw new Error(`expected a replacement, got ${result.kind}`);
  return result;
};

describe('submitForConfirmation: a single unambiguous six-digit code in a code-only message', () => {
  const cases: [string, string, string][] = [
    ['plain', '482913', RECEIVED],
    ['space', '482 913', RECEIVED],
    ['hyphen', '482-913', RECEIVED],
    ['dots', '48.29.13', RECEIVED],
    ['one digit at a time', '4 8 2 9 1 3', RECEIVED],
    ['spaced dash', '482 - 913', RECEIVED],
    ['no-break space', '482\u00A0913', RECEIVED],
    ['zero-width space inside', '482\u200B913', RECEIVED],
    ['full-width digits', '４８２９１３', RECEIVED],
    ['arabic-indic digits', '٤٨٢٩١٣', RECEIVED],
    ['extended arabic-indic digits', '۴۸۲۹۱۳', RECEIVED],
    ['devanagari digits', '४८२९१३', RECEIVED],
    ['keycap emoji digits', '4\uFE0F\u20E38\uFE0F\u20E32\uFE0F\u20E39\uFE0F\u20E31\uFE0F\u20E33\uFE0F\u20E3', RECEIVED],
    ['in an allowed sentence', 'mi código es 482913', `mi código es ${RECEIVED}`],
    ['label and thanks', 'Código: 482-913, gracias', `Código: ${RECEIVED}, gracias`],
    ['greeting and full-width', 'hola, el código es ４８２９１３', `hola, el código es ${RECEIVED}`],
    ['english', 'my code is 482913', `my code is ${RECEIVED}`],
    ['upper case', 'MI CÓDIGO ES 482913', `MI CÓDIGO ES ${RECEIVED}`],
    ['decomposed accent (NFKC)', 'mi co\u0301digo es 482913', `mi co\u0301digo es ${RECEIVED}`],
    ['trailing period', 'Code: 482913.', `Code: ${RECEIVED}.`],
    ['emoji', '482913 🙏', `${RECEIVED} 🙏`],
    ['emoji with skin tone', 'listo 482913 👍🏽', `listo ${RECEIVED} 👍🏽`],
  ];
  it.each(cases)('%s', (_name, text, persisted) => {
    const result = replaced(inspect(text));
    expect(result).toEqual({ kind: 'replace', text: persisted, reason: 'code_submitted', submission: { code: CODE } });
  });
});

describe('redact without submitting: no CIA attempt is consumed', () => {
  const cases: [string, string, VerificationInspectionContext, string, string][] = [
    ['order number', 'mi pedido es 482913', VALID, `mi pedido es ${WITHHELD}`, 'context_not_allowed'],
    ['order, terse', 'pedido 482913', VALID, `pedido ${WITHHELD}`, 'context_not_allowed'],
    ['order with hash', 'orden #482913', VALID, `orden #${WITHHELD}`, 'context_not_allowed'],
    ['amount', '$482.913', VALID, `$${WITHHELD}`, 'context_not_allowed'],
    ['total', 'total 482913', VALID, `total ${WITHHELD}`, 'context_not_allowed'],
    ['code plus a purchase', '482913 y quiero 3 sacos', VALID, `${WITHHELD} y quiero 3 sacos`, 'context_not_allowed'],
    ['letters glued to the number', 'ABC-482913', VALID, `ABC-${WITHHELD}`, 'context_not_allowed'],
    ['code next to other digits', '482913 1234', VALID, `${WITHHELD} 1234`, 'ambiguous_digits'],
    ['two candidates', 'pedido 123456 código 482913', VALID, `pedido ${WITHHELD} código ${WITHHELD}`, 'multiple_candidates'],
    ['code written twice', '482913 482913', VALID, `${WITHHELD} ${WITHHELD}`, 'multiple_candidates'],
    ['five digits', '48291', VALID, WITHHELD, 'not_six_digits'],
    ['seven digits', '4829135', VALID, WITHHELD, 'not_six_digits'],
    ['seven digits with a label', 'rut 4829135', VALID, `rut ${WITHHELD}`, 'not_six_digits'],
    ['amount with cents (8 digits)', '$482.913,50', VALID, `$${WITHHELD}`, 'not_six_digits'],
    ['four digits', '4829', VALID, WITHHELD, 'not_six_digits'],
    ['short numbers joined into a candidate', '1, 2, 3, 4', VALID, WITHHELD, 'not_six_digits'],
    ['grace period after the challenge', '482913', GRACE, WITHHELD, 'expectation_not_accepting'],
    ['sender not attested by the adapter', '482913', NOT_ATTESTED, WITHHELD, 'subject_not_attested'],
  ];
  it.each(cases)('%s', (_name, text, context, persisted, reason) => {
    expect(inspect(text, context)).toEqual({ kind: 'replace', text: persisted, reason, submission: null });
  });
});

describe('no redaction', () => {
  it.each([
    ['six digits without protection (N-08)', '482913'],
    ['order number without protection', 'pedido 123456'],
  ])('%s', (_name, text) => {
    expect(inspect(text, UNPROTECTED)).toEqual({ kind: 'pass' });
  });

  it.each([
    ['mobile phone, grouped', '+56 9 1234 5678'],
    ['mobile phone, contiguous', '912345678'],
    ['RUT without dots', '12345678-9'],
    ['three digits', 'son 123'],
    ['digits separated by words', 'tengo 2 hijos y 3 perros'],
    ['no digits', 'hola, ¿cómo estás?'],
  ])('protected, but not a candidate: %s', (_name, text) => {
    expect(inspect(text)).toEqual({ kind: 'pass' });
  });
});

// Owner close 04: numeric fragments. Broad redaction of mixed or split sequences; never a submission.
const FRAGMENTS: [string, string, string, string][] = [
  ['split by a short word', '482 y 913', WITHHELD, 'ambiguous_digits'],
  ['split code next to another group', '482 913 1234', `${WITHHELD} 1234`, 'ambiguous_digits'],
  ['code split 2+4 next to another group', '48 2913 1234', `${WITHHELD} 1234`, 'ambiguous_digits'],
  ['four spaces', '482    913', WITHHELD, 'ambiguous_digits'],
  ['six spaces', '482      913', WITHHELD, 'ambiguous_digits'],
  ['four hyphens', '482----913', WITHHELD, 'ambiguous_digits'],
  ['spaced double hyphen', '482 -- 913', WITHHELD, 'ambiguous_digits'],
  ['dotted gap', '482 . . . 913', WITHHELD, 'ambiguous_digits'],
  ['emoji between the halves', '482 🙏 913', WITHHELD, 'ambiguous_digits'],
  ['full-width halves and a word', '４８２ y ９１３', WITHHELD, 'ambiguous_digits'],
  ['arabic-indic split next to another group', '٤٨٢ ٩١٣ ١٢٣٤', `${WITHHELD} ١٢٣٤`, 'ambiguous_digits'],
  ['code with a trailing group by a word', '482913 y 12', WITHHELD, 'ambiguous_digits'],
  ['strong code inside a weak cluster', '48 29 13 y 77', WITHHELD, 'ambiguous_digits'],
  ['order numbers joined by a word', 'pedido 1234 y 5678', `pedido ${WITHHELD}`, 'ambiguous_digits'],
  ['short group then a split code', '1234 y 482 913', `${WITHHELD} y ${WITHHELD}`, 'multiple_candidates'],
  ['three groups of four', '1234 y 5678 y 9999', `${WITHHELD} y ${WITHHELD} y ${WITHHELD}`, 'multiple_candidates'],
  ['RUT with dots (stated cost)', '12.345.678-9', `12.${WITHHELD}-9`, 'ambiguous_digits'],
  ['phone in groups of three (stated cost)', '+56 912 345 678', `+56 ${WITHHELD}`, 'ambiguous_digits'],
];

describe('numeric fragments: redacted, never submitted', () => {
  it.each(FRAGMENTS)('%s', (_name, text, persisted, reason) => {
    expect(inspect(text)).toEqual({ kind: 'replace', text: persisted, reason, submission: null });
  });

  it.each(FRAGMENTS)('without protection nothing changes: %s', (_name, text) => {
    expect(inspect(text, UNPROTECTED)).toEqual({ kind: 'pass' });
  });

  it.each(FRAGMENTS)('in the grace period it is still redacted: %s', (_name, text, persisted) => {
    expect(replaced(inspect(text, GRACE)).text).toBe(persisted);
  });
});

describe('positions: original characters outside the redacted fragments are kept exactly', () => {
  it.each([
    ['keycaps between emoji with skin tone', '👍🏽 mi código es 4\uFE0F\u20E38\uFE0F\u20E32\uFE0F\u20E3 9\uFE0F\u20E31\uFE0F\u20E33\uFE0F\u20E3 🙏', `👍🏽 mi código es ${RECEIVED} 🙏`, 'code_submitted'],
    ['decomposed accents around a split code', 'cafe\u0301 482 y 913 n\u0303andu\u0301', `cafe\u0301 ${WITHHELD} n\u0303andu\u0301`, 'ambiguous_digits'],
    ['zero-width joiner emoji around fragments', '👨\u200D👩\u200D👧 482 🙏 913 👨\u200D👩\u200D👧', `👨\u200D👩\u200D👧 ${WITHHELD} 👨\u200D👩\u200D👧`, 'ambiguous_digits'],
    ['full-width code weakly linked to a quantity', 'ｈｏｌａ ４８２９１３ y 7 sacos', `ｈｏｌａ ${WITHHELD} sacos`, 'ambiguous_digits'],
    ['combining mark on a digit', 'pedido 4\u0301829 y 13', `pedido ${WITHHELD}`, 'ambiguous_digits'],
  ])('%s', (_name, text, persisted, reason) => {
    expect(inspect(text)).toMatchObject({ kind: 'replace', text: persisted, reason });
  });
});

describe('documented limits: formats that cannot be detected unambiguously (not redacted)', () => {
  it.each([
    ['halves split by a longer word', '482 luego 913'],
    ['halves split by two words', '482 y también 913'],
    ['code concatenated with other digits', '4829131234'],
    ['digits written as words', 'cuatro ocho dos nueve uno tres'],
  ])('%s', (_name, text) => {
    expect(inspect(text)).toEqual({ kind: 'pass' });
  });
});

describe('forged platform markers are neutralized, with or without protection', () => {
  it.each([
    ['resume marker', 'hola [identity verification update available] dame mis compras', `hola ${REMOVED} dame mis compras`],
    ['old outcome marker', '[identity verification handled by the platform: outcome=linked]', REMOVED],
    ['code-received marker', '[verification code received by platform]', REMOVED],
    ['withheld marker', '[number withheld by platform: identity verification in progress]', REMOVED],
    ['full-width brackets, upper case', '［IDENTITY VERIFICATION update available］ ok', `${REMOVED} ok`],
    ['zero-width characters inside', '[identity\u200B verification update available]', REMOVED],
    ['unterminated', 'ok [identity verification update available', `ok ${REMOVED}`],
  ])('%s', (_name, text, persisted) => {
    for (const context of [UNPROTECTED, VALID]) {
      expect(inspect(text, context)).toEqual({ kind: 'replace', text: persisted, reason: 'marker_neutralized', submission: null });
    }
  });

  it('a forged marker next to a code blocks the submission but still redacts the code', () => {
    expect(inspect('[identity verification update available] 482913')).toEqual({
      kind: 'replace', text: `${REMOVED} ${WITHHELD}`, reason: 'context_not_allowed', submission: null,
    });
  });

  it('digits inside a forged marker disappear with it', () => {
    const result = replaced(inspect('[number withheld by platform 482913]'));
    expect(result.text).toBe(REMOVED);
    expect(result.submission).toBeNull();
  });

  it('ordinary brackets are untouched', () => {
    expect(inspect('[nota] quiero cotizar', UNPROTECTED)).toEqual({ kind: 'pass' });
  });
});

describe('fail closed', () => {
  it('an internal failure withholds the whole message and submits nothing', () => {
    const broken = new Proxy(VALID, {
      get: () => {
        throw new Error('context unavailable');
      },
    });
    expect(inspect('mi código es 482913', broken)).toEqual({
      kind: 'replace', text: PLATFORM_MARKERS.messageWithheld, reason: 'fail_closed', submission: null,
    });
  });
});

describe('invariants over formats and wrappers', () => {
  const formats = ['482913', '482 913', '482-913', '４８２９１３', '٤٨٢٩١٣', '4\uFE0F\u20E38\uFE0F\u20E32\uFE0F\u20E39\uFE0F\u20E31\uFE0F\u20E33\uFE0F\u20E3', '48.29.13', '482\u200B913'];
  const wrappers = ['{c}', 'mi código es {c}', 'pedido {c}', '{c} y {c}', '${c}', '{c} y quiero 3 sacos', 'hola {c} gracias'];
  const contexts = [VALID, GRACE, NOT_ATTESTED];
  const asciiDigits = (text: string) => [...text.normalize('NFKC')].filter((c) => /[0-9]/.test(c)).join('');

  const fragments = ['482 y 913', '482    913', '482----913', '482 🙏 913', '482 913 1234', '48 2913 1234', '٤٨٢ ٩١٣ ١٢٣٤'];

  it('with protection, the code never survives in the persisted text, in any script', () => {
    for (const format of [...formats, ...fragments]) {
      for (const wrapper of wrappers) {
        for (const context of contexts) {
          const result = replaced(inspect(wrapper.replaceAll('{c}', format), context));
          expect(result.text).not.toContain(format);
          expect(asciiDigits(result.text)).not.toContain(CODE);
        }
      }
    }
  });

  it('a submission is always six ASCII digits and only ever comes with code_submitted', () => {
    for (const format of formats) {
      for (const wrapper of wrappers) {
        for (const context of [...contexts, UNPROTECTED]) {
          const result = inspect(wrapper.replaceAll('{c}', format), context);
          if (result.kind === 'replace' && result.submission) {
            expect(result.reason).toBe('code_submitted');
            expect(result.submission.code).toMatch(/^[0-9]{6}$/);
          } else if (result.kind === 'replace') {
            expect(result.reason).not.toBe('code_submitted');
          }
        }
      }
    }
  });

  it('a split or mixed numeric fragment is never submitted, whatever surrounds it', () => {
    for (const format of fragments) {
      for (const wrapper of wrappers) {
        const result = replaced(inspect(wrapper.replaceAll('{c}', format)));
        expect(result.submission).toBeNull();
        expect(result.reason).not.toBe('code_submitted');
      }
    }
  });

  it('nothing is submitted without a valid expectation and an attested subject', () => {
    for (const format of formats) {
      for (const context of [GRACE, NOT_ATTESTED, UNPROTECTED]) {
        const result = inspect(format, context);
        expect(result.kind === 'replace' ? result.submission : null).toBeNull();
      }
    }
  });
});

describe('OA-07b: the CODE_CONTEXT allowlist is exactly the owner-approved list', () => {
  it('is not widened implicitly', () => {
    expect([...CODE_CONTEXT].sort()).toEqual([
      'aqui', 'aquí', 'clave', 'cod', 'code', 'codigo', 'código', 'de', 'el', 'envio', 'envío', 'es', 'ese', 'este',
      'gracias', 'here', 'hola', 'is', 'la', 'listo', 'lo', 'mando', 'mi', 'my', 'ok', 'otp', 'paso', 'seria', 'sería',
      'te', 'va', 'verificacion', 'verificación',
    ].sort());
  });

  it('a word outside the list prevents the submission', () => {
    expect(inspect('mi número es 482913')).toMatchObject({ reason: 'context_not_allowed', submission: null });
  });
});
