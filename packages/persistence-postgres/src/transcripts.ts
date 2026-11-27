import type { SessionTranscriptLine } from '@r4/live-ops';
import { query, type Pool } from './pool.js';
import { iso, type Row } from './rows.js';

/** (ADR-069 D4, owner 2026-11-27) Session transcripts are kept 30 days, then deleted. */
export const TRANSCRIPT_RETENTION_DAYS = 30;

export interface SessionTranscriptView {
  readonly transcriptId: string;
  readonly taskId: string | null;
  readonly channel: string;
  readonly modality: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly truncated: boolean;
  /** Figures the agent's voice said without backing (ADR-068 D3); null when no audit ran. */
  readonly audit: { readonly delegations: number; readonly unbacked: readonly string[] } | null;
  /** The contact's words and the agent's voice as the engine transcribed them: untrusted data, shown as text. */
  readonly lines: readonly SessionTranscriptLine[];
}

/** (ADR-069 D3/D4) Reads one session transcript and purges the expired ones. */
export class PostgresTranscripts {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async get(transcriptId: string): Promise<SessionTranscriptView | null> {
    const r = (await query<Row>(this.#pool, 'select * from session_transcripts where transcript_id = $1', [transcriptId])).rows[0];
    if (!r) return null;
    return {
      transcriptId: r.transcript_id as string, taskId: (r.task_id as string | null) ?? null, channel: r.channel as string, modality: r.modality as string,
      startedAt: iso(r.started_at), endedAt: iso(r.ended_at), truncated: r.truncated as boolean,
      audit: (r.audit as SessionTranscriptView['audit']) ?? null, lines: r.lines as SessionTranscriptLine[],
    };
  }

  /** Deletes the transcripts of sessions that started more than `days` ago. Returns how many. */
  async purge(days = TRANSCRIPT_RETENTION_DAYS): Promise<number> {
    const r = await query(this.#pool, `delete from session_transcripts where started_at < now() - make_interval(days => $1::int)`, [days]);
    return r.rowCount ?? 0;
  }
}
