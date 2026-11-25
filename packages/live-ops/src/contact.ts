import { PlatformError } from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { OutboundTemplate } from './channel.js';
import type { ProductionStore } from './ports.js';

/**
 * (ADR-055) The contact gate: whether a message on the platform's own initiative (not an answer to the contact) may go
 * out, decided by owner rules every source obeys. Answers never pass through it. Core knows purposes only as strings
 * from the pack; it never learns what the subject of a message is.
 */

/** `observe` decides and records only; `active` sends. */
export type ContactMode = 'observe' | 'active';

/** The owner's rules (ADR-055 Decision 2, revision 1). Versioned: every decision records `version`. */
export interface ContactRules {
  readonly version: string;
  readonly timeZone: string;
  /** ISO weekdays (1 = Monday … 7 = Sunday) with service, and the local span `[from, to)` as minutes of the day. */
  readonly days: readonly number[];
  readonly fromMinute: number;
  readonly toMinute: number;
  /** At most one message per `minGapMs`, and `maxPerWindow` per `windowMs` (all sources). */
  readonly minGapMs: number;
  readonly maxPerWindow: number;
  readonly windowMs: number;
  /** The channel's free-text window after the contact's last message (e.g. 24 h). */
  readonly freeTextWindowMs: number;
}

export type ContactTemplate = OutboundTemplate;

/** One message a source wants to send now, if the gate lets it. */
export interface ContactCandidate {
  /** Unique per message forever, e.g. `<pack>.<source>:<reference>:<step>`: one decision per source reference. */
  readonly sourceRef: string;
  readonly purpose: string;
  readonly channel: string;
  readonly conversationKey: string;
  /** The task the message rides on (its delivery owner thread). */
  readonly taskId: string;
  readonly lastInboundAt: Date;
  /** Past this instant the message no longer makes sense: a waiting decision becomes `dropped`. */
  readonly deadline: Date;
  /** The free text (also the caption of what a template would say, for the observed record). */
  readonly text: string;
  /** Present: the message goes as this template (allowed outside the free-text window). */
  readonly template: ContactTemplate | null;
  /** The platform notice key it is sent under (`^[a-z][a-z0-9._:-]{2,199}$`). */
  readonly noticeKey: string;
}

export interface ContactSource {
  /** Candidates due now, without a decision yet, with the database time they were selected at. */
  due(limit: number): Promise<{ readonly now: Date; readonly candidates: readonly ContactCandidate[] }>;
}

export type ContactOutcome = 'send' | 'stopped' | 'dropped';

export interface ContactDecisionRecord {
  readonly sourceRef: string;
  readonly purpose: string;
  readonly channel: string;
  readonly conversationKey: string;
  readonly taskId: string;
  readonly mode: ContactMode;
  readonly outcome: ContactOutcome;
  readonly rule: string;
  readonly rulesVersion: string;
  readonly text: string;
  readonly template: ContactTemplate | null;
  readonly outboundId: string | null;
}

/** The gate's durable state: opt-outs and the log of decisions (also the frequency count). */
export interface ContactStore {
  optedOut(channel: string, conversationKey: string): Promise<boolean>;
  /** Idempotent: a contact already opted out stays as it was (false). */
  recordOptOut(command: { readonly channel: string; readonly conversationKey: string; readonly source: 'contact_keyword' | 'operator'; readonly inboundId: string | null }): Promise<boolean>;
  /** Instants of the `send` decisions of this mode for the contact since `since`. */
  sentSince(channel: string, conversationKey: string, mode: ContactMode, since: Date): Promise<Date[]>;
  /** False when the source reference already has a decision (a concurrent sweep won). */
  recordDecision(decision: ContactDecisionRecord): Promise<boolean>;
}

export type GateResult =
  | { readonly outcome: 'send'; readonly rule: 'allowed' }
  /** Final: the contact's permission (rule 1) or the channel (rule 7) forbids it. */
  | { readonly outcome: 'stopped'; readonly rule: 'opt_out' | 'channel' }
  /** Not now: may pass later, until the candidate's deadline. */
  | { readonly outcome: 'wait'; readonly rule: 'human' | 'gap' | 'monthly_cap' | 'hours' };

/** Local weekday (1–7) and minute of the day of `at` in `timeZone`. */
export function localClock(at: Date, timeZone: string): { readonly weekday: number; readonly minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday ?? '') + 1;
  return { weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * The rules in the order of ADR-055 Decision 2; the first that applies decides. Rules 2 (an open claim) and 4 (the owner of
 * the subject) arrive as pauses of the owning services (C3): until then they never apply.
 */
export function decideContact(
  facts: { readonly now: Date; readonly optedOut: boolean; readonly humanOwned: boolean; readonly sent: readonly Date[]; readonly lastInboundAt: Date; readonly template: boolean },
  rules: ContactRules,
): GateResult {
  if (facts.optedOut) return { outcome: 'stopped', rule: 'opt_out' };
  if (facts.humanOwned) return { outcome: 'wait', rule: 'human' };
  const now = facts.now.getTime();
  if (facts.sent.some((t) => now - t.getTime() < rules.minGapMs)) return { outcome: 'wait', rule: 'gap' };
  if (facts.sent.filter((t) => now - t.getTime() < rules.windowMs).length >= rules.maxPerWindow) return { outcome: 'wait', rule: 'monthly_cap' };
  const local = localClock(facts.now, rules.timeZone);
  if (!rules.days.includes(local.weekday) || local.minute < rules.fromMinute || local.minute >= rules.toMinute) return { outcome: 'wait', rule: 'hours' };
  if (!facts.template && now - facts.lastInboundAt.getTime() >= rules.freeTextWindowMs) return { outcome: 'stopped', rule: 'channel' };
  return { outcome: 'send', rule: 'allowed' };
}

/** Lower case, no accents, no punctuation or emoji, single spaces: how opt-out words are compared (equality only). */
export function normalizeContactText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** (ADR-055 rule 1) The pack's opt-out words and its fixed texts. */
export interface ContactOptOut {
  /** Normalized (`normalizeContactText`) phrases; the whole message must equal one. */
  readonly phrases: readonly string[];
  /** Sent at once as a platform notice when the contact's case is live and no person owns it. */
  readonly confirmation: string;
  /** The input the agent receives instead when a new case opens with the opt-out (it confirms in its own words). */
  readonly frame: string;
}

export const isOptOut = (optOut: ContactOptOut, text: string): boolean => optOut.phrases.includes(normalizeContactText(text));

export interface ContactSweepResult {
  readonly sent: number;
  readonly observed: number;
  readonly stopped: number;
  readonly dropped: number;
  readonly failed: number;
}

/**
 * (ADR-055 C1/C2) Takes the source's due candidates through the gate and records one decision per source reference.
 * `observe` decides and records, never enqueues. `active` enqueues free text as a platform notice (idempotent by its
 * key, before the decision, so a crash in between is a replay, never a second message); a template is sent only with `templates` (C2b:
 * the provider approved it), otherwise observed. A waiting candidate is decided again on the next sweep, and dropped
 * (with the rule that held it) once past its deadline.
 */
export interface ContactSweepOptions {
  readonly store: Pick<ProductionStore, 'taskState' | 'createPlatformNotice'>;
  readonly contacts: ContactStore;
  readonly source: ContactSource;
  readonly rules: ContactRules;
  readonly mode: ContactMode;
  /** (C2b) Send templates too in `active` mode; otherwise they are only observed. */
  readonly templates?: boolean;
  readonly logger: StructuredLogger;
}

export class ContactSweep {
  readonly #o: ContactSweepOptions;

  constructor(options: ContactSweepOptions) {
    this.#o = options;
  }

  async sweep(limit = 50): Promise<ContactSweepResult> {
    const { store, contacts, source, rules, logger } = this.#o;
    const tally = { sent: 0, observed: 0, stopped: 0, dropped: 0, failed: 0 };
    const { now, candidates } = await source.due(limit);
    for (const c of candidates) {
      try {
        const mode: ContactMode = c.template && this.#o.templates !== true ? 'observe' : this.#o.mode;
        const gate = decideContact({
          now,
          optedOut: await contacts.optedOut(c.channel, c.conversationKey),
          humanOwned: (await store.taskState(c.taskId))?.humanOwned ?? false,
          sent: await contacts.sentSince(c.channel, c.conversationKey, mode, new Date(now.getTime() - rules.windowMs)),
          lastInboundAt: c.lastInboundAt,
          template: c.template !== null,
        }, rules);
        const late = now.getTime() > c.deadline.getTime();
        const outcome: ContactOutcome = gate.outcome === 'stopped' ? 'stopped' : gate.outcome === 'wait' || late ? 'dropped' : 'send';
        if (gate.outcome === 'wait' && !late) continue;
        const rule = gate.outcome === 'send' && late ? 'deadline' : gate.rule;
        let outboundId: string | null = null;
        if (outcome === 'send' && mode === 'active') {
          outboundId = (await store.createPlatformNotice({ taskId: c.taskId, noticeKey: c.noticeKey, text: c.text, correlationId: `contact:${c.sourceRef}`, ...(c.template ? { template: c.template } : {}) })).record.outboundId;
        }
        const recorded = await contacts.recordDecision({ sourceRef: c.sourceRef, purpose: c.purpose, channel: c.channel, conversationKey: c.conversationKey, taskId: c.taskId, mode, outcome, rule, rulesVersion: rules.version, text: c.text, template: c.template, outboundId });
        if (!recorded) continue;
        if (outcome === 'send') tally[mode === 'active' ? 'sent' : 'observed'] += 1;
        else tally[outcome] += 1;
        emitTelemetry(logger, 'contact.decided', { channel: c.channel, taskId: c.taskId, purpose: c.purpose, sourceRef: c.sourceRef, mode, outcome, rule });
      } catch (error) {
        tally.failed += 1;
        emitTelemetry(logger, 'contact.failed', { channel: c.channel, taskId: c.taskId, sourceRef: c.sourceRef, error: error instanceof PlatformError ? error.code : 'infrastructure' });
      }
    }
    return tally;
  }
}
