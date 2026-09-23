import { snapshotComposition } from '@r4/context-compiler';
import type { ContextSnapshot } from '@r4/contracts';
import { buildEvaluationSubject, type ContextSnapshotMeta, type DomainProjection, type EvaluationSubject, type ModelCallRecord, type TrajectoryRecords } from '@r4/evaluation';
import {
  PostgresActionLedgerStore,
  PostgresAgentDefinitionStore,
  PostgresContextSnapshotStore,
  PostgresExecutionStore,
  PostgresMemoryStore,
  PostgresObservationStore,
  PostgresTaskRuntimeStore,
  type Pool,
} from '@r4/persistence-postgres';

/**
 * A pack's projection of its own application state for one task (e.g. a
 * state record and its transitions). Read-only; the pack owns the store.
 */
export interface DomainProjectionProvider {
  readonly projectionId: string;
  project(taskId: string): Promise<DomainProjection>;
}

/**
 * Canonical trajectory reader (R4-G). Rebuilds a finished trajectory from the
 * stores that already hold it — tasks, runs, steps, context snapshots,
 * observations, the action ledger, goals, temporal events, waits, human
 * requests and conversational memory — through their existing read APIs.
 * It adds no table and copies no history; it never writes (the only
 * transactions it opens run SELECTs).
 */
export class PostgresTrajectoryReader {
  readonly #pool: Pool;
  readonly #projections: readonly DomainProjectionProvider[];

  constructor(pool: Pool, options: { projections?: readonly DomainProjectionProvider[] } = {}) {
    this.#pool = pool;
    this.#projections = options.projections ?? [];
  }

  async records(taskId: string, extras: { modelCalls?: readonly ModelCallRecord[] | null; sourceRef?: string } = {}): Promise<TrajectoryRecords> {
    const pool = this.#pool;
    const view = await new PostgresTaskRuntimeStore(pool).getTaskView(taskId);
    if (!view) throw new Error(`task ${taskId} not found`);
    const tasks = new PostgresTaskRuntimeStore(pool);
    const execution = new PostgresExecutionStore(pool);
    const snapshots = new PostgresContextSnapshotStore(pool);
    const runs = [];
    for (const summary of view.runs) {
      const run = await tasks.getRun(summary.runId);
      if (!run) throw new Error(`run ${summary.runId} not found`);
      const steps = await execution.transaction((uow) => uow.listRunSteps(summary.runId));
      runs.push({ run, steps, contexts: (await snapshots.listForRun(summary.runId)).map(snapshotMeta) });
    }
    const temporal = await execution.transaction(async (uow) => {
      const t = uow.temporal;
      if (!t) return { events: [], waits: [], humans: [] };
      return { events: await t.events(taskId), waits: await t.listWaits(taskId), humans: await t.listHumans(taskId) };
    });
    const memory = await new PostgresMemoryStore(pool).listForTask(taskId);
    const definition = await new PostgresAgentDefinitionStore(pool).get(view.task.agentId, view.task.agentVersion);
    const domain: Record<string, DomainProjection> = {};
    for (const p of this.#projections) domain[p.projectionId] = await p.project(taskId);
    return {
      source: { kind: 'durable', ref: extras.sourceRef ?? `task:${taskId}` },
      task: view.task,
      agent: { agentId: view.task.agentId, version: view.task.agentVersion, contentHash: definition?.contentHash ?? null },
      runs,
      observations: await new PostgresObservationStore(pool).listByTask(taskId),
      ledger: await new PostgresActionLedgerStore(pool).forTask(taskId),
      goals: view.goals,
      events: temporal.events.map((e) => ({ eventId: e.eventId, type: e.type, entityId: e.entityId, occurredAt: e.occurredAt, responseKey: e.responseKey, data: e.data })),
      waits: temporal.waits,
      humans: temporal.humans.map((h) => ({ requestId: h.requestId, kind: h.kind, status: h.status, createdAt: h.createdAt })),
      conversation: memory.flatMap((m) => (m.memoryType === 'CONVERSATIONAL' ? [{ entryId: m.entryId, role: m.content.actor.role, text: m.content.text, interactionRef: m.content.interactionRef, recordedAt: m.recordedAt }] : [])),
      domain,
      modelCalls: extras.modelCalls ?? null,
    };
  }

  async subject(taskId: string, extras: { modelCalls?: readonly ModelCallRecord[] | null; sourceRef?: string } = {}): Promise<EvaluationSubject> {
    return buildEvaluationSubject(await this.records(taskId, extras));
  }
}

/** Metadata of one snapshot: its accounting (C2) and which items it showed — not the compiled content. */
export function snapshotMeta(s: ContextSnapshot): ContextSnapshotMeta {
  const c = snapshotComposition(s);
  return {
    snapshotId: s.snapshotId,
    runId: s.runId,
    iteration: s.iteration,
    attempt: s.attempt,
    estimatedTokens: s.estimatedTokens,
    includedTokensByKind: Object.fromEntries(Object.entries(c.byKind).map(([k, t]) => [k, t.included.estimatedTokens])),
    includedTokensBySource: Object.fromEntries(Object.entries(c.bySource).map(([k, t]) => [k, t.included.estimatedTokens])),
    compactedCount: c.compactedCount,
    includedItemIds: s.decisions.filter((d) => d.decision === 'included').map((d) => d.itemId),
    excludedItemIds: s.decisions.filter((d) => d.decision === 'excluded').map((d) => d.itemId),
  };
}
