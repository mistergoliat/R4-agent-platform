import type { ContactDecisionRecord, ContactMode, ContactStore } from '@r4/live-ops';
import { query, type Pool } from './pool.js';

/** (ADR-055) Opt-outs and contact decisions (migration 0029). */
export class PostgresContactStore implements ContactStore {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async optedOut(channel: string, conversationKey: string): Promise<boolean> {
    const r = await query(this.#pool, 'select 1 from contact_opt_outs where channel = $1 and conversation_key = $2 and revoked_at is null', [channel, conversationKey]);
    return (r.rowCount ?? 0) > 0;
  }

  async recordOptOut(command: { readonly channel: string; readonly conversationKey: string; readonly source: 'contact_keyword' | 'operator'; readonly inboundId: string | null }): Promise<boolean> {
    // A revoked opt-out is renewed by a new request; an active one stays as it was.
    const r = await query(
      this.#pool,
      `insert into contact_opt_outs (channel, conversation_key, source, inbound_id) values ($1, $2, $3, $4)
       on conflict (channel, conversation_key) do update set source = excluded.source, inbound_id = excluded.inbound_id, opted_out_at = clock_timestamp(), revoked_at = null, revoked_by = null
        where contact_opt_outs.revoked_at is not null`,
      [command.channel, command.conversationKey, command.source, command.inboundId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async sentSince(channel: string, conversationKey: string, mode: ContactMode, since: Date): Promise<Date[]> {
    const r = await query<{ decided_at: Date }>(
      this.#pool,
      `select decided_at from contact_decisions where channel = $1 and conversation_key = $2 and mode = $3 and outcome = 'send' and decided_at >= $4 order by decided_at`,
      [channel, conversationKey, mode, since],
    );
    return r.rows.map((row) => row.decided_at);
  }

  async recordDecision(d: ContactDecisionRecord): Promise<boolean> {
    const r = await query(
      this.#pool,
      `insert into contact_decisions (source_ref, purpose, channel, conversation_key, task_id, mode, outcome, rule, rules_version, text, template, outbound_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (source_ref) do nothing`,
      [d.sourceRef, d.purpose, d.channel, d.conversationKey, d.taskId, d.mode, d.outcome, d.rule, d.rulesVersion, d.text, d.template ? JSON.stringify(d.template) : null, d.outboundId],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
