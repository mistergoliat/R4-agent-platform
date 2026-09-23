import { z } from 'zod';
import {
  AGENT_DECISION_TYPES,
  agentDecisionSchema,
  type AgentDecision,
  type DecisionErrorCode,
} from '@r4/contracts';
import type { ModelResponse } from '@r4/model-gateway';
import type { CapabilityDescriptor } from './context.js';

export interface DecisionError {
  readonly code: DecisionErrorCode;
  readonly message: string;
}

export type DecisionParseResult =
  | { readonly ok: true; readonly decision: AgentDecision }
  | { readonly ok: false; readonly error: DecisionError };

/** What semantic validation checks the decision against — platform facts, not model claims. */
export interface DecisionValidationContext {
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly observationIds: ReadonlySet<string>;
}

/**
 * Model output → AgentDecision. The model is untrusted, so every stage can
 * reject, each with its own classified code, and nothing partially valid is
 * ever accepted:
 *
 *   ModelResponse → parse (JSON) → schema (strict) → semantics (platform facts)
 *
 * C1 accepts decisions as structured output only; native tool calls are not a
 * decision transport here (Constitution §27.11 stays open).
 *
 * The strict schemas are also what keeps trusted fields out of the model's
 * reach (R4-D): a decision carrying an execution key, a policy decision, a
 * risk class, a permission, an identity, a receipt or a status is rejected
 * as `invalid_decision_schema`, never silently stripped.
 */
export function parseAgentDecision(response: ModelResponse, context: DecisionValidationContext): DecisionParseResult {
  const raw = extractJson(response);
  if (!raw.ok) return raw;
  const document = raw.value;

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return fail('invalid_decision_schema', 'a decision must be a JSON object');
  }
  const type = (document as { type?: unknown }).type;
  if (typeof type !== 'string' || !(AGENT_DECISION_TYPES as readonly string[]).includes(type)) {
    return fail('unknown_decision_type', `"type" must be one of ${AGENT_DECISION_TYPES.join(', ')}`);
  }

  const parsed = agentDecisionSchema.safeParse(document);
  if (!parsed.success) {
    // Paths and messages only: never echo model-provided values.
    return fail('invalid_decision_schema', z.prettifyError(parsed.error));
  }
  const decision = parsed.data;

  switch (decision.type) {
    case 'read_capability': {
      const capability = context.capabilities.find((c) => c.capabilityId === decision.capabilityId);
      if (!capability) {
        return fail('unknown_capability', 'the requested capability is not available to this run');
      }
      if (capability.riskClass !== 'READ') {
        return fail('capability_not_permitted', `${capability.capabilityId} is ${capability.riskClass}; only READ capabilities are invoked (writes are proposed)`);
      }
      return { ok: true, decision };
    }
    case 'propose_action': {
      // Structure only: whether the action may execute is the Policy Engine's decision, not the kernel's.
      const capability = context.capabilities.find((c) => c.capabilityId === decision.capabilityId);
      if (!capability) {
        return fail('unknown_capability', 'the proposed capability is not available to this run');
      }
      if (capability.riskClass === 'READ') {
        return fail('capability_not_permitted', `${capability.capabilityId} is READ; reads are invoked with read_capability, not proposed`);
      }
      const unknown = (decision.evidenceRefs ?? []).filter((id) => !context.observationIds.has(id));
      if (unknown.length > 0) {
        return fail('unknown_evidence', `evidenceRefs must reference observations of this task (${unknown.length} unknown)`);
      }
      return { ok: true, decision };
    }
    case 'complete': {
      const unknown = decision.result.evidence.filter((id) => !context.observationIds.has(id));
      if (unknown.length > 0) {
        return fail('unknown_evidence', `evidence must reference observations of this task (${unknown.length} unknown)`);
      }
      return { ok: true, decision };
    }
    case 'respond':
      return { ok: true, decision };
  }
}

function extractJson(response: ModelResponse): { ok: true; value: unknown } | { ok: false; error: DecisionError } {
  if (response.structuredData !== undefined) return { ok: true, value: response.structuredData };
  if (typeof response.content === 'string' && response.content.trim().length > 0) {
    try {
      return { ok: true, value: JSON.parse(response.content) as unknown };
    } catch {
      return fail('invalid_structured_output', 'model output is not a JSON document');
    }
  }
  if (response.toolCalls.length > 0) {
    return fail('invalid_structured_output', 'native tool calls are not an accepted decision transport; a JSON decision is required');
  }
  return fail('invalid_structured_output', 'model returned no output');
}

function fail(code: DecisionErrorCode, message: string): { ok: false; error: DecisionError } {
  return { ok: false, error: { code, message } };
}
