import type { Clock } from '@r4/contracts';
import { query, type Pool } from './pool.js';
import { iso, type Row } from './rows.js';

/**
 * (ADR-067 D2) The latest rating per (task, scope, rated reply): the history is kept, reads use this. Ties on the
 * contact's time go to the later arrival. Rows without a task are never «latest» of anything (see `unresolved`).
 */
export const LATEST_FEEDBACK = `select distinct on (task_id, scope, outbound_id) *
    from customer_feedback where task_id is not null
   order by task_id, scope, outbound_id, occurred_at desc, received_at desc, feedback_id desc`;

export const FEEDBACK_REVIEW_LIMIT = 50;

/** Latest values in the window. `unanswered`: the card was shown and nothing replaced it. */
export interface FeedbackCounts {
  readonly unanswered: number;
  readonly bien: number;
  readonly mas_o_menos: number;
  readonly mal: number;
  readonly up: number;
  readonly down: number;
}

export type FeedbackAnsweredBy = 'agent' | 'person';

export interface FeedbackReviewItem {
  readonly taskId: string;
  readonly channel: string;
  readonly scope: 'conversation' | 'message';
  readonly value: 'mal' | 'mas_o_menos' | 'down';
  readonly outboundId: string | null;
  readonly at: string;
  /** The contact's own words: untrusted data, shown as text, never interpreted. */
  readonly comment: string | null;
}

export interface FeedbackView {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly totals: FeedbackCounts;
  readonly byChannel: (FeedbackCounts & { readonly channel: string })[];
  /** Who answered the conversation: `person` when a person wrote to the contact or took the conversation. */
  readonly byAnsweredBy: (FeedbackCounts & { readonly answeredBy: FeedbackAnsweredBy })[];
  /** Ratings in the window whose conversation had no task (never counted above). */
  readonly unresolved: number;
  /** The newest «Mal», «Más o menos» and «No», at most FEEDBACK_REVIEW_LIMIT. */
  readonly review: FeedbackReviewItem[];
}

const zero = (): Record<keyof FeedbackCounts, number> => ({ unanswered: 0, bien: 0, mas_o_menos: 0, mal: 0, up: 0, down: 0 });
const KEY: Record<string, keyof FeedbackCounts> = { shown: 'unanswered', bien: 'bien', mas_o_menos: 'mas_o_menos', mal: 'mal', up: 'up', down: 'down' };

export class PostgresFeedback {
  readonly #pool: Pool;
  readonly #clock: Clock;
  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  /** The last `days` × 24 h up to now, by the time the contact rated. */
  async summary(days: number): Promise<FeedbackView> {
    const now = this.#clock.now();
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    // ponytail: LATEST_FEEDBACK scans the whole table (one row per rating); bound it by time if it ever holds millions.
    const latest = `with latest as (${LATEST_FEEDBACK}),
      win as (
        select l.*,
               case when exists (select 1 from outbound_messages o where o.task_id = l.task_id and o.origin = 'operator' and o.status <> 'cancelled')
                      or exists (select 1 from human_requests h where h.task_id = l.task_id and h.kind = 'handoff' and h.human_ref is not null)
                    then 'person' else 'agent' end as answered_by
          from latest l where l.occurred_at >= $1::timestamptz)`;
    const groups = (await query<Row>(this.#pool, `${latest} select channel, answered_by, value, count(*)::int as n from win group by 1, 2, 3`, [since])).rows;
    const review = (await query<Row>(
      this.#pool,
      `${latest} select task_id, channel, scope, value, outbound_id, occurred_at, comment from win
        where value in ('mal', 'mas_o_menos', 'down') order by occurred_at desc, feedback_id desc limit $2`,
      [since, FEEDBACK_REVIEW_LIMIT],
    )).rows;
    const unresolved = (await query<Row>(this.#pool, 'select count(*)::int as n from customer_feedback where task_id is null and occurred_at >= $1::timestamptz', [since])).rows[0]!.n as number;

    const totals = zero();
    const byChannel = new Map<string, Record<keyof FeedbackCounts, number>>();
    const byAnsweredBy = new Map<FeedbackAnsweredBy, Record<keyof FeedbackCounts, number>>();
    for (const g of groups) {
      const key = KEY[g.value as string]!;
      const n = g.n as number;
      for (const counts of [totals, upsert(byChannel, g.channel as string), upsert(byAnsweredBy, g.answered_by as FeedbackAnsweredBy)]) counts[key] += n;
    }
    return {
      windowDays: days,
      generatedAt: now.toISOString(),
      totals,
      byChannel: [...byChannel].sort(([a], [b]) => a.localeCompare(b)).map(([channel, counts]) => ({ channel, ...counts })),
      byAnsweredBy: [...byAnsweredBy].sort(([a], [b]) => a.localeCompare(b)).map(([answeredBy, counts]) => ({ answeredBy, ...counts })),
      unresolved,
      review: review.map((r) => ({
        taskId: r.task_id as string, channel: r.channel as string, scope: r.scope as FeedbackReviewItem['scope'], value: r.value as FeedbackReviewItem['value'],
        outboundId: (r.outbound_id as string | null) ?? null, at: iso(r.occurred_at), comment: (r.comment as string | null) ?? null,
      })),
    };
  }
}

function upsert<K>(map: Map<K, Record<keyof FeedbackCounts, number>>, key: K): Record<keyof FeedbackCounts, number> {
  const found = map.get(key);
  if (found) return found;
  const created = zero();
  map.set(key, created);
  return created;
}
