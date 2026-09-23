import type { ActionAttempt, ActionExecution, ActionProposal, ActionReceipt, AgentRun, AgentTask, Goal, Observation, PolicyDecision, RunStep, TaskWait } from '@r4/contracts';
import {
  SUBJECT_SCHEMA_VERSION,
  parseEvaluationSubject,
  type ContextSnapshotMeta,
  type DomainProjection,
  type EvaluationSubject,
  type ModelCallRecord,
  type SubjectResponse,
  type SubjectRun,
  type SubjectTurn,
} from './subject.js';

/**
 * Everything durable about one task, as its owners' stores return it. A
 * reader (PostgreSQL today) fills this from existing tables — Quality adds no
 * table and duplicates no history — and `buildEvaluationSubject` turns it into
 * the canonical subject. Pure: the same records always give the same subject.
 */
export interface TrajectoryRecords {
  readonly source: { readonly kind: 'durable' | 'fixture'; readonly ref: string };
  readonly task: AgentTask;
  readonly agent: { readonly agentId: string; readonly version: number; readonly contentHash: string | null };
  readonly runs: readonly { readonly run: AgentRun; readonly steps: readonly RunStep[]; readonly contexts: readonly ContextSnapshotMeta[] }[];
  readonly observations: readonly Observation[];
  readonly ledger: {
    readonly proposals: readonly ActionProposal[];
    readonly decisions: readonly PolicyDecision[];
    readonly executions: readonly ActionExecution[];
    readonly attempts: readonly ActionAttempt[];
    readonly receipts: readonly ActionReceipt[];
  };
  readonly goals: readonly Goal[];
  /** Temporal events (goal.*, task.input.received, human responses), all on the database temporal clock. */
  readonly events: readonly { readonly eventId: string; readonly type: string; readonly entityId: string; readonly occurredAt: string; readonly responseKey: string | null; readonly data: Readonly<Record<string, unknown>> }[];
  readonly waits: readonly TaskWait[];
  readonly humans: readonly { readonly requestId: string; readonly kind: string; readonly status: string; readonly createdAt: string }[];
  /** CONVERSATIONAL memory: what the requester (and humans) said, with the input it came from. */
  readonly conversation: readonly { readonly entryId: string; readonly role: string; readonly text: string; readonly interactionRef: string; readonly recordedAt: string }[];
  /** Pack-supplied projections of application state (keyed by projection id). */
  readonly domain?: Readonly<Record<string, DomainProjection>>;
  /** Harness-recorded model call metadata, when the trajectory was produced under a recorder. */
  readonly modelCalls?: readonly ModelCallRecord[] | null;
}

export function buildEvaluationSubject(records: TrajectoryRecords): EvaluationSubject {
  const turns = turnsOf(records);
  const turnByItem = new Map(turns.map((t) => [t.itemRef, t.index]));
  const runs: SubjectRun[] = [...records.runs]
    .sort((a, b) => a.run.sequence - b.run.sequence)
    .map(({ run, steps, contexts }) => {
      const first = [...contexts].sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt)[0];
      const visible = first ? [...first.includedItemIds, ...first.excludedItemIds].map((id) => turnByItem.get(id)).filter((i): i is number => i !== undefined) : [];
      return {
        runId: run.runId,
        sequence: run.sequence,
        status: run.status,
        termination: run.termination,
        usage: run.usage,
        recoveries: run.recoveries,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        turnIndex: visible.length > 0 ? Math.max(...visible) : null,
        steps: [...steps].sort((a, b) => a.iteration - b.iteration),
        contexts: [...contexts].sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt),
      };
    });

  const responses: SubjectResponse[] = [];
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.decision?.type !== 'respond') continue;
      const snapshot = run.contexts.filter((c) => c.snapshotId === step.contextSnapshotId || (step.contextSnapshotId === null && c.iteration === step.iteration)).at(-1);
      responses.push({
        responseId: step.stepId,
        runId: run.runId,
        position: { run: run.sequence, iteration: step.iteration },
        turnIndex: run.turnIndex,
        text: step.decision.content,
        evidenceInContext: snapshot ? snapshot.includedItemIds.filter((id) => id.startsWith('observation:')).map((id) => id.slice('observation:'.length)) : [],
        snapshotId: snapshot?.snapshotId ?? null,
      });
    }
  }

  const t = records.task;
  return parseEvaluationSubject({
    schemaVersion: SUBJECT_SCHEMA_VERSION,
    subjectId: `task:${t.taskId}`,
    source: records.source,
    task: {
      taskId: t.taskId,
      taskType: t.taskType,
      agentId: t.agentId,
      agentVersion: t.agentVersion,
      status: t.status,
      statusReason: t.statusReason,
      rootGoalId: t.rootGoalId,
      currentGoalId: t.currentGoalId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    },
    agent: records.agent,
    turns,
    runs,
    responses,
    observations: records.observations,
    actions: {
      proposals: records.ledger.proposals,
      policyDecisions: records.ledger.decisions,
      executions: records.ledger.executions,
      attempts: records.ledger.attempts,
      receipts: records.ledger.receipts,
    },
    goals: records.goals,
    goalTransitions: records.events.filter((e) => e.type.startsWith('goal.')).map((e) => ({ type: e.type, goalId: e.entityId, at: e.occurredAt })),
    temporal: {
      waits: records.waits,
      humanRequests: records.humans.map((h) => ({ requestId: h.requestId, kind: h.kind, status: h.status, createdAt: h.createdAt })),
    },
    domain: records.domain ?? {},
    modelCalls: records.modelCalls ?? null,
  });
}

/**
 * Turns, in the order the platform received them (database temporal clock):
 * canonical inputs (CONVERSATIONAL memory from a non-agent actor) and human
 * responses (temporal events with a response key). Each keeps the context
 * item id the model saw it under, which is how runs are attributed to turns.
 */
function turnsOf(records: TrajectoryRecords): SubjectTurn[] {
  const inputs = records.conversation
    .filter((c) => c.role !== 'agent')
    .map((c) => ({ kind: 'input' as const, itemRef: `memory:${c.entryId}`, text: c.text, at: c.recordedAt, tie: c.entryId }));
  const humans = records.events
    .filter((e) => e.responseKey !== null && textOf(e.data) !== '')
    .map((e) => ({ kind: 'human_response' as const, itemRef: `human_response:${e.eventId}`, text: textOf(e.data), at: e.occurredAt, tie: e.eventId }));
  return [...inputs, ...humans]
    .sort((a, b) => (a.at === b.at ? (a.tie < b.tie ? -1 : 1) : Date.parse(a.at) - Date.parse(b.at)))
    .map((t, i) => ({ index: i + 1, kind: t.kind, itemRef: t.itemRef, text: t.text, at: t.at }));
}

function textOf(data: Readonly<Record<string, unknown>>): string {
  for (const key of ['content', 'text', 'answer']) if (typeof data[key] === 'string') return data[key];
  return '';
}
