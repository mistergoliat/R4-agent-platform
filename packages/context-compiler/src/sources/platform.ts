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
 * The current goal. Requester-set goals are AUTHORITATIVE about what was
 * asked; goals the agent formed itself are COGNITIVE. Neither is business truth.
 */
export const goalSource: ContextSource = new MappingSource(PLATFORM_SOURCE_IDS.goal, ({ execution: { goal } }) => [
  {
    itemId: `goal:${goal.goalId}`,
    kind: 'goal',
    authority: goal.origin === 'requester' ? 'AUTHORITATIVE' : 'COGNITIVE',
    temporality: 'live',
    content: { goalId: goal.goalId, description: goal.description, successCriteria: goal.successCriteria, status: goal.status, origin: goal.origin },
    provenance: { recordType: 'goal', recordId: goal.goalId, recordVersion: String(goal.version) },
    createdAt: goal.createdAt,
    taskId: goal.taskId,
  },
]);

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
    content: { capabilityId: capability.capabilityId, version: capability.version, description: capability.description, inputSchema: capability.inputSchema as JsonValue },
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
  return [agentDefinitionSource, taskSource, runSource, goalSource, capabilitySource, observationSource];
}
