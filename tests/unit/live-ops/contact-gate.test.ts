import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { ContactSweep, decideContact, isOptOut, localClock, normalizeContactText, type ContactCandidate, type ContactDecisionRecord, type ContactStore } from '@r4/live-ops';
import { SALES_CONTACT_RULES as RULES, SALES_OPT_OUT } from '@r4-sales/agent/production';

/** ADR-055 C1: the contact gate decides messages on the platform's own initiative, in the owner's rule order. */
// Wednesday 2026-11-25 12:00 in Chile (UTC-3, daylight saving).
const NOON = new Date('2026-11-25T15:00:00.000Z');
const H = 3_600_000;
const facts = (over: Partial<Parameters<typeof decideContact>[0]> = {}) => ({ now: NOON, optedOut: false, humanOwned: false, sent: [], lastInboundAt: new Date(NOON.getTime() - 20 * H), template: false, ...over });

describe('contact gate (rules in order)', () => {
  it('lets a message out in hours, inside the window, with no recent message', () => {
    expect(decideContact(facts(), RULES)).toEqual({ outcome: 'send', rule: 'allowed' });
  });

  it('opt-out first and final, then a person on the case, then the frequency, then the hours, then the channel', () => {
    const sunday = new Date('2026-11-29T15:00:00.000Z');
    const everything = facts({ optedOut: true, humanOwned: true, sent: [new Date(sunday.getTime() - H)], now: sunday, lastInboundAt: new Date(0) });
    expect(decideContact(everything, RULES)).toEqual({ outcome: 'stopped', rule: 'opt_out' });
    expect(decideContact({ ...everything, optedOut: false }, RULES)).toEqual({ outcome: 'wait', rule: 'human' });
    expect(decideContact({ ...everything, optedOut: false, humanOwned: false }, RULES)).toEqual({ outcome: 'wait', rule: 'gap' });
    expect(decideContact({ ...everything, optedOut: false, humanOwned: false, sent: [] }, RULES)).toEqual({ outcome: 'wait', rule: 'hours' });
    expect(decideContact(facts({ lastInboundAt: new Date(NOON.getTime() - 24 * H) }), RULES)).toEqual({ outcome: 'stopped', rule: 'channel' });
    expect(decideContact(facts({ lastInboundAt: new Date(NOON.getTime() - 96 * H), template: true }), RULES)).toEqual({ outcome: 'send', rule: 'allowed' });
  });

  it('at most 1 per 3 days and 4 per 30 days, all sources counted', () => {
    const day = 86_400_000;
    expect(decideContact(facts({ sent: [new Date(NOON.getTime() - 3 * day + 60_000)] }), RULES).rule).toBe('gap');
    expect(decideContact(facts({ sent: [new Date(NOON.getTime() - 3 * day)] }), RULES).outcome).toBe('send');
    const four = [4, 8, 12, 16].map((d) => new Date(NOON.getTime() - d * day));
    expect(decideContact(facts({ sent: four }), RULES)).toEqual({ outcome: 'wait', rule: 'monthly_cap' });
    expect(decideContact(facts({ sent: four.slice(1) }), RULES).outcome).toBe('send');
  });

  it('hours: Monday to Saturday 9:00–20:00 in Chile, daylight saving included', () => {
    expect(localClock(NOON, 'America/Santiago')).toEqual({ weekday: 3, minute: 12 * 60 });
    const at = (iso: string) => decideContact(facts({ now: new Date(iso), lastInboundAt: new Date(new Date(iso).getTime() - H) }), RULES).outcome;
    expect(at('2026-11-25T11:59:00.000Z')).toBe('wait'); // 08:59
    expect(at('2026-11-25T12:00:00.000Z')).toBe('send'); // 09:00
    expect(at('2026-11-25T22:59:00.000Z')).toBe('send'); // 19:59
    expect(at('2026-11-25T23:00:00.000Z')).toBe('wait'); // 20:00
    expect(at('2026-11-28T15:00:00.000Z')).toBe('send'); // Saturday
    expect(at('2026-11-29T15:00:00.000Z')).toBe('wait'); // Sunday
    expect(at('2026-07-01T13:00:00.000Z')).toBe('send'); // winter (UTC-4): 09:00
  });
});

describe('opt-out words', () => {
  it('equality after normalization: case, accents, punctuation and emoji do not matter; a longer sentence is not an opt-out', () => {
    expect(normalizeContactText('  ¡No quiero MÁS mensajes! 🙏 ')).toBe('no quiero mas mensajes');
    for (const t of ['BAJA', 'baja.', 'No me escriban', 'no me escriban!!', 'No quiero más mensajes']) expect(isOptOut(SALES_OPT_OUT, t)).toBe(true);
    for (const t of ['no me escriban más tarde', 'la baja de precio', 'bajar', 'quiero la barra baja', '']) expect(isOptOut(SALES_OPT_OUT, t)).toBe(false);
  });
});

describe('contact sweep', () => {
  const candidate = (over: Partial<ContactCandidate> = {}): ContactCandidate => ({
    sourceRef: 'sales.quote-followup:q1:1', purpose: 'seguimiento', channel: 'whatsapp', conversationKey: 'a'.repeat(64), taskId: 't1',
    lastInboundAt: new Date(NOON.getTime() - 20 * H), deadline: new Date(NOON.getTime() + H), text: 'Hola', template: null, noticeKey: 'sales.followup-1:q1', ...over,
  });
  function harness(c: ContactCandidate[], options: { humanOwned?: boolean; optedOut?: boolean; now?: Date } = {}) {
    const decisions: ContactDecisionRecord[] = [];
    const notices: string[] = [];
    const contacts: ContactStore = {
      optedOut: () => Promise.resolve(options.optedOut ?? false),
      recordOptOut: () => Promise.resolve(true),
      sentSince: (_channel, key) => Promise.resolve(decisions.filter((d) => d.outcome === 'send' && d.conversationKey === key).map(() => NOON)),
      recordDecision: (d) => {
        if (decisions.some((x) => x.sourceRef === d.sourceRef)) return Promise.resolve(false);
        decisions.push(d);
        return Promise.resolve(true);
      },
    };
    const store = {
      taskState: () => Promise.resolve({ humanOwned: options.humanOwned ?? false } as never),
      createPlatformNotice: (n: { noticeKey: string }) => {
        notices.push(n.noticeKey);
        return Promise.resolve({ record: { outboundId: '00000000-0000-7000-8000-000000000001' } as never, replayed: false });
      },
    };
    const sweep = (mode: 'observe' | 'active') => new ContactSweep({ store, contacts, source: { due: () => Promise.resolve({ now: options.now ?? NOON, candidates: c }) }, rules: RULES, mode, logger: createSilentLogger() });
    return { decisions, notices, sweep };
  }

  it('observe decides and records, never enqueues; a second sweep does not decide twice', async () => {
    const h = harness([candidate()]);
    expect(await h.sweep('observe').sweep()).toMatchObject({ observed: 1, sent: 0 });
    expect(await h.sweep('observe').sweep()).toMatchObject({ observed: 0 });
    expect(h.notices).toEqual([]);
    expect(h.decisions).toEqual([expect.objectContaining({ mode: 'observe', outcome: 'send', rule: 'allowed', rulesVersion: 'sales-contact@1', outboundId: null })]);
  });

  it('active enqueues the free text as a platform notice and records its outbound; a template stays observed', async () => {
    const h = harness([candidate(), candidate({ sourceRef: 'sales.quote-followup:q2:2', noticeKey: 'sales.followup-2:q2', conversationKey: 'b'.repeat(64), template: { name: 'seguimiento_cotizacion', language: 'es', parameters: ['PC-1', '28-11-2026'] } })]);
    expect(await h.sweep('active').sweep()).toMatchObject({ sent: 1, observed: 1 });
    expect(h.notices).toEqual(['sales.followup-1:q1']);
    expect(h.decisions.map((d) => [d.mode, d.outboundId !== null])).toEqual([['active', true], ['observe', false]]);
  });

  it('a held candidate waits (no record) until its deadline, then is dropped with the rule that held it; an opt-out stops it', async () => {
    const waiting = harness([candidate()], { humanOwned: true });
    expect(await waiting.sweep('active').sweep()).toMatchObject({ dropped: 0, sent: 0 });
    expect(waiting.decisions).toEqual([]);
    const late = harness([candidate()], { humanOwned: true, now: new Date(NOON.getTime() + 2 * H) });
    expect(await late.sweep('active').sweep()).toMatchObject({ dropped: 1 });
    expect(late.decisions[0]).toMatchObject({ outcome: 'dropped', rule: 'human' });
    const allowedButLate = harness([candidate({ deadline: new Date(NOON.getTime() - 1) })]);
    await allowedButLate.sweep('active').sweep();
    expect(allowedButLate.decisions[0]).toMatchObject({ outcome: 'dropped', rule: 'deadline' });
    expect(allowedButLate.notices).toEqual([]);
    const out = harness([candidate()], { optedOut: true });
    await out.sweep('active').sweep();
    expect(out.decisions[0]).toMatchObject({ outcome: 'stopped', rule: 'opt_out' });
    expect(out.notices).toEqual([]);
  });
});
