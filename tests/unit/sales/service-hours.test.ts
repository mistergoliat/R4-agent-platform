import { describe, expect, it } from 'vitest';
import { SALES_HUMAN_REQUEST_NOTICE_TEXT, SALES_RUN_FAILURE_FALLBACK_TEXT, frameUnsupported, salesConsultationExpiry, salesHumanRequestNotice, salesRunFailureNotice, salesServiceWindow, salesUnprocessableSentence } from '@r4-sales/agent/production';

/** (Owner decision 2026-11-12) Service hours: Monday to Friday, 10:00 to 17:00, Chile time. */
const chile = (iso: string) => new Date(iso); // UTC instants; Chile is UTC-3 in these dates (summer time)

describe('Sales service hours', () => {
  it.each([
    ['Wednesday 12:00', '2026-01-07T15:00:00Z', { open: true, reopens: null }],
    ['Wednesday 10:00 (opens)', '2026-01-07T13:00:00Z', { open: true, reopens: null }],
    ['Wednesday 16:59', '2026-01-07T19:59:00Z', { open: true, reopens: null }],
    ['Wednesday 17:00 (closes)', '2026-01-07T20:00:00Z', { open: false, reopens: 'next_business_day' }],
    ['Wednesday 08:30 (before opening)', '2026-01-07T11:30:00Z', { open: false, reopens: 'today' }],
    ['Saturday 12:00', '2026-01-10T15:00:00Z', { open: false, reopens: 'next_business_day' }],
    ['Sunday 09:00', '2026-01-11T12:00:00Z', { open: false, reopens: 'next_business_day' }],
    ['Friday 18:00', '2026-01-09T21:00:00Z', { open: false, reopens: 'next_business_day' }],
  ])('%s', (_name, iso, expected) => {
    expect(salesServiceWindow(chile(iso))).toEqual(expected);
  });

  it('follows Chile winter time too (UTC-4): a weekday 10:00 in July is open', () => {
    expect(salesServiceWindow(new Date('2026-07-08T14:00:00Z'))).toEqual({ open: true, reopens: null });
    expect(salesServiceWindow(new Date('2026-07-08T13:59:00Z'))).toEqual({ open: false, reopens: 'today' });
  });
});

describe('what the customer is told', () => {
  const open = chile('2026-01-07T15:00:00Z');
  const evening = chile('2026-01-07T22:00:00Z');
  const early = chile('2026-01-07T11:00:00Z');

  it('content the bot cannot process: a problem, a retry, and a trainer (in hours) or when the team answers (after hours)', () => {
    expect(salesUnprocessableSentence(open)).toBe('Tuve un problema para ver lo que me enviaste y estoy intentando solucionarlo. ¿Me lo puedes enviar de nuevo o escribirme qué necesitas? Si prefieres, te derivo con un entrenador de nuestro equipo.');
    expect(salesUnprocessableSentence(evening)).toMatch(/Si prefieres hablar con un entrenador: Nuestro equipo está entrenando 💪 y te responderá el siguiente día hábil, entre las 10:00 y las 17:00\.$/);
    expect(salesUnprocessableSentence(early)).toMatch(/te responderá hoy, entre las 10:00 y las 17:00\.$/);
    expect(frameUnsupported('unsupported', evening)).toContain('Nuestro equipo está entrenando');
    expect(frameUnsupported('audio', open)).toContain('Tuve un problema para escuchar lo que me enviaste');
    expect(frameUnsupported('reaction', open)).toMatch(/^\[r4:evento\] El cliente reaccionó con un emoji/);
    expect(frameUnsupported('reaction', open)).not.toMatch(/Tuve un problema|entrenador/);
    expect(frameUnsupported('constructor', open)).toContain('un tipo de mensaje que la plataforma no puede procesar');
  });

  it('notices that promise a person say when the person answers', () => {
    expect(salesRunFailureNotice(open)).toBe(SALES_RUN_FAILURE_FALLBACK_TEXT);
    expect(salesHumanRequestNotice(open)).toBe(SALES_HUMAN_REQUEST_NOTICE_TEXT);
    expect(SALES_RUN_FAILURE_FALLBACK_TEXT).toMatch(/estoy intentando solucionarlo: ya le avisé a un asesor/);
    for (const text of [salesRunFailureNotice(evening), salesHumanRequestNotice(evening)]) {
      expect(text).toContain('Nuestro equipo está entrenando 💪 y te responderá el siguiente día hábil, entre las 10:00 y las 17:00.');
      expect(text).not.toMatch(/asesor|cotizaci[oó]n|emit|confirm|pedido|pago|qued[oó]/i);
    }
  });
});

/**
 * (Owner decision 2026-11-23) When a consultation to the team expires: 30 min in service hours; otherwise the next
 * opening + 30 min; never later than the customer's 24 h window minus 30 min. Chile is UTC-3 on these dates.
 */
describe('Sales consultation expiry', () => {
  const at = (chileLocal: string, latestInputLocal = chileLocal) => salesConsultationExpiry({ now: `${chileLocal}-03:00`, latestInputAt: `${latestInputLocal}-03:00` });
  const chileTime = (iso: string) => new Date(iso).toISOString();
  it.each([
    ['in hours (Tue 11:00): 30 min', '2026-11-24T11:00:00', '2026-11-24T11:30:00'],
    ['30 min fit exactly before closing (Tue 16:30)', '2026-11-24T16:30:00', '2026-11-24T17:00:00'],
    ['near closing (Tue 16:50): next day 10:30', '2026-11-24T16:50:00', '2026-11-25T10:30:00'],
    ['after hours (Tue 21:00): Wed 10:30', '2026-11-24T21:00:00', '2026-11-25T10:30:00'],
    ['before opening (Tue 09:45): 10:30 the same day', '2026-11-24T09:45:00', '2026-11-24T10:30:00'],
  ])('%s', (_name, now, expected) => {
    expect(at(now)).toBe(chileTime(`${expected}-03:00`));
  });

  it('Fri 20:00: Monday 10:30 would be past the 24 h window, so it is capped at Sat 19:30 (latest input + 24 h - 30 min)', () => {
    expect(at('2026-11-27T20:00:00')).toBe(chileTime('2026-11-28T19:30:00-03:00'));
  });

  it('the cap counts from the latest customer message, and never falls before a minute from now', () => {
    // Asked Tue 21:00 about a message from Mon 22:00: the window closes Tue 21:30 (- margin), sooner than Wed 10:30.
    expect(at('2026-11-24T21:00:00', '2026-11-23T22:00:00')).toBe(chileTime('2026-11-24T21:30:00-03:00'));
    // The window already closed: expires in a minute (the agent wakes and tells, as it can).
    expect(at('2026-11-24T21:00:00', '2026-11-22T10:00:00')).toBe(chileTime('2026-11-24T21:01:00-03:00'));
  });
});
