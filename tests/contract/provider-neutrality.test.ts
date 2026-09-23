import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agentDecisionSchema,
  agentDefinitionSchema,
  agentRunSchema,
  runStepSchema,
  taskLeaseSchema,
  agentTaskSchema,
  capabilityDefinitionSchema,
  goalSchema,
  observationSchema,
} from '@r4/contracts';

/** Collects every property name declared anywhere in a JSON Schema document. */
function propertyNames(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, out);
  } else if (schema !== null && typeof schema === 'object') {
    const record = schema as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') {
      for (const key of Object.keys(record.properties)) out.add(key);
    }
    for (const value of Object.values(record)) propertyNames(value, out);
  }
  return out;
}

const VENDOR_OR_MODEL_FIELD = /^(provider|providerId|model|modelId|modelName|vendor|apiKey|endpoint|baseUrl)$/i;
const DOMAIN_FIELD = /(quote|cart|opportunit|campaign|product|payment|catalog|customer|order|shipping|commercial)/i;

const CONTRACTS = {
  AgentDefinition: agentDefinitionSchema,
  AgentTask: agentTaskSchema,
  AgentRun: agentRunSchema,
  Goal: goalSchema,
  CapabilityDefinition: capabilityDefinitionSchema,
  Observation: observationSchema,
  // R4-C1
  AgentDecision: agentDecisionSchema,
  RunStep: runStepSchema,
  TaskLease: taskLeaseSchema,
};

describe('provider and domain neutrality of public contracts', () => {
  it.each(Object.entries(CONTRACTS))('%s names no vendor or concrete model', (_name, schema) => {
    const names = [...propertyNames(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))];
    expect(names.filter((n) => VENDOR_OR_MODEL_FIELD.test(n))).toEqual([]);
  });

  it.each(Object.entries(CONTRACTS))('%s carries no domain field', (_name, schema) => {
    const names = [...propertyNames(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))];
    expect(names.filter((n) => DOMAIN_FIELD.test(n))).toEqual([]);
  });

  it('expresses model needs only as abstract requirements', () => {
    const names = propertyNames(z.toJSONSchema(agentDefinitionSchema, { io: 'input', unrepresentable: 'any' }));
    expect(names.has('modelRequirements')).toBe(true);
    expect(names.has('reasoningLevel')).toBe(true);
  });
});
