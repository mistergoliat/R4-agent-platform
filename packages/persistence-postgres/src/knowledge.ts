import { randomUUID } from 'node:crypto';
import { PlatformError, type HumanScope } from '@r4/contracts';
import { query, withTransaction, type Pool } from './pool.js';
import { iso, type Row } from './rows.js';

/**
 * ADR-052: a curated knowledge base (statements with their source) that operators propose, verify, sign and
 * retire. No agent reads it: consuming it is a future agent-definition version with its own evaluation.
 */

export const KNOWLEDGE_STATES = ['proposed', 'verified', 'signed', 'retired'] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];
export const MAX_KNOWLEDGE_ENTRIES = 500;

export interface KnowledgeEntry {
  readonly entryId: string;
  readonly topic: string;
  readonly statement: string;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly state: KnowledgeState;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly verifiedBy: string | null;
  readonly verifiedAt: string | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly retiredBy: string | null;
  readonly retiredAt: string | null;
  /** YYYY-MM-DD. */
  readonly expiresAt: string | null;
}

export interface NewKnowledgeEntry {
  readonly topic: string;
  readonly statement: string;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly expiresAt: string | null;
}

/** The scope a transition needs; null: the transition does not exist. */
export function knowledgeTransitionScope(from: KnowledgeState, to: KnowledgeState): HumanScope | null {
  if (from === 'proposed' && to === 'verified') return 'knowledge.curate';
  if (from === 'verified' && to === 'signed') return 'knowledge.sign';
  if (from !== 'retired' && to === 'retired') return 'knowledge.curate';
  return null;
}

const at = (v: unknown) => (v == null ? null : iso(v));
const entryOf = (r: Row): KnowledgeEntry => ({
  entryId: r.entry_id as string, topic: r.topic as string, statement: r.statement as string, source: r.source as string,
  sourceRef: (r.source_ref as string | null) ?? null, state: r.state as KnowledgeState, createdBy: r.created_by as string, createdAt: iso(r.created_at),
  verifiedBy: (r.verified_by as string | null) ?? null, verifiedAt: at(r.verified_at), signedBy: (r.signed_by as string | null) ?? null, signedAt: at(r.signed_at),
  retiredBy: (r.retired_by as string | null) ?? null, retiredAt: at(r.retired_at), expiresAt: (r.expires_on as string | null) ?? null,
});
// `date` as text: the driver would turn it into a local-midnight Date.
const COLUMNS = '*, expires_at::text as expires_on';

export class PostgresKnowledge {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Every state, newest first. */
  async list(): Promise<KnowledgeEntry[]> {
    return (await query<Row>(this.#pool, `select ${COLUMNS} from knowledge_entries order by created_at desc, entry_id limit ${MAX_KNOWLEDGE_ENTRIES}`)).rows.map(entryOf);
  }

  async propose(entry: NewKnowledgeEntry, createdBy: string, correlationId: string): Promise<KnowledgeEntry> {
    return withTransaction(this.#pool, async (c) => {
      const row = (await c.query<Row>(
        `insert into knowledge_entries (entry_id, topic, statement, source, source_ref, state, created_by, created_at, expires_at)
         values ($1, $2, $3, $4, $5, 'proposed', $6, clock_timestamp(), $7::date) returning ${COLUMNS}`,
        [randomUUID(), entry.topic, entry.statement, entry.source, entry.sourceRef, createdBy, entry.expiresAt],
      )).rows[0]!;
      await c.query(
        `insert into knowledge_entry_events (entry_id, from_state, to_state, note, decided_by, decided_at, correlation_id) values ($1, null, 'proposed', null, $2, $3, $4)`,
        [row.entry_id, createdBy, row.created_at, correlationId],
      );
      return entryOf(row);
    });
  }

  /** 404 unknown entry; 409 `invalid_transition`; 422 `human_scope_denied` without the transition's scope. */
  async transition(entryId: string, to: Exclude<KnowledgeState, 'proposed'>, note: string, operator: { readonly humanRef: string; readonly scopes: readonly string[] }, correlationId: string): Promise<KnowledgeEntry> {
    return withTransaction(this.#pool, async (c) => {
      const current = (await c.query<Row>('select state from knowledge_entries where entry_id = $1 for update', [entryId])).rows[0];
      if (!current) throw new PlatformError('not_found', 'knowledge_entry_not_found', `knowledge entry ${entryId} not found`);
      const from = current.state as KnowledgeState;
      const scope = knowledgeTransitionScope(from, to);
      if (!scope) throw new PlatformError('conflict', 'invalid_transition', `a ${from} entry cannot become ${to}`);
      if (!operator.scopes.includes(scope)) throw new PlatformError('precondition', 'human_scope_denied', `operator lacks the ${scope} scope`);
      const event = (await c.query<Row>(
        `insert into knowledge_entry_events (entry_id, from_state, to_state, note, decided_by, decided_at, correlation_id)
         values ($1, $2, $3, $4, $5, clock_timestamp(), $6) returning decided_at`,
        [entryId, from, to, note, operator.humanRef, correlationId],
      )).rows[0]!;
      // `to` is verified | signed | retired: each has its own <state>_by / <state>_at columns.
      const row = (await c.query<Row>(
        `update knowledge_entries set state = $2, ${to}_by = $3, ${to}_at = $4 where entry_id = $1 returning ${COLUMNS}`,
        [entryId, to, operator.humanRef, event.decided_at],
      )).rows[0]!;
      return entryOf(row);
    });
  }
}
