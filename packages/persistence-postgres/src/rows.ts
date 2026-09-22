import type {
  AgentRun,
  AgentTask,
  Goal,
  JsonObject,
  JsonValue,
  Observation,
  Principal,
  RegisteredAgentDefinition,
  TaskStatus,
  TaskTransition,
} from '@r4/contracts';

/**
 * Row ↔ contract mapping. Rows come from our own database (trusted), so
 * mapping is structural; validation happened before the write.
 */

export type Row = Record<string, unknown>;

export function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function taskFromRow(row: Row): AgentTask {
  return {
    taskId: row.task_id as string,
    taskType: row.task_type as string,
    agentId: row.agent_id as string,
    agentVersion: row.agent_version as number,
    status: row.status as TaskStatus,
    statusReason: (row.status_reason as string | null) ?? null,
    parentTaskId: (row.parent_task_id as string | null) ?? null,
    rootGoalId: row.root_goal_id as string,
    currentGoalId: row.current_goal_id as string,
    requestedBy: { kind: row.requested_by_kind as Principal['kind'], ref: row.requested_by_ref as string },
    input: row.input as JsonObject,
    constraints: row.constraints as JsonObject,
    budget: row.budget as AgentTask['budget'],
    result: (row.result as JsonObject | null) ?? null,
    deadlineAt: isoOrNull(row.deadline_at),
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    correlationId: row.correlation_id as string,
    version: row.version as number,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function goalFromRow(row: Row): Goal {
  return {
    goalId: row.goal_id as string,
    taskId: row.task_id as string,
    parentGoalId: (row.parent_goal_id as string | null) ?? null,
    description: row.description as string,
    successCriteria: row.success_criteria as string[],
    status: row.status as Goal['status'],
    origin: row.origin as Goal['origin'],
    correlationId: row.correlation_id as string,
    version: row.version as number,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function runFromRow(row: Row): AgentRun {
  const failureCode = (row.failure_code as string | null) ?? null;
  return {
    runId: row.run_id as string,
    taskId: row.task_id as string,
    sequence: row.sequence as number,
    agentId: row.agent_id as string,
    agentVersion: row.agent_version as number,
    status: row.status as AgentRun['status'],
    contextSnapshotRef: (row.context_snapshot_ref as string | null) ?? null,
    usage: {
      modelCalls: row.model_calls as number,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      capabilityCalls: row.capability_calls as number,
    },
    result: (row.result as JsonObject | null) ?? null,
    failure: failureCode === null ? null : { code: failureCode, message: (row.failure_message as string | null) ?? '' },
    correlationId: row.correlation_id as string,
    version: row.version as number,
    startedAt: iso(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function transitionFromRow(row: Row): TaskTransition {
  return {
    transitionId: row.transition_id as string,
    taskId: row.task_id as string,
    fromStatus: (row.from_status as TaskStatus | null) ?? null,
    toStatus: row.to_status as TaskStatus,
    reason: (row.reason as string | null) ?? null,
    actor: { kind: row.actor_kind as Principal['kind'], ref: row.actor_ref as string },
    taskVersion: row.task_version as number,
    correlationId: row.correlation_id as string,
    occurredAt: iso(row.occurred_at),
  };
}

export function agentDefinitionFromRow(row: Row): RegisteredAgentDefinition {
  return {
    schemaVersion: row.schema_version as 1,
    agentId: row.agent_id as string,
    version: row.version as number,
    displayName: row.display_name as string,
    description: row.description as string,
    instructions: row.instructions as string,
    taskTypes: row.task_types as string[],
    capabilityScopes: row.capability_scopes as string[],
    skills: row.skills as string[],
    modelRequirements: row.model_requirements as RegisteredAgentDefinition['modelRequirements'],
    contextPolicy: row.context_policy as RegisteredAgentDefinition['contextPolicy'],
    budgets: row.budgets as RegisteredAgentDefinition['budgets'],
    delegationPolicy: row.delegation_policy as RegisteredAgentDefinition['delegationPolicy'],
    evaluationProfile: (row.evaluation_profile as RegisteredAgentDefinition['evaluationProfile']) ?? null,
    contentHash: row.content_hash as string,
    registeredAt: iso(row.registered_at),
  };
}

export function observationFromRow(row: Row): Observation {
  const errorCode = (row.error_code as string | null) ?? null;
  return {
    observationId: row.observation_id as string,
    taskId: row.task_id as string,
    runId: (row.run_id as string | null) ?? null,
    agentId: row.agent_id as string,
    source: {
      kind: 'capability',
      capabilityId: row.capability_id as string,
      capabilityVersion: (row.capability_version as number | null) ?? null,
      invocationId: row.invocation_id as string,
    },
    outcome: row.outcome as Observation['outcome'],
    payload: (row.payload as JsonValue | null) ?? null,
    error:
      errorCode === null
        ? null
        : {
            code: errorCode as NonNullable<Observation['error']>['code'],
            message: (row.error_message as string | null) ?? '',
            details: (row.error_details as JsonValue | null) ?? null,
          },
    observedAt: iso(row.observed_at),
    validUntil: isoOrNull(row.valid_until),
    provenance: row.provenance as JsonObject,
    correlationId: row.correlation_id as string,
  };
}

/** JSONB parameters are always passed pre-serialized (pg would turn arrays into SQL arrays). */
export function jsonb(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
