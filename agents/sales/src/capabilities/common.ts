import { z } from 'zod';
import { DomainError } from '@r4-adapters/domains';
import { CapabilityFailure } from '@r4/capability-runtime';
import type { CapabilityDefinition } from '@r4/contracts';

export const moneySchema = z.strictObject({ amount: z.int().nonnegative(), currency: z.literal('CLP') });
export const itemQuantitySchema = z.strictObject({ productId: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,47}$/), quantity: z.int().min(1).max(99) });
export const destinationSchema = z.strictObject({ commune: z.string().trim().min(2).max(80), region: z.string().trim().min(2).max(80).optional() });

type ReadDefinition = Omit<CapabilityDefinition, 'inputSchema' | 'outputSchema'>;

/** Common metadata of the pack's READ capabilities (each states its own owner, scope and freshness). */
export function readDefinition(fields: Pick<ReadDefinition, 'capabilityId' | 'description' | 'owner' | 'requiredScopes' | 'freshnessTtlMs'> & { timeoutMs?: number }): ReadDefinition {
  return {
    version: 1,
    riskClass: 'READ',
    identityRequirement: 'none',
    confirmationPolicy: 'none',
    approvalPolicy: 'none',
    idempotency: 'inherent',
    retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
    timeoutMs: fields.timeoutMs ?? 10_000,
    auditLevel: 'standard',
    capabilityId: fields.capabilityId,
    description: fields.description,
    owner: fields.owner,
    requiredScopes: fields.requiredScopes,
    freshnessTtlMs: fields.freshnessTtlMs,
  };
}

/**
 * Runs a READ against a domain port, translating the owner's classified
 * failure into a structured failed observation (`error.details.category`).
 * Anything unclassified propagates as a plain handler failure.
 */
export async function domainRead<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DomainError) {
      throw new CapabilityFailure(error.message, { category: error.category, code: error.code, retryable: error.retryable, ...error.details });
    }
    throw error;
  }
}
