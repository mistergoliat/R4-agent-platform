import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import { createFixtureDomains, type FixtureDomains } from '@r4-adapters/domains';
import { createPlatform, type Platform } from '@r4/api';
import type { ExecutionPolicy } from '@r4/agent-kernel';
import { snapshotComposition } from '@r4/context-compiler';
import type { Clock, Principal, RunStep, TrustedHumanContext } from '@r4/contracts';
import type { ModelProvider } from '@r4/model-gateway';
import { createLogger } from '@r4/observability';
import {
  PostgresActionLedgerStore,
  PostgresContextSnapshotStore,
  PostgresExecutionStore,
  PostgresMemoryStore,
  PostgresObservationStore,
  createPool,
  type Pool,
} from '@r4/persistence-postgres';
import { createWorkerPlatform, type WorkerCycle, type WorkerPlatform } from '@r4/worker';
import { composeSales } from '../composition.js';
import { SALES_AGENT_DIR } from '../definition.js';
import { SALES_AGENT_ID, SALES_TASK_TYPE } from '../ids.js';
import type { PostgresSalesStore } from '../workspace/store.js';

/** A process clock that scenarios can move forward (C2 freshness, observation validity). */
export interface ShiftableClock extends Clock {
  offsetMs: number;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function shiftableClock(): ShiftableClock {
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  return clock;
}

/** The harness's stand-in for an authenticated operator (no production IAM exists in R4). */
export const HARNESS_OPERATOR: TrustedHumanContext = { humanRef: 'sales-harness-operator', scopes: ['consultation.answer', 'handoff.manage', 'task.cancel'], correlationId: 'sales-harness' };

/** Who creates conversations: the Sales ingress (a channel adapter in production), provisionally identified. */
export const HARNESS_INGRESS: Principal = { kind: 'service', ref: 'sales-harness-ingress' };

export const SALES_ROOT_GOAL = {
  description: 'Help this customer reach a purchase decision that fits their real objective and constraints, and a governed quote when they want one.',
  successCriteria: ['the customer objective and constraints are understood and kept', 'any proposed solution is grounded in current catalog evidence', 'a quote is claimed only from a receipt-backed observation'],
};

export interface SalesHarnessOptions {
  readonly databaseUrl: string;
  readonly modelProvider: ModelProvider;
  readonly domains?: FixtureDomains;
  readonly clock?: ShiftableClock;
  /** Worker execution policy overrides (per-run ceilings). */
  readonly execution?: Partial<ExecutionPolicy>;
  readonly workerId?: string;
  /** Worker lease timing (short leases let a scenario simulate a worker that died). */
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  /** Keep metadata-only telemetry events in memory (for live reports). */
  readonly captureTelemetry?: boolean;
}

export interface TurnRecord {
  readonly index: number;
  readonly kind: 'customer' | 'operator';
  readonly text: string;
  readonly at: string;
  readonly runIds: readonly string[];
  readonly cycles: readonly WorkerCycle['kind'][];
}

const DEFAULT_EXECUTION: ExecutionPolicy = {
  maxIterations: 30,
  maxModelCalls: 30,
  maxReadCapabilityCalls: 30,
  maxRunDurationMs: 10 * 60_000,
  modelCallTimeoutMs: 120_000,
  maxWriteActions: 200,
};

/**
 * Conversational E2E harness: the R4 API composition (task runtime, temporal
 * runtime) and a real R4 worker composed with the Sales pack, in one process,
 * over PostgreSQL. A turn is canonical input (`submitInput`) — never a
 * channel webhook — and the worker is driven cycle by cycle until it has
 * nothing left to do, so every turn ends in durable state that can be
 * inspected. The worker can be torn down and rebuilt between turns (a process
 * boundary: new pool, new registries; only PostgreSQL survives).
 */
export class SalesHarness {
  readonly domains: FixtureDomains;
  readonly clock: ShiftableClock;
  /** Metadata-only telemetry events (filled when `captureTelemetry` is set). */
  readonly telemetry: readonly Record<string, unknown>[];
  readonly #options: SalesHarnessOptions;
  readonly #logger: Logger;
  readonly #api: Platform;
  readonly #pool: Pool;
  #worker: WorkerPlatform;
  #store: PostgresSalesStore;
  readonly #turns = new Map<string, TurnRecord[]>();

  private constructor(options: SalesHarnessOptions, logger: Logger, api: Platform, pool: Pool, worker: WorkerPlatform, store: PostgresSalesStore, domains: FixtureDomains, clock: ShiftableClock, telemetry: readonly Record<string, unknown>[]) {
    this.telemetry = telemetry;
    this.#options = options;
    this.#logger = logger;
    this.#api = api;
    this.#pool = pool;
    this.#worker = worker;
    this.#store = store;
    this.domains = domains;
    this.clock = clock;
  }

  static async start(options: SalesHarnessOptions): Promise<SalesHarness> {
    const clock = options.clock ?? shiftableClock();
    const domains = options.domains ?? createFixtureDomains({ now: () => clock.now() });
    const telemetry: Record<string, unknown>[] = [];
    const logger = options.captureTelemetry ? telemetryLogger(telemetry) : createLogger({ service: 'sales-harness', level: 'silent' });
    const api = await createPlatform({ databaseUrl: options.databaseUrl, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 4 }, { logger, clock });
    const pool = createPool({ connectionString: options.databaseUrl, logger, applicationName: 'sales-harness', max: 4 });
    try {
      const { worker, store } = await bootWorker(options, pool, domains, clock, logger);
      return new SalesHarness(options, logger, api, pool, worker, store, domains, clock, telemetry);
    } catch (error) {
      await pool.end().catch(() => undefined);
      await api.close().catch(() => undefined);
      throw error;
    }
  }

  get store(): PostgresSalesStore {
    return this.#store;
  }

  get pool(): Pool {
    return this.#pool;
  }

  get api(): Platform {
    return this.#api;
  }

  /** Opens a Sales conversation (task) and binds it to a customer reference (null = anonymous). */
  async openConversation(options: { customerRef?: string | null; channelRef?: string; correlationId?: string } = {}): Promise<string> {
    const { view } = await this.#api.tasks.createTask({
      request: { taskType: SALES_TASK_TYPE, agentId: SALES_AGENT_ID, goal: SALES_ROOT_GOAL, input: { channel: options.channelRef ?? 'harness' } },
      requestedBy: HARNESS_INGRESS,
      correlationId: options.correlationId ?? 'sales-harness',
    });
    const taskId = view.task.taskId;
    await this.#store.bindConversation({ taskId, customerRef: options.customerRef ?? null, channelRef: options.channelRef ?? 'harness' });
    this.#turns.set(taskId, []);
    return taskId;
  }

  /** Delivers one customer message as canonical input, then runs the agent until it has nothing left to do. */
  async say(taskId: string, text: string): Promise<TurnRecord> {
    const { index, at } = await this.#submit(taskId, text);
    return this.#record(taskId, { index, kind: 'customer', text, at, ...(await this.runUntilIdle()) });
  }

  /**
   * A turn during which the worker process "dies": its cycle is started and
   * not awaited; once `died()` holds (e.g. the Quote owner has issued the
   * quote but no receipt exists yet), the worker composition is closed under
   * it — its pool is gone, so nothing it does can be recorded and its lease
   * stops being extended — and a fresh worker takes over once the lease has
   * expired on the database clock. Requires a short `leaseDurationMs`.
   */
  async sayThroughWorkerDeath(taskId: string, text: string, died: () => boolean, timeoutMs = 30_000): Promise<TurnRecord> {
    const { index, at } = await this.#submit(taskId, text);
    const deadline = Date.now() + timeoutMs;
    const orphan = this.#worker;
    void orphan.worker.runOnce().catch(() => undefined);
    while (!died()) {
      if (Date.now() > deadline) throw new Error('the worker never reached the death point');
      await sleep(20);
    }
    void orphan.close().catch(() => undefined);
    const { worker, store } = await bootWorker(this.#options, this.#pool, this.domains, this.clock, this.#logger);
    this.#worker = worker;
    this.#store = store;
    const runIds: string[] = [];
    const cycles: WorkerCycle['kind'][] = [];
    // The dead worker's lease has to expire before anyone may claim the task again.
    for (;;) {
      const cycle = await worker.worker.runOnce();
      if (cycle.kind !== 'idle') {
        cycles.push(cycle.kind);
        if (cycle.kind === 'executed') runIds.push(cycle.runId);
        break;
      }
      if (Date.now() > deadline) throw new Error('no worker could take over the task');
      await sleep(50);
    }
    const rest = await this.runUntilIdle();
    return this.#record(taskId, { index, kind: 'customer', text, at, runIds: [...new Set([...runIds, ...rest.runIds])], cycles: [...cycles, ...rest.cycles] });
  }

  async #submit(taskId: string, text: string): Promise<{ index: number; at: string }> {
    const index = (this.#turns.get(taskId) ?? []).length + 1;
    const binding = await this.#store.conversation(taskId);
    const actor: Principal = binding?.customerRef ? { kind: 'user', ref: binding.customerRef } : { kind: 'unauthenticated', ref: 'anonymous-visitor' };
    const at = this.clock.now().toISOString();
    await this.#api.temporal.submitInput(taskId, { externalKey: `turn-${index}`, content: text, sourceRef: binding?.channelRef ?? 'harness', occurredAt: at }, actor, `turn-${index}`);
    return { index, at };
  }

  #record(taskId: string, record: TurnRecord): TurnRecord {
    this.#turns.set(taskId, [...(this.#turns.get(taskId) ?? []), record]);
    return record;
  }

  /** Answers the task's open consultation as the harness operator, then runs the agent. */
  async answerConsultation(taskId: string, text: string): Promise<TurnRecord> {
    const { humans } = await this.#api.temporal.inspect(taskId);
    const open = humans.find((h) => h.kind === 'consultation' && h.status === 'requested');
    if (!open) throw new Error(`task ${taskId} has no open consultation`);
    const index = (this.#turns.get(taskId) ?? []).length + 1;
    const at = this.clock.now().toISOString();
    await this.#api.temporal.respondHuman(open.requestId, { responseKey: `answer-${open.requestId}`, outcome: 'answer', content: text }, HARNESS_OPERATOR);
    return this.#record(taskId, { index, kind: 'operator', text, at, ...(await this.runUntilIdle()) });
  }

  /** Worker cycles until idle (bounded): every claimable task runs to its next durable stop. */
  async runUntilIdle(maxCycles = 25): Promise<{ runIds: string[]; cycles: WorkerCycle['kind'][] }> {
    const runIds: string[] = [];
    const cycles: WorkerCycle['kind'][] = [];
    for (let i = 0; i < maxCycles; i += 1) {
      const cycle = await this.#worker.worker.runOnce();
      if (cycle.kind === 'idle') break;
      cycles.push(cycle.kind);
      if (cycle.kind === 'executed' && !runIds.includes(cycle.runId)) runIds.push(cycle.runId);
    }
    return { runIds, cycles };
  }

  /** Tears the worker down and boots a new one: only PostgreSQL (and the external owners) survive. */
  async restartWorker(): Promise<void> {
    await this.#worker.close();
    const { worker, store } = await bootWorker(this.#options, this.#pool, this.domains, this.clock, this.#logger);
    this.#worker = worker;
    this.#store = store;
  }

  turns(taskId: string): readonly TurnRecord[] {
    return this.#turns.get(taskId) ?? [];
  }

  /** Everything durable about one conversation, from the owners' stores (read-only). */
  async inspect(taskId: string): Promise<ConversationState> {
    const pool = this.#pool;
    const view = await this.#api.tasks.getTask(taskId);
    const execution = new PostgresExecutionStore(pool);
    const snapshots = new PostgresContextSnapshotStore(pool);
    const runs = [];
    for (const summary of view.runs) {
      const run = await this.#api.tasks.getRun(summary.runId);
      const steps = await execution.transaction((uow) => uow.listRunSteps(summary.runId));
      const contexts = (await snapshots.listForRun(summary.runId)).map((s) => {
        const c = snapshotComposition(s);
        const itemIds = Object.values(s.compiledContext.sections).flatMap((items) => items.map((i) => i.itemId));
        const sectionByItem = Object.fromEntries(Object.entries(s.compiledContext.sections).flatMap(([section, items]) => items.map((i) => [i.itemId, section])));
        // Diagnostics: which item each id the model could read appears in (its item id, provenance or content).
        const itemByMentionedId: Record<string, string> = {};
        for (const items of Object.values(s.compiledContext.sections)) for (const item of items) for (const id of JSON.stringify(item).match(UUID) ?? []) itemByMentionedId[id] ??= item.itemId;
        return { snapshotId: s.snapshotId, iteration: s.iteration, attempt: s.attempt, estimatedTokens: s.estimatedTokens, itemIds, sectionByItem, itemByMentionedId, includedTokensByKind: Object.fromEntries(Object.entries(c.byKind).map(([k, t]) => [k, t.included.estimatedTokens])), includedTokensBySource: Object.fromEntries(Object.entries(c.bySource).map(([k, t]) => [k, t.included.estimatedTokens])), compactedCount: c.compactedCount };
      });
      runs.push({ run, steps, contexts });
    }
    return {
      task: view.task,
      goals: view.goals,
      runs,
      observations: await new PostgresObservationStore(pool).listByTask(taskId),
      ledger: await new PostgresActionLedgerStore(pool).forTask(taskId),
      temporal: await this.#api.temporal.inspect(taskId),
      conversation: (await new PostgresMemoryStore(pool).listForTask(taskId)).filter((m) => m.memoryType === 'CONVERSATIONAL'),
      workspace: await this.#store.workspace(taskId),
      workspaceTransitions: await this.#store.transitions(taskId),
      quoteReferences: await this.#store.quoteReferences(taskId),
      turns: this.turns(taskId),
    };
  }

  async close(): Promise<void> {
    await this.#worker.close().catch(() => undefined);
    await this.#pool.end().catch(() => undefined);
    await this.#api.close().catch(() => undefined);
  }
}

export type ConversationState = {
  readonly task: Awaited<ReturnType<Platform['tasks']['getTask']>>['task'];
  readonly goals: Awaited<ReturnType<Platform['tasks']['getTask']>>['goals'];
  readonly runs: readonly {
    readonly run: Awaited<ReturnType<Platform['tasks']['getRun']>>;
    readonly steps: readonly RunStep[];
    readonly contexts: readonly { snapshotId: string; iteration: number; itemIds: readonly string[]; sectionByItem: Readonly<Record<string, string>>; itemByMentionedId: Readonly<Record<string, string>>; attempt: number; estimatedTokens: number; includedTokensByKind: Record<string, number>; includedTokensBySource: Record<string, number>; compactedCount: number }[];
  }[];
  readonly observations: Awaited<ReturnType<PostgresObservationStore['listByTask']>>;
  readonly ledger: Awaited<ReturnType<PostgresActionLedgerStore['forTask']>>;
  readonly temporal: Awaited<ReturnType<Platform['temporal']['inspect']>>;
  readonly conversation: Awaited<ReturnType<PostgresMemoryStore['listForTask']>>;
  readonly workspace: Awaited<ReturnType<PostgresSalesStore['workspace']>>;
  readonly workspaceTransitions: Awaited<ReturnType<PostgresSalesStore['transitions']>>;
  readonly quoteReferences: Awaited<ReturnType<PostgresSalesStore['quoteReferences']>>;
  readonly turns: readonly TurnRecord[];
};

async function bootWorker(options: SalesHarnessOptions, pool: Pool, domains: FixtureDomains, clock: ShiftableClock, logger: Logger): Promise<{ worker: WorkerPlatform; store: PostgresSalesStore }> {
  const sales = composeSales({ pool, domains, modelProvider: options.modelProvider, clock });
  const worker = await createWorkerPlatform(
    {
      databaseUrl: options.databaseUrl,
      logLevel: 'silent',
      dbPoolMax: 4,
      workerId: options.workerId ?? 'sales-harness-worker',
      leaseDurationMs: options.leaseDurationMs ?? 60_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      pollIntervalMs: 50,
      maxRunRecoveries: 3,
      execution: { ...DEFAULT_EXECUTION, ...options.execution },
      context: { budget: { mode: 'unbounded' } },
    },
    sales.bindings,
    { logger, clock },
  );
  return { worker, store: sales.store };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Metadata-only telemetry sink: the platform never logs content, so these lines are safe to keep. */
function telemetryLogger(into: Record<string, unknown>[]): Logger {
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.event === 'string') into.push(parsed);
      }
      callback();
    },
  });
  return createLogger({ service: 'sales-harness', level: 'info', destination });
}
