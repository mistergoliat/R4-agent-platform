import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CATALOG_KEY_PATTERN,
  DomainError,
  QUOTE_V2_NOT_FOUND_FINAL_AFTER_MS,
  QUOTE_V2_TAX_RATE_PATTERN,
  canonicalJson,
  canonicalTaxRate,
  normalizeCommuneName,
  quoteV2Totals,
  type CatalogPort,
  type QuoteV2CreateRequest,
  type QuoteV2CreateResult,
  type QuoteV2LineInput,
  type QuoteV2Operation,
  type QuoteV2Quote,
  type QuoteV2Service,
  type QuoteV2ShippingInput,
  type ShippingService,
} from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult, WriteHandlerContext, WriteReconciliationResult } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import type { PostgresSalesStore, QuoteV2RequestRecord } from '../workspace/store.js';
import { resolveOrderBasis } from './shipping-basis.js';

/** How R4 identifies itself as the quote's business source (owner `externalCorrelation`; never a CRM opportunity). */
export const QUOTE_V2_CORRELATION = Object.freeze({ sourceSystem: 'r4-sales', externalReferenceType: 'r4-task' } as const);
/** Item and pricing provenance as the Catalog owner names itself. */
export const CATALOG_SOURCE_SYSTEM = 'catalog-service';
export const SHIPPING_SOURCE_SYSTEM = 'pc-carrier';
/** Executor deadline of one attempt: Catalog + Shipping verification, the POST (adapter ≤ 30 s) and the document read. */
export const QUOTE_V2_TIMEOUT_MS = 90_000;

/** Owner `Text`: no control characters, no leading or trailing whitespace (`\p{Cc}` also refuses C1 controls: stricter, never looser). */
const OWNER_TEXT = /^[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u;
/** Owner `OpaqueReference`. */
const OPAQUE_REFERENCE = /^[!-~](?:[ -~]{0,198}[!-~])?$/;
const text = (max: number) => z.string().trim().max(max).regex(OWNER_TEXT, 'printable text without control characters');
const clp = z.int().min(0).max(1_000_000_000);
const contact = { email: z.email().max(254).optional(), phone: z.string().regex(/^\+?[0-9][0-9 ()-]{5,19}$/).optional() };
const rut = z.string().regex(/^[1-9][0-9]{0,7}-[0-9K]$/, 'RUT without dots, uppercase K').optional();

/**
 * What a quote.create@2 proposal states — and therefore what a human
 * approves: the customer snapshot exactly as stated by the customer, every
 * line (Catalog sellable-item key, quantity, the Catalog's tax-included unit
 * price and rate), the chosen shipping offer (or null), and the expected
 * totals. Nothing here is trusted: execution verifies every amount against
 * the owners before anything is sent, and fails closed on any difference.
 */
export const quoteCreateV2Input = z.strictObject({
  workspaceVersion: z.int().min(1),
  customer: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('guest'), displayName: text(200).optional(), ...contact }),
    z.strictObject({ kind: z.literal('person'), displayName: text(200), rut, ...contact }),
    z.strictObject({ kind: z.literal('company'), legalName: text(200), tradeName: text(200).optional(), rut, contactName: text(200).optional(), ...contact }),
  ]),
  lines: z
    .array(
      z.strictObject({
        itemKey: z.string().regex(CATALOG_KEY_PATTERN),
        quantity: z.int().min(1).max(99),
        unitPrice: z.strictObject({ amount: clp, taxBasis: z.literal('included'), taxRate: z.string().regex(QUOTE_V2_TAX_RATE_PATTERN) }),
      }),
    )
    .min(1)
    .max(20),
  shipping: z
    .strictObject({
      destinationCommune: text(80),
      carrierName: text(120),
      serviceType: text(120),
      amount: z.strictObject({ amount: clp, taxBasis: z.literal('excluded'), taxRate: z.string().regex(QUOTE_V2_TAX_RATE_PATTERN) }),
    })
    .nullable(),
  expectedTotals: z.strictObject({ net: clp, tax: clp, gross: clp }),
  currency: z.literal('CLP'),
});
export type QuoteCreateV2Input = z.infer<typeof quoteCreateV2Input>;

const amountsSchema = z.strictObject({ net: z.int().nonnegative(), tax: z.int().nonnegative(), gross: z.int().nonnegative() });
export const quoteCreateV2Output = z.strictObject({
  quoteId: z.string(),
  quoteNumber: z.string(),
  status: z.literal('issued'),
  currency: z.literal('CLP'),
  totals: amountsSchema.extend({ exemptNet: z.int().nonnegative() }),
  lines: z.array(z.strictObject({ position: z.int().positive(), description: z.string(), quantity: z.string(), amounts: amountsSchema })),
  shipping: z.strictObject({ carrierName: z.string(), serviceType: z.string().nullable(), commune: z.string(), amounts: amountsSchema }).nullable(),
  issuedAt: z.string(),
  validity: z.strictObject({ policyId: z.string().nullable(), issueLocalDate: z.string(), validThroughLocalDate: z.string(), validUntilExclusive: z.string() }),
  /** The owner's immutable document, by hash only (never a URL: the owner is private). */
  document: z.strictObject({ pdfSha256: z.string(), byteLength: z.int().positive(), verification: z.enum(['verified', 'unavailable', 'mismatch']) }),
  basedOnWorkspaceVersion: z.int().positive(),
});
export type QuoteCreateV2Output = z.infer<typeof quoteCreateV2Output>;

export interface QuoteV2CapabilityDeps {
  readonly store: PostgresSalesStore;
  readonly quotes: QuoteV2Service;
  readonly catalog: CatalogPort;
  readonly shipping: ShippingService;
  readonly now?: () => Date;
}

/**
 * quote.create@2 (R4-J3B) — governed IRREVERSIBLE_WRITE over the Quote V2
 * port (Model B: R4 supplies the resolved commercial snapshot; Quote
 * verifies arithmetic, numbers, validates and renders).
 *
 * First attempt of a command:
 *   1. verify the approved snapshot: workspace version and selection, every
 *      line's current Catalog evidence (sellable, exact unit price for the
 *      quantity tier, tax rate), the chosen shipping offer against a fresh
 *      Shipping owner quote, and expectedTotals against the owner's
 *      published arithmetic. Any difference → rejected, nothing sent; a new
 *      proposal (new approval, new execution key) is required.
 *   2. freeze the exact CreateQuoteRequest under the execution key (0007).
 * Every attempt: log the send, POST the frozen body with Idempotency-Key =
 * execution key, then settle from the owner's state — never from the HTTP
 * status alone. 202/issuing → unknown (the platform reconciles by key until
 * the operation settles). Lost answers → unknown, reconciled by key; a new
 * key is never generated for the same command.
 */
export function quoteCreateV2Capability(deps: QuoteV2CapabilityDeps): WriteCapabilityRegistration<QuoteCreateV2Input, QuoteCreateV2Output> {
  const { store, quotes } = deps;
  const now = deps.now ?? (() => new Date());
  return {
    definition: {
      capabilityId: CAPABILITY_IDS.quoteCreate,
      version: 2,
      description:
        'Issues a formal quote (Quote owner V2) for the Sales workspace selection at workspaceVersion. Every commercial fact must be copied from current observations, never estimated: one line per selected itemKey with its quantity and the catalog item price for that quantity (unitPrice.amount = pricing.finalGross.amount, tax included; taxRate = pricing.tax.rate as a decimal string such as "0.19"); shipping = the offer the customer chose from shipping.quote (basis=order) for the workspace destination (carrierName, serviceType, amount.amount = price.ownerNet.amount, taxBasis "excluded", taxRate "0.19"), or null only when the workspace has no delivery destination; expectedTotals = net, tax and gross of the whole quote with the Quote owner arithmetic (per line: gross = unit × quantity, net = round-half-up(gross / (1 + rate)), tax = gross − net; shipping: tax = round-half-up(net × rate)); customer = kind guest (optional name/contact), person (displayName) or company (legalName), with only what the customer stated. A human approves exactly these facts. Rejected, with nothing issued, when any fact differs from the owners\' current data (the details carry what the owners say now).',
      owner: 'quote',
      riskClass: 'IRREVERSIBLE_WRITE',
      requiredScopes: [SCOPES.quoteCreate],
      identityRequirement: 'provisional',
      confirmationPolicy: 'none',
      // Defense in depth: approval is required by the capability itself, whatever the action policy says.
      approvalPolicy: 'required',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 0 },
      timeoutMs: QUOTE_V2_TIMEOUT_MS,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: 'reconcile_before_retry',
    input: quoteCreateV2Input,
    output: quoteCreateV2Output,
    async execute(input, context) {
      let record = await store.quoteV2Request(context.executionKey);
      if (!record) {
        let prepared: Prepared;
        try {
          prepared = await prepareRequest(deps, input, context, now());
        } catch (error) {
          // Nothing was frozen or sent: an owner outage during verification is a definitive "no effect".
          if (!(error instanceof DomainError)) throw error;
          if (error.category === 'validation' || error.category === 'not_found') return { status: 'rejected', code: 'quote_evidence_invalid', message: error.message, details: { category: error.category, ownerCode: error.code } };
          return { status: 'failed', code: 'quote_evidence_unavailable', message: `commercial evidence could not be verified: ${error.message}`, details: { category: error.category, ownerCode: error.code, retryable: true } };
        }
        if (prepared.status === 'rejected') return prepared;
        record = await store.recordQuoteV2Request({ executionKey: context.executionKey, taskId: context.execution.taskId, workspaceVersion: input.workspaceVersion, request: prepared.request, requestSha256: sha256(canonicalJson(prepared.request)) });
      }
      await store.recordQuoteV2Send(context.executionKey);
      let result: QuoteV2CreateResult;
      try {
        result = await quotes.createAndIssue(record.request, context.executionKey, { signal: context.signal, correlationId: context.execution.correlationId });
      } catch (error) {
        return classifySend(error);
      }
      return settle(deps, record, result.quote, result.operation, result.replayed, context);
    },
    async reconcile(context): Promise<WriteReconciliationResult<QuoteCreateV2Output>> {
      const record = await store.quoteV2Request(context.executionKey);
      // The command died before its body was frozen: nothing can have been sent for this key.
      if (!record) return { status: 'not_applied' };
      try {
        const binding = await quotes.lookupIdempotency(context.executionKey, { signal: context.signal, correlationId: context.execution.correlationId });
        if (!binding) {
          const age = await store.quoteV2SendAgeMs(context.executionKey);
          // Owner rule: `not_found` is final only once no attempt can still commit.
          if (age === null || age >= QUOTE_V2_TIMEOUT_MS + QUOTE_V2_NOT_FOUND_FINAL_AFTER_MS) return { status: 'not_applied' };
          return { status: 'unknown', message: 'the quote owner has no binding for this key yet, but the last attempt could still commit' };
        }
        const quote = await quotes.getQuote(binding.quoteId, { signal: context.signal });
        const operation = binding.operationId ? await quotes.getOperation(binding.operationId, { signal: context.signal }) : null;
        return await settle(deps, record, quote, operation, true, context);
      } catch (error) {
        if (error instanceof DomainError) return { status: 'unknown', message: `quote reconciliation incomplete: ${error.message}` };
        throw error;
      }
    },
  };
}

type Prepared = { readonly status: 'prepared'; readonly request: QuoteV2CreateRequest } | Extract<WriteExecutionResult<never>, { status: 'rejected' }>;

const reject = (code: string, message: string, details: Record<string, string | number | boolean | null> = {}): Prepared => ({ status: 'rejected', code, message, details });

/** Verifies the approved snapshot against the workspace and the owners' current data, and builds the exact owner request. Sends nothing. */
async function prepareRequest(deps: QuoteV2CapabilityDeps, input: QuoteCreateV2Input, context: WriteHandlerContext, now: Date): Promise<Prepared> {
  const taskId = context.execution.taskId;
  const options = { signal: context.signal, correlationId: context.execution.correlationId };
  const workspace = await deps.store.workspace(taskId);
  if (workspace.version !== input.workspaceVersion) return reject('workspace_version_mismatch', `the workspace is at version ${workspace.version}; propose a quote for the current selection`, { currentVersion: workspace.version, requestedVersion: input.workspaceVersion });
  const selected = new Map(workspace.state.items.map((i) => [i.productId, i.quantity]));
  const proposed = new Map(input.lines.map((l) => [l.itemKey, l.quantity]));
  if (selected.size !== proposed.size || proposed.size !== input.lines.length || [...proposed].some(([key, quantity]) => selected.get(key) !== quantity)) {
    return reject('quote_lines_not_selection', 'the quote lines must be exactly the workspace selection (item keys and quantities)', { selectedItems: selected.size, proposedLines: input.lines.length });
  }
  const delivery = workspace.state.delivery;
  if (delivery && !input.shipping) return reject('shipping_not_selected', 'the workspace has a delivery destination: the customer must choose a shipping offer before the quote, or the destination must be cleared', { commune: delivery.commune });
  if (!delivery && input.shipping) return reject('shipping_without_destination', 'shipping was proposed but the workspace has no delivery destination');
  if (delivery && input.shipping && normalizeCommuneName(delivery.commune) !== normalizeCommuneName(input.shipping.destinationCommune)) {
    return reject('shipping_destination_mismatch', 'the shipping destination differs from the workspace delivery destination', { workspaceCommune: delivery.commune });
  }

  const lines: QuoteV2LineInput[] = [];
  for (const [index, line] of input.lines.entries()) {
    const item = await deps.catalog.getItemContext({ itemKey: line.itemKey, quantity: line.quantity }, options);
    const at = { line: index + 1, itemKey: line.itemKey };
    if (item.status !== 'found') return reject('item_not_sellable', `${line.itemKey} is not a sellable catalog item (${item.status})`, at);
    if (item.availability.sellability !== 'sellable') return reject('item_not_sellable', `${item.parentProduct.name} is ${item.availability.sellability}`, { ...at, reason: item.availability.reason });
    if (item.availability.availableQuantity !== null && item.availability.availableQuantity < line.quantity) return reject('insufficient_stock', `only ${item.availability.availableQuantity} units are available`, { ...at, available: item.availability.availableQuantity });
    if (item.freshness.validUntil !== null && Date.parse(item.freshness.validUntil) <= now.getTime()) return reject('catalog_evidence_stale', 'the catalog answer is already past its owner validity', at);
    if (item.pricing.status !== 'available') return reject('item_price_unavailable', `the catalog has no price for ${line.itemKey}`, { ...at, reason: item.pricing.reason });
    if (item.pricing.quantity !== line.quantity) return reject('item_price_tier_mismatch', 'the catalog priced a different quantity tier', { ...at, pricedQuantity: item.pricing.quantity });
    const rate = canonicalTaxRate(item.pricing.tax.rate);
    if (item.pricing.finalGross.amount !== line.unitPrice.amount || rate !== line.unitPrice.taxRate) {
      return reject('commercial_price_changed', `the catalog price of ${line.itemKey} for ${line.quantity} unit(s) is ${item.pricing.finalGross.amount} CLP (tax ${rate ?? 'unrepresentable'}), not ${line.unitPrice.amount}`, { ...at, catalogUnitGross: item.pricing.finalGross.amount, catalogTaxRate: rate });
    }
    const description = ownerText(item.parentProduct.name, 300);
    const sku = item.variant.sku ?? item.parentProduct.sku;
    const attributes = item.variant.attributes.map((a) => ({ name: ownerText(a.group, 60), value: ownerText(a.value, 120) }));
    if (!description || attributes.length > 10 || attributes.some((a) => !a.name || !a.value)) return reject('catalog_text_unusable', 'the catalog description of an item cannot be printed on a quote', at);
    lines.push({
      kind: 'product',
      item: {
        sourceSystem: CATALOG_SOURCE_SYSTEM,
        productRef: item.ref.productId,
        ...(item.ref.variantId !== null ? { variantRef: item.ref.variantId } : {}),
        ...(sku && ownerText(sku, 100) ? { sku: ownerText(sku, 100)! } : {}),
        description,
        ...(attributes.length > 0 ? { attributes: attributes as { name: string; value: string }[] } : {}),
      },
      quantity: { value: String(line.quantity), unit: 'unit' },
      unitPrice: { amount: line.unitPrice.amount, taxBasis: 'included', taxRate: line.unitPrice.taxRate },
      pricingProvenance: { sourceSystem: CATALOG_SOURCE_SYSTEM, ...(OPAQUE_REFERENCE.test(item.pricing.engineVersion) ? { reference: item.pricing.engineVersion } : {}), asOf: item.freshness.asOf },
    });
  }

  let shipping: QuoteV2ShippingInput | undefined;
  if (input.shipping) {
    const chosen = input.shipping;
    const items = input.lines.map((l) => ({ productId: l.itemKey, quantity: l.quantity }));
    const basis = await resolveOrderBasis(deps.catalog, items, options);
    const quote = await deps.shipping.quote({ destination: { commune: chosen.destinationCommune }, basis: { type: 'order', ...basis } }, options);
    const offer = quote.offers.find((o) => o.carrierName === chosen.carrierName && o.serviceType === chosen.serviceType && o.price.ownerNet.amount === chosen.amount.amount);
    if (!quote.serviceable || !offer) {
      const sameService = quote.offers.find((o) => o.carrierName === chosen.carrierName && o.serviceType === chosen.serviceType);
      return reject('shipping_offer_changed', sameService ? `the shipping owner now prices ${chosen.carrierName} ${chosen.serviceType} at ${sameService.price.ownerNet.amount} CLP net` : `the shipping owner no longer offers ${chosen.carrierName} ${chosen.serviceType} for this order`, { currentOwnerNet: sameService?.price.ownerNet.amount ?? null });
    }
    if (canonicalTaxRate(offer.price.tax.rate) !== chosen.amount.taxRate) return reject('shipping_tax_changed', 'the shipping VAT rate differs from the proposal', { shippingTaxRate: offer.price.tax.rate });
    const commune = ownerText(quote.destination.communeName, 80);
    const region = ownerText(quote.destination.regionName, 80);
    const carrier = ownerText(offer.carrierName, 120);
    const service = ownerText(offer.serviceType, 120);
    if (!commune || !carrier) return reject('shipping_text_unusable', 'the shipping owner answer cannot be printed on a quote');
    shipping = {
      carrier: { name: carrier },
      ...(service ? { serviceType: { name: service } } : {}),
      destination: { commune, ...(region ? { region } : {}), country: 'CL' },
      // The owner prices freight NET; Quote applies the declared rate (QUOTE_V2_DOMAIN_CONTRACT §16).
      amount: { amount: offer.price.ownerNet.amount, taxBasis: 'excluded', taxRate: chosen.amount.taxRate },
      sourceQuote: { sourceSystem: SHIPPING_SOURCE_SYSTEM, ...(OPAQUE_REFERENCE.test(quote.provenance.endpoint) ? { reference: quote.provenance.endpoint } : {}), asOf: quote.asOf },
    };
  }

  const request: QuoteV2CreateRequest = {
    externalCorrelation: { ...QUOTE_V2_CORRELATION, externalReference: taskId },
    customer: Object.fromEntries(Object.entries(input.customer).filter(([, v]) => v !== undefined)) as unknown as QuoteV2CreateRequest['customer'],
    lines,
    ...(shipping ? { shipping } : {}),
    expectedTotals: { ...input.expectedTotals },
  };
  const computed = quoteV2Totals(request);
  if (computed.net !== input.expectedTotals.net || computed.tax !== input.expectedTotals.tax || computed.gross !== input.expectedTotals.gross) {
    return reject('expected_totals_mismatch', `the approved totals do not match the Quote owner arithmetic (net ${computed.net}, tax ${computed.tax}, gross ${computed.gross})`, { computedNet: computed.net, computedTax: computed.tax, computedGross: computed.gross });
  }
  return { status: 'prepared', request };
}

/**
 * Settles one owner observation of the bound quote. Success only for a
 * formally issued quote whose identity, totals, validity and document
 * manifest match what R4 approved; `issuing` is never success.
 */
async function settle(deps: QuoteV2CapabilityDeps, record: QuoteV2RequestRecord, quote: QuoteV2Quote, operation: QuoteV2Operation | null, replayed: boolean, context: WriteHandlerContext): Promise<WriteExecutionResult<QuoteCreateV2Output>> {
  const { store, quotes } = deps;
  const ref = `quote ${quote.quoteNumber ?? quote.quoteId}`;
  if (quote.quoteNumber && quote.issuance) {
    await store.recordQuoteV2Acceptance({ executionKey: record.executionKey, taskId: record.taskId, quoteId: quote.quoteId, quoteNumber: quote.quoteNumber, operationId: quote.issuance.operationId });
  }
  if (quote.status === 'issuing') {
    // A failed operation is terminal for that operation, not for the quote: only an owner operator can retry or cancel it.
    if (operation?.status === 'failed') return { status: 'unknown', message: `${ref} was accepted but its issuance operation failed (${operation.attempts.lastErrorCode ?? 'unknown'}); it is not a formal quote — an owner operator must retry or cancel it` };
    return { status: 'unknown', message: `${ref} is issuing (operation ${operation?.status ?? 'pending'}); not yet a formal quote` };
  }
  if (quote.status === 'cancelled' && !quote.document.available) {
    return { status: 'failed', code: 'quote_not_issued', message: `${ref} was cancelled before it was ever issued`, details: { quoteId: quote.quoteId } };
  }
  if (quote.status !== 'issued') return { status: 'unknown', message: `${ref} is ${quote.status}, not issued` };
  const expected = record.request.expectedTotals!;
  const problems = [
    !quote.quoteNumber && 'no quote number',
    !quote.issuance && 'no issuance',
    (!quote.validity || quote.validity.source !== 'policy') && 'validity is not the owner policy',
    (!quote.document.available || !quote.document.pdfSha256 || !quote.document.byteLength) && 'no document manifest',
    (quote.totals.net !== expected.net || quote.totals.tax !== expected.tax || quote.totals.gross !== expected.gross) && 'owner totals differ from the approved totals',
    (quote.externalCorrelation.sourceSystem !== QUOTE_V2_CORRELATION.sourceSystem || quote.externalCorrelation.externalReference !== record.taskId) && 'external correlation differs',
    quote.lines.length !== record.request.lines.length && 'line count differs',
    (quote.shipping === null) !== (record.request.shipping === undefined) && 'shipping presence differs',
  ].filter((p): p is string => typeof p === 'string');
  // Issued, but not as approved or not provably formal: never reported as success.
  if (problems.length > 0) return { status: 'unknown', message: `${ref} is issued but does not match the approved snapshot: ${problems.join('; ')}` };
  const pdfSha256 = quote.document.pdfSha256!;
  const byteLength = quote.document.byteLength!;
  let verification: 'verified' | 'unavailable' | 'mismatch';
  try {
    const document = await quotes.getDocument(quote.quoteId, { signal: context.signal });
    const actual = sha256(document.bytes);
    verification = actual === pdfSha256 && document.bytes.byteLength === byteLength && (document.declaredSha256 === null || document.declaredSha256 === pdfSha256) ? 'verified' : 'mismatch';
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // The quote stays issued; document access is classified on its own (no duplicate quote, no failure).
    verification = 'unavailable';
  }
  const issuedAt = quote.issuance!.issuedAt;
  const validity = quote.validity!;
  await store.recordQuoteV2Issued({ executionKey: record.executionKey, taskId: record.taskId, quoteId: quote.quoteId, quoteNumber: quote.quoteNumber!, issuedAt, validThroughLocalDate: validity.validThroughLocalDate, validUntilExclusive: validity.validUntilExclusive, pdfSha256, byteLength, documentVerification: verification });
  const shipping = record.request.shipping;
  return {
    status: 'applied',
    result: {
      quoteId: quote.quoteId,
      quoteNumber: quote.quoteNumber!,
      status: 'issued',
      currency: 'CLP',
      totals: { net: quote.totals.net, tax: quote.totals.tax, gross: quote.totals.gross, exemptNet: quote.totals.exemptNet },
      lines: quote.lines.map((l) => ({ position: l.position, description: record.request.lines[l.position - 1]?.item.description ?? '', quantity: record.request.lines[l.position - 1]?.quantity.value ?? '', amounts: { ...l.amounts } })),
      shipping: shipping && quote.shipping ? { carrierName: shipping.carrier.name, serviceType: shipping.serviceType?.name ?? null, commune: shipping.destination.commune, amounts: { ...quote.shipping.amounts } } : null,
      issuedAt,
      validity: { policyId: validity.policyId, issueLocalDate: validity.issueLocalDate, validThroughLocalDate: validity.validThroughLocalDate, validUntilExclusive: validity.validUntilExclusive },
      document: { pdfSha256, byteLength, verification },
      basedOnWorkspaceVersion: record.workspaceVersion,
    },
    resourceRef: `quote:${quote.quoteId}`,
    externalOperationRef: quote.quoteNumber!,
    executedAt: issuedAt,
    replayed,
  };
}

/** A failed POST. Only "never sent" or an owner refusal before binding is a known outcome. */
function classifySend(error: unknown): WriteExecutionResult<QuoteCreateV2Output> {
  if (!(error instanceof DomainError)) throw error;
  const details = { category: error.category, ownerCode: error.code, ...error.details };
  if (error.outcomeUnknown || error.category === 'contract_violation' || error.category === 'not_found') return { status: 'unknown', message: `quote owner outcome unknown (${error.code}): ${error.message}` };
  if (error.category === 'temporarily_unavailable') return { status: 'failed', code: 'quote_service_unavailable', message: error.message, details: { ...details, retryable: true } };
  if (error.category === 'unauthorized') return { status: 'failed', code: 'quote_owner_unauthorized', message: error.message, details: { ...details, retryable: false } };
  // validation (422 arithmetic_mismatch / validation_error, 400) and conflict (409): refused, nothing bound for this body.
  return { status: 'rejected', code: `quote_${error.code}`.replace(/[^a-z0-9_.]/g, '_'), message: error.message, details };
}

/** Owner text as-is (trimmed), or null when it cannot be printed (control characters, empty, too long). */
function ownerText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 && trimmed.length <= max && OWNER_TEXT.test(trimmed) ? trimmed : null;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
