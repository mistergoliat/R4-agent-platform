import type { ContextContributionInput, JsonValue, Observation } from '@r4/contracts';
import type { ContextSource, ContextSourceRequest } from '../source.js';

/**
 * Built-in sources over the platform's own durable records. They only map the
 * facts the execution layer loaded under its lease: every item is derived
 * from a record id and version, so the same durable state always yields the
 * same items (no wall clock enters their content).
 */
export const PLATFORM_SOURCE_IDS = {
  agent: 'platform.agent',
  task: 'platform.task',
  run: 'platform.run',
  goal: 'platform.goal',
  capability: 'platform.capability',
  observation: 'platform.observation',
  interaction: 'platform.interaction',
} as const;

class MappingSource implements ContextSource {
  readonly id: string;
  readonly #map: (request: ContextSourceRequest) => ContextContributionInput[];

  constructor(id: string, map: (request: ContextSourceRequest) => ContextContributionInput[]) {
    this.id = id;
    this.#map = map;
  }

  load(request: ContextSourceRequest): Promise<readonly ContextContributionInput[]> {
    return Promise.resolve(this.#map(request));
  }
}

/** AgentDefinition essentials: identity and instructions (AUTHORITATIVE: the registry owns them). */
export const agentDefinitionSource: ContextSource = new MappingSource(PLATFORM_SOURCE_IDS.agent, ({ execution: { agent, task } }) => [
  {
    itemId: `agent:${agent.agentId}.v${agent.version}`,
    kind: 'agent_definition',
    authority: 'AUTHORITATIVE',
    temporality: 'live',
    content: { agentId: agent.agentId, version: agent.version, displayName: agent.displayName, instructions: agent.instructions },
    provenance: { recordType: 'agent_definition', recordId: agent.agentId, recordVersion: String(agent.version) },
    // Definitions are immutable per version; the task pinned this one when it was created.
    createdAt: task.createdAt,
  },
]);

/** The task as requested (AUTHORITATIVE: the Task Runtime owns it). */
export const taskSource: ContextSource = new MappingSource(PLATFORM_SOURCE_IDS.task, ({ execution: { task } }) => [
  {
    itemId: `task:${task.taskId}`,
    kind: 'task',
    authority: 'AUTHORITATIVE',
    temporality: 'live',
    content: { taskId: task.taskId, taskType: task.taskType, input: task.input, constraints: task.constraints, deadlineAt: task.deadlineAt },
    provenance: { recordType: 'agent_task', recordId: task.taskId, recordVersion: String(task.version) },
    createdAt: task.createdAt,
    taskId: task.taskId,
  },
]);

/**
 * The run: its current execution constraints (AUTHORITATIVE, platform-owned)
 * and the agent's own recorded `respond` outputs (CONVERSATIONAL: what the
 * agent said, not what is true).
 */
export const runSource: ContextSource = new MappingSource(PLATFORM_SOURCE_IDS.run, ({ scope, execution: { run, agent, constraints, responses } }) => [
  {
    itemId: `execution:${run.runId}`,
    kind: 'execution_constraints',
    authority: 'AUTHORITATIVE',
    temporality: 'live',
    content: { iteration: scope.iteration, remaining: constraints.remaining, runDeadlineAt: constraints.runDeadlineAt },
    provenance: { recordType: 'agent_run', recordId: run.runId, recordVersion: `iteration-${scope.iteration}` },
    createdAt: run.startedAt,
    taskId: run.taskId,
  },
  ...responses.map((response): ContextContributionInput => ({
    itemId: `response:${response.stepId}`,
    kind: 'conversation_turn',
    authority: 'CONVERSATIONAL',
    temporality: 'point_in_time',
    content: { actor: { role: 'agent', ref: agent.agentId }, text: response.content, iteration: response.iteration },
    provenance: { recordType: 'agent_run_step', recordId: response.stepId },
    createdAt: response.recordedAt,
    observedAt: response.recordedAt,
    taskId: run.taskId,
  })),
]);

/**
 * Goals. Requester-set goals are AUTHORITATIVE about what was asked; goals
 * the agent formed itself are COGNITIVE. Neither is business truth.
 *
 * (R4-E) With several goals, each item says whether it is the root and
 * whether it is the current focus. Active goals and the current focus are
 * live `goal` items (required kind); a closed goal that is no longer the
 * focus becomes an OBSERVED `episode` of its closing — history that competes
 * for budget and selection like any other, never a privileged objective.
 */
export const goalSource: ContextSource = new MappingSource(PLATFORM_SOURCE_IDS.goal, ({ execution: { goal: current, goals, task } }) => {
  const all = goals ?? [current];
  const structured = all.length > 1;
  return all.map((goal): ContextContributionInput => {
    const relation = structured ? { parentGoalId: goal.parentGoalId, isRoot: goal.goalId === task.rootGoalId, isCurrent: goal.goalId === task.currentGoalId } : {};
    const provenance = { recordType: 'goal', recordId: goal.goalId, recordVersion: String(goal.version) };
    if (goal.status === 'active' || goal.goalId === task.currentGoalId) {
      return {
        itemId: `goal:${goal.goalId}`,
        kind: 'goal',
        authority: goal.origin === 'requester' ? 'AUTHORITATIVE' : 'COGNITIVE',
        temporality: 'live',
        content: { goalId: goal.goalId, description: goal.description, successCriteria: goal.successCriteria, status: goal.status, origin: goal.origin, ...relation },
        provenance,
        createdAt: goal.createdAt,
        taskId: goal.taskId,
      };
    }
    return {
      itemId: `goal_history:${goal.goalId}`,
      kind: 'episode',
      authority: 'OBSERVED',
      temporality: 'point_in_time',
      content: { event: `goal.${goal.status}`, goalId: goal.goalId, description: goal.description, origin: goal.origin, ...relation },
      provenance,
      createdAt: goal.updatedAt,
      observedAt: goal.updatedAt,
      taskId: goal.taskId,
    };
  });
});

/**
 * (R4-E) Cross-run interaction projection over durable records, so a run
 * that starts after a wait, a consultation or a handoff knows what was said
 * before it — the question the agent asked, not only the answer:
 *
 *   - the agent's `respond` outputs of earlier runs (this run's come from `platform.run`)
 *   - questions to a human (consultation) and handoff summaries the agent wrote
 *   - every human decision with the human's own text (answer, approval note,
 *     takeover/release note) — CONVERSATIONAL with human provenance, never truth
 *   - the waits between runs and how each ended, with the agent's stated reason
 *   - goal changes the platform refused, so the agent can recover
 *
 * Conversation turns compete for the conversation budget (and compaction)
 * like any other turn; episodes like any other episode. No transcript is
 * ever forced into the context.
 */
export const interactionSource: ContextSource = new MappingSource(PLATFORM_SOURCE_IDS.interaction, ({ execution: { interactions, run, agent, task } }) => {
  if (!interactions) return [];
  const items: ContextContributionInput[] = [];
  const humans = new Map(interactions.humans.map((h) => [h.requestId, h]));
  const waitReason = new Map<string, string>();
  for (const step of interactions.steps) {
    const decision = step.decision;
    if (!decision) continue;
    if (decision.type === 'wait' && decision.reason !== undefined) waitReason.set(step.runId, decision.reason);
    if (decision.type === 'respond' && step.runId !== run.runId) {
      items.push({
        itemId: `response:${step.stepId}`,
        kind: 'conversation_turn',
        authority: 'CONVERSATIONAL',
        temporality: 'point_in_time',
        content: { actor: { role: 'agent', ref: agent.agentId }, text: decision.content, iteration: step.iteration, earlierRun: true },
        provenance: { recordType: 'agent_run_step', recordId: step.stepId },
        createdAt: step.createdAt,
        observedAt: step.createdAt,
        taskId: task.taskId,
      });
    }
    if (decision.type === 'manage_goal' && step.outcome === 'refused' && step.error) {
      items.push({
        itemId: `goal_rejection:${step.stepId}`,
        kind: 'episode',
        authority: 'OBSERVED',
        temporality: 'point_in_time',
        content: { event: 'goal.change.rejected', change: decision.change, code: step.error.code, text: step.error.message },
        provenance: { recordType: 'agent_run_step', recordId: step.stepId },
        createdAt: step.createdAt,
        observedAt: step.createdAt,
        taskId: task.taskId,
      });
    }
  }
  for (const h of interactions.humans) {
    const said = h.kind === 'consultation' ? { text: h.payload.question, refs: h.payload.contextRefs } : h.kind === 'handoff' && h.payload.initiatedBy === 'agent' ? { text: h.payload.summary, refs: h.payload.contextRefs } : null;
    if (said === null) continue;
    items.push({
      itemId: `human_request:${h.requestId}`,
      kind: 'conversation_turn',
      authority: 'CONVERSATIONAL',
      temporality: 'point_in_time',
      content: { actor: { role: 'agent', ref: agent.agentId }, text: said.text, interaction: { kind: h.kind, requestId: h.requestId, status: h.status, contextRefs: said.refs } },
      provenance: { recordType: 'human_request', recordId: h.requestId },
      createdAt: h.createdAt,
      observedAt: h.createdAt,
      taskId: task.taskId,
    });
  }
  for (const e of interactions.responses) {
    if (typeof e.data.content !== 'string') continue;
    const requestId = typeof e.data.requestId === 'string' ? e.data.requestId : e.entityId;
    const request = humans.get(requestId);
    items.push({
      itemId: `human_response:${e.eventId}`,
      kind: 'conversation_turn',
      authority: 'CONVERSATIONAL',
      temporality: 'point_in_time',
      content: {
        actor: { role: 'operator', ref: e.actorRef },
        text: e.data.content,
        interaction: { kind: request?.kind ?? 'handoff', requestId, outcome: typeof e.data.outcome === 'string' ? e.data.outcome : null, ...(request?.kind === 'approval' ? { proposalId: request.payload.proposalId } : {}) },
      },
      provenance: { recordType: 'temporal_event', recordId: e.eventId, producedBy: `user:${e.actorRef}` },
      createdAt: e.occurredAt,
      observedAt: e.occurredAt,
      taskId: task.taskId,
    });
  }
  for (const w of interactions.waits) {
    if (w.status === 'waiting') continue;
    const reason = w.runId === null ? undefined : waitReason.get(w.runId);
    items.push({
      itemId: `wait:${w.waitId}`,
      kind: 'episode',
      authority: 'OBSERVED',
      temporality: 'point_in_time',
      content: { event: 'task.wait', kind: w.kind, status: w.status, resolution: w.resolution, startedAt: w.createdAt, endedAt: w.completedAt, dueAt: w.dueAt, ...(reason === undefined ? {} : { statedReason: reason }) },
      provenance: { recordType: 'task_wait', recordId: w.waitId },
      createdAt: w.completedAt ?? w.createdAt,
      observedAt: w.completedAt ?? w.createdAt,
      taskId: task.taskId,
    });
  }
  return items;
});

/**
 * Capabilities visible to the model. Visible ≠ executable: whether a decided
 * READ may run is still checked by the kernel and the capability invoker.
 */
export const capabilitySource: ContextSource = new MappingSource(PLATFORM_SOURCE_IDS.capability, ({ execution: { capabilities, task } }) =>
  capabilities.map((capability): ContextContributionInput => ({
    itemId: `capability:${capability.capabilityId}.v${capability.version}`,
    kind: 'capability',
    authority: 'AUTHORITATIVE',
    temporality: 'live',
    content: {
      capabilityId: capability.capabilityId,
      version: capability.version,
      description: capability.description,
      inputSchema: capability.inputSchema as JsonValue,
      ...(capability.riskClass === undefined ? {} : { riskClass: capability.riskClass }),
    },
    provenance: { recordType: 'capability_definition', recordId: capability.capabilityId, recordVersion: String(capability.version) },
    createdAt: task.createdAt,
  })),
);

/**
 * The task's observations (OBSERVED evidence, as of `observedAt`, valid until
 * `validUntil`). The newest observation of the current run is required: it
 * answers the READ the agent just asked for.
 */
export const observationSource: ContextSource = new MappingSource(PLATFORM_SOURCE_IDS.observation, ({ execution: { observations, run } }) => {
  const latest = latestOf(observations.filter((o) => o.runId === run.runId));
  return observations.map((o): ContextContributionInput => ({
    itemId: `observation:${o.observationId}`,
    kind: 'observation',
    authority: 'OBSERVED',
    temporality: 'point_in_time',
    content: {
      observationId: o.observationId,
      capabilityId: o.source.capabilityId,
      capabilityVersion: o.source.capabilityVersion,
      outcome: o.outcome,
      payload: o.payload,
      error: o.error,
      // R4-D: an action outcome says which proposal it answers and whether a receipt backs it.
      ...(o.source.kind === 'action'
        ? { action: { proposalId: o.source.proposalId, receiptId: o.source.receiptId, ...(o.source.approvalRequestId ? { approvalRequestId: o.source.approvalRequestId } : {}) } }
        : {}),
    },
    provenance: {
      recordType: 'observation',
      recordId: o.observationId,
      producedBy: `${o.source.capabilityId}@${o.source.capabilityVersion ?? '?'}`,
    },
    createdAt: o.observedAt,
    observedAt: o.observedAt,
    validUntil: o.validUntil,
    taskId: o.taskId,
    required: o === latest,
  }));
});

function latestOf(observations: readonly Observation[]): Observation | undefined {
  let latest: Observation | undefined;
  for (const o of observations) {
    if (!latest || o.observedAt > latest.observedAt || (o.observedAt === latest.observedAt && o.observationId > latest.observationId)) latest = o;
  }
  return latest;
}

/** Every built-in platform source, in registration order. */
export function platformContextSources(): ContextSource[] {
  return [agentDefinitionSource, taskSource, runSource, goalSource, capabilitySource, observationSource, interactionSource];
}
