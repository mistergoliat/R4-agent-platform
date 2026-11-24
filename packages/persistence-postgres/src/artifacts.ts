import { PlatformError } from '@r4/contracts';
import { query, withTransaction, type Pool, type PoolClient } from './pool.js';
import { iso, type Row } from './rows.js';

/**
 * ADR-058 Decision 1: a minimal generic Artifact. Opaque JSON versions per kind (immutable) and an append-only
 * signature log; the current version of a kind is the one signed last. Core never interprets the content: each kind's
 * schema lives in its own package. Scopes are checked by the caller (console, CLI), not here.
 */

export interface ArtifactVersion {
  readonly kind: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  /** The version it was built on (null: imported, or built before ADR-058 D9). */
  readonly baseVersion: number | null;
  /** How many approved proposals it contains (they become applied when it is signed). */
  readonly includes: number;
}

export interface SignedArtifact extends ArtifactVersion {
  readonly content: unknown;
  readonly signedBy: string;
  readonly signedAt: string;
}

export interface ArtifactSignature {
  readonly kind: string;
  readonly version: number;
  readonly replacesVersion: number | null;
  readonly signedBy: string;
  readonly signedAt: string;
  /** Proposals this signature applied (the version's `includes` still approved). */
  readonly applied?: number;
}

export const ARTIFACT_PROPOSAL_STATES = ['proposed', 'approved', 'rejected', 'applied', 'resolved', 'undone'] as const;
export type ArtifactProposalState = (typeof ARTIFACT_PROPOSAL_STATES)[number];
export const MAX_ARTIFACT_PROPOSALS = 5000;

export interface NewArtifactProposal {
  /** Same fingerprint, same proposal (a later run does not propose it again). */
  readonly fingerprint: string;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  /** Opaque to Core; the owning pack applies it. null: informational (approving acknowledges it). */
  readonly change: unknown;
}

export interface ArtifactProposal {
  readonly proposalId: string;
  readonly kind: string;
  readonly baseVersion: number;
  readonly source: string;
  readonly fingerprint: string;
  readonly summary: string;
  readonly evidence: unknown;
  readonly change: unknown;
  readonly state: ArtifactProposalState;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly appliedVersion: number | null;
}

const proposalOf = (r: Row): ArtifactProposal => ({
  proposalId: r.proposal_id as string, kind: r.kind as string, baseVersion: r.base_version as number, source: r.source as string,
  fingerprint: r.fingerprint as string, summary: r.summary as string, evidence: r.evidence, change: r.change ?? null,
  state: r.state as ArtifactProposalState, createdAt: iso(r.created_at), decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at == null ? null : iso(r.decided_at), decisionNote: (r.decision_note as string | null) ?? null,
  appliedVersion: (r.applied_version as number | null) ?? null,
});

const versionOf = (r: Row): ArtifactVersion => ({
  kind: r.kind as string, version: r.version as number, contentSha256: r.content_sha256 as string,
  note: (r.note as string | null) ?? null, createdBy: r.created_by as string, createdAt: iso(r.created_at),
  baseVersion: (r.base_version as number | null) ?? null, includes: (r.includes_count as number | null) ?? 0,
});
const VERSION_COLUMNS = 'kind, version, content_sha256, note, created_by, created_at, base_version, coalesce(cardinality(includes), 0) as includes_count';
const V_COLUMNS = 'v.kind, v.version, v.content_sha256, v.note, v.created_by, v.created_at, v.base_version, coalesce(cardinality(v.includes), 0) as includes_count';
// The hash of a jsonb value as the database stores it: equal content gives an equal hash whatever its key order.
const SHA = (param: string) => `encode(sha256(convert_to(${param}::jsonb::text, 'UTF8')), 'hex')`;

export class PostgresArtifacts {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * A new version of `kind`, or the latest one when its content is the same (`created: false`). `baseVersion`: the
   * version it was built on; `includes`: the approved proposals it contains (applied when it is signed).
   */
  async createVersion(input: { kind: string; content: unknown; createdBy: string; note: string | null; baseVersion?: number; includes?: readonly string[] }): Promise<{ version: ArtifactVersion; created: boolean }> {
    const content = JSON.stringify(input.content);
    return withTransaction(this.#pool, async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`artifact:${input.kind}`]);
      const latest = (await c.query<Row>(
        `select ${VERSION_COLUMNS}, content_sha256 = ${SHA('$2')} as same from artifact_versions where kind = $1 order by version desc limit 1`,
        [input.kind, content],
      )).rows[0];
      if (latest?.same) return { version: versionOf(latest), created: false };
      const row = (await c.query<Row>(
        `insert into artifact_versions (kind, version, content, content_sha256, note, created_by, base_version, includes)
         values ($1, $2, $3::jsonb, ${SHA('$3')}, $4, $5, $6, $7::uuid[]) returning ${VERSION_COLUMNS}`,
        [input.kind, ((latest?.version as number | undefined) ?? 0) + 1, content, input.note, input.createdBy, input.baseVersion ?? null, input.includes?.length ? [...input.includes] : null],
      )).rows[0]!;
      return { version: versionOf(row), created: true };
    });
  }

  /** One version with its content; null: unknown. */
  async version(kind: string, version: number): Promise<(ArtifactVersion & { readonly content: unknown }) | null> {
    const r = (await query<Row>(this.#pool, `select ${VERSION_COLUMNS}, content from artifact_versions where kind = $1 and version = $2`, [kind, version])).rows[0];
    return r ? { ...versionOf(r), content: r.content } : null;
  }

  /**
   * Every version of a kind, newest first, without content; `current` marks the one signed last. `stale`: never signed
   * and built on a version that is no longer current, so it cannot be signed (build it again).
   */
  async versions(kind: string): Promise<(ArtifactVersion & { readonly signatures: number; readonly current: boolean; readonly stale: boolean })[]> {
    const r = await query<Row>(
      this.#pool,
      `with cur as (select version from artifact_signatures where kind = $1 order by signed_at desc, signature_id desc limit 1)
       select ${V_COLUMNS}, (select count(*)::int from artifact_signatures s where s.kind = v.kind and s.version = v.version) as signatures,
              coalesce(v.version = (select version from cur), false) as current
         from artifact_versions v where v.kind = $1 order by v.version desc limit 200`,
      [kind],
    );
    const current = (r.rows.find((row) => row.current)?.version as number | undefined) ?? null;
    return r.rows.map((row) => {
      const v = versionOf(row);
      return { ...v, signatures: row.signatures as number, current: row.current as boolean, stale: row.signatures === 0 && v.baseVersion !== null && v.baseVersion !== current };
    });
  }

  /**
   * Stores what `source` (a pack's run) found against `baseVersion`, by fingerprint:
   * - new: proposed;
   * - still proposed: refreshed (summary, evidence, base version and source of the latest run);
   * - informational (no change) marked seen or rejected: reopened, the problem is still there;
   * - a proposal with a change already decided: skipped (the person's decision stands; a rejected one never returns).
   */
  async propose(input: { kind: string; baseVersion: number; source: string; correlationId: string; proposals: readonly NewArtifactProposal[] }): Promise<{ created: number; refreshed: number; reopened: number; skipped: number }> {
    if (!input.proposals.length) return { created: 0, refreshed: 0, reopened: 0, skipped: 0 };
    const incoming = JSON.stringify(input.proposals.map((p) => ({ ...p, change: p.change ?? null })));
    const INCOMING = `jsonb_to_recordset($4::jsonb) as i(fingerprint text, summary text, evidence jsonb, change jsonb)`;
    return withTransaction(this.#pool, async (c) => {
      const reopened = (await c.query<Row>(
        `update artifact_proposals p set state = 'proposed', decided_by = null, decided_at = null, decision_note = null,
                summary = i.summary, evidence = i.evidence, base_version = $2, source = $3
           from ${INCOMING}, (select proposal_id, state as old_state from artifact_proposals where kind = $1 and change is null and state in ('approved', 'rejected') for update) o
          where p.kind = $1 and p.fingerprint = i.fingerprint and i.change is null and o.proposal_id = p.proposal_id
         returning p.proposal_id, o.old_state`,
        [input.kind, input.baseVersion, input.source, incoming],
      )).rows;
      for (const state of ['approved', 'rejected']) await this.#events(c, reopened.filter((r) => r.old_state === state).map((r) => r.proposal_id as string), state, 'proposed', input.source, null, input.correlationId);
      const reopenedIds = reopened.map((r) => r.proposal_id as string);
      const refreshed = (await c.query(
        `update artifact_proposals p set summary = i.summary, evidence = i.evidence, change = i.change, base_version = $2, source = $3
           from ${INCOMING}
          where p.kind = $1 and p.fingerprint = i.fingerprint and p.state = 'proposed' and not (p.proposal_id = any($5::uuid[]))`,
        [input.kind, input.baseVersion, input.source, incoming, reopenedIds],
      )).rowCount ?? 0;
      const created = (await c.query<Row>(
        `insert into artifact_proposals (kind, base_version, source, fingerprint, summary, evidence, change, state)
         select $1, $2, $3, i.fingerprint, i.summary, i.evidence, i.change, 'proposed' from ${INCOMING}
         on conflict (kind, fingerprint) where state in ('proposed', 'approved', 'rejected', 'undone') do nothing
         returning proposal_id`,
        [input.kind, input.baseVersion, input.source, incoming],
      )).rows.map((r) => r.proposal_id as string);
      await this.#events(c, created, null, 'proposed', input.source, null, input.correlationId);
      return { created: created.length, refreshed, reopened: reopenedIds.length, skipped: input.proposals.length - created.length - refreshed - reopenedIds.length };
    });
  }

  /**
   * Closes as `resolved` what the sources whose name starts with `sourcePrefix` proposed and their latest run no longer
   * finds: open proposals, and informational ones marked seen or rejected. Approved changes still wait to be applied.
   */
  async resolveUnseen(input: { kind: string; sourcePrefix: string; seenFingerprints: readonly string[]; resolvedBy: string; correlationId: string }): Promise<{ resolved: number }> {
    return withTransaction(this.#pool, async (c) => {
      const rows = (await c.query<Row>(
        `update artifact_proposals p set state = 'resolved', decided_by = $4, decided_at = clock_timestamp()
           from (select proposal_id, state as old_state from artifact_proposals
                  where kind = $1 and starts_with(source, $2) and not (fingerprint = any($3::text[]))
                    and (state = 'proposed' or (change is null and state in ('approved', 'rejected'))) for update) o
          where p.proposal_id = o.proposal_id
         returning p.proposal_id, o.old_state`,
        [input.kind, input.sourcePrefix, [...input.seenFingerprints], input.resolvedBy],
      )).rows;
      for (const state of ['proposed', 'approved', 'rejected']) await this.#events(c, rows.filter((r) => r.old_state === state).map((r) => r.proposal_id as string), state, 'resolved', input.resolvedBy, null, input.correlationId);
      return { resolved: rows.length };
    });
  }

  /** A kind's proposals, oldest first; optionally of one state. */
  async proposals(kind: string, state?: ArtifactProposalState): Promise<ArtifactProposal[]> {
    const r = await query<Row>(
      this.#pool,
      `select * from artifact_proposals where kind = $1 and ($2::text is null or state = $2) order by created_at, proposal_id limit ${MAX_ARTIFACT_PROPOSALS}`,
      [kind, state ?? null],
    );
    return r.rows.map(proposalOf);
  }

  /** A person approves or rejects proposals still `proposed` (others are skipped). Scopes are checked by the caller. */
  async decide(input: { kind: string; proposalIds: readonly string[]; decision: 'approved' | 'rejected'; decidedBy: string; note: string | null; correlationId: string }): Promise<{ decided: number; skipped: number }> {
    return withTransaction(this.#pool, async (c) => {
      const ids = (await c.query<Row>(
        `update artifact_proposals set state = $3, decided_by = $4, decided_at = clock_timestamp(), decision_note = $5
          where kind = $1 and proposal_id = any($2::uuid[]) and state = 'proposed' returning proposal_id`,
        [input.kind, [...input.proposalIds], input.decision, input.decidedBy, input.note],
      )).rows.map((r) => r.proposal_id as string);
      await this.#events(c, ids, 'proposed', input.decision, input.decidedBy, input.note, input.correlationId);
      return { decided: ids.length, skipped: new Set(input.proposalIds).size - ids.length };
    });
  }

  async #events(c: PoolClient, ids: readonly string[], from: string | null, to: string, by: string, note: string | null, correlationId: string): Promise<void> {
    if (!ids.length) return;
    await c.query(
      `insert into artifact_proposal_events (proposal_id, from_state, to_state, decided_by, note, correlation_id) select unnest($1::uuid[]), $2, $3, $4, $5, $6`,
      [[...ids], from, to, by, note, correlationId],
    );
  }

  /**
   * Makes `version` the current one and applies the approved proposals it includes. 404 unknown version;
   * 409 `already_current`; 409 `stale_base` for a version never signed that was built on another version than the
   * current one (signing it would drop what was published since). Signing a version signed before again (going
   * back) is allowed.
   */
  async sign(input: { kind: string; version: number; signedBy: string; note: string | null; correlationId: string }): Promise<ArtifactSignature> {
    return withTransaction(this.#pool, async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`artifact:${input.kind}`]);
      const target = (await c.query<Row>('select base_version, includes, (select count(*)::int from artifact_signatures s where s.kind = v.kind and s.version = v.version) as signatures from artifact_versions v where kind = $1 and version = $2', [input.kind, input.version])).rows[0];
      if (!target) throw new PlatformError('not_found', 'artifact_version_not_found', `${input.kind} v${input.version} not found`);
      const current = (await c.query<Row>('select version from artifact_signatures where kind = $1 order by signed_at desc, signature_id desc limit 1', [input.kind])).rows[0];
      const replaces = (current?.version as number | undefined) ?? null;
      if (replaces === input.version) throw new PlatformError('conflict', 'already_current', `${input.kind} v${input.version} is already the current version`);
      if (target.signatures === 0 && target.base_version !== null && target.base_version !== replaces) {
        throw new PlatformError('conflict', 'stale_base', `${input.kind} v${input.version} was built on v${Number(target.base_version)}, but the current version is v${String(replaces)}: build it again`);
      }
      const row = (await c.query<Row>(
        `insert into artifact_signatures (kind, version, replaces_version, signed_by, note, correlation_id) values ($1, $2, $3, $4, $5, $6)
         returning kind, version, replaces_version, signed_by, signed_at`,
        [input.kind, input.version, replaces, input.signedBy, input.note, input.correlationId],
      )).rows[0]!;
      const includes = (target.includes as string[] | null) ?? [];
      const applied = includes.length ? (await c.query<Row>(
        `update artifact_proposals set state = 'applied', applied_version = $3
          where kind = $1 and proposal_id = any($2::uuid[]) and state = 'approved' and change is not null returning proposal_id`,
        [input.kind, includes, input.version],
      )).rows.map((r) => r.proposal_id as string) : [];
      await this.#events(c, applied, 'approved', 'applied', input.signedBy, null, input.correlationId);
      return { kind: row.kind as string, version: row.version as number, replacesVersion: (row.replaces_version as number | null) ?? null, signedBy: row.signed_by as string, signedAt: iso(row.signed_at), applied: applied.length };
    });
  }

  /** Every signature of a kind, newest first (the first one is the current version), with its version, never the content. */
  async signatures(kind: string): Promise<(ArtifactSignature & ArtifactVersion)[]> {
    const r = await query<Row>(
      this.#pool,
      `select ${V_COLUMNS}, s.replaces_version, s.signed_by, s.signed_at, s.note as signature_note
         from artifact_signatures s join artifact_versions v on v.kind = s.kind and v.version = s.version
        where s.kind = $1 order by s.signed_at desc, s.signature_id desc limit 200`,
      [kind],
    );
    return r.rows.map((row) => ({ ...versionOf(row), note: (row.signature_note as string | null) ?? (row.note as string | null) ?? null, replacesVersion: (row.replaces_version as number | null) ?? null, signedBy: row.signed_by as string, signedAt: iso(row.signed_at) }));
  }

  /**
   * An applied change a person reverted (the owning pack built and signed the version that reverts it). It keeps its
   * fingerprint, so its source never proposes or applies it again. 409 `invalid_transition` unless it is applied.
   */
  async markUndone(input: { kind: string; proposalId: string; undoneBy: string; note: string | null; correlationId: string }): Promise<ArtifactProposal> {
    return withTransaction(this.#pool, async (c) => {
      const row = (await c.query<Row>(
        `update artifact_proposals set state = 'undone', decided_by = $3, decided_at = clock_timestamp(), decision_note = $4
          where kind = $1 and proposal_id = $2 and state = 'applied' returning *`,
        [input.kind, input.proposalId, input.undoneBy, input.note],
      )).rows[0];
      if (!row) throw new PlatformError('conflict', 'invalid_transition', `proposal ${input.proposalId} is not an applied change of ${input.kind}`);
      await this.#events(c, [input.proposalId], 'applied', 'undone', input.undoneBy, input.note, input.correlationId);
      return proposalOf(row);
    });
  }

  /** The version signed last, with its content; null: nothing signed for this kind. */
  async current(kind: string): Promise<SignedArtifact | null> {
    const r = (await query<Row>(
      this.#pool,
      `select ${V_COLUMNS}, v.content, s.signed_by, s.signed_at
         from artifact_signatures s join artifact_versions v on v.kind = s.kind and v.version = s.version
        where s.kind = $1 order by s.signed_at desc, s.signature_id desc limit 1`,
      [kind],
    )).rows[0];
    return r ? { ...versionOf(r), content: r.content, signedBy: r.signed_by as string, signedAt: iso(r.signed_at) } : null;
  }
}
