import { z } from 'zod';
import {
  agentIdSchema,
  capabilityIdSchema,
  correlationIdSchema,
  positiveIntSchema,
  scopeSchema,
  slugSchema,
  uniqueArray,
  uuidSchema,
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
