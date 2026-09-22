import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PlatformError } from '@r4/contracts';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { GET_TEST_FACT_ID, getTestFactCapability } from '../../fixtures/capabilities/get-test-fact.js';

describe('CapabilityRegistry', () => {
  it('registers a capability and derives JSON Schemas from its validators', () => {
    const registry = new CapabilityRegistry();
    const definition = registry.register(getTestFactCapability());
    expect(definition.capabilityId).toBe(GET_TEST_FACT_ID);
    expect(definition.inputSchema).toMatchObject({
      type: 'object',
      properties: { factKey: { type: 'string' } },
      required: ['factKey'],
      additionalProperties: false,
    });
    expect(definition.outputSchema).toMatchObject({ type: 'object', required: ['factKey', 'found', 'value'] });
    expect(registry.list()).toEqual([definition]);
  });

  it('refuses duplicate (id, version) registrations', () => {
    const registry = new CapabilityRegistry();
    registry.register(getTestFactCapability());
    expect(() => registry.register(getTestFactCapability())).toThrow(PlatformError);
  });

  it('refuses invalid metadata', () => {
    const registry = new CapabilityRegistry();
    const base = getTestFactCapability();
    const invalid = { ...base, definition: { ...base.definition, requiredScopes: [] } };
    expect(() => registry.register(invalid)).toThrow(/invalid capability definition/);
  });

  it('refuses validators that cannot be expressed as JSON Schema', () => {
    const registry = new CapabilityRegistry();
    const base = getTestFactCapability();
    const weird = { ...base, input: z.custom<{ factKey: string }>(() => true).transform((v) => v) };
    expect(() => registry.register(weird)).toThrow(PlatformError);
  });

  it('resolves the latest version unless a version is requested', () => {
    const registry = new CapabilityRegistry();
    const v1 = getTestFactCapability();
    registry.register(v1);
    registry.register({ ...v1, definition: { ...v1.definition, version: 2 } });
    expect(registry.resolve(GET_TEST_FACT_ID)?.definition.version).toBe(2);
    expect(registry.resolve(GET_TEST_FACT_ID, 1)?.definition.version).toBe(1);
    expect(registry.resolve(GET_TEST_FACT_ID, 3)).toBeUndefined();
    expect(registry.resolve('missing.capability')).toBeUndefined();
  });

  it('discovers only capabilities whose required scopes are all granted', () => {
    const registry = new CapabilityRegistry();
    const base = getTestFactCapability();
    registry.register(base);
    registry.register({
      ...base,
      definition: { ...base.definition, capabilityId: 'platform_test.get_secret_fact', requiredScopes: ['platform_test.read', 'platform_test.secret'] },
    });
    expect(registry.discover([]).map((d) => d.capabilityId)).toEqual([]);
    expect(registry.discover(['platform_test.read']).map((d) => d.capabilityId)).toEqual([GET_TEST_FACT_ID]);
    expect(registry.discover(['platform_test.read', 'platform_test.secret']).map((d) => d.capabilityId)).toEqual([
      'platform_test.get_secret_fact',
      GET_TEST_FACT_ID,
    ]);
  });
});
