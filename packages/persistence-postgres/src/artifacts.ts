import { PlatformError } from '@r4/contracts';
import { query, withTransaction, type Pool } from './pool.js';
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
}

const versionOf = (r: Row): ArtifactVersion => ({
  kind: r.kind as string, version: r.version as number, contentSha256: r.content_sha256 as string,
  note: (r.note as string | null) ?? null, createdBy: r.created_by as string, createdAt: iso(r.created_at),
});
const VERSION_COLUMNS = 'kind, version, content_sha256, note, created_by, created_at';
// The hash of a jsonb value as the database stores it: equal content gives an equal hash whatever its key order.
const SHA = (param: string) => `encode(sha256(convert_to(${param}::jsonb::text, 'UTF8')), 'hex')`;

export class PostgresArtifacts {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** A new version of `kind`, or the latest one when its content is the same (`created: false`). */
  async createVersion(input: { kind: string; content: unknown; createdBy: string; note: string | null }): Promise<{ version: ArtifactVersion; created: boolean }> {
    const content = JSON.stringify(input.content);
    return withTransaction(this.#pool, async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`artifact:${input.kind}`]);
      const latest = (await c.query<Row>(
        `select ${VERSION_COLUMNS}, content_sha256 = ${SHA('$2')} as same from artifact_versions where kind = $1 order by version desc limit 1`,
        [input.kind, content],
      )).rows[0];
      if (latest?.same) return { version: versionOf(latest), created: false };
      const row = (await c.query<Row>(
        `insert into artifact_versions (kind, version, content, content_sha256, note, created_by)
         values ($1, $2, $3::jsonb, ${SHA('$3')}, $4, $5) returning ${VERSION_COLUMNS}`,
        [input.kind, ((latest?.version as number | undefined) ?? 0) + 1, content, input.note, input.createdBy],
      )).rows[0]!;
      return { version: versionOf(row), created: true };
    });
  }

  /** Makes `version` the current one. 404 unknown version; 409 `already_current`. */
  async sign(input: { kind: string; version: number; signedBy: string; note: string | null; correlationId: string }): Promise<ArtifactSignature> {
    return withTransaction(this.#pool, async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`artifact:${input.kind}`]);
      const exists = (await c.query('select 1 from artifact_versions where kind = $1 and version = $2', [input.kind, input.version])).rowCount;
      if (!exists) throw new PlatformError('not_found', 'artifact_version_not_found', `${input.kind} v${input.version} not found`);
      const current = (await c.query<Row>('select version from artifact_signatures where kind = $1 order by signed_at desc, signature_id desc limit 1', [input.kind])).rows[0];
      const replaces = (current?.version as number | undefined) ?? null;
      if (replaces === input.version) throw new PlatformError('conflict', 'already_current', `${input.kind} v${input.version} is already the current version`);
      const row = (await c.query<Row>(
        `insert into artifact_signatures (kind, version, replaces_version, signed_by, note, correlation_id) values ($1, $2, $3, $4, $5, $6)
         returning kind, version, replaces_version, signed_by, signed_at`,
        [input.kind, input.version, replaces, input.signedBy, input.note, input.correlationId],
      )).rows[0]!;
      return { kind: row.kind as string, version: row.version as number, replacesVersion: (row.replaces_version as number | null) ?? null, signedBy: row.signed_by as string, signedAt: iso(row.signed_at) };
    });
  }

  /** Every signature of a kind, newest first (the first one is the current version), with its version, never the content. */
  async signatures(kind: string): Promise<(ArtifactSignature & ArtifactVersion)[]> {
    const r = await query<Row>(
      this.#pool,
      `select v.kind, v.version, v.content_sha256, v.note, v.created_by, v.created_at, s.replaces_version, s.signed_by, s.signed_at, s.note as signature_note
         from artifact_signatures s join artifact_versions v on v.kind = s.kind and v.version = s.version
        where s.kind = $1 order by s.signed_at desc, s.signature_id desc limit 200`,
      [kind],
    );
    return r.rows.map((row) => ({ ...versionOf(row), note: (row.signature_note as string | null) ?? (row.note as string | null) ?? null, replacesVersion: (row.replaces_version as number | null) ?? null, signedBy: row.signed_by as string, signedAt: iso(row.signed_at) }));
  }

  /** The version signed last, with its content; null: nothing signed for this kind. */
  async current(kind: string): Promise<SignedArtifact | null> {
    const r = (await query<Row>(
      this.#pool,
      `select v.kind, v.version, v.content_sha256, v.note, v.created_by, v.created_at, v.content, s.signed_by, s.signed_at
         from artifact_signatures s join artifact_versions v on v.kind = s.kind and v.version = s.version
        where s.kind = $1 order by s.signed_at desc, s.signature_id desc limit 1`,
      [kind],
    )).rows[0];
    return r ? { ...versionOf(r), content: r.content, signedBy: r.signed_by as string, signedAt: iso(r.signed_at) } : null;
  }
}
