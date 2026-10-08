import { z } from 'zod';

/**
 * Runtime validation of Quote V2 responses (OpenAPI 2.0.0). Only the members
 * R4 reads are declared; objects are NOT strict because the owner contract
 * says consumers MUST ignore unknown response members (2.x is additive).
 * Enumerations R4 branches on are closed: an unknown status is a contract
 * violation, never guessed.
 */
export const QUOTE_V2_CONTRACT_VERSION = '2.0.0';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/);
const localDate = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const clp = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const amounts = z.object({ net: clp, tax: clp, gross: clp });
const status = z.enum(['draft', 'issuing', 'issued', 'expired', 'cancelled']);

export const quoteSchema = z.object({
  quoteId: z.uuid(),
  status,
  version: z.int().min(1),
  quoteNumber: z.string().regex(/^[A-Z]{2,8}-[0-9]{6,}$/).nullable(),
  currency: z.literal('CLP'),
  externalCorrelation: z.object({ sourceSystem: z.string(), externalReferenceType: z.string().optional(), externalReference: z.string().optional() }),
  lines: z.array(z.object({ position: z.int().min(1), amounts })),
  shipping: z.object({ amounts }).nullable(),
  totals: amounts.extend({ exemptNet: clp }),
  validity: z.object({ source: z.string(), policyId: z.string().nullable(), issueLocalDate: localDate, validThroughLocalDate: localDate, validUntilExclusive: instant }).nullable(),
  issuance: z.object({ issuedAt: instant, operationId: z.uuid(), issuerProfileId: z.string() }).nullable(),
  document: z.object({
    available: z.boolean(),
    pdfSha256: sha256.nullable(),
    byteLength: z.int().min(1).nullable(),
    artifactRef: z.string().nullable(),
    generatedAt: instant.nullable(),
  }),
});

export const operationSchema = z.object({
  operationId: z.uuid(),
  type: z.literal('quote.issue'),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  quoteId: z.uuid(),
  deadlineAt: instant,
  completedAt: instant.nullable(),
  attempts: z.object({ count: z.int().min(0), lastErrorCode: z.string().nullable(), nextAttemptAt: instant.nullable() }),
});

export const quoteOperationResultSchema = z.object({ quote: quoteSchema, operation: operationSchema });

export const idempotencyLookupSchema = z.discriminatedUnion('state', [
  z.object({ operation: z.literal('quote.create_and_issue'), state: z.literal('not_found'), binding: z.null() }),
  z.object({
    operation: z.literal('quote.create_and_issue'),
    state: z.literal('bound'),
    binding: z.object({ boundAt: instant, requestFingerprint: sha256, resourceType: z.literal('quote'), quoteId: z.uuid(), operationId: z.uuid().nullable(), quoteStatus: status }),
  }),
]);

export const errorResponseSchema = z.object({
  error: z.object({ code: z.string().max(64), message: z.string().max(500), requestId: z.string().max(100), details: z.record(z.string(), z.unknown()).optional() }),
});
