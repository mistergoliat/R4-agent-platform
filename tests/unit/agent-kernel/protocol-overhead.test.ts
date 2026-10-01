import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { consultationDecisionSchema, handoffDecisionSchema, manageGoalDecisionSchema, waitDecisionSchema } from '@r4/contracts';
import { AGENT_DECISION_JSON_SCHEMA, DECISION_PROTOCOL, PROTOCOL_INSTRUCTIONS } from '@r4/agent-kernel';

/**
 * Decision-protocol overhead accounting (R4-E). Every model call carries the
 * protocol instructions (system message) and the decision JSON Schema (output
 * contract). R4-E grew both; this pins the measured size so any further growth
 * is a deliberate, visible change — and so budget tests are written against
 * the property they verify, not against an accidental ceiling order.
 *
 * Measured at r4.agent_decision.v3: instructions 2 778 chars (824 for the four
 * E decisions), schema 6 216 chars (≈4 140 for the E decision shapes alone).
 * r4.agent_decision.v4 (R4-F live validation) adds one line saying which
 * references are citable and names the riskClass/decision fields that
 * separate READ from proposed capabilities (+436 chars: 3 214); the schema
 * is unchanged. r4.agent_decision.v5 (R4-J1E-R2.2) rewrites only the respond
 * line — sent to the requester, ends the turn, work before it, no wait after
 * it (+149 chars: 3 363); the schema is unchanged (6 216).
 */
describe('decision protocol overhead', () => {
  const instructions = PROTOCOL_INSTRUCTIONS;
  const schema = JSON.stringify(AGENT_DECISION_JSON_SCHEMA);

  it('is protocol v5', () => {
    expect(DECISION_PROTOCOL).toBe('r4.agent_decision.v5');
    expect(instructions).toContain('Decision protocol r4.agent_decision.v5.');
  });

  it('stays within its accounted size', () => {
    expect(instructions.length).toBeLessThanOrEqual(3_400);
    expect(schema.length).toBeLessThanOrEqual(6_400);
    expect(instructions.length + schema.length).toBeLessThanOrEqual(9_650);
  });

  it('attributes the R4-E share explicitly', () => {
    const eLines = instructions.split('\n').filter((line) => /"type":"(wait|request_consultation|request_handoff|manage_goal)"/.test(line));
    expect(eLines).toHaveLength(4);
    expect(eLines.join('\n').length).toBeLessThanOrEqual(900);
    const eSchema = JSON.stringify(z.toJSONSchema(z.union([waitDecisionSchema, consultationDecisionSchema, handoffDecisionSchema, manageGoalDecisionSchema])));
    expect(eSchema.length).toBeLessThanOrEqual(4_300);
  });
});
