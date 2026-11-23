import type { Clock } from '@r4/contracts';
import { query, withTransaction, type Pool } from './pool.js';
import { customerTurns } from './console-reads.js';
import { iso, type Row } from './rows.js';

/**
 * ADR-051: incidents are groups of failures with the same signature, computed at read time by deterministic SQL
 * detectors over existing durable tables (no model, no occurrence table). Only the human triage is stored.
 * Never message text, contact data or reasoning: codes, counts, times and opaque task ids.
 */

/** A conversation's last input without a reply accepted by the channel for this long is an incident. */
export const UNANSWERED_AFTER_MS = 10 * 60_000;
/** A reply turn slower than this is an incident. */
export const SLOW_REPLY_MS = 60_000;
export const MAX_EXAMPLE_TASKS = 5;

export const INCIDENT_DETECTORS = ['customer_unanswered', 'run_failed', 'platform_handoff', 'step_error', 'outbound_problem', 'inbound_problem', 'slow_reply', 'consultation_waiting'] as const;
export type IncidentDetector = (typeof INCIDENT_DETECTORS)[number];
export const INCIDENT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export type TriageDecision = 'ignored' | 'requested';

export interface IncidentTriage {
  readonly state: 'open' | TriageDecision | 'reopened';
  readonly note: string | null;
  readonly requestUrl: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

export interface Incident {
  readonly signature: string;
  readonly detector: IncidentDetector;
  readonly severity: IncidentSeverity;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly code: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly exampleTaskIds: string[];
  readonly triage: IncidentTriage;
}

export interface IncidentsView {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly incidents: Incident[];
}

export interface StoredTriage {
  readonly state: TriageDecision;
  readonly note: string;
  readonly requestUrl: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export const incidentSignature = (detector: IncidentDetector, agentId: string | null, agentVersion: number | null, code: string): string =>
  `${detector}:${agentId ?? '-'}@${agentVersion ?? '-'}:${code}`;

/** Format of a signature this API can produce (agent ids are kebab-case slugs; codes are printable ASCII). */
export const INCIDENT_SIGNATURE = new RegExp(`^(?:${INCIDENT_DETECTORS.join('|')}):(?:[a-z][a-z0-9-]{0,63}|-)@(?:[0-9]{1,9}|-):[\\x21-\\x7e]{1,200}$`);

/** ADR-051 Decision 1. Compound codes are `<reason>/<code>`; outbound/inbound failures are prefixed `failed/`. */
export function incidentSeverity(detector: IncidentDetector, code: string): IncidentSeverity {
  switch (detector) {
    case 'customer_unanswered':
      return 'critical';
    case 'run_failed':
      return code.startsWith('model_failure/') || code.startsWith('budget_exhausted/') ? 'high' : 'medium';
    case 'platform_handoff':
      return code === 'autonomy_disabled' || code === 'rollout_excluded' ? 'info' : 'medium';
    case 'step_error':
      return 'low';
    case 'outbound_problem':
      return code === 'unknown' ? 'critical' : 'high';
    case 'inbound_problem':
      return code.startsWith('failed/') ? 'high' : 'info';
    case 'slow_reply':
      return 'medium';
    case 'consultation_waiting':
      return 'high';
  }
}

/** No decision: open. A decision older than the group's last occurrence: reopened (the row is unchanged). */
export function triageView(stored: StoredTriage | undefined, lastSeen: string): IncidentTriage {
  if (!stored) return { state: 'open', note: null, requestUrl: null, decidedBy: null, decidedAt: null };
  const state = Date.parse(lastSeen) > Date.parse(stored.decidedAt) ? 'reopened' : stored.state;
  return { ...stored, state };
}

/** Severity (critical first), then the most recent last occurrence. */
export const compareIncidents = (a: Incident, b: Incident): number =>
  INCIDENT_SEVERITIES.indexOf(a.severity) - INCIDENT_SEVERITIES.indexOf(b.severity) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen);

const triageFromRow = (r: Row): StoredTriage => ({
  state: r.state as TriageDecision, note: r.note as string, requestUrl: (r.request_url as string | null) ?? null, decidedBy: r.decided_by as string, decidedAt: iso(r.decided_at),
});

export class PostgresIncidents {
  readonly #pool: Pool;
  readonly #clock: Clock;
  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  /** The last `days` × 24 h up to now. */
  async list(days: number): Promise<IncidentsView> {
    const now = this.#clock.now();
    const since = '$1::timestamptz';
    // No upper bound: an occurrence is never hidden by clock skew between this host and the database.
    // ponytail: each detector scans its table over the window (only outbound has an index on that time); add
    // per-source time indexes if a window ever holds millions of rows.
    const groups = await query<Row>(
      this.#pool,
      `with occ (detector, agent_id, agent_version, code, task_id, at) as (
         -- The newest input of a task, still without any channel-accepted reply after it, on an autonomous
         -- conversation that no human holds (requested or active handoff). A task that already ended
         -- (completed or cancelled: idle close, operator cancel, lane retirement) left its last input
         -- unanswered on purpose; a failed one is reported by run_failed and its fallback notice.
         select 'customer_unanswered', t.agent_id, t.agent_version, 'no_accepted_reply', li.task_id, li.at
           from (select task_id, max(received_at) as at from task_inputs where received_at >= ${since} group by task_id) li
           join agent_tasks t on t.task_id = li.task_id
          where li.at <= $2::timestamptz
            and t.status not in ('completed', 'cancelled', 'failed')
            and exists (select 1 from channel_conversation_bindings b where b.task_id = li.task_id and b.autonomy = 'autonomous')
            and not exists (select 1 from outbound_messages o where o.task_id = li.task_id and o.accepted_at >= li.at)
            and not exists (select 1 from human_requests h where h.task_id = li.task_id and h.kind = 'handoff' and h.status in ('requested', 'active'))
         union all
         select 'run_failed', r.agent_id, r.agent_version, r.termination_reason || '/' || r.termination_code, r.task_id, r.finished_at
           from agent_runs r where r.status = 'failed' and r.finished_at >= ${since}
         union all
         select 'platform_handoff', t.agent_id, t.agent_version, coalesce(h.payload->>'reason', 'unspecified'), h.task_id, h.created_at
           from human_requests h join agent_tasks t on t.task_id = h.task_id
          where h.kind = 'handoff' and h.payload->>'initiatedBy' = 'platform' and h.created_at >= ${since}
         union all
         select 'step_error', r.agent_id, r.agent_version, s.error_code, s.task_id, s.created_at
           from agent_run_steps s join agent_runs r on r.run_id = s.run_id
          where s.outcome in ('refused', 'invalid') and s.created_at >= ${since}
         union all
         select 'outbound_problem', t.agent_id, t.agent_version,
                case o.status when 'failed' then 'failed/' || coalesce(o.error_code, 'unspecified') when 'unknown' then 'unknown' else 'cancelled/' || o.cancel_reason end,
                o.task_id, o.updated_at
           from outbound_messages o join agent_tasks t on t.task_id = o.task_id
          where (o.status in ('failed', 'unknown') or (o.status = 'cancelled' and o.cancel_reason in ('expired', 'window_closed')))
            and o.updated_at >= ${since}
         union all
         select 'inbound_problem', t.agent_id, t.agent_version,
                case i.status when 'failed' then 'failed/' else '' end || coalesce(i.failure_code, 'unspecified'), i.task_id, i.received_at
           from inbound_events i left join agent_tasks t on t.task_id = i.task_id
          where i.status in ('failed', 'rejected') and i.received_at >= ${since}
         union all
         -- (ADR-056 D5) A consultation the agent asked that no human answered within the SLA (same 10 minutes).
         select 'consultation_waiting', t.agent_id, t.agent_version, 'unanswered_over_${UNANSWERED_AFTER_MS / 60_000}_min', h.task_id, h.created_at
           from human_requests h join agent_tasks t on t.task_id = h.task_id
          where h.kind = 'consultation' and h.status = 'requested' and h.created_at >= ${since} and h.created_at <= $2::timestamptz
         union all
         select 'slow_reply', r.agent_id, r.agent_version, 'customer_turn_over_${SLOW_REPLY_MS / 1000}s', turns.task_id, turns.at
           from (${customerTurns(since)}) turns join agent_runs r on r.run_id = turns.run_id
          where turns.ms > $3::int),
       per_task as (
         select detector, agent_id, agent_version, code, task_id, count(*) as n, min(at) as first_seen, max(at) as last_seen
           from occ group by 1, 2, 3, 4, 5)
       select detector, agent_id, agent_version, code, sum(n) as n, min(first_seen) as first_seen, max(last_seen) as last_seen,
              (array_agg(task_id::text order by last_seen desc) filter (where task_id is not null))[1:${MAX_EXAMPLE_TASKS}] as examples
         from per_task group by 1, 2, 3, 4`,
      [new Date(now.getTime() - days * 86_400_000).toISOString(), new Date(now.getTime() - UNANSWERED_AFTER_MS).toISOString(), SLOW_REPLY_MS],
    );
    const incidents = groups.rows.map((g) => {
      const detector = g.detector as IncidentDetector;
      const agentId = (g.agent_id as string | null) ?? null;
      const agentVersion = g.agent_version == null ? null : Number(g.agent_version);
      const code = g.code as string;
      return { signature: incidentSignature(detector, agentId, agentVersion, code), detector, severity: incidentSeverity(detector, code), agentId, agentVersion, code,
        count: Number(g.n), firstSeen: iso(g.first_seen), lastSeen: iso(g.last_seen), exampleTaskIds: (g.examples as string[] | null) ?? [] };
    });
    const stored = await this.#triage(incidents.map((i) => i.signature));
    return {
      windowDays: days,
      generatedAt: now.toISOString(),
      incidents: incidents.map((i): Incident => ({ ...i, triage: triageView(stored.get(i.signature), i.lastSeen) })).sort(compareIncidents),
    };
  }

  /** Records the decision in the append-only history and makes it the signature's current triage. */
  async triage(signature: string, decision: { readonly state: TriageDecision; readonly note: string; readonly requestUrl: string | null }, decidedBy: string, correlationId: string): Promise<StoredTriage> {
    return withTransaction(this.#pool, async (c) => {
      const values = [signature, decision.state, decision.note, decision.requestUrl, decidedBy];
      // Database time, like the source tables the reopen comparison reads.
      const event = (await c.query<Row>(
        `insert into incident_triage_events (signature, state, note, request_url, decided_by, decided_at, correlation_id)
         values ($1, $2, $3, $4, $5, clock_timestamp(), $6) returning decided_at`,
        [...values, correlationId],
      )).rows[0]!;
      const row = (await c.query<Row>(
        `insert into incident_triage (signature, state, note, request_url, decided_by, decided_at) values ($1, $2, $3, $4, $5, $6)
         on conflict (signature) do update set state = excluded.state, note = excluded.note, request_url = excluded.request_url,
                                                decided_by = excluded.decided_by, decided_at = excluded.decided_at
         returning *`,
        [...values, event.decided_at],
      )).rows[0]!;
      return triageFromRow(row);
    });
  }

  async #triage(signatures: string[]): Promise<Map<string, StoredTriage>> {
    if (signatures.length === 0) return new Map();
    const rows = (await query<Row>(this.#pool, 'select * from incident_triage where signature = any($1::text[])', [signatures])).rows;
    return new Map(rows.map((r) => [r.signature as string, triageFromRow(r)]));
  }
}
