import { query, type Pool } from './pool.js';
import { iso, type Row } from './rows.js';

/**
 * ADR-058 Decision 10: facts a person answered for an artifact kind (subject, field, value), append-only; the current
 * fact of a subject and field is the latest. Opaque to Core. Scopes are checked by the caller.
 */
export interface ArtifactFact {
  readonly factId: string;
  readonly kind: string;
  readonly subject: string;
  readonly field: string;
  readonly value: string;
  readonly source: string;
  readonly note: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface NewArtifactFact {
  readonly subject: string;
  readonly field: string;
  readonly value: string;
  readonly source: string;
  readonly note: string | null;
}

const factOf = (r: Row): ArtifactFact => ({
  factId: r.fact_id as string, kind: r.kind as string, subject: r.subject as string, field: r.field as string, value: r.value as string,
  source: r.source as string, note: (r.note as string | null) ?? null, recordedBy: r.recorded_by as string, recordedAt: iso(r.recorded_at),
});

export const MAX_ARTIFACT_FACTS = 5000;

export class PostgresArtifactFacts {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(kind: string, fact: NewArtifactFact, recordedBy: string, correlationId: string): Promise<ArtifactFact> {
    const r = await query<Row>(
      this.#pool,
      `insert into artifact_facts (kind, subject, field, value, source, note, recorded_by, correlation_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [kind, fact.subject, fact.field, fact.value, fact.source, fact.note, recordedBy, correlationId],
    );
    return factOf(r.rows[0]!);
  }

  /** The current fact of each subject and field (the latest answer), newest first; optionally of one subject. */
  async current(kind: string, subject?: string): Promise<ArtifactFact[]> {
    const r = await query<Row>(
      this.#pool,
      `select distinct on (subject, field) * from artifact_facts where kind = $1 and ($2::text is null or subject = $2)
        order by subject, field, recorded_at desc, fact_id desc`,
      [kind, subject ?? null],
    );
    return r.rows.map(factOf).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, MAX_ARTIFACT_FACTS);
  }

  /** Every answer for one subject and field, newest first (the history). */
  async history(kind: string, subject: string, field: string): Promise<ArtifactFact[]> {
    const r = await query<Row>(this.#pool, `select * from artifact_facts where kind = $1 and subject = $2 and field = $3 order by recorded_at desc, fact_id desc limit 200`, [kind, subject, field]);
    return r.rows.map(factOf);
  }
}
