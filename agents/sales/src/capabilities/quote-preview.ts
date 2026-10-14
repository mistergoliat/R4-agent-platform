import { z } from 'zod';
import type { CatalogPort, ShippingService } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, SCOPES } from '../ids.js';
import type { PostgresSalesStore } from '../workspace/store.js';
import { snapshotLimitBreaches, type AutonomousQuoteLimits, type AutonomousQuoteLimitsV6 } from './autonomy-limits.js';
import { formatClp, offerReference } from './offer-presentation.js';
import { buildCommercialSnapshot } from './commercial-snapshot.js';
import { domainRead, readDefinition } from './common.js';

export const quotePreviewInput = z.strictObject({});
export type QuotePreviewInput = z.infer<typeof quotePreviewInput>;

const amounts = z.strictObject({ net: z.int().nonnegative(), tax: z.int().nonnegative(), gross: z.int().nonnegative() });
const blocker = z.strictObject({ code: z.string(), message: z.string(), details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) });
const snapshotSchema = z.strictObject({
  schema: z.literal('r4-sales-commercial-snapshot-v1'),
  currency: z.literal('CLP'),
  customer: z.strictObject({ kind: z.literal('guest') }),
  lines: z.array(
    z.strictObject({
      position: z.int().positive(),
      itemKey: z.string(),
      productRef: z.string(),
      variantRef: z.string().nullable(),
      sku: z.string().nullable(),
      description: z.string(),
      attributes: z.array(z.strictObject({ name: z.string(), value: z.string() })),
      quantity: z.int().positive(),
      unitPrice: z.strictObject({ amount: z.int().nonnegative(), taxBasis: z.literal('included'), taxRate: z.string() }),
      amounts,
    }),
  ),
  shipping: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('excluded') }),
    z.strictObject({
      kind: z.literal('selected'),
      carrierName: z.string(),
      serviceType: z.string().nullable(),
      commune: z.string(),
      region: z.string().nullable(),
      amount: z.strictObject({ amount: z.int().nonnegative(), taxBasis: z.literal('excluded'), taxRate: z.string() }),
      amounts,
    }),
  ]),
  totals: amounts,
});

export const quotePreviewOutput = z.strictObject({
  workspaceVersion: z.int().nonnegative(),
  status: z.enum(['ready', 'blocked']),
  /** SHA-256 of the canonical commercial snapshot: names this exact content, authorizes nothing. */
  previewId: z.string().nullable(),
  snapshot: snapshotSchema.nullable(),
  /** Why no quote can be built from the workspace as it is (owner facts, missing choices). */
  blockers: z.array(blocker),
  /** Limits of autonomous issuance this snapshot already exceeds (frequency limits are checked at issuance). */
  limitBreaches: z.array(blocker),
  /** Whether the customer's recorded quote request names THIS preview. */
  quoteRequest: z.strictObject({ recorded: z.boolean(), matchesThisPreview: z.boolean() }),
  /** True when quote.create may be proposed for this previewId (the request is recorded for it, nothing blocks it, within limits). Issuance re-verifies everything. */
  issuable: z.boolean(),
  evidence: z.strictObject({
    validUntil: z.string().nullable(),
    catalog: z.array(z.strictObject({ itemKey: z.string(), asOf: z.string(), validUntil: z.string().nullable(), availableQuantity: z.int().nullable() })),
    shippingAsOf: z.string().nullable(),
  }),
});
export type QuotePreviewOutput = z.infer<typeof quotePreviewOutput>;

/**
 * quote.preview@1 (R4-J3E) — READ, Sales-owned. Builds the commercial
 * snapshot the workspace would issue as a quote, from the workspace and the
 * owners' current data only (it takes no arguments: the model can state no
 * price, quantity, total, shipping amount or customer datum). Same checks and
 * arithmetic as issuance. Persisted as an immutable observation whose
 * validity is the earliest owner validity behind it.
 */
export function quotePreviewCapability(deps: { readonly store: Pick<PostgresSalesStore, 'workspace'>; readonly catalog: CatalogPort; readonly shipping: ShippingService; readonly limits: AutonomousQuoteLimits; readonly now?: () => Date }): CapabilityRegistration<QuotePreviewInput, QuotePreviewOutput> {
  const now = deps.now ?? (() => new Date());
  return {
    definition: readDefinition({
      capabilityId: AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview,
      description:
        'Previews the formal quote the current Sales workspace would produce: every selected item with the catalog price for its quantity (tax included), the shipping offer the customer chose (or delivery explicitly excluded), and the net, VAT and gross totals with the Quote owner arithmetic. Takes no arguments: everything comes from the workspace and the owners now. status=blocked lists what prevents a quote (unsellable item, missing stock, stale or missing price, shipping not chosen or changed). limitBreaches lists autonomy limits the quote exceeds (it cannot be issued without a human). previewId names exactly this content; issuable=true only when the customer\'s quote request is recorded for this previewId. Show the customer the lines, shipping and totals from this preview, never your own arithmetic.',
      owner: 'sales',
      requiredScopes: [SCOPES.catalogRead, SCOPES.shippingRead],
      freshnessTtlMs: 15 * 60_000,
      timeoutMs: 20_000,
    }),
    input: quotePreviewInput,
    output: quotePreviewOutput,
    ownerValidUntil: (output) => output.evidence.validUntil,
    handler: (_input, context) =>
      domainRead(async () => {
        const workspace = await deps.store.workspace(context.execution.taskId);
        const built = await buildCommercialSnapshot(deps, workspace, { signal: context.signal, correlationId: context.execution.correlationId }, now());
        const request = workspace.state.quoteRequest ?? null;
        if (built.status === 'blocked') {
          return {
            workspaceVersion: workspace.version,
            status: 'blocked' as const,
            previewId: null,
            snapshot: null,
            blockers: built.blockers.map((b) => ({ ...b, details: { ...b.details } })),
            limitBreaches: [],
            quoteRequest: { recorded: request !== null, matchesThisPreview: false },
            issuable: false,
            evidence: { validUntil: null, catalog: [], shippingAsOf: null },
          };
        }
        const breaches = snapshotLimitBreaches(built.snapshot, deps.limits);
        const matches = request?.previewId === built.previewId;
        return {
          workspaceVersion: workspace.version,
          status: 'ready' as const,
          previewId: built.previewId,
          snapshot: JSON.parse(JSON.stringify(built.snapshot)) as QuotePreviewOutput['snapshot'],
          blockers: [],
          limitBreaches: breaches.map((b) => ({ ...b, details: { ...b.details } })),
          quoteRequest: { recorded: request !== null, matchesThisPreview: matches },
          issuable: matches && breaches.length === 0,
          evidence: {
            validUntil: built.evidence.validUntil,
            catalog: built.evidence.lines.map((l) => ({ itemKey: l.itemKey, asOf: l.asOf, validUntil: l.validUntil, availableQuantity: l.availableQuantity })),
            shippingAsOf: built.evidence.shipping?.asOf ?? null,
          },
        };
      }),
  };
}

export const quotePreviewV2Output = quotePreviewOutput.omit({ quoteRequest: true }).extend({
  /**
   * (R4-J3E-B) What the offer message must show so that a later customer
   * confirmation can be bound to THIS snapshot: the Sales-derived reference
   * (never typed by the customer) and the gross total. Null when blocked.
   */
  presentation: z.strictObject({ reference: z.string(), commercialVersion: z.int().nonnegative(), grossClp: z.int().nonnegative(), totalText: z.string() }).nullable(),
});
export type QuotePreviewV2Output = z.infer<typeof quotePreviewV2Output>;

/**
 * quote.preview@2 (R4-J3E-B, sales-production@6 only). The same snapshot as
 * version 1, plus the presentation the offer message must carry. issuable =
 * ready and within the snapshot limits: the customer's confirmation is read
 * later from the conversation itself, never recorded by the agent.
 */
export function quotePreviewV2Capability(deps: { readonly store: Pick<PostgresSalesStore, 'workspace' | 'commercialVersion'>; readonly catalog: CatalogPort; readonly shipping: ShippingService; readonly limits: AutonomousQuoteLimitsV6; readonly now?: () => Date }): CapabilityRegistration<QuotePreviewInput, QuotePreviewV2Output> {
  const now = deps.now ?? (() => new Date());
  return {
    definition: {
      ...readDefinition({
        capabilityId: AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview,
        description:
          'Previews the formal quote the current Sales workspace would produce: every selected item with the catalog price for its quantity (tax included), the shipping offer the customer chose (or delivery explicitly excluded), and the net, VAT and gross totals with the Quote owner arithmetic. Takes no arguments: everything comes from the workspace and the owners now. status=blocked lists what prevents a quote; limitBreaches lists autonomy limits it exceeds (it then needs a human). When ready, present the customer the lines, shipping and totals exactly as stated here, INCLUDING presentation.totalText and presentation.reference verbatim in the same message, and ask whether to issue the quote. The customer never has to type the reference.',
        owner: 'sales',
        requiredScopes: [SCOPES.catalogRead, SCOPES.shippingRead],
        freshnessTtlMs: 15 * 60_000,
        timeoutMs: 20_000,
      }),
      version: 2,
    },
    input: quotePreviewInput,
    output: quotePreviewV2Output,
    ownerValidUntil: (output) => output.evidence.validUntil,
    handler: (_input, context) =>
      domainRead(async () => {
        const taskId = context.execution.taskId;
        const workspace = await deps.store.workspace(taskId);
        const built = await buildCommercialSnapshot(deps, workspace, { signal: context.signal, correlationId: context.execution.correlationId }, now());
        if (built.status === 'blocked') {
          return {
            workspaceVersion: workspace.version, status: 'blocked' as const, previewId: null, snapshot: null,
            blockers: built.blockers.map((b) => ({ ...b, details: { ...b.details } })), limitBreaches: [], issuable: false,
            evidence: { validUntil: null, catalog: [], shippingAsOf: null }, presentation: null,
          };
        }
        const breaches = snapshotLimitBreaches(built.snapshot, deps.limits);
        const commercialVersion = await deps.store.commercialVersion(taskId);
        const gross = built.snapshot.totals.gross;
        return {
          workspaceVersion: workspace.version,
          status: 'ready' as const,
          previewId: built.previewId,
          snapshot: JSON.parse(JSON.stringify(built.snapshot)) as QuotePreviewV2Output['snapshot'],
          blockers: [],
          limitBreaches: breaches.map((b) => ({ ...b, details: { ...b.details } })),
          issuable: breaches.length === 0,
          evidence: {
            validUntil: built.evidence.validUntil,
            catalog: built.evidence.lines.map((l) => ({ itemKey: l.itemKey, asOf: l.asOf, validUntil: l.validUntil, availableQuantity: l.availableQuantity })),
            shippingAsOf: built.evidence.shipping?.asOf ?? null,
          },
          presentation: { reference: offerReference(built.previewId, commercialVersion), commercialVersion, grossClp: gross, totalText: `Total: $${formatClp(gross)} (IVA incluido)` },
        };
      }),
  };
}
