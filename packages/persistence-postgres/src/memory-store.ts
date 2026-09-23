import { PlatformError, memoryEntrySchema, type ContextSnapshot, type MemoryEntry, type MemoryEntryInput } from '@r4/contracts';
import type { MemoryReader } from '@r4/context-compiler';
import { mapPgError, query, type Pool } from './pool.js';
import { contextSnapshotFromRow, jsonb, memoryEntryFromRow, type Row } from './rows.js';

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

/**
 * Durable task memory (R4-C2). Append-only: entries are inserted, superseded
 * by newer entries or expired — never rewritten or deleted (the database
 * enforces it with a trigger). Validation happens here, before the write,
 * against the strict MemoryEntry contract.
 */
export class PostgresMemoryStore implements MemoryReader {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Every entry of the task, superseded and expired ones included, oldest first. */
  async listForTask(taskId: string): Promise<MemoryEntry[]> {
    const result = await query(this.#pool, 'select * from memory_entries where task_id = $1 order by occurred_at, entry_id', [taskId]);
    return result.rows.map(memoryEntryFromRow);
  }

  async append(entry: MemoryEntryInput): Promise<MemoryEntry> {
    const parsed = memoryEntrySchema.safeParse(entry);
    if (!parsed.success) throw new PlatformError('validation', 'invalid_memory_entry', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    try {
      return await insertMemoryEntry(this.#pool, parsed.data);
    } catch (error) {
      throw mapPgError(error);
    }
  }

  /** Ends an entry's validity. Only once: an already expired entry is left untouched. */
  async expire(entryId: string, at: string): Promise<boolean> {
    const result = await query(this.#pool, 'update memory_entries set expired_at = $2 where entry_id = $1 and expired_at is null', [entryId, at]);
    return result.rowCount === 1;
  }
}

/**
 * Inserts a memory entry. A DERIVED_SUMMARY is idempotent on (task,
 * derivation key): the stored one is returned when it already exists.
 */
export async function insertMemoryEntry(db: Queryable, entry: MemoryEntry): Promise<MemoryEntry> {
  const derivationKey = entry.memoryType === 'DERIVED_SUMMARY' ? entry.content.derivation.derivationKey : null;
  const inserted = await db.query(
    `insert into memory_entries (
       entry_id, task_id, memory_type, content, occurred_at, recorded_at, valid_until, expired_at,
       supersedes_entry_id, sensitivity, recorded_by_kind, recorded_by_ref, derivation_key, correlation_id)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (task_id, derivation_key) do nothing
     returning *`,
    [
      entry.entryId, entry.taskId, entry.memoryType, jsonb(entry.content), entry.occurredAt, entry.recordedAt, entry.validUntil, entry.expiredAt,
      entry.supersedesEntryId, entry.sensitivity, entry.recordedBy.kind, entry.recordedBy.ref, derivationKey, entry.correlationId,
    ],
  );
  if (inserted.rows[0]) return memoryEntryFromRow(inserted.rows[0]);
  const existing = await db.query('select * from memory_entries where task_id = $1 and derivation_key = $2', [entry.taskId, derivationKey]);
  if (!existing.rows[0]) throw new Error(`memory entry ${entry.entryId} vanished during insertion`);
  return memoryEntryFromRow(existing.rows[0]);
}

const SNAPSHOT_ITEM_COLUMNS = 13;

export async function insertContextSnapshot(db: Queryable, snapshot: ContextSnapshot): Promise<void> {
  await db.query(
    `insert into context_snapshots (
       snapshot_id, run_id, task_id, iteration, attempt, agent_id, agent_version, compiler_version, policy_version,
       compiled_context, content_hash, input_fingerprint, estimated_tokens, budget_mode, max_estimated_tokens, supersedes_snapshot_id,
       correlation_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      snapshot.snapshotId, snapshot.runId, snapshot.taskId, snapshot.iteration, snapshot.attempt, snapshot.agentId, snapshot.agentVersion,
      snapshot.compilerVersion, snapshot.policyVersion, jsonb(snapshot.compiledContext), snapshot.contentHash, snapshot.inputFingerprint,
      snapshot.estimatedTokens, snapshot.budget.mode, snapshot.budget.mode === 'fixed' ? snapshot.budget.maxEstimatedTokens : null,
      snapshot.supersedesSnapshotId, snapshot.correlationId, snapshot.createdAt,
    ],
  );
  // Batched multi-row inserts (bounded parameter count per statement).
  const BATCH = 500;
  for (let start = 0; start < snapshot.decisions.length; start += BATCH) {
    const batch = snapshot.decisions.slice(start, start + BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((d, i) => {
      values.push(snapshot.snapshotId, start + i, d.itemId, d.sourceId, d.kind, d.authority, d.freshness, d.sensitivity, d.decision, d.section, d.reason, d.representedBy, d.estimatedTokens);
      const base = i * SNAPSHOT_ITEM_COLUMNS;
      return `(${Array.from({ length: SNAPSHOT_ITEM_COLUMNS }, (_, k) => `$${base + k + 1}`).join(', ')})`;
    });
    await db.query(
      `insert into context_snapshot_items (
         snapshot_id, position, item_id, source_id, kind, authority, freshness, sensitivity, decision, section, exclusion_reason,
         represented_by, estimated_tokens)
       values ${tuples.join(', ')}`,
      values,
    );
  }
}

export async function loadContextSnapshot(db: Queryable, row: Row): Promise<ContextSnapshot> {
  const items = await db.query('select * from context_snapshot_items where snapshot_id = $1 order by position', [row.snapshot_id]);
  return contextSnapshotFromRow(row, items.rows);
}

/** Read side for audits and tests: reconstruct exactly what a model call saw. */
export class PostgresContextSnapshotStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async get(snapshotId: string): Promise<ContextSnapshot | null> {
    const result = await query(this.#pool, 'select * from context_snapshots where snapshot_id = $1', [snapshotId]);
    return result.rows[0] ? loadContextSnapshot(this.#pool, result.rows[0]) : null;
  }

  /** Every snapshot of a run, by iteration and attempt. */
  async listForRun(runId: string): Promise<ContextSnapshot[]> {
    const result = await query(this.#pool, 'select * from context_snapshots where run_id = $1 order by iteration, attempt', [runId]);
    const snapshots: ContextSnapshot[] = [];
    for (const row of result.rows) snapshots.push(await loadContextSnapshot(this.#pool, row));
    return snapshots;
  }
}
