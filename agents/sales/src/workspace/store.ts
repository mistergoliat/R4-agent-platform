import type pg from 'pg';
import type { QuoteV2CreateRequest } from '@r4-adapters/domains';
import { applyOperations, emptyWorkspace, type Workspace, type WorkspaceApplication, type WorkspaceChange, type WorkspaceState, type WorkspaceUpdateInput, type WorkspaceUpdateV2Input } from './model.js';

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

/** The frozen Quote V2 body R4 sends for one execution key (0007). */
export interface QuoteV2RequestRecord {
  readonly executionKey: string;
  readonly taskId: string;
  readonly workspaceVersion: number;
  readonly request: QuoteV2CreateRequest;
  readonly requestSha256: string;
  readonly recordedAt: string;
}

/** A formally issued Quote V2 quote as the owner reported it, with R4's document verification. */
export interface QuoteV2IssuedRecord {
  readonly executionKey: string;
  readonly taskId: string;
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly issuedAt: string;
  readonly validThroughLocalDate: string;
  readonly validUntilExclusive: string;
  readonly pdfSha256: string;
  readonly byteLength: number;
  readonly documentVerification: 'verified' | 'unavailable' | 'mismatch';
  readonly recordedAt: string;
}

/** (R4-J3E) One autonomous decision of quote.create@3 (0008), as recorded. */
export interface AutonomousQuoteDecisionRecord {
  readonly executionKey: string;
  readonly taskId: string;
  readonly previewId: string;
  readonly outcome: 'authorized' | 'rejected';
  /** `eligible` exactly when authorized; otherwise why the issuance was refused. */
  readonly reasonCode: string;
  readonly snapshot: object | null;
  readonly limits: object;
  readonly measurements: object;
  readonly quoteRequest: object | null;
  readonly decidedAt: string;
}

/** (R4-J3E) What `decideAutonomousQuote` measured under its lock, for the caller's judgement. */
export interface AutonomousQuoteCounters {
  /** Autonomous authorizations already recorded for this conversation task. */
  readonly authorizedInConversation: number;
  /** Autonomous authorizations recorded in this database during the last hour (database clock). */
  readonly authorizedLastHour: number;
  /** The execution key that already authorized this exact snapshot in this conversation, if any. */
  readonly sameSnapshotAuthorizedBy: string | null;
}

/**
 * PostgreSQL store of Sales application state. It touches only the `sales`
 * schema (0006–0008, owned by this pack): never an R4 runtime table and never a
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
  async applyCommand(command: { taskId: string; executionKey: string; input: WorkspaceUpdateInput | WorkspaceUpdateV2Input; unknownProducts: readonly string[]; now: string; requireVersion?: number }): Promise<{ result: StoredWorkspaceResult; workspace: Workspace; replayed: boolean }> {
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
          : command.requireVersion !== undefined && command.requireVersion !== current.version
            ? // (R4-J3E) The caller verified owner facts against this exact version; anything newer must be re-verified.
              { kind: 'rejected', code: 'version_conflict', message: `the workspace changed (version ${current.version}, verified at ${command.requireVersion}); verify again`, operationIndex: null }
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

  /**
   * Freezes the Quote V2 request body for this execution key, once (0007): a
   * later call returns the first record unchanged, so every retry and
   * reconciliation sends exactly the same body.
   */
  async recordQuoteV2Request(request: Omit<QuoteV2RequestRecord, 'recordedAt'>): Promise<QuoteV2RequestRecord> {
    await this.#pool.query(
      `insert into sales.quote_v2_requests (execution_key, task_id, workspace_version, request, request_sha256) values ($1, $2, $3, $4, $5)
       on conflict (execution_key) do nothing`,
      [request.executionKey, request.taskId, request.workspaceVersion, JSON.stringify(request.request), request.requestSha256],
    );
    const stored = await this.quoteV2Request(request.executionKey);
    if (!stored) throw new Error(`quote v2 request ${request.executionKey} was not recorded`);
    return stored;
  }

  async quoteV2Request(executionKey: string): Promise<QuoteV2RequestRecord | null> {
    const r = await this.#pool.query<{ execution_key: string; task_id: string; workspace_version: number; request: QuoteV2CreateRequest; request_sha256: string; recorded_at: Date }>('select * from sales.quote_v2_requests where execution_key = $1', [executionKey]);
    const row = r.rows[0];
    return row ? { executionKey: row.execution_key, taskId: row.task_id, workspaceVersion: row.workspace_version, request: row.request, requestSha256: row.request_sha256, recordedAt: row.recorded_at.toISOString() } : null;
  }

  /** Logged before every POST of the frozen body. */
  async recordQuoteV2Send(executionKey: string): Promise<void> {
    await this.#pool.query('insert into sales.quote_v2_sends (execution_key) values ($1) on conflict do nothing', [executionKey]);
  }

  /** Milliseconds since the latest POST of this key started (database clock), or null when it was never sent. */
  async quoteV2SendAgeMs(executionKey: string): Promise<number | null> {
    const r = await this.#pool.query<{ age_ms: string | null }>('select (extract(epoch from (clock_timestamp() - max(sent_at))) * 1000)::bigint as age_ms from sales.quote_v2_sends where execution_key = $1', [executionKey]);
    const age = r.rows[0]?.age_ms;
    return age === null || age === undefined ? null : Number(age);
  }

  /** Idempotent per execution key; only ever called with the Quote owner's own answer. */
  async recordQuoteV2Acceptance(acceptance: { executionKey: string; taskId: string; quoteId: string; quoteNumber: string; operationId: string }): Promise<void> {
    await this.#pool.query(
      `insert into sales.quote_v2_acceptances (execution_key, task_id, quote_id, quote_number, operation_id) values ($1, $2, $3, $4, $5)
       on conflict (execution_key) do nothing`,
      [acceptance.executionKey, acceptance.taskId, acceptance.quoteId, acceptance.quoteNumber, acceptance.operationId],
    );
  }

  /** Idempotent per execution key: the first verified record stands (a later read never rewrites it). */
  async recordQuoteV2Issued(issued: Omit<QuoteV2IssuedRecord, 'recordedAt'>): Promise<QuoteV2IssuedRecord> {
    await this.#pool.query(
      `insert into sales.quote_v2_issued (execution_key, task_id, quote_id, quote_number, issued_at, valid_through_local_date, valid_until_exclusive, pdf_sha256, byte_length, document_verification)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (execution_key) do nothing`,
      [issued.executionKey, issued.taskId, issued.quoteId, issued.quoteNumber, issued.issuedAt, issued.validThroughLocalDate, issued.validUntilExclusive, issued.pdfSha256, issued.byteLength, issued.documentVerification],
    );
    return (await this.quoteV2Issued(issued.taskId)).find((q) => q.executionKey === issued.executionKey)!;
  }

  async quoteV2Issued(taskId: string): Promise<QuoteV2IssuedRecord[]> {
    const r = await this.#pool.query<{ execution_key: string; task_id: string; quote_id: string; quote_number: string; issued_at: Date; valid_through_local_date: string; valid_until_exclusive: Date; pdf_sha256: string; byte_length: number; document_verification: QuoteV2IssuedRecord['documentVerification']; recorded_at: Date }>(
      `select execution_key, task_id, quote_id, quote_number, issued_at, to_char(valid_through_local_date, 'YYYY-MM-DD') as valid_through_local_date, valid_until_exclusive, pdf_sha256, byte_length, document_verification, recorded_at
         from sales.quote_v2_issued where task_id = $1 order by recorded_at, execution_key`,
      [taskId],
    );
    return r.rows.map((row) => ({
      executionKey: row.execution_key,
      taskId: row.task_id,
      quoteId: row.quote_id,
      quoteNumber: row.quote_number,
      issuedAt: row.issued_at.toISOString(),
      validThroughLocalDate: row.valid_through_local_date,
      validUntilExclusive: row.valid_until_exclusive.toISOString(),
      pdfSha256: row.pdf_sha256,
      byteLength: row.byte_length,
      documentVerification: row.document_verification,
      recordedAt: row.recorded_at.toISOString(),
    }));
  }

  async autonomousDecision(executionKey: string, client: pg.Pool | pg.PoolClient = this.#pool): Promise<AutonomousQuoteDecisionRecord | null> {
    const r = await client.query<AutonomousDecisionRow>('select * from sales.quote_autonomous_decisions where execution_key = $1', [executionKey]);
    return r.rows[0] ? decisionOf(r.rows[0]) : null;
  }

  /** Records a refusal decided before any counter mattered (once per key; a replay returns the first decision). */
  async recordAutonomousRejection(rejection: Omit<AutonomousQuoteDecisionRecord, 'outcome' | 'decidedAt'>): Promise<AutonomousQuoteDecisionRecord> {
    await this.#pool.query(
      `insert into sales.quote_autonomous_decisions (execution_key, task_id, preview_id, outcome, reason_code, snapshot, limits, measurements, quote_request)
       values ($1, $2, $3, 'rejected', $4, $5, $6, $7, $8) on conflict (execution_key) do nothing`,
      [rejection.executionKey, rejection.taskId, rejection.previewId, rejection.reasonCode, json(rejection.snapshot), JSON.stringify(rejection.limits), JSON.stringify(rejection.measurements), json(rejection.quoteRequest)],
    );
    return (await this.autonomousDecision(rejection.executionKey))!;
  }

  /**
   * (R4-J3E) The autonomous decision of one quote.create@3 command, atomically:
   * a decision already taken for this key is returned as is (replay); otherwise,
   * under one lock that serializes every autonomous decision of this database,
   * the counters are measured (authorized quotes of this conversation, of the
   * last hour, an earlier authorization of the same snapshot) and `judge`
   * decides. An authorization is recorded in the SAME transaction that freezes
   * the exact Quote V2 request (0007): nothing is ever sent without its decision.
   */
  async decideAutonomousQuote(command: {
    readonly executionKey: string;
    readonly taskId: string;
    readonly previewId: string;
    readonly snapshot: object;
    readonly limits: object;
    readonly quoteRequest: object;
    readonly workspaceVersion: number;
    readonly request: QuoteV2CreateRequest;
    readonly requestSha256: string;
    readonly judge: (counters: AutonomousQuoteCounters) => { readonly reasonCode: string; readonly measurements: object };
  }): Promise<{ readonly decision: AutonomousQuoteDecisionRecord; readonly replayed: boolean }> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 7))', ['sales.quote_autonomous_decisions']);
      const previous = await this.autonomousDecision(command.executionKey, client);
      if (previous) {
        await client.query('commit');
        return { decision: previous, replayed: true };
      }
      const counts = await client.query<{ conversation: string; last_hour: string; same_snapshot: string | null }>(
        `select count(*) filter (where task_id = $1) as conversation,
                count(*) filter (where decided_at > clock_timestamp() - interval '1 hour') as last_hour,
                min(execution_key) filter (where task_id = $1 and preview_id = $2) as same_snapshot
           from sales.quote_autonomous_decisions where outcome = 'authorized'`,
        [command.taskId, command.previewId],
      );
      const row = counts.rows[0]!;
      const verdict = command.judge({ authorizedInConversation: Number(row.conversation), authorizedLastHour: Number(row.last_hour), sameSnapshotAuthorizedBy: row.same_snapshot });
      const authorized = verdict.reasonCode === 'eligible';
      await client.query(
        `insert into sales.quote_autonomous_decisions (execution_key, task_id, preview_id, outcome, reason_code, snapshot, limits, measurements, quote_request)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [command.executionKey, command.taskId, command.previewId, authorized ? 'authorized' : 'rejected', verdict.reasonCode, JSON.stringify(command.snapshot), JSON.stringify(command.limits), JSON.stringify(verdict.measurements), JSON.stringify(command.quoteRequest)],
      );
      if (authorized) {
        await client.query(
          `insert into sales.quote_v2_requests (execution_key, task_id, workspace_version, request, request_sha256) values ($1, $2, $3, $4, $5)
           on conflict (execution_key) do nothing`,
          [command.executionKey, command.taskId, command.workspaceVersion, JSON.stringify(command.request), command.requestSha256],
        );
      }
      const decision = (await this.autonomousDecision(command.executionKey, client))!;
      await client.query('commit');
      return { decision, replayed: false };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

interface AutonomousDecisionRow {
  execution_key: string;
  task_id: string;
  preview_id: string;
  outcome: 'authorized' | 'rejected';
  reason_code: string;
  snapshot: object | null;
  limits: object;
  measurements: object;
  quote_request: object | null;
  decided_at: Date;
}

function decisionOf(row: AutonomousDecisionRow): AutonomousQuoteDecisionRecord {
  return {
    executionKey: row.execution_key,
    taskId: row.task_id,
    previewId: row.preview_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    snapshot: row.snapshot,
    limits: row.limits,
    measurements: row.measurements,
    quoteRequest: row.quote_request,
    decidedAt: row.decided_at.toISOString(),
  };
}

function json(value: object | null): string | null {
  return value === null ? null : JSON.stringify(value);
}
