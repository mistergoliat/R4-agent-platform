import { randomUUID } from 'node:crypto';
import { PlatformError, type AgentDefinition } from '@r4/contracts';
import { draftDefinition, type DraftEditable } from '@r4/agent-registry';
import { query, withTransaction, type Pool, type PoolClient } from './pool.js';
import { PostgresAgentDefinitionStore } from './agent-definition-store.js';
import { iso, jsonb, type Row } from './rows.js';

/**
 * ADR-054 (W1): agent drafts. A draft is a proposed definition derived from a REGISTERED base; it is never
 * registered and never runs in production. Each save is a new immutable revision.
 */

export const DRAFT_STATES = ['draft', 'ready', 'launched', 'discarded'] as const;
export type DraftState = (typeof DRAFT_STATES)[number];
export const MAX_AGENT_DRAFTS = 200;

export interface AgentDraft {
  readonly draftId: string;
  readonly agentId: string;
  readonly base: { readonly agentId: string; readonly version: number };
  readonly template: string;
  readonly channel: string | null;
  readonly state: DraftState;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface AgentDraftRevision {
  readonly revision: number;
  readonly definition: AgentDefinition;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface NewAgentDraft {
  readonly agentId: string;
  readonly base: { readonly agentId: string; readonly version: number };
  readonly template: string;
  readonly channel: string | null;
  readonly edits: DraftEditable;
  readonly note: string | null;
}

const draftOf = (r: Row): AgentDraft => ({
  draftId: r.draft_id as string, agentId: r.agent_id as string, base: { agentId: r.base_agent_id as string, version: Number(r.base_version) },
  template: r.template as string, channel: (r.channel as string | null) ?? null, state: r.state as DraftState, revision: Number(r.revision),
  createdBy: r.created_by as string, createdAt: iso(r.created_at), updatedBy: r.updated_by as string, updatedAt: iso(r.updated_at),
});
const revisionOf = (r: Row): AgentDraftRevision => ({
  revision: Number(r.revision), definition: r.definition as AgentDefinition, note: (r.note as string | null) ?? null, createdBy: r.created_by as string, createdAt: iso(r.created_at),
});

export class PostgresAgentDrafts {
  readonly #pool: Pool;
  readonly #definitions: PostgresAgentDefinitionStore;
  constructor(pool: Pool) {
    this.#pool = pool;
    this.#definitions = new PostgresAgentDefinitionStore(pool);
  }

  /** Every draft, most recently changed first. */
  async list(): Promise<AgentDraft[]> {
    return (await query<Row>(this.#pool, `select * from agent_drafts order by updated_at desc, draft_id limit ${MAX_AGENT_DRAFTS}`)).rows.map(draftOf);
  }

  /** The draft with every revision, newest first. 404 `agent_draft_not_found`. */
  async get(draftId: string): Promise<{ draft: AgentDraft; revisions: AgentDraftRevision[] }> {
    const row = (await query<Row>(this.#pool, 'select * from agent_drafts where draft_id = $1', [draftId])).rows[0];
    if (!row) throw notFound(draftId);
    const revisions = (await query<Row>(this.#pool, 'select * from agent_draft_revisions where draft_id = $1 order by revision desc', [draftId])).rows.map(revisionOf);
    return { draft: draftOf(row), revisions };
  }

  /** 404 `base_definition_not_found`; 409 `agent_draft_open` when the agent id already has an open draft; 422 the draft rule. */
  async create(input: NewAgentDraft, by: string, correlationId: string): Promise<{ draft: AgentDraft; revision: AgentDraftRevision }> {
    const base = await this.#definitions.get(input.base.agentId, input.base.version);
    if (!base) throw new PlatformError('not_found', 'base_definition_not_found', `base ${input.base.agentId}@${input.base.version} is not registered`);
    const definition = draftDefinition(base, input.agentId, input.edits);
    return withTransaction(this.#pool, async (c) => {
      const open = (await c.query<Row>(`select draft_id from agent_drafts where agent_id = $1 and state in ('draft', 'ready') for update`, [input.agentId])).rows[0];
      if (open) throw new PlatformError('conflict', 'agent_draft_open', `${input.agentId} already has an open draft (${open.draft_id as string})`);
      const row = (await c.query<Row>(
        `insert into agent_drafts (draft_id, agent_id, base_agent_id, base_version, template, channel, state, revision, created_by, created_at, updated_by, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'draft', 1, $7, clock_timestamp(), $7, clock_timestamp()) returning *`,
        [randomUUID(), input.agentId, base.agentId, base.version, input.template, input.channel, by],
      )).rows[0]!;
      const revision = await insertRevision(c, row.draft_id as string, 1, definition, input.note, by, correlationId);
      return { draft: draftOf(row), revision };
    });
  }

  /** A new revision of an open draft (a `ready` draft goes back to `draft`). 409 `agent_draft_closed`; 422 the draft rule. */
  async revise(draftId: string, edits: DraftEditable, note: string | null, by: string, correlationId: string): Promise<{ draft: AgentDraft; revision: AgentDraftRevision }> {
    return withTransaction(this.#pool, async (c) => {
      const current = (await c.query<Row>('select * from agent_drafts where draft_id = $1 for update', [draftId])).rows[0];
      if (!current) throw notFound(draftId);
      if (current.state !== 'draft' && current.state !== 'ready') throw new PlatformError('conflict', 'agent_draft_closed', `a ${current.state as string} draft cannot change`);
      const base = await this.#definitions.get(current.base_agent_id as string, Number(current.base_version));
      if (!base) throw new PlatformError('not_found', 'base_definition_not_found', `base ${current.base_agent_id as string}@${current.base_version as number} is not registered`);
      const definition = draftDefinition(base, current.agent_id as string, edits);
      const next = Number(current.revision) + 1;
      const revision = await insertRevision(c, draftId, next, definition, note, by, correlationId);
      const row = (await c.query<Row>(`update agent_drafts set revision = $2, state = 'draft', updated_by = $3, updated_at = $4 where draft_id = $1 returning *`, [draftId, next, by, revision.createdAt])).rows[0]!;
      return { draft: draftOf(row), revision };
    });
  }

  /** Closes an open draft for good (its revisions stay). 409 `agent_draft_closed`. */
  async discard(draftId: string, by: string): Promise<AgentDraft> {
    return withTransaction(this.#pool, async (c) => {
      const current = (await c.query<Row>('select state from agent_drafts where draft_id = $1 for update', [draftId])).rows[0];
      if (!current) throw notFound(draftId);
      if (current.state !== 'draft' && current.state !== 'ready') throw new PlatformError('conflict', 'agent_draft_closed', `a ${current.state as string} draft cannot be discarded`);
      return draftOf((await c.query<Row>(`update agent_drafts set state = 'discarded', updated_by = $2, updated_at = clock_timestamp() where draft_id = $1 returning *`, [draftId, by])).rows[0]!);
    });
  }
}

async function insertRevision(c: PoolClient, draftId: string, revision: number, definition: AgentDefinition, note: string | null, by: string, correlationId: string): Promise<AgentDraftRevision> {
  const row = (await c.query<Row>(
    `insert into agent_draft_revisions (draft_id, revision, definition, note, created_by, created_at, correlation_id)
     values ($1, $2, $3::jsonb, $4, $5, clock_timestamp(), $6) returning *`,
    [draftId, revision, jsonb(definition), note, by, correlationId],
  )).rows[0]!;
  return revisionOf(row);
}

const notFound = (draftId: string) => new PlatformError('not_found', 'agent_draft_not_found', `agent draft ${draftId} not found`);
