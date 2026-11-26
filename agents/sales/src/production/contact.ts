import type pg from 'pg';
import { WHATSAPP_CHANNEL_ID } from '@r4-adapters/whatsapp-cloud';
import type { ContactCandidate, ContactMode, ContactOptOut, ContactRules, ContactSource } from '@r4/live-ops';

/** (ADR-055, owner decisions of 2026-11-25) The rules every message on Sales' own initiative obeys. */
export const SALES_CONTACT_RULES: ContactRules = Object.freeze({
  version: 'sales-contact@1',
  timeZone: 'America/Santiago',
  days: Object.freeze([1, 2, 3, 4, 5, 6]),
  fromMinute: 9 * 60,
  toMinute: 20 * 60,
  minGapMs: 3 * 86_400_000,
  maxPerWindow: 4,
  windowMs: 30 * 86_400_000,
  freeTextWindowMs: 24 * 3_600_000,
});

export const SALES_OPT_OUT: ContactOptOut = Object.freeze({
  phrases: Object.freeze(['baja', 'no me escriban', 'no quiero mas mensajes']),
  confirmation: 'Listo, no te escribiremos por iniciativa propia. Si nos escribes, te respondemos como siempre.',
  frame: '[r4:baja] El cliente pidió no recibir mensajes por iniciativa propia, y la plataforma ya lo registró. Confírmale en una frase que no le escribiremos por iniciativa propia y que, si nos escribe, le respondemos como siempre. No le ofrezcas nada.',
});

/** (ADR-055 rev. 1) The line the quote's PDF caption gains on WhatsApp while the contact gate is composed. */
export const SALES_QUOTE_OPT_OUT_LINE = 'Si no quieres que te escribamos, responde BAJA.';

/** (owner 2026-11-26) v2: quotes are valid 60 minutes, so the template offers to refresh the quote and never states a validity. */
export const SALES_FOLLOW_UP_TEMPLATE = 'seguimiento_cotizacion_v2';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** S1: the first in-hours moment from 18 h after the contact's last message, never past 23 h 30 (inside the 24 h window). */
export const FOLLOW_UP_1_FROM_MS = 18 * HOUR;
export const FOLLOW_UP_1_UNTIL_MS = 23.5 * HOUR;
/** S2: 3 days after S1 (the 1-per-3-days cap), or 4 days after the quote without S1; dropped 2 days later. */
export const FOLLOW_UP_2_AFTER_S1_MS = 3 * DAY;
export const FOLLOW_UP_2_AFTER_QUOTE_MS = 4 * DAY;
export const FOLLOW_UP_2_SLACK_MS = 2 * DAY;

export const followUpSourceRef = (quoteId: string, step: 1 | 2) => `sales.quote-followup:${quoteId.toLowerCase()}:${step}`;

/**
 * (owner 2026-11-26) Quotes are valid 60 minutes: a follow-up never says the quote still holds. It offers to refresh it
 * with today's prices and stock; if the contact answers, the agent quotes again.
 */
export function followUpText(step: 1 | 2, quoteNumber: string): string {
  return step === 1
    ? `Hola, ¿pudiste revisar la cotización ${quoteNumber}? Si quieres, la actualizo con los precios y el stock de hoy, o vemos cualquier duda del despacho.`
    : `Hola, te escribe Pesín de Pesas Chile. ¿Pudiste revisar tu cotización ${quoteNumber}? Si quieres, la actualizo con los precios y el stock de hoy o resolvemos cualquier duda.`;
}

/** What the source reads per conversation task: its latest issued quote and the facts the follow-up depends on. */
export interface QuoteFollowUpRow {
  readonly now: Date;
  readonly taskId: string;
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly issuedAt: Date;
  readonly channel: string;
  readonly conversationKey: string;
  readonly bindingOpen: boolean;
  /** The contact's last message in this case, and in any case of the same contact. */
  readonly lastInboundAt: Date | null;
  readonly contactLastInboundAt: Date | null;
  /** The case waits for the contact with nothing in flight (no outbound pending, no human request, no action running). */
  readonly idleWaiting: boolean;
  /** The case was closed by the idle close (ADR-047). */
  readonly idleClosed: boolean;
  readonly s1: { readonly at: Date; readonly outcome: string; readonly mode: string } | null;
}

/**
 * The follow-ups due now, from the rows (pure). The sequence ends — no candidate — when the contact wrote after the
 * case went idle (that is a new conversation) or the case ended any other way (a person, a
 * completion). Opt-out, a person on the case, frequency and hours are the gate's, not this plan's.
 */
export function planQuoteFollowUps(rows: readonly QuoteFollowUpRow[], mode: ContactMode): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  for (const r of rows) {
    const now = r.now.getTime();
    const last = r.lastInboundAt?.getTime();
    // A quote is valid 60 minutes: an expired quote is the usual case, and the follow-up offers to refresh it.
    if (last === undefined) continue;
    if ((r.contactLastInboundAt?.getTime() ?? last) > last) continue;
    const base = { purpose: 'seguimiento', channel: r.channel, conversationKey: r.conversationKey, taskId: r.taskId, lastInboundAt: r.lastInboundAt! };
    if (!r.s1) {
      if (r.bindingOpen && r.idleWaiting && now >= last + FOLLOW_UP_1_FROM_MS && now < last + 24 * HOUR) {
        out.push({ ...base, sourceRef: followUpSourceRef(r.quoteId, 1), deadline: new Date(last + FOLLOW_UP_1_UNTIL_MS), text: followUpText(1, r.quoteNumber), template: null, noticeKey: `sales.followup-1:${r.quoteId.toLowerCase()}` });
        continue;
      }
      if (now < last + 24 * HOUR) continue;
    }
    if (!(r.idleClosed || r.idleWaiting)) continue;
    const s1Sent = r.s1 !== null && r.s1.outcome === 'send' && r.s1.mode === mode;
    const due = s1Sent ? r.s1.at.getTime() + FOLLOW_UP_2_AFTER_S1_MS : r.issuedAt.getTime() + FOLLOW_UP_2_AFTER_QUOTE_MS;
    if (now < due) continue;
    out.push({
      ...base, sourceRef: followUpSourceRef(r.quoteId, 2), deadline: new Date(due + FOLLOW_UP_2_SLACK_MS), text: followUpText(2, r.quoteNumber),
      template: { name: SALES_FOLLOW_UP_TEMPLATE, language: 'es', parameters: [r.quoteNumber] }, noticeKey: `sales.followup-2:${r.quoteId.toLowerCase()}`,
    });
  }
  return out;
}

/**
 * (ADR-055 C1/C2) Quote follow-ups on WhatsApp: the latest quote of each conversation task issued in the last 10 days,
 * on the temporal clock (`r4_now()`), the clock of task inputs and of the idle close.
 */
export function salesQuoteFollowUpSource(pool: pg.Pool, mode: ContactMode, channel: string = WHATSAPP_CHANNEL_ID): ContactSource {
  return {
    async due(limit) {
      const r = await pool.query<{
        now: Date; task_id: string; quote_id: string; quote_number: string; issued_at: Date; channel: string; conversation_key: string;
        binding_open: boolean; last_inbound_at: Date | null; contact_last_inbound_at: Date | null; idle_waiting: boolean; idle_closed: boolean;
        s1_at: Date | null; s1_outcome: string | null; s1_mode: string | null;
      }>(
        `with q as (
           select distinct on (i.task_id) i.task_id, i.quote_id, i.quote_number, i.issued_at
             from sales.quote_v2_issued i
            where i.issued_at > r4_now() - interval '10 days'
            order by i.task_id, i.issued_at desc
         )
         select r4_now() as now, q.*, b.channel, b.conversation_key, b.status = 'open' as binding_open, b.last_inbound_at,
                (select max(b2.last_inbound_at) from channel_conversation_bindings b2 where b2.channel = b.channel and b2.conversation_key = b.conversation_key) as contact_last_inbound_at,
                (t.status = 'waiting'
                  and exists (select 1 from task_waits w where w.task_id = t.task_id and w.status = 'waiting' and w.kind = 'WAIT_FOR_INPUT')
                  and not exists (select 1 from outbound_messages o where o.task_id = t.task_id and o.status in ('pending', 'dispatching', 'unknown'))
                  and not exists (select 1 from human_requests h where h.task_id = t.task_id and h.status in ('requested', 'active'))
                  and not exists (select 1 from action_executions e where e.task_id = t.task_id and e.status not in ('succeeded', 'rejected', 'failed'))) as idle_waiting,
                (t.status = 'cancelled' and t.status_reason = 'idle_timeout') as idle_closed,
                s1.decided_at as s1_at, s1.outcome as s1_outcome, s1.mode as s1_mode
           from q
           join channel_conversation_bindings b on b.task_id = q.task_id
           join agent_tasks t on t.task_id = q.task_id
           left join contact_decisions s1 on s1.source_ref = 'sales.quote-followup:' || q.quote_id::text || ':1'
          where b.channel = $1 and b.autonomy = 'autonomous'
            and not exists (select 1 from contact_decisions d3 where d3.source_ref = 'sales.quote-followup:' || q.quote_id::text || ':2')
          order by q.issued_at`,
        [channel],
      );
      const now = r.rows[0]?.now ?? (await pool.query<{ now: Date }>('select r4_now() as now')).rows[0]!.now;
      const rows: QuoteFollowUpRow[] = r.rows.map((x) => ({
        now: x.now, taskId: x.task_id, quoteId: x.quote_id, quoteNumber: x.quote_number, issuedAt: x.issued_at,
        channel: x.channel, conversationKey: x.conversation_key, bindingOpen: x.binding_open, lastInboundAt: x.last_inbound_at, contactLastInboundAt: x.contact_last_inbound_at,
        idleWaiting: x.idle_waiting, idleClosed: x.idle_closed, s1: x.s1_at ? { at: x.s1_at, outcome: x.s1_outcome!, mode: x.s1_mode! } : null,
      }));
      // ponytail: every quote of the last 10 days is planned each minute; page by issue time if volume ever needs it.
      return { now, candidates: planQuoteFollowUps(rows, mode).slice(0, limit) };
    },
  };
}
