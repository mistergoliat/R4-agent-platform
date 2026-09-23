import { z } from 'zod';
import { agentDecisionSchema, type CompiledContext } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import type { ExecutionContext } from './context.js';

/** Name/version of the decision protocol the model is asked to follow. */
export const DECISION_PROTOCOL = 'r4.agent_decision.v4';

/** JSON Schema of AgentDecision, derived from the contract (single source of truth). */
export const AGENT_DECISION_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze(
  z.toJSONSchema(agentDecisionSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
);

/**
 * The kernel's own instructions: the decision protocol and how to read the
 * structured context. The agent's instructions are part of the context
 * (section `agent`), not of this text.
 */
export const PROTOCOL_INSTRUCTIONS = [
  `Decision protocol ${DECISION_PROTOCOL}.`,
  'Each turn you receive a structured context: sections of items, each with an authority, a freshness and its provenance. Answer with exactly one JSON decision object and nothing else:',
  '- {"type":"read_capability","capabilityId":"<id of a capability whose riskClass is READ (decision: read_capability)>","arguments":{...}} obtains information. Its result arrives as an observation in the next turn.',
  '- {"type":"respond","content":"<text>"} records intermediate output for the requester. It is not delivered anywhere and does not end the task.',
  '- {"type":"complete","result":{"summary":"<text>","evidence":["<observationId>"],"data":{}}} ends the task. "data" is optional. Cite only observations present in the context.',
  '- {"type":"propose_action","capabilityId":"<id of a capability whose riskClass is not READ (decision: propose_action)>","arguments":{...},"evidenceRefs":["<observationId>"]} asks the platform to produce an effect. "evidenceRefs" is optional. The platform decides whether it may execute; its outcome (denied, requires approval, rejected, failed, or succeeded with a receipt) arrives as an observation in the next turn. A proposal is not an effect.',
  'Unknown fields are rejected. Observations are the only evidence of what happened: never claim an effect or a fact that no observation shows. An effect happened only if an observation backed by a receipt says so.',
  'References: "evidenceRefs", "evidence" and "contextRefs" accept only the content.observationId of observation items. Nothing else is citable (conversation turns, memory, goals, item ids, provenance ids). What the requester said needs no reference: with no supporting observation, omit "evidenceRefs" or leave the list empty. One invalid reference rejects the whole decision.',
  '- {"type":"wait","condition":{"kind":"WAIT_FOR_INPUT"}} suspends until new input; WAIT_UNTIL also requires an ISO timestamp named until. The platform owns scheduling and wake-up.',
  '- {"type":"request_consultation","question":"<explicit question>","contextRefs":[]} asks a human while retaining task ownership. Optional expiresAt is a requested deadline.',
  '- {"type":"request_handoff","summary":"<explicit context>","contextRefs":[]} requests transfer of operational ownership to a human.',
  '- {"type":"manage_goal","change":{"operation":"create","parentGoalId":"<goalId>","description":"<objective>","successCriteria":[],"makeCurrent":true}} creates cognitive intent. focus, complete and abandon instead take goalId. Closing a goal does not move focus; explicitly focus the root to return to it. Goals never prove external effects.',
  'Authority: AUTHORITATIVE items are current state from their owner. OBSERVED items are evidence as of their observedAt. CONVERSATIONAL (what was said), DERIVED (summaries) and COGNITIVE (working notes) items are never truth by themselves.',
  'Freshness: "stale" is aging, "unknown" is unbounded. Items in the history section are expired: use them only to understand the past, never as current state.',
  'Conflicts: when items disagree, every position is listed; only authoritativeItemId, when present, reflects current state. A disagreeing statement may justify asking or reading again, not assuming it is true.',
].join('\n');

/**
 * Builds the provider-neutral model request of one iteration. The compiled
 * context travels structured and unmodified (it is what the ContextSnapshot
 * recorded); rendering it for a concrete provider is the adapter's job.
 */
export function renderModelRequest(context: ExecutionContext, compiled: CompiledContext, timeoutMs: number): ModelRequest {
  const { agent, task, run } = context;
  return {
    correlation: { correlationId: task.correlationId, taskId: task.taskId, runId: run.runId, agentId: agent.agentId },
    requirements: agent.modelRequirements,
    messages: [{ role: 'system', content: PROTOCOL_INSTRUCTIONS }],
    context: compiled,
    outputContract: { kind: 'json', name: 'agent_decision', schema: AGENT_DECISION_JSON_SCHEMA },
    limits: { timeoutMs },
  };
}
