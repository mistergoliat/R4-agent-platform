import { PlatformError, type Clock } from '@r4/contracts';
import { query, type Pool } from './pool.js';
import { iso, type Row } from './rows.js';

/**
 * (ADR-049 Phase 2) Read-only projections for the R4 console: a per-step run
 * trace, activity per local day and agent, and a normalized event feed. Durable
 * tables only; no message text, no model reasoning, no free-text decision
 * content, no contact addresses.
 */

export interface RunStepTrace {
  readonly stepId: string;
  readonly iteration: number;
  readonly origin: 'model' | 'platform';
  readonly outcome: 'pending' | 'observed' | 'recorded' | 'refused' | 'invalid' | 'model_failed';
  /** Platform reason code only; the error message is never exposed (it may repeat model output). */
  readonly errorCode: string | null;
  /** read_capability | respond | complete | propose_action | wait | request_consultation | request_handoff | manage_goal; null for invalid/model_failed. */
  readonly decisionType: string | null;
  /** Only for read_capability and propose_action. */
  readonly capabilityId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
  /** createdAt − (previous step's completedAt, or the run's startedAt for the first step): context + model call for model steps. */
  readonly decideMs: number | null;
  /** completedAt − createdAt: the capability READ / governed action until its observation; null while pending. */
  readonly executeMs: number | null;
}

export interface RunStepsView {
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly steps: RunStepTrace[];
}

export interface AgentDayActivity {
  /** null: inbound not attributed to any task (e.g. rejected before ingestion). */
  readonly agentId: string | null;
  readonly tasksCreated: number;
  readonly inboundReceived: number;
  readonly outboundDelivered: number;
  readonly handoffsRequested: number;
  readonly runs: number;
  readonly failedRuns: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly capabilityCalls: number;
}

export interface DayActivity {
  /** Local calendar day (YYYY-MM-DD) in `timeZone`. */
  readonly day: string;
  readonly customerTurn: { readonly p50Ms: number | null; readonly n: number };
  readonly agents: AgentDayActivity[];
}

export interface ProductionActivity {
  readonly timeZone: string;
  readonly days: DayActivity[];
}

export const PLATFORM_EVENT_KINDS = ['task.transition', 'temporal.event', 'autonomy.control', 'action.receipt'] as const;
export type PlatformEventKind = (typeof PLATFORM_EVENT_KINDS)[number];

export interface PlatformEvent {
  /** `<iso>|<id>`; pass as `before` to get the next (older) page. */
  readonly cursor: string;
  readonly at: string;
  readonly kind: PlatformEventKind;
  readonly taskId: string | null;
  /** Worker / operator / platform ref; a channel contact pseudonym shows as `contact`, any ref with `@` as `redacted`. */
  readonly actor: string;
  /** task.transition: new status; temporal.event: event type; autonomy.control: `<scope>:enabled|disabled`; action.receipt: `<capabilityId>:<status>`. */
  readonly code: string;
}

/**
 * Reply latency (`metrics().latency.customerTurnMs`): an agent reply accepted by the channel, measured from
 * the newest task input the replying step could have seen. One row per reply accepted in [since, until] (no upper
 * bound without `until`). Only the FIRST reply accepted after that input counts (owner 2026-11-26): a later one (a
 * relayed consultation answer, a second message) is not the contact waiting, because they already had a reply.
 */
export const customerTurns = (since: string, until?: string): string =>
  `select o.accepted_at as at, o.task_id, s.run_id, extract(epoch from (o.accepted_at - li.at)) * 1000 as ms
     from outbound_messages o join agent_run_steps s on s.step_id = o.response_step_id
     cross join lateral (select max(i.received_at) as at from task_inputs i where i.task_id = o.task_id and i.received_at <= s.created_at) li
    where o.accepted_at >= ${since}${until ? ` and o.accepted_at <= ${until}` : ''}
      and not exists (select 1 from outbound_messages p where p.task_id = o.task_id and p.accepted_at >= li.at and p.accepted_at < o.accepted_at)`;

const ms = (from: unknown, to: unknown): number | null => (from == null || to == null ? null : new Date(to as string).getTime() - new Date(from as string).getTime());
const actor = (col: string) => `case when ${col} ~ '^[a-z][a-z0-9_.-]{0,63}:[0-9a-f]{32}$' then 'contact' when ${col} like '%@%' then 'redacted' else ${col} end`;

export class PostgresConsoleReads {
  readonly #pool: Pool;
  readonly #clock: Clock;
  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async runSteps(runId: string): Promise<RunStepsView> {
    const run = (await query<Row>(this.#pool, 'select run_id, task_id, agent_id, status, started_at, finished_at from agent_runs where run_id = $1', [runId])).rows[0];
    if (!run) throw new PlatformError('not_found', 'run_not_found', `run ${runId} not found`);
    const rows = (
      await query<Row>(
        this.#pool,
        `select step_id, iteration, origin, outcome, error_code, decision_type,
                case when decision_type in ('read_capability', 'propose_action') then decision->>'capabilityId' end as capability_id,
                input_tokens, output_tokens, created_at, completed_at
           from agent_run_steps where run_id = $1 order by iteration limit 500`,
        [runId],
      )
    ).rows;
    let previousEnd: unknown = run.started_at;
    const steps = rows.map((r): RunStepTrace => {
      const step: RunStepTrace = {
        stepId: r.step_id as string, iteration: r.iteration as number, origin: r.origin as RunStepTrace['origin'], outcome: r.outcome as RunStepTrace['outcome'],
        errorCode: (r.error_code as string | null) ?? null, decisionType: (r.decision_type as string | null) ?? null, capabilityId: (r.capability_id as string | null) ?? null,
        inputTokens: r.input_tokens as number, outputTokens: r.output_tokens as number,
        createdAt: iso(r.created_at), completedAt: r.completed_at == null ? null : iso(r.completed_at),
        decideMs: ms(previousEnd, r.created_at), executeMs: ms(r.created_at, r.completed_at),
      };
      previousEnd = r.completed_at;
      return step;
    });
    return {
      runId: run.run_id as string, taskId: run.task_id as string, agentId: run.agent_id as string, status: run.status as string,
      startedAt: iso(run.started_at), finishedAt: run.finished_at == null ? null : iso(run.finished_at), steps,
    };
  }

  /** The last `days` local days (today included) in `timeZone`. */
  async activity(days: number, timeZone: string): Promise<ProductionActivity> {
    const params = [days, timeZone, this.#clock.now().toISOString()];
    const since = `((date_trunc('day', $3::timestamptz at time zone $2) - make_interval(days => $1::int - 1)) at time zone $2)`;
    const daily = await query<Row>(
      this.#pool,
      `with turns as (${customerTurns(since, '$3::timestamptz')})
       select to_char(d, 'YYYY-MM-DD') as day,
              (select percentile_cont(0.5) within group (order by t.ms) from turns t where (t.at at time zone $2)::date = d::date) as p50,
              (select count(t.ms) from turns t where (t.at at time zone $2)::date = d::date) as n
         from generate_series(($3::timestamptz at time zone $2)::date - ($1::int - 1), ($3::timestamptz at time zone $2)::date, interval '1 day') d
        order by d`,
      params,
    );
    // ponytail: union over the whole window then group; per-source partial aggregation if a day ever holds millions of rows.
    const facts = await query<Row>(
      this.#pool,
      `with facts (at, agent_id, tasks, inbound, delivered, handoffs, runs, failed, model_calls, input_tokens, output_tokens, capability_calls) as (
         select t.created_at, t.agent_id, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0 from agent_tasks t where t.created_at >= ${since}
         union all
         select i.received_at, t.agent_id, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0 from inbound_events i left join agent_tasks t on t.task_id = i.task_id
          where i.received_at >= ${since} and i.content_kind <> 'rejected'
         union all
         select coalesce(o.delivered_at, o.read_at), t.agent_id, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0 from outbound_messages o join agent_tasks t on t.task_id = o.task_id
          where coalesce(o.delivered_at, o.read_at) >= ${since}
         union all
         select h.created_at, t.agent_id, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0 from human_requests h join agent_tasks t on t.task_id = h.task_id
          where h.kind = 'handoff' and h.created_at >= ${since}
         union all
         select r.started_at, r.agent_id, 0, 0, 0, 0, 1, (r.status = 'failed')::int, r.model_calls, r.input_tokens, r.output_tokens, r.capability_calls from agent_runs r
          where r.started_at >= ${since})
       select to_char(at at time zone $2, 'YYYY-MM-DD') as day, agent_id,
              sum(tasks) as tasks, sum(inbound) as inbound, sum(delivered) as delivered, sum(handoffs) as handoffs, sum(runs) as runs, sum(failed) as failed,
              sum(model_calls) as model_calls, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(capability_calls) as capability_calls
         from facts where at <= $3::timestamptz group by 1, 2 order by 1, 2 nulls last`,
      params,
    );
    return {
      timeZone,
      days: daily.rows.map((d) => ({
        day: d.day as string,
        customerTurn: { p50Ms: d.p50 == null ? null : Math.round(Number(d.p50)), n: Number(d.n) },
        agents: facts.rows.filter((f) => f.day === d.day).map((f) => ({
          agentId: (f.agent_id as string | null) ?? null,
          tasksCreated: Number(f.tasks), inboundReceived: Number(f.inbound), outboundDelivered: Number(f.delivered), handoffsRequested: Number(f.handoffs),
          runs: Number(f.runs), failedRuns: Number(f.failed), modelCalls: Number(f.model_calls),
          inputTokens: Number(f.input_tokens), outputTokens: Number(f.output_tokens), capabilityCalls: Number(f.capability_calls),
        })),
      })),
    };
  }

  /** Newest first, strictly older than `before` (`<iso>|<id>`). */
  async events(limit: number, before?: { readonly at: string; readonly id: string }): Promise<{ events: PlatformEvent[]; nextCursor: string | null }> {
    // Timestamps are truncated to milliseconds so the ISO cursor round-trips exactly.
    // ponytail: sorts the union of four tables per page (no index on the truncated time); add per-source keyset indexes if pages get slow.
    const r = await query<Row>(
      this.#pool,
      `select * from (
         select date_trunc('milliseconds', occurred_at) as at, transition_id::text as id, 'task.transition' as kind, task_id, ${actor('actor_ref')} as actor, to_status as code from agent_task_transitions
         union all
         select date_trunc('milliseconds', occurred_at), event_id::text, 'temporal.event', task_id, ${actor('actor_ref')}, event_type from temporal_events
         union all
         select date_trunc('milliseconds', occurred_at), event_id::text, 'autonomy.control', null, ${actor('changed_by')}, scope || ':' || case when autonomy_enabled then 'enabled' else 'disabled' end from autonomy_control_events
         union all
         select date_trunc('milliseconds', recorded_at), receipt_id::text, 'action.receipt', task_id, 'platform', capability_id || ':' || status from action_receipts
       ) e
       where $1::timestamptz is null or (e.at, e.id) < ($1::timestamptz, $2::text)
       order by e.at desc, e.id desc limit $3`,
      [before?.at ?? null, before?.id ?? null, limit],
    );
    const events = r.rows.map((row): PlatformEvent => {
      const at = iso(row.at);
      return { cursor: `${at}|${row.id as string}`, at, kind: row.kind as PlatformEventKind, taskId: (row.task_id as string | null) ?? null, actor: row.actor as string, code: row.code as string };
    });
    return { events, nextCursor: events.length === limit ? events.at(-1)!.cursor : null };
  }
}
