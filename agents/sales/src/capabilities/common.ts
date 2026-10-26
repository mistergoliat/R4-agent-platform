import { z } from 'zod';
import { CATALOG_KEY_PATTERN, DomainError, type DomainErrorCategory } from '@r4-adapters/domains';
import { CapabilityFailure } from '@r4/capability-runtime';
import type { CapabilityDefinition, DependencyFailureCode } from '@r4/contracts';

export const moneySchema = z.strictObject({ amount: z.int().nonnegative(), currency: z.literal('CLP') });
/** `productId` holds the Catalog owner's opaque sellable-item key (never a SKU). */
export const itemQuantitySchema = z.strictObject({ productId: z.string().regex(CATALOG_KEY_PATTERN), quantity: z.int().min(1).max(99) });
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
 * (R4-J5) A dependency failure becomes a typed observation code with a fixed message and only
 * { category, code, retryable }: the adapter's message and diagnostics (transport code, HTTP status,
 * owner code, required scope) stay in its own telemetry and never reach the model.
 */
const DEPENDENCY_FAILURES: Partial<Record<DomainErrorCategory, { code: DependencyFailureCode; message: string }>> = {
  temporarily_unavailable: { code: 'dependency_unavailable', message: 'the capability owner is temporarily unavailable' },
  timeout: { code: 'dependency_timeout', message: 'the capability owner did not answer in time' },
  unauthorized: { code: 'dependency_unauthorized', message: 'the capability owner refused the platform credential' },
  contract_violation: { code: 'dependency_contract_violation', message: 'the capability owner answered outside its contract' },
};

/**
 * Runs a READ against a domain port, translating the owner's classified
 * failure into a structured failed observation (`error.details.category`).
 * Dependency failures carry a typed code (above); the other categories keep
 * `handler_error` with the owner's details. Anything unclassified propagates
 * as a plain handler failure.
 */
export async function domainRead<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DomainError) {
      const dependency = DEPENDENCY_FAILURES[error.category];
      if (dependency) throw new CapabilityFailure(dependency.message, { category: error.category, code: error.code, retryable: error.retryable }, dependency.code);
      throw new CapabilityFailure(error.message, { category: error.category, code: error.code, retryable: error.retryable, ...error.details });
    }
    throw error;
  }
}
