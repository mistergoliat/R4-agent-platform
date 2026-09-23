import type { ConversationState } from './runtime.js';

/**
 * The structured record of one scenario run: what was said, what the agent
 * decided, which capabilities ran and what they observed, how goals and the
 * Sales workspace evolved, which receipts exist, how each run ended and what
 * it cost. Built from durable state only; it contains no chain-of-thought
 * (none is ever stored) and no secret (none reaches these records).
 */
export interface ScenarioReport {
  readonly scenario: { readonly id: string; readonly title: string };
  readonly mode: 'scripted' | 'live';
  readonly model: Readonly<Record<string, unknown>> | null;
  readonly taskId: string;
  readonly finalTaskStatus: string;
  readonly turns: readonly {
    readonly index: number;
    readonly kind: 'customer' | 'operator';
    readonly text: string;
    readonly agentResponses: readonly string[];
    readonly runIds: readonly string[];
  }[];
  readonly decisions: readonly {
    readonly runSequence: number;
    readonly iteration: number;
    readonly type: string | null;
    readonly capabilityId: string | null;
    readonly outcome: string;
    readonly errorCode: string | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }[];
  readonly capabilities: readonly { readonly capabilityId: string; readonly kind: 'read' | 'action'; readonly outcome: string; readonly errorCode: string | null; readonly observedAt: string; readonly validUntil: string | null }[];
  readonly observations: readonly { readonly observationId: string; readonly capabilityId: string; readonly outcome: string; readonly payload: unknown; readonly error: unknown }[];
  readonly receipts: readonly { readonly capabilityId: string; readonly status: string; readonly resourceRef: string | null; readonly externalOperationRef: string | null; readonly replayed: boolean }[];
  readonly goals: readonly { readonly goalId: string; readonly parentGoalId: string | null; readonly description: string; readonly status: string; readonly origin: string; readonly isRoot: boolean; readonly isCurrent: boolean }[];
  readonly goalTransitions: readonly { readonly type: string; readonly goalId: string; readonly at: string }[];
  readonly workspace: { readonly version: number; readonly state: unknown };
  readonly workspaceTransitions: readonly { readonly version: number; readonly outcome: string; readonly operations: unknown; readonly changes: unknown }[];
  readonly quoteReferences: readonly { readonly quoteNumber: string; readonly basedOnWorkspaceVersion: number }[];
  readonly runs: readonly { readonly sequence: number; readonly status: string; readonly termination: unknown; readonly usage: unknown; readonly steps: number }[];
  readonly tokens: { readonly input: number; readonly output: number; readonly modelCalls: number };
  readonly context: readonly { readonly runSequence: number; readonly iteration: number; readonly estimatedTokens: number; readonly includedTokensByKind: Readonly<Record<string, number>>; readonly includedTokensBySource: Readonly<Record<string, number>>; readonly compactedCount: number }[];
}

export function buildReport(input: { id: string; title: string; mode: 'scripted' | 'live'; model: Record<string, unknown> | null; state: ConversationState }): ScenarioReport {
  const { state } = input;
  const runSeq = new Map(state.runs.map((r) => [r.run.runId, r.run.sequence]));
  const allSteps = state.runs.flatMap((r) => r.steps.map((s) => ({ ...s, runSequence: r.run.sequence })));
  const responsesByRun = new Map<string, string[]>();
  for (const s of allSteps) {
    if (s.decision?.type !== 'respond') continue;
    responsesByRun.set(s.runId, [...(responsesByRun.get(s.runId) ?? []), s.decision.content]);
  }
  return {
    scenario: { id: input.id, title: input.title },
    mode: input.mode,
    model: input.model,
    taskId: state.task.taskId,
    finalTaskStatus: state.task.status,
    turns: state.turns.map((t) => ({ index: t.index, kind: t.kind, text: t.text, agentResponses: t.runIds.flatMap((id) => responsesByRun.get(id) ?? []), runIds: t.runIds })),
    decisions: allSteps.map((s) => ({
      runSequence: s.runSequence,
      iteration: s.iteration,
      type: s.decision?.type ?? null,
      capabilityId: s.decision && (s.decision.type === 'read_capability' || s.decision.type === 'propose_action') ? s.decision.capabilityId : null,
      outcome: s.outcome,
      errorCode: s.error?.code ?? null,
      inputTokens: s.usage.inputTokens,
      outputTokens: s.usage.outputTokens,
    })),
    capabilities: state.observations.map((o) => ({ capabilityId: o.source.capabilityId, kind: o.source.kind === 'capability' ? 'read' : 'action', outcome: o.outcome, errorCode: o.error?.code ?? null, observedAt: o.observedAt, validUntil: o.validUntil })),
    observations: state.observations.map((o) => ({ observationId: o.observationId, capabilityId: o.source.capabilityId, outcome: o.outcome, payload: o.payload, error: o.error })),
    receipts: state.ledger.receipts.map((r) => ({ capabilityId: r.capabilityId, status: r.status, resourceRef: r.resourceRef, externalOperationRef: r.externalOperationRef, replayed: r.evidence.replayed })),
    goals: state.goals.map((g) => ({ goalId: g.goalId, parentGoalId: g.parentGoalId, description: g.description, status: g.status, origin: g.origin, isRoot: g.goalId === state.task.rootGoalId, isCurrent: g.goalId === state.task.currentGoalId })),
    goalTransitions: state.temporal.events.filter((e) => e.type.startsWith('goal.')).map((e) => ({ type: e.type, goalId: e.entityId, at: e.occurredAt })),
    workspace: { version: state.workspace.version, state: state.workspace.state },
    workspaceTransitions: state.workspaceTransitions.map((t) => ({ version: t.toVersion, outcome: t.outcome, operations: t.operations, changes: t.changes })),
    quoteReferences: state.quoteReferences.map((q) => ({ quoteNumber: q.quoteNumber, basedOnWorkspaceVersion: q.basedOnWorkspaceVersion })),
    runs: state.runs.map((r) => ({ sequence: r.run.sequence, status: r.run.status, termination: r.run.termination, usage: r.run.usage, steps: r.steps.length })),
    tokens: {
      input: allSteps.reduce((sum, s) => sum + s.usage.inputTokens, 0),
      output: allSteps.reduce((sum, s) => sum + s.usage.outputTokens, 0),
      modelCalls: allSteps.length,
    },
    context: state.runs.flatMap((r) => r.contexts.map((c) => ({ runSequence: runSeq.get(r.run.runId) ?? 0, iteration: c.iteration, estimatedTokens: c.estimatedTokens, includedTokensByKind: c.includedTokensByKind, includedTokensBySource: c.includedTokensBySource, compactedCount: c.compactedCount }))),
  };
}
