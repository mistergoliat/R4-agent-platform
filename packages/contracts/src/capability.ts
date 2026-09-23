import { z } from 'zod';
import {
  agentIdSchema,
  capabilityIdSchema,
  correlationIdSchema,
  positiveIntSchema,
  principalSchema,
  scopeSchema,
  slugSchema,
  uniqueArray,
  uuidSchema,
  type Principal,
} from './primitives.js';

/**
 * Capability metadata. Describes a bounded operation well enough for future
 * policy, scope and risk decisions. Carries no domain semantics: domains and
 * agent packs register capabilities; Core only governs them.
 */
export const RISK_CLASSES = [
  'READ',
  'REVERSIBLE_WRITE',
  'IRREVERSIBLE_WRITE',
  'FINANCIAL',
  'EXTERNAL_COMMUNICATION',
  'PRIVILEGED',
] as const;
export const riskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof riskClassSchema>;

/**
 * How a write capability's owner makes a repeated execution with the same
 * platform execution key safe (R4-D, ADR-018). Both require the domain to
 * apply at most one effect per execution key.
 *
 * - idempotent_replay       executing again with the same key returns the
 *                           original outcome instead of a second effect
 * - reconcile_before_retry  the outcome can be looked up by key; the platform
 *                           must reconcile before it may execute again
 *
 * A write without a declared strategy is never executed.
 */
export const WRITE_RECOVERY_STRATEGIES = ['idempotent_replay', 'reconcile_before_retry'] as const;
export const writeRecoveryStrategySchema = z.enum(WRITE_RECOVERY_STRATEGIES);
export type WriteRecoveryStrategy = z.infer<typeof writeRecoveryStrategySchema>;

/** A JSON Schema document, as exposed to models and external consumers. */
export const jsonSchemaDocumentSchema = z.record(z.string(), z.unknown());

export const capabilityDefinitionSchema = z
  .strictObject({
    capabilityId: capabilityIdSchema,
    version: positiveIntSchema,
    /** Model-facing description. Never the source of an invariant. */
    description: z.string().min(1).max(2000),
    /** Owning agent pack or domain adapter. */
    owner: slugSchema,
    riskClass: riskClassSchema,
    requiredScopes: uniqueArray(scopeSchema).min(1),
    identityRequirement: z.enum(['none', 'provisional', 'verified']),
    confirmationPolicy: z.enum(['none', 'required']),
    approvalPolicy: z.enum(['none', 'required']),
    /**
     * inherent: repeating the call has no additional effect (reads).
     * key_required: callers must supply an idempotency key.
     * unsupported: the operation cannot be safely repeated.
     */
    idempotency: z.enum(['inherent', 'key_required', 'unsupported']),
    retryPolicy: z.strictObject({
      maxAttempts: z.int().min(1).max(10),
      initialBackoffMs: z.int().min(0).max(60_000),
    }),
    timeoutMs: z.int().min(1).max(300_000),
    /** How long a successful observation may be treated as current; null = not declared. */
    freshnessTtlMs: z.int().positive().nullable(),
    auditLevel: z.enum(['minimal', 'standard', 'full']),
    inputSchema: jsonSchemaDocumentSchema,
    outputSchema: jsonSchemaDocumentSchema,
    /** (R4-D) Declared only by write capabilities registered with write handlers. */
    writeRecovery: writeRecoveryStrategySchema.optional(),
  })
  .superRefine((definition, ctx) => {
    // Blind retries of writes are forbidden: a retried non-read must be keyed.
    if (
      definition.riskClass !== 'READ' &&
      definition.retryPolicy.maxAttempts > 1 &&
      definition.idempotency !== 'key_required'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['retryPolicy', 'maxAttempts'],
        message: 'non-READ capabilities may only retry when idempotency is "key_required"',
      });
    }
    if (definition.riskClass === 'READ' && definition.idempotency === 'unsupported') {
      ctx.addIssue({
        code: 'custom',
        path: ['idempotency'],
        message: 'READ capabilities must be safely repeatable',
      });
    }
    if (definition.writeRecovery !== undefined && definition.riskClass === 'READ') {
      ctx.addIssue({ code: 'custom', path: ['writeRecovery'], message: 'READ capabilities have no write recovery strategy' });
    }
    if (definition.writeRecovery !== undefined && definition.idempotency !== 'key_required') {
      ctx.addIssue({ code: 'custom', path: ['writeRecovery'], message: 'a write recovery strategy requires idempotency "key_required" (execution keys)' });
    }
  });
export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;

/**
 * Built by the platform — never by the model — for every invocation. It is the
 * only source of identity, scopes and correlation a capability handler sees.
 */
export const trustedExecutionContextSchema = z.strictObject({
  taskId: uuidSchema,
  runId: uuidSchema,
  agentId: agentIdSchema,
  agentVersion: positiveIntSchema,
  correlationId: correlationIdSchema,
  grantedScopes: uniqueArray(scopeSchema),
});
export type TrustedExecutionContext = z.infer<typeof trustedExecutionContextSchema>;

/**
 * How strongly the platform has established who a task acts for. Same scale
 * as `identityRequirement`. Derived by the platform from the resolved
 * principal — never from model output or arguments.
 */
export const IDENTITY_ASSURANCES = ['none', 'provisional', 'verified'] as const;
export const identityAssuranceSchema = z.enum(IDENTITY_ASSURANCES);
export type IdentityAssurance = z.infer<typeof identityAssuranceSchema>;

export function identityAssuranceRank(level: IdentityAssurance): number {
  return IDENTITY_ASSURANCES.indexOf(level);
}

/**
 * R4-D: the platform's assurance for a resolved principal. No identity
 * verification service exists yet, so nothing is `verified`: an
 * authenticated principal is `provisional`, an unauthenticated one `none`.
 */
export function identityAssuranceOf(principal: Principal): IdentityAssurance {
  return principal.kind === 'unauthenticated' ? 'none' : 'provisional';
}

/**
 * The trusted context of a governed action (R4-D): the execution context plus
 * who the task acts for and how well that is established. Built by the
 * platform from durable task, run and agent records and persisted with the
 * command, so recovery executes with exactly the same context. There is no
 * tenant: R4 has no tenancy model yet (not invented here).
 */
export const trustedActionContextSchema = trustedExecutionContextSchema.extend({
  actor: principalSchema,
  identityAssurance: identityAssuranceSchema,
});
export type TrustedActionContext = z.infer<typeof trustedActionContextSchema>;

/**
 * What an agent asks for. Untrusted end to end: the id may not exist and the
 * arguments are validated by the runtime against the registered schema.
 */
export interface CapabilityInvocationRequest {
  readonly capabilityId: string;
  readonly capabilityVersion?: number;
  readonly arguments: unknown;
}

export const CAPABILITY_REJECTION_CODES = [
  'capability_not_found',
  'scope_denied',
  'execution_not_permitted',
  'invalid_arguments',
] as const;
export const CAPABILITY_FAILURE_CODES = [
  'handler_error',
  'timeout',
  'invalid_capability_output',
] as const;
export type CapabilityRejectionCode = (typeof CAPABILITY_REJECTION_CODES)[number];
export type CapabilityFailureCode = (typeof CAPABILITY_FAILURE_CODES)[number];
