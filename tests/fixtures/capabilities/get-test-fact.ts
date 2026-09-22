import { z } from 'zod';
import type { CapabilityRegistration } from '@r4/capability-runtime';

/**
 * Artificial, read-only test capability. Synthetic data with no domain
 * meaning; it exists only to prove registration, discovery, schema
 * validation, the invocation contract and observation creation.
 */
export const TEST_FACTS: Readonly<Record<string, string>> = Object.freeze({
  'platform.name': 'R4',
  'platform.phase': 'R4-B',
  alpha: 'first',
});

const input = z.strictObject({
  factKey: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
});
const output = z.strictObject({
  factKey: z.string(),
  found: z.boolean(),
  value: z.string().nullable(),
});

export const GET_TEST_FACT_ID = 'platform_test.get_test_fact';

export function getTestFactCapability(
  handler?: CapabilityRegistration<z.infer<typeof input>, z.infer<typeof output>>['handler'],
): CapabilityRegistration<z.infer<typeof input>, z.infer<typeof output>> {
  return {
    definition: {
      capabilityId: GET_TEST_FACT_ID,
      version: 1,
      description: 'Returns a fixed synthetic test fact by key. Test-only.',
      owner: 'platform-test',
      riskClass: 'READ',
      requiredScopes: ['platform_test.read'],
      identityRequirement: 'none',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'inherent',
      retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
      timeoutMs: 1_000,
      freshnessTtlMs: 60_000,
      auditLevel: 'standard',
    },
    input,
    output,
    handler:
      handler ??
      (({ factKey }) =>
        Promise.resolve({ factKey, found: factKey in TEST_FACTS, value: TEST_FACTS[factKey] ?? null })),
  };
}
