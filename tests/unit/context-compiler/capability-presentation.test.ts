import { describe, expect, it } from 'vitest';
import { capabilitySource, type VisibleCapability } from '@r4/context-compiler';
import { request } from '../../fixtures/context/builders.js';

/**
 * R4-F live validation (S03, DeepSeek with reasoning disabled): the model
 * sent a Sales workspace write as `read_capability` in every attempt. The
 * risk class was in the capability item, but last, after a long input
 * schema. The capability item now states, before what it takes, its risk
 * class and the one decision type the kernel accepts for it. Presentation
 * only: the kernel still enforces the rule on its own facts.
 */
describe('capability items state how they are used before what they take', () => {
  const bigSchema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, { type: 'string' }])) };
  const capabilities: VisibleCapability[] = [
    { capabilityId: 'platform_test.read', version: 1, description: 'reads', inputSchema: { type: 'object' }, riskClass: 'READ' },
    { capabilityId: 'platform_test.write', version: 2, description: 'writes', inputSchema: bigSchema, riskClass: 'REVERSIBLE_WRITE' },
    { capabilityId: 'platform_test.pay', version: 1, description: 'pays', inputSchema: { type: 'object' }, riskClass: 'FINANCIAL' },
  ];

  it('derives the decision type from the risk class and places both right after the id', async () => {
    const base = request();
    const items = await capabilitySource.load({ ...base, execution: { ...base.execution, capabilities } });
    expect(items.map((i) => i.content)).toEqual([
      { capabilityId: 'platform_test.read', riskClass: 'READ', decision: 'read_capability', version: 1, description: 'reads', inputSchema: { type: 'object' } },
      { capabilityId: 'platform_test.write', riskClass: 'REVERSIBLE_WRITE', decision: 'propose_action', version: 2, description: 'writes', inputSchema: bigSchema },
      { capabilityId: 'platform_test.pay', riskClass: 'FINANCIAL', decision: 'propose_action', version: 1, description: 'pays', inputSchema: { type: 'object' } },
    ]);
    for (const item of items) expect(Object.keys(item.content as object).slice(0, 3)).toEqual(['capabilityId', 'riskClass', 'decision']);
  });

  it('states no decision type when no risk class is known', async () => {
    const items = await capabilitySource.load(request());
    expect(items[0]!.content).not.toHaveProperty('decision');
    expect(items[0]!.content).not.toHaveProperty('riskClass');
  });
});
