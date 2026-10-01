import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@r4/contracts';
import { PROTOCOL_INSTRUCTIONS, parseAgentDecision, type DecisionValidationContext } from '@r4/agent-kernel';
import type { ModelResponse } from '@r4/model-gateway';
import { READ_FACT, WRITE_THING } from '../../support/kernel-fixtures.js';

const observationId = uuidv7();
const context: DecisionValidationContext = { capabilities: [READ_FACT, WRITE_THING], observationIds: new Set([observationId]) };

function response(partial: Partial<ModelResponse>): ModelResponse {
  return {
    content: null,
    toolCalls: [],
    structuredData: undefined,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'stop',
    latencyMs: 1,
    provider: { providerId: 'fake', modelId: 'fake-1', requestId: null },
    ...partial,
  };
}

const errorCode = (r: ReturnType<typeof parseAgentDecision>) => (r.ok ? null : r.error.code);

describe('decision parser: ModelResult → parse → schema → semantics', () => {
  it('accepts a valid READ of an offered READ capability', () => {
    const result = parseAgentDecision(response({ structuredData: { type: 'read_capability', capabilityId: READ_FACT.capabilityId, arguments: { factKey: 'alpha' } } }), context);
    expect(result).toEqual({ ok: true, decision: { type: 'read_capability', capabilityId: READ_FACT.capabilityId, arguments: { factKey: 'alpha' } } });
  });

  it('accepts a JSON document delivered as text content', () => {
    const result = parseAgentDecision(response({ content: ' {"type":"respond","content":"hi"} ' }), context);
    expect(result).toEqual({ ok: true, decision: { type: 'respond', content: 'hi' } });
  });

  it('accepts complete citing a known observation', () => {
    const result = parseAgentDecision(response({ structuredData: { type: 'complete', result: { summary: 'ok', evidence: [observationId] } } }), context);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['text that is not JSON', response({ content: 'I will now read the fact.' }), 'invalid_structured_output'],
    ['no output at all', response({}), 'invalid_structured_output'],
    ['native tool calls instead of a decision', response({ toolCalls: [{ id: '1', name: READ_FACT.capabilityId, arguments: {} }] }), 'invalid_structured_output'],
    ['a JSON array', response({ structuredData: [1, 2] }), 'invalid_decision_schema'],
    ['a JSON string', response({ structuredData: 'complete' }), 'invalid_decision_schema'],
    ['missing type', response({ structuredData: { capabilityId: READ_FACT.capabilityId, arguments: {} } }), 'unknown_decision_type'],
    ['unknown type', response({ structuredData: { type: 'delegate', action: 'x' } }), 'unknown_decision_type'],
    ['partially valid (extra key)', response({ structuredData: { type: 'respond', content: 'x', thoughts: 'hidden reasoning' } }), 'invalid_decision_schema'],
    ['invalid arguments shape', response({ structuredData: { type: 'read_capability', capabilityId: READ_FACT.capabilityId, arguments: null } }), 'invalid_decision_schema'],
    ['unknown capability', response({ structuredData: { type: 'read_capability', capabilityId: 'platform_test.nope', arguments: {} } }), 'unknown_capability'],
    ['write-class capability', response({ structuredData: { type: 'read_capability', capabilityId: WRITE_THING.capabilityId, arguments: {} } }), 'capability_not_permitted'],
    ['evidence the task never observed', response({ structuredData: { type: 'complete', result: { summary: 'ok', evidence: [uuidv7()] } } }), 'unknown_evidence'],
  ])('rejects %s with a classified error', (_name, res, code) => {
    expect(errorCode(parseAgentDecision(res, context))).toBe(code);
  });

  it('prefers structured data over text content', () => {
    const result = parseAgentDecision(response({ content: 'not json', structuredData: { type: 'respond', content: 'structured' } }), context);
    expect(result).toEqual({ ok: true, decision: { type: 'respond', content: 'structured' } });
  });

  it('never echoes model-provided values in schema errors', () => {
    const secret = 'SECRET-REASONING-TEXT';
    const result = parseAgentDecision(response({ structuredData: { type: 'respond', content: 42, note: secret } }), context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(secret);
  });

  it('rejects every non-READ risk class', () => {
    for (const riskClass of ['REVERSIBLE_WRITE', 'IRREVERSIBLE_WRITE', 'FINANCIAL', 'EXTERNAL_COMMUNICATION', 'PRIVILEGED'] as const) {
      const ctx: DecisionValidationContext = { capabilities: [{ ...WRITE_THING, riskClass }], observationIds: new Set() };
      const result = parseAgentDecision(response({ structuredData: { type: 'read_capability', capabilityId: WRITE_THING.capabilityId, arguments: {} } }), ctx);
      expect(errorCode(result), riskClass).toBe('capability_not_permitted');
    }
  });
});

/**
 * R4-F live validation (S02, DeepSeek): the model proposed a Sales workspace
 * update recording a customer-stated fact and cited, as evidence, the record
 * id of the customer's own conversation turn (`memory:<entryId>`) — an id
 * it could see in the context, but not an observation. The platform was
 * right to reject it; the protocol did not say what is citable. The fix is
 * in the protocol text (since r4.agent_decision.v4), never in the validator.
 */
describe('evidence references (live regression: conversation turn cited as evidence)', () => {
  const conversationTurnRecordId = uuidv7();
  const propose = (evidenceRefs?: unknown) =>
    response({ structuredData: { type: 'propose_action', capabilityId: WRITE_THING.capabilityId, arguments: { note: 'budget stated by the requester' }, ...(evidenceRefs === undefined ? {} : { evidenceRefs }) } });

  it('still rejects a conversation turn id, and an observation item id, as evidence', () => {
    expect(errorCode(parseAgentDecision(propose([conversationTurnRecordId]), context))).toBe('unknown_evidence');
    // No prefix stripping or similarity mapping: only the observationId itself is evidence (the schema already refuses a non-UUID).
    expect(errorCode(parseAgentDecision(propose([`observation:${observationId}`]), context))).toBe('invalid_decision_schema');
    expect(errorCode(parseAgentDecision(propose([observationId, conversationTurnRecordId]), context))).toBe('unknown_evidence');
  });

  it('accepts a proposal that cites nothing, or only observation ids', () => {
    expect(parseAgentDecision(propose(), context).ok).toBe(true);
    expect(parseAgentDecision(propose([]), context).ok).toBe(true);
    expect(parseAgentDecision(propose([observationId]), context).ok).toBe(true);
  });

  it('is explained by the protocol: only observation ids are citable, requester statements need no reference', () => {
    const line = PROTOCOL_INSTRUCTIONS.split('\n').find((l) => l.startsWith('References:'));
    expect(line).toBeDefined();
    expect(line).toContain('content.observationId');
    expect(line).toMatch(/conversation turns/);
    expect(line).toMatch(/What the requester said needs no reference/);
    expect(line).toMatch(/omit "evidenceRefs"/);
  });
});

/**
 * R4-F live validation (S03, DeepSeek): the model sent a Sales workspace
 * update as `read_capability`. The capability item showed its riskClass,
 * but the protocol only said "a READ id" without naming the field. The
 * platform keeps refusing it; v4 names the field in both decision lines and
 * each capability item states its decision type (context-compiler test).
 */
describe('decision type vs risk class (live regression: write sent as read_capability)', () => {
  it('still refuses a write capability invoked as a READ', () => {
    const decision = { type: 'read_capability', capabilityId: WRITE_THING.capabilityId, arguments: { operations: [{ op: 'record_fact', key: 'presupuesto_clp', value: 800000, statedBy: 'customer' }] } };
    expect(errorCode(parseAgentDecision(response({ structuredData: decision }), context))).toBe('capability_not_permitted');
  });

  it('is explained by the protocol through the riskClass field shown on each capability', () => {
    const lines = PROTOCOL_INSTRUCTIONS.split('\n');
    expect(lines.find((l) => l.includes('"type":"read_capability"'))).toContain('whose riskClass is READ (decision: read_capability)');
    expect(lines.find((l) => l.includes('"type":"propose_action"'))).toContain('whose riskClass is not READ (decision: propose_action)');
  });
});
