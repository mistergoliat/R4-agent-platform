import type pg from 'pg';
import { applyOperations, emptyWorkspace, type Workspace, type WorkspaceApplication, type WorkspaceChange, type WorkspaceState, type WorkspaceUpdateInput } from './model.js';

/** Who a conversation acts for, as the Sales ingress established it. */
export interface ConversationBinding {
  readonly taskId: string;
  /** Null: anonymous customer (identity unavailable). */
  readonly customerRef: string | null;
  readonly channelRef: string;
  readonly createdAt: string;
}

export type StoredWorkspaceResult =
  /** `state` is the workspace as this command left it: a replay answers with exactly this. */
  | { readonly status: 'applied'; readonly version: number; readonly operations: number; readonly state: WorkspaceState }
  | { readonly status: 'rejected'; readonly version: number; readonly code: string; readonly message: string; readonly operationIndex: number | null };

export interface WorkspaceTransition {
  readonly executionKey: string;
  readonly taskId: string;
  readonly outcome: 'applied' | 'rejected';
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly operations: WorkspaceUpdateInput['operations'];
  readonly changes: readonly WorkspaceChange[];
  readonly result: StoredWorkspaceResult;
  readonly recordedAt: string;
}

/** What the quote capability sent to the Quote owner for one execution key (no prices). */
export interface QuoteRequestRecord {
  readonly executionKey: string;
  readonly taskId: string;
  readonly workspaceVersion: number;
  readonly selection: readonly { readonly productId: string; readonly quantity: number }[];
  readonly delivery: { readonly commune: string; readonly region: string | null };
  readonly requestedAt: string;
}

export interface QuoteReference {
  readonly executionKey: string;
  readonly taskId: string;
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly basedOnWorkspaceVersion: number;
  readonly recordedAt: string;
}

/**
 * PostgreSQL store of Sales application state. It touches only the `sales`
 * schema (0006, owned by this pack): never an R4 runtime table and never a
 * domain owner's database.
 *
 * `applyCommand` is idempotent on the platform execution key: the first call
 * with a key applies (or rejects) the batch and records it with the key in
 * one transaction; any later call with the same key returns that stored
 * outcome without applying anything — which is what makes the capability's
 * `idempotent_replay` declaration true.
 */
export class PostgresSalesStore {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async bindConversation(binding: { taskId: string; customerRef: string | null; channelRef: string }): Promise<ConversationBinding> {
    await this.#pool.query('insert into sales.conversations (task_id, customer_ref, channel_ref) values ($1, $2, $3) on conflict (task_id) do nothing', [binding.taskId, binding.customerRef, binding.channelRef]);
    const stored = await this.conversation(binding.taskId);
    if (!stored || stored.customerRef !== binding.customerRef || stored.channelRef !== binding.channelRef) {
      throw new Error(`conversation ${binding.taskId} is already bound differently`);
    }
    return stored;
  }

  async conversation(taskId: string): Promise<ConversationBinding | null> {
    const r = await this.#pool.query<{ task_id: string; customer_ref: string | null; channel_ref: string; created_at: Date }>('select * from sales.conversations where task_id = $1', [taskId]);
    const row = r.rows[0];
    return row ? { taskId: row.task_id, customerRef: row.customer_ref, channelRef: row.channel_ref, createdAt: row.created_at.toISOString() } : null;
  }

  async workspace(taskId: string, client: pg.Pool | pg.PoolClient = this.#pool): Promise<Workspace> {
    const r = await client.query<{ version: number; state: WorkspaceState; created_at: Date; updated_at: Date }>('select version, state, created_at, updated_at from sales.workspaces where task_id = $1', [taskId]);
    const row = r.rows[0];
    return row ? { taskId, version: row.version, state: row.state, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() } : emptyWorkspace(taskId);
  }

  /**
   * Applies one governed command atomically, at most once per execution key.
   * `unknownProducts` are ids the Catalog owner said it does not have (checked
   * by the caller before the transaction): the batch is then rejected.
   */
  async applyCommand(command: { taskId: string; executionKey: string; input: WorkspaceUpdateInput; unknownProducts: readonly string[]; now: string }): Promise<{ result: StoredWorkspaceResult; workspace: Workspace; replayed: boolean }> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      // Serializes commands of one conversation (including its very first one, before any row exists).
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 6))', [command.taskId]);
      const previous = await this.#transition(client, command.executionKey);
      if (previous) {
        const workspace = await this.workspace(command.taskId, client);
        await client.query('commit');
        return { result: previous.result, workspace, replayed: true };
      }
      const current = await this.workspace(command.taskId, client);
      const application: WorkspaceApplication =
        command.unknownProducts.length > 0
          ? { kind: 'rejected', code: 'unknown_product', message: `the catalog has no product ${command.unknownProducts.join(', ')}`, operationIndex: null }
          : applyOperations(current, command.input, command.now);
      let workspace = current;
      let result: StoredWorkspaceResult;
      if (application.kind === 'applied') {
        const version = current.version + 1;
        await client.query(
          `insert into sales.workspaces (task_id, version, state, created_at, updated_at) values ($1, $2, $3, $4, $4)
           on conflict (task_id) do update set version = excluded.version, state = excluded.state, updated_at = excluded.updated_at`,
          [command.taskId, version, JSON.stringify(application.state), command.now],
        );
        workspace = { taskId: command.taskId, version, state: application.state, createdAt: current.createdAt ?? command.now, updatedAt: command.now };
        result = { status: 'applied', version, operations: command.input.operations.length, state: application.state };
      } else {
        result = { status: 'rejected', version: current.version, code: application.code, message: application.message, operationIndex: application.operationIndex };
      }
      await client.query(
        `insert into sales.workspace_transitions (execution_key, task_id, outcome, from_version, to_version, operations, changes, result, recorded_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [command.executionKey, command.taskId, result.status, current.version, workspace.version, JSON.stringify(command.input.operations), JSON.stringify(application.kind === 'applied' ? application.changes : []), JSON.stringify(result), command.now],
      );
      await client.query('commit');
      return { result, workspace, replayed: false };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** What is recorded for an execution key (reconciliation by key). */
  async transitionByKey(executionKey: string): Promise<WorkspaceTransition | null> {
    return this.#transition(this.#pool, executionKey);
  }

  async transitions(taskId: string): Promise<WorkspaceTransition[]> {
    const r = await this.#pool.query<TransitionRow>('select * from sales.workspace_transitions where task_id = $1 order by recorded_at, to_version, execution_key', [taskId]);
    return r.rows.map(transitionOf);
  }

  /**
   * Records what will be sent for this execution key, once: a later call with
   * the same key returns the first record unchanged (replays and
   * reconciliation must send exactly the same request).
   */
  async recordQuoteRequest(request: Omit<QuoteRequestRecord, 'requestedAt'>): Promise<QuoteRequestRecord> {
    await this.#pool.query(
      `insert into sales.quote_requests (execution_key, task_id, workspace_version, selection, delivery) values ($1, $2, $3, $4, $5)
       on conflict (execution_key) do nothing`,
      [request.executionKey, request.taskId, request.workspaceVersion, JSON.stringify(request.selection), JSON.stringify(request.delivery)],
    );
    const stored = await this.quoteRequest(request.executionKey);
    if (!stored) throw new Error(`quote request ${request.executionKey} was not recorded`);
    return stored;
  }

  async quoteRequest(executionKey: string): Promise<QuoteRequestRecord | null> {
    const r = await this.#pool.query<{ execution_key: string; task_id: string; workspace_version: number; selection: QuoteRequestRecord['selection']; delivery: QuoteRequestRecord['delivery']; requested_at: Date }>(
      'select * from sales.quote_requests where execution_key = $1',
      [executionKey],
    );
    const row = r.rows[0];
    return row ? { executionKey: row.execution_key, taskId: row.task_id, workspaceVersion: row.workspace_version, selection: row.selection, delivery: row.delivery, requestedAt: row.requested_at.toISOString() } : null;
  }

  /** Idempotent per execution key; only ever called with the Quote owner's own answer. */
  async recordQuoteReference(reference: { executionKey: string; taskId: string; quoteId: string; quoteNumber: string }): Promise<void> {
    await this.#pool.query(
      `insert into sales.quote_references (execution_key, task_id, quote_id, quote_number) values ($1, $2, $3, $4)
       on conflict (execution_key) do nothing`,
      [reference.executionKey, reference.taskId, reference.quoteId, reference.quoteNumber],
    );
  }

  async quoteReferences(taskId: string): Promise<QuoteReference[]> {
    const r = await this.#pool.query<{ execution_key: string; task_id: string; quote_id: string; quote_number: string; workspace_version: number; recorded_at: Date }>(
      `select r.execution_key, r.task_id, r.quote_id, r.quote_number, q.workspace_version, r.recorded_at
         from sales.quote_references r join sales.quote_requests q using (execution_key)
        where r.task_id = $1 order by r.recorded_at, r.execution_key`,
      [taskId],
    );
    return r.rows.map((row) => ({ executionKey: row.execution_key, taskId: row.task_id, quoteId: row.quote_id, quoteNumber: row.quote_number, basedOnWorkspaceVersion: row.workspace_version, recordedAt: row.recorded_at.toISOString() }));
  }

  async #transition(client: pg.Pool | pg.PoolClient, executionKey: string): Promise<WorkspaceTransition | null> {
    const r = await client.query<TransitionRow>('select * from sales.workspace_transitions where execution_key = $1', [executionKey]);
    return r.rows[0] ? transitionOf(r.rows[0]) : null;
  }
}

interface TransitionRow {
  execution_key: string;
  task_id: string;
  outcome: 'applied' | 'rejected';
  from_version: number;
  to_version: number;
  operations: WorkspaceUpdateInput['operations'];
  changes: WorkspaceChange[];
  result: StoredWorkspaceResult;
  recorded_at: Date;
}

function transitionOf(row: TransitionRow): WorkspaceTransition {
  return {
    executionKey: row.execution_key,
    taskId: row.task_id,
    outcome: row.outcome,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    operations: row.operations,
    changes: row.changes,
    result: row.result,
    recordedAt: row.recorded_at.toISOString(),
  };
}
