import type { Clock } from '@r4/contracts';
import { query, type Pool } from './pool.js';
import { customerTurns } from './console-reads.js';
import type { IncidentSeverity, PostgresIncidents } from './incidents.js';
import { iso, type Row } from './rows.js';

/**
 * ADR-052: deterministic reads for the console's releases (per agent version), quality (a generic stage funnel),
 * learning (what the agent could not resolve alone) and autonomy (policy outcomes per capability). SQL over
 * durable tables, no model, bounded by a window of `days` × 24 h up to now (no upper bound, like ADR-051).
 * Never message text, EXCEPT the learning gaps' agent-authored question/summary and the human's answer, with
 * contact-like strings masked (`maskContact`).
 */

export const MAX_LEARNING_GAPS = 200;
/** A run that read the same capability this many times is a repeated read. */
export const REPEATED_READS = 4;

export interface VersionStats {
  readonly agentId: string;
  readonly agentVersion: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly tasks: number;
  readonly runs: number;
  readonly failedRuns: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly capabilityCalls: number;
  readonly agentHandoffs: number;
  readonly platformHandoffs: number;
  readonly actionsSucceeded: Record<string, number>;
  readonly customerTurn: { readonly p50Ms: number | null; readonly p95Ms: number | null; readonly n: number };
  readonly incidents: Record<IncidentSeverity, number>;
}

export interface VersionsView {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly versions: VersionStats[];
}

export interface FunnelRow {
  readonly agentId: string;
  readonly agentVersion: number;
  readonly conversations: number;
  readonly reached: number[];
  readonly handedOff: number;
  readonly idleClosed: number;
  readonly cancelled: number;
  readonly failed: number;
  readonly repeatedReads: number;
}

export interface FunnelView {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly stages: string[];
  readonly versions: FunnelRow[];
}

export interface LearningGap {
  readonly requestId: string;
  readonly taskId: string;
  readonly kind: 'consultation' | 'agent_handoff' | 'platform_handoff';
  readonly createdAt: string;
  readonly status: string;
  readonly text: string | null;
  readonly reason: string | null;
  readonly answer: string | null;
}

export interface LearningGapsView {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly gaps: LearningGap[];
}

export interface AutonomyRow {
  readonly agentId: string;
  readonly agentVersion: number;
  readonly capabilityId: string;
  readonly riskClass: string | null;
  readonly decisions: { allow: number; deny: number; requireApproval: number };
  readonly denyReasons: Record<string, number>;
  readonly approvals: { approved: number; rejected: number; pending: number };
  readonly receipts: { succeeded: number; rejected: number; failed: number };
  readonly lastDecisionAt: string | null;
}

export interface AutonomyView {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly capabilities: AutonomyRow[];
}

// An e-mail address, or 8+ digits allowing up to two separators between them (phone numbers, national ids).
const CONTACT_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+|\+?\(?\d(?:[ .\-()]{0,2}\d){7,}/g;
export const MASK = '[masked]';
/** Masks e-mail addresses and digit runs of 8 or more (separators allowed) in human- or agent-authored text. */
export const maskContact = (text: string | null): string | null => (text == null ? null : text.replace(CONTACT_LIKE, MASK));

const byVersion = <T extends { agentId: string; agentVersion: number }>(a: T, b: T) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : b.agentVersion - a.agentVersion);
const keyOf = (r: Row) => `${r.agent_id as string}@${Number(r.agent_version)}`;
const maxIso = (a: string | null, b: string) => (a === null || Date.parse(b) > Date.parse(a) ? b : a);
const minIso = (a: string | null, b: string) => (a === null || Date.parse(b) < Date.parse(a) ? b : a);

export class PostgresInsights {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #incidents: PostgresIncidents;
  constructor(pool: Pool, clock: Clock, incidents: PostgresIncidents) {
    this.#pool = pool;
    this.#clock = clock;
    this.#incidents = incidents;
  }

  #window(days: number) {
    const now = this.#clock.now();
    return { generatedAt: now.toISOString(), since: new Date(now.getTime() - days * 86_400_000).toISOString() };
  }

  /** Per agent version: activity, cost, handoffs, succeeded actions, reply latency and ADR-051 incidents. */
  async versions(days: number): Promise<VersionsView> {
    const { generatedAt, since } = this.#window(days);
    // ponytail: unions the window of four tables then groups, like activity(); per-source aggregation if it grows.
    const [facts, actions, turns, incidents] = await Promise.all([
      query<Row>(
        this.#pool,
        `with facts (at, agent_id, agent_version, tasks, runs, failed, model_calls, input_tokens, output_tokens, capability_calls, agent_handoffs, platform_handoffs) as (
           select created_at, agent_id, agent_version, 1, 0, 0, 0, 0, 0, 0, 0, 0 from agent_tasks where created_at >= $1
           union all
           select started_at, agent_id, agent_version, 0, 1, (status = 'failed')::int, model_calls, input_tokens, output_tokens, capability_calls, 0, 0 from agent_runs where started_at >= $1
           union all
           select h.created_at, t.agent_id, t.agent_version, 0, 0, 0, 0, 0, 0, 0, (h.payload->>'initiatedBy' = 'agent')::int, (h.payload->>'initiatedBy' = 'platform')::int
             from human_requests h join agent_tasks t on t.task_id = h.task_id
            where h.kind = 'handoff' and h.payload->>'initiatedBy' in ('agent', 'platform') and h.created_at >= $1)
         select agent_id, agent_version, min(at) filter (where runs = 1) as first_run, max(at) filter (where runs = 1) as last_run, min(at) as first_at, max(at) as last_at,
                sum(tasks) as tasks, sum(runs) as runs, sum(failed) as failed, sum(model_calls) as model_calls, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
                sum(capability_calls) as capability_calls, sum(agent_handoffs) as agent_handoffs, sum(platform_handoffs) as platform_handoffs
           from facts group by 1, 2`,
        [since],
      ),
      query<Row>(
        this.#pool,
        `select p.agent_id, p.agent_version, r.capability_id, count(*) as n, min(r.recorded_at) as first_at, max(r.recorded_at) as last_at
           from action_receipts r join action_proposals p on p.proposal_id = r.proposal_id
          where r.status = 'succeeded' and r.recorded_at >= $1 group by 1, 2, 3`,
        [since],
      ),
      query<Row>(
        this.#pool,
        `select r.agent_id, r.agent_version, percentile_cont(0.5) within group (order by t.ms) as p50, percentile_cont(0.95) within group (order by t.ms) as p95, count(t.ms) as n
           from (${customerTurns('$1::timestamptz')}) t join agent_runs r on r.run_id = t.run_id group by 1, 2`,
        [since],
      ),
      this.#incidents.list(days),
    ]);

    type Acc = { -readonly [K in keyof VersionStats]: VersionStats[K] } & { firstAny: string | null; lastAny: string | null; firstRun: string | null; lastRun: string | null };
    const rows = new Map<string, Acc>();
    const get = (agentId: string, agentVersion: number): Acc => {
      const key = `${agentId}@${agentVersion}`;
      let acc = rows.get(key);
      if (!acc) {
        acc = {
          agentId, agentVersion, firstSeen: '', lastSeen: '', tasks: 0, runs: 0, failedRuns: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, capabilityCalls: 0,
          agentHandoffs: 0, platformHandoffs: 0, actionsSucceeded: {}, customerTurn: { p50Ms: null, p95Ms: null, n: 0 },
          incidents: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, firstAny: null, lastAny: null, firstRun: null, lastRun: null,
        };
        rows.set(key, acc);
      }
      return acc;
    };
    const seen = (acc: Acc, first: string, last: string) => {
      acc.firstAny = minIso(acc.firstAny, first);
      acc.lastAny = maxIso(acc.lastAny, last);
    };
    for (const f of facts.rows) {
      const acc = get(f.agent_id as string, Number(f.agent_version));
      Object.assign(acc, {
        tasks: Number(f.tasks), runs: Number(f.runs), failedRuns: Number(f.failed), modelCalls: Number(f.model_calls), inputTokens: Number(f.input_tokens),
        outputTokens: Number(f.output_tokens), capabilityCalls: Number(f.capability_calls), agentHandoffs: Number(f.agent_handoffs), platformHandoffs: Number(f.platform_handoffs),
        firstRun: f.first_run == null ? null : iso(f.first_run), lastRun: f.last_run == null ? null : iso(f.last_run),
      });
      seen(acc, iso(f.first_at), iso(f.last_at));
    }
    for (const a of actions.rows) {
      const acc = get(a.agent_id as string, Number(a.agent_version));
      acc.actionsSucceeded[a.capability_id as string] = Number(a.n);
      seen(acc, iso(a.first_at), iso(a.last_at));
    }
    for (const t of turns.rows) {
      get(t.agent_id as string, Number(t.agent_version)).customerTurn = {
        p50Ms: t.p50 == null ? null : Math.round(Number(t.p50)), p95Ms: t.p95 == null ? null : Math.round(Number(t.p95)), n: Number(t.n),
      };
    }
    for (const i of incidents.incidents) {
      if (i.agentId === null || i.agentVersion === null) continue;
      const acc = get(i.agentId, i.agentVersion);
      acc.incidents[i.severity] += i.count;
      seen(acc, i.firstSeen, i.lastSeen);
    }
    const versions = [...rows.values()].map(({ firstAny, lastAny, firstRun, lastRun, ...v }): VersionStats => ({
      ...v, firstSeen: firstRun ?? firstAny ?? generatedAt, lastSeen: lastRun ?? lastAny ?? generatedAt,
    }));
    return { windowDays: days, generatedAt, versions: versions.sort(byVersion) };
  }

  /**
   * Tasks created in the window, per agent version of the task. A task reached a stage (a capability id prefix) when
   * it has a read_capability step on a matching capability whose observation succeeded, or a succeeded action
   * receipt (a governed propose_action) on a matching capability, at any time of its life.
   */
  async funnel(days: number, stages: readonly string[]): Promise<FunnelView> {
    const { generatedAt, since } = this.#window(days);
    const [totals, reached] = await Promise.all([
      query<Row>(
        this.#pool,
        `select t.agent_id, t.agent_version, count(*) as conversations,
                count(*) filter (where exists (select 1 from human_requests h where h.task_id = t.task_id and h.kind = 'handoff')) as handed_off,
                count(*) filter (where t.status = 'cancelled' and t.status_reason = 'idle_timeout') as idle_closed,
                count(*) filter (where t.status = 'cancelled' and t.status_reason is distinct from 'idle_timeout') as cancelled,
                count(*) filter (where t.status = 'failed') as failed,
                count(*) filter (where exists (select 1 from agent_run_steps s where s.task_id = t.task_id and s.decision_type = 'read_capability'
                                                group by s.run_id, s.decision->>'capabilityId' having count(*) >= ${REPEATED_READS})) as repeated_reads
           from agent_tasks t where t.created_at >= $1 group by 1, 2`,
        [since],
      ),
      query<Row>(
        this.#pool,
        `select t.agent_id, t.agent_version, u.i, count(*) as n
           from agent_tasks t cross join unnest($2::text[]) with ordinality u (prefix, i)
          where t.created_at >= $1
            and (exists (select 1 from agent_run_steps s join observations o on o.observation_id = s.observation_id
                          where s.task_id = t.task_id and s.decision_type = 'read_capability' and o.outcome = 'succeeded' and starts_with(s.decision->>'capabilityId', u.prefix))
              or exists (select 1 from action_receipts r where r.task_id = t.task_id and r.status = 'succeeded' and starts_with(r.capability_id, u.prefix)))
          group by 1, 2, 3`,
        [since, stages],
      ),
    ]);
    const versions = totals.rows.map((r): FunnelRow => ({
      agentId: r.agent_id as string, agentVersion: Number(r.agent_version), conversations: Number(r.conversations),
      reached: stages.map((_, i) => Number(reached.rows.find((x) => keyOf(x) === keyOf(r) && Number(x.i) === i + 1)?.n ?? 0)),
      handedOff: Number(r.handed_off), idleClosed: Number(r.idle_closed), cancelled: Number(r.cancelled), failed: Number(r.failed), repeatedReads: Number(r.repeated_reads),
    }));
    return { windowDays: days, generatedAt, stages: [...stages], versions: versions.sort(byVersion) };
  }

  /** Consultations and agent/platform handoffs opened in the window, newest first, with the human's latest answer. */
  async gaps(days: number): Promise<LearningGapsView> {
    const { generatedAt, since } = this.#window(days);
    const rows = await query<Row>(
      this.#pool,
      `select h.request_id, h.task_id, h.created_at, h.status,
              case when h.kind = 'consultation' then 'consultation' when h.payload->>'initiatedBy' = 'agent' then 'agent_handoff' else 'platform_handoff' end as kind,
              case when h.kind = 'consultation' then h.payload->>'question' when h.payload->>'initiatedBy' = 'agent' then h.payload->>'summary' end as text,
              case when h.kind = 'handoff' and h.payload->>'initiatedBy' = 'platform' then h.payload->>'reason' end as reason,
              -- A human response (it carries a response key; platform releases do not), on the request or a takeover of it.
              (select e.data->>'content' from temporal_events e
                where e.task_id = h.task_id and (e.entity_id = h.request_id or e.data->>'requestId' = h.request_id::text)
                  and e.response_key is not null and e.data ? 'content'
                order by e.occurred_at desc limit 1) as answer
         from human_requests h
        where h.created_at >= $1 and (h.kind = 'consultation' or (h.kind = 'handoff' and h.payload->>'initiatedBy' in ('agent', 'platform')))
        order by h.created_at desc, h.request_id limit ${MAX_LEARNING_GAPS}`,
      [since],
    );
    return {
      windowDays: days,
      generatedAt,
      gaps: rows.rows.map((r): LearningGap => ({
        requestId: r.request_id as string, taskId: r.task_id as string, kind: r.kind as LearningGap['kind'], createdAt: iso(r.created_at), status: r.status as string,
        text: maskContact((r.text as string | null) ?? null), reason: (r.reason as string | null) ?? null, answer: maskContact((r.answer as string | null) ?? null),
      })),
    };
  }

  /** Per agent version and capability: policy outcomes, deny reasons, human approvals and receipts in the window. */
  async autonomy(days: number): Promise<AutonomyView> {
    const { generatedAt, since } = this.#window(days);
    const rows = await query<Row>(
      this.#pool,
      `select 'decision' as src, agent_id, agent_version, capability_id, outcome as code, reason_code as reason, count(*) as n,
              max(evaluated_at) as last_at, (array_agg(risk_class order by evaluated_at desc))[1] as risk
         from policy_decisions where evaluated_at >= $1 group by 2, 3, 4, 5, 6
       union all
       select 'approval', p.agent_id, p.agent_version, h.payload->>'capabilityId', h.status, null, count(*), null, null
         from human_requests h join action_proposals p on p.proposal_id = h.proposal_id
        where h.kind = 'approval' and h.status in ('approved', 'rejected', 'requested') and h.created_at >= $1 group by 2, 3, 4, 5
       union all
       select 'receipt', p.agent_id, p.agent_version, r.capability_id, r.status, null, count(*), null, null
         from action_receipts r join action_proposals p on p.proposal_id = r.proposal_id where r.recorded_at >= $1 group by 2, 3, 4, 5`,
      [since],
    );
    type Acc = { -readonly [K in keyof AutonomyRow]: AutonomyRow[K] };
    const out = new Map<string, Acc>();
    for (const r of rows.rows) {
      const key = `${keyOf(r)}:${r.capability_id as string}`;
      let acc = out.get(key);
      if (!acc) {
        acc = {
          agentId: r.agent_id as string, agentVersion: Number(r.agent_version), capabilityId: r.capability_id as string, riskClass: null,
          decisions: { allow: 0, deny: 0, requireApproval: 0 }, denyReasons: {}, approvals: { approved: 0, rejected: 0, pending: 0 },
          receipts: { succeeded: 0, rejected: 0, failed: 0 }, lastDecisionAt: null,
        };
        out.set(key, acc);
      }
      const n = Number(r.n);
      const code = r.code as string;
      if (r.src === 'decision') {
        acc.decisions[code === 'require_approval' ? 'requireApproval' : (code as 'allow' | 'deny')] += n;
        if (code === 'deny') acc.denyReasons[r.reason as string] = (acc.denyReasons[r.reason as string] ?? 0) + n;
        const last = iso(r.last_at);
        if (maxIso(acc.lastDecisionAt, last) !== acc.lastDecisionAt) [acc.lastDecisionAt, acc.riskClass] = [last, r.risk as string];
      } else if (r.src === 'approval') acc.approvals[code === 'requested' ? 'pending' : (code as 'approved' | 'rejected')] += n;
      else acc.receipts[code as 'succeeded' | 'rejected' | 'failed'] += n;
    }
    const capabilities = [...out.values()].sort((a, b) => byVersion(a, b) || (a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0));
    return { windowDays: days, generatedAt, capabilities };
  }
}
