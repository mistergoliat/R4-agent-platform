import { z } from 'zod';
import { agentDecisionSchema } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import { readableCapabilities, type ExecutionContext } from './context.js';

/** Name/version of the decision protocol the model is asked to follow. */
export const DECISION_PROTOCOL = 'r4.agent_decision.v1';

/** JSON Schema of AgentDecision, derived from the contract (single source of truth). */
export const AGENT_DECISION_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze(
  z.toJSONSchema(agentDecisionSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
);

const PROTOCOL_INSTRUCTIONS = [
  `Decision protocol ${DECISION_PROTOCOL}.`,
  'Each turn you receive the execution context as a JSON document. Answer with exactly one JSON decision object and nothing else:',
  '- {"type":"read_capability","capabilityId":"<an id from capabilities>","arguments":{...}} obtains information. Its result arrives as an observation in the next turn.',
  '- {"type":"respond","content":"<text>"} records intermediate output for the requester. It is not delivered anywhere and does not end the task.',
  '- {"type":"complete","result":{"summary":"<text>","evidence":["<observationId>"],"data":{}}} ends the task. "data" is optional. Cite only observations present in the context.',
  'Unknown fields are rejected. Observations are the only evidence of what happened: never claim an effect or a fact that no observation shows.',
].join('\n');

/**
 * Renders the minimal execution context into a provider-neutral model
 * request. Deterministic; carries no transcript and no memory (R4-C2 will
 * replace this with the Context Compiler's output).
 */
export function renderModelRequest(context: ExecutionContext, timeoutMs: number): ModelRequest {
  const { agent, task, run, goal, budget } = context;
  const document = {
    protocol: DECISION_PROTOCOL,
    iteration: context.iteration,
    task: { taskId: task.taskId, taskType: task.taskType, input: task.input, constraints: task.constraints },
    goal: { description: goal.description, successCriteria: goal.successCriteria },
    capabilities: readableCapabilities(context).map((c) => ({
      capabilityId: c.capabilityId,
      version: c.version,
      description: c.description,
      inputSchema: c.inputSchema,
    })),
    observations: context.observations.map((o) => ({
      observationId: o.observationId,
      capabilityId: o.source.capabilityId,
      outcome: o.outcome,
      payload: o.payload,
      error: o.error,
      observedAt: o.observedAt,
      validUntil: o.validUntil,
    })),
    responses: context.responses,
    budget: {
      remaining: {
        iterations: budget.limits.maxIterations - budget.usage.iterations,
        modelCalls: budget.limits.maxModelCalls - budget.usage.modelCalls,
        readCapabilityCalls: budget.limits.maxReadCapabilityCalls - budget.usage.readCapabilityCalls,
        runDurationMs: budget.limits.maxRunDurationMs - budget.usage.elapsedMs,
        tokens: budget.limits.maxTokens === null ? null : budget.limits.maxTokens - budget.usage.tokens,
      },
    },
  };
  return {
    correlation: { correlationId: task.correlationId, taskId: task.taskId, runId: run.runId, agentId: agent.agentId },
    requirements: agent.modelRequirements,
    messages: [
      { role: 'system', content: `${agent.instructions}\n\n${PROTOCOL_INSTRUCTIONS}` },
      { role: 'user', content: JSON.stringify(document) },
    ],
    outputContract: { kind: 'json', name: 'agent_decision', schema: AGENT_DECISION_JSON_SCHEMA },
    limits: { timeoutMs },
  };
}
