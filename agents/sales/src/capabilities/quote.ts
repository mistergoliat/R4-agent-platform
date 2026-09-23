import { z } from 'zod';
import { DomainError, type Quote, type QuoteService } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult, WriteReconciliationResult } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { selectionOf } from '../workspace/model.js';
import type { PostgresSalesStore, QuoteRequestRecord } from '../workspace/store.js';
import { moneySchema } from './common.js';

/**
 * What the model may say about a quote: which workspace version it is for and
 * the customer's name and contact. Never a line, a price, a total, a quote id
 * or a number — the strict schema rejects them (the Quote owner prices and
 * identifies the quote itself).
 */
export const quoteCreateInput = z.strictObject({
  workspaceVersion: z.int().min(1),
  customer: z
    .strictObject({
      name: z.string().trim().min(2).max(120),
      email: z.email().max(200).optional(),
      phone: z.string().regex(/^\+?[0-9 ()-]{7,20}$/).optional(),
    })
    .refine((c) => c.email !== undefined || c.phone !== undefined, { message: 'an email or a phone of the customer is required', path: ['email'] }),
});
export type QuoteCreateInput = z.infer<typeof quoteCreateInput>;

const lineSchema = z.strictObject({ productId: z.string(), name: z.string(), quantity: z.int().positive(), unitPrice: moneySchema, lineTotal: moneySchema });
export const quoteCreateOutput = z.strictObject({
  quoteId: z.string(),
  quoteNumber: z.string(),
  status: z.literal('issued'),
  lines: z.array(lineSchema),
  shipping: z.strictObject({ serviceLevel: z.literal('standard'), commune: z.string(), amount: moneySchema }),
  subtotal: moneySchema,
  total: moneySchema,
  issuedAt: z.string(),
  validUntil: z.string(),
  documentRef: z.string(),
  basedOnWorkspaceVersion: z.int().positive(),
});
export type QuoteCreateOutput = z.infer<typeof quoteCreateOutput>;

/**
 * quote.create — governed IRREVERSIBLE_WRITE over the Quote port (an issued
 * quote is a commercial document; it is superseded by a new quote, never
 * edited). The selection and destination come from the Sales workspace at
 * the version the agent names — not from model arguments — and are recorded
 * with the platform execution key before the first call, so every replay or
 * reconciliation of this command sends exactly the same request.
 *
 * The execution key IS the Quote owner's idempotency key: one command, one
 * logical quote, however many workers, crashes or retries. Outcomes map to
 * R4-D semantics: owner refusal → rejected; owner unreachable before sending
 * → failed (no effect); timeout / lost connection after sending → unknown,
 * which the platform reconciles by key (`reconcile_before_retry`) and never
 * guesses.
 */
export function quoteCapability(deps: { store: PostgresSalesStore; quotes: QuoteService }): WriteCapabilityRegistration<QuoteCreateInput, QuoteCreateOutput> {
  const { store, quotes } = deps;
  return {
    definition: {
      capabilityId: CAPABILITY_IDS.quoteCreate,
      version: 1,
      description:
        'Asks the Quote owner to issue a quote for the Sales workspace selection and delivery destination at the given workspaceVersion, for the named customer (name plus email or phone). The owner prices every line and shipping from current data and returns the quote id, number, totals and validity. Rejected when the workspace moved past that version or lacks a selection or destination.',
      owner: 'quote',
      riskClass: 'IRREVERSIBLE_WRITE',
      requiredScopes: [SCOPES.quoteCreate],
      identityRequirement: 'provisional',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 0 },
      timeoutMs: 20_000,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: 'reconcile_before_retry',
    input: quoteCreateInput,
    output: quoteCreateOutput,
    async execute(input, context) {
      const taskId = context.execution.taskId;
      let request = await store.quoteRequest(context.executionKey);
      if (!request) {
        const workspace = await store.workspace(taskId);
        if (workspace.version !== input.workspaceVersion) {
          return { status: 'rejected', code: 'workspace_version_mismatch', message: `the workspace is at version ${workspace.version}; quote the current selection explicitly`, details: { currentVersion: workspace.version, requestedVersion: input.workspaceVersion } };
        }
        const missing = [...(workspace.state.items.length === 0 ? ['selection'] : []), ...(workspace.state.delivery === null ? ['delivery_destination'] : [])];
        if (missing.length > 0) return { status: 'rejected', code: 'workspace_incomplete', message: `the workspace lacks: ${missing.join(', ')}`, details: { missing: missing.join(',') } };
        const delivery = workspace.state.delivery!;
        request = await store.recordQuoteRequest({ executionKey: context.executionKey, taskId, workspaceVersion: workspace.version, selection: selectionOf(workspace.state), delivery: { commune: delivery.commune, region: delivery.region } });
      }
      try {
        const outcome = await quotes.create(
          { customer: { name: input.customer.name, email: input.customer.email ?? null, phone: input.customer.phone ?? null }, lines: request.selection, delivery: request.delivery },
          context.executionKey,
          { signal: context.signal },
        );
        if (outcome.status === 'rejected') return { status: 'rejected', code: outcome.code, message: outcome.message, details: { ...outcome.details } };
        return await issued(store, request, outcome.quote, outcome.replayed);
      } catch (error) {
        return classify(error);
      }
    },
    async reconcile(context): Promise<WriteReconciliationResult<QuoteCreateOutput>> {
      const request = await store.quoteRequest(context.executionKey);
      // Nothing was ever sent for this key (the command died before its request was recorded).
      if (!request) return { status: 'not_applied' };
      try {
        const quote = await quotes.findByIdempotencyKey(context.executionKey, { signal: context.signal });
        return quote ? await issued(store, request, quote, true) : { status: 'not_applied' };
      } catch (error) {
        return classify(error);
      }
    },
  };
}

async function issued(store: PostgresSalesStore, request: QuoteRequestRecord, quote: Quote, replayed: boolean): Promise<WriteExecutionResult<QuoteCreateOutput>> {
  // A pointer written from the owner's own answer, idempotent per key.
  await store.recordQuoteReference({ executionKey: request.executionKey, taskId: request.taskId, quoteId: quote.quoteId, quoteNumber: quote.quoteNumber });
  return {
    status: 'applied',
    result: {
      quoteId: quote.quoteId,
      quoteNumber: quote.quoteNumber,
      status: quote.status,
      lines: quote.lines.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, unitPrice: { ...l.unitPrice }, lineTotal: { ...l.lineTotal } })),
      shipping: { serviceLevel: quote.shipping.serviceLevel, commune: quote.shipping.commune, amount: { ...quote.shipping.amount } },
      subtotal: { ...quote.subtotal },
      total: { ...quote.total },
      issuedAt: quote.issuedAt,
      validUntil: quote.validUntil,
      documentRef: quote.documentRef,
      basedOnWorkspaceVersion: request.workspaceVersion,
    },
    resourceRef: `quote:${quote.quoteId}`,
    externalOperationRef: quote.quoteNumber,
    executedAt: quote.issuedAt,
    replayed,
  };
}

function classify(error: unknown): WriteExecutionResult<QuoteCreateOutput> {
  if (!(error instanceof DomainError)) throw error;
  if (error.outcomeUnknown) return { status: 'unknown', message: `quote owner outcome unknown: ${error.message}` };
  if (error.category === 'temporarily_unavailable') return { status: 'failed', code: 'quote_service_unavailable', message: error.message, details: { category: error.category, retryable: true } };
  return { status: 'rejected', code: error.code, message: error.message, details: { category: error.category, ...error.details } };
}
