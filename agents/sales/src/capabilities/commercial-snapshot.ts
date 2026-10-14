import { createHash } from 'node:crypto';
import {
  DomainError,
  canonicalJson,
  canonicalTaxRate,
  normalizeCommuneName,
  quoteV2ChargeAmounts,
  quoteV2Totals,
  type CallOptions,
  type CatalogPort,
  type QuoteV2Amounts,
  type QuoteV2CreateRequest,
  type QuoteV2LineInput,
  type QuoteV2ShippingInput,
  type ShippingService,
} from '@r4-adapters/domains';
import type { Workspace } from '../workspace/model.js';
import { CATALOG_SOURCE_SYSTEM, SHIPPING_SOURCE_SYSTEM } from './quote-v2.js';
import { resolveOrderBasis } from './shipping-basis.js';
import { SHIPPING_FRESHNESS_TTL_MS } from './shipping.js';

/**
 * (R4-J3E) The commercial snapshot: what one quote would contain, resolved
 * deterministically from the Sales workspace (selection, quantities,
 * destination, the customer's shipping choice) and the owners' CURRENT data
 * (Catalog item price for the quantity tier, tax, sellability, stock;
 * Shipping offer for the order) with the Quote V2 normative arithmetic.
 *
 * The model contributes nothing to it: no price, quantity, total, customer
 * datum or shipping amount comes from model output. `previewId` is the
 * SHA-256 of its canonical form, so it names exactly one commercial content
 * (schema, lines, unit prices, tax, shipping, totals, customer) — never a
 * moment: owner timestamps are evidence, outside the hash. Recomputing the
 * snapshot with the same workspace and the same owner facts always yields
 * the same id; any change of product, quantity, destination, shipping
 * choice or price yields another.
 *
 * A previewId is a name, not an authorization: quote.create@3 recomputes the
 * snapshot from the owners at execution and issues only when the recomputed
 * id equals the one the customer asked for.
 */
export const COMMERCIAL_SNAPSHOT_SCHEMA = 'r4-sales-commercial-snapshot-v1';

export interface CommercialSnapshotLine {
  readonly position: number;
  readonly itemKey: string;
  readonly productRef: string;
  readonly variantRef: string | null;
  readonly sku: string | null;
  readonly description: string;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly quantity: number;
  /** The Catalog's tax-included unit price for this quantity tier. */
  readonly unitPrice: { readonly amount: number; readonly taxBasis: 'included'; readonly taxRate: string };
  readonly amounts: QuoteV2Amounts;
}

export type CommercialSnapshotShipping =
  | { readonly kind: 'excluded' }
  | {
      readonly kind: 'selected';
      readonly carrierName: string;
      readonly serviceType: string | null;
      readonly commune: string;
      readonly region: string | null;
      /** The Shipping owner's NET price for this order now (tax excluded; Quote applies the rate). */
      readonly amount: { readonly amount: number; readonly taxBasis: 'excluded'; readonly taxRate: string };
      readonly amounts: QuoteV2Amounts;
    };

export interface CommercialSnapshot {
  readonly schema: typeof COMMERCIAL_SNAPSHOT_SCHEMA;
  readonly currency: 'CLP';
  /** Customer identity is UNAVAILABLE in R4: an autonomous quote is a guest quote and carries no personal data. */
  readonly customer: { readonly kind: 'guest' };
  readonly lines: readonly CommercialSnapshotLine[];
  readonly shipping: CommercialSnapshotShipping;
  readonly totals: QuoteV2Amounts;
}

/** Owner evidence behind a snapshot (outside the hash). */
export interface CommercialEvidence {
  readonly lines: readonly { readonly itemKey: string; readonly asOf: string; readonly validUntil: string | null; readonly pricingReference: string | null; readonly availableQuantity: number | null }[];
  readonly shipping: { readonly asOf: string; readonly reference: string | null } | null;
  /** The earliest instant any owner fact behind the snapshot stops being current (Catalog validity; Shipping R4 bound). */
  readonly validUntil: string | null;
}

export interface CommercialBlocker {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export type CommercialSnapshotResult =
  | { readonly status: 'ready'; readonly previewId: string; readonly snapshot: CommercialSnapshot; readonly evidence: CommercialEvidence }
  | { readonly status: 'blocked'; readonly blockers: readonly CommercialBlocker[] };

/** Owner `Text`: no control characters, no leading or trailing whitespace (same rule quote.create@2 applies). */
const OWNER_TEXT = /^[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u;
/** Owner `OpaqueReference`. */
const OPAQUE_REFERENCE = /^[!-~](?:[ -~]{0,198}[!-~])?$/;

export function previewIdOf(snapshot: CommercialSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/**
 * Resolves the snapshot for the workspace as it is. Never throws for a
 * commercial reason: those are blockers. Throws `DomainError` only when an
 * owner could not answer (outage, timeout): nothing can be concluded then.
 */
export async function buildCommercialSnapshot(deps: { readonly catalog: CatalogPort; readonly shipping: ShippingService }, workspace: Workspace, options: CallOptions, now: Date): Promise<CommercialSnapshotResult> {
  const blockers: CommercialBlocker[] = [];
  const block = (code: string, message: string, details: Record<string, string | number | boolean | null> = {}) => blockers.push({ code, message, details });
  const state = workspace.state;
  if (state.items.length === 0) block('selection_empty', 'no product is selected in the workspace');

  const lines: CommercialSnapshotLine[] = [];
  const evidenceLines: CommercialEvidence['lines'][number][] = [];
  for (const [index, selected] of state.items.entries()) {
    const at = { line: index + 1, itemKey: selected.productId };
    const item = await deps.catalog.getItemContext({ itemKey: selected.productId, quantity: selected.quantity }, options);
    if (item.status !== 'found') {
      block('item_not_sellable', `${selected.productId} is not a sellable catalog item (${item.status})`, at);
      continue;
    }
    if (item.availability.sellability !== 'sellable') {
      block('item_not_sellable', `${item.parentProduct.name} is ${item.availability.sellability}`, { ...at, reason: item.availability.reason });
      continue;
    }
    if (item.availability.availableQuantity !== null && item.availability.availableQuantity < selected.quantity) {
      block('insufficient_stock', `only ${item.availability.availableQuantity} units of ${item.parentProduct.name} are available`, { ...at, available: item.availability.availableQuantity, requested: selected.quantity });
      continue;
    }
    if (item.freshness.validUntil !== null && Date.parse(item.freshness.validUntil) <= now.getTime()) {
      block('catalog_evidence_stale', 'the catalog answer is already past its owner validity', at);
      continue;
    }
    if (item.pricing.status !== 'available') {
      block('item_price_unavailable', `the catalog has no price for ${selected.productId}`, { ...at, reason: item.pricing.reason });
      continue;
    }
    if (item.pricing.quantity !== selected.quantity) {
      block('item_price_tier_mismatch', 'the catalog priced a different quantity tier', { ...at, pricedQuantity: item.pricing.quantity });
      continue;
    }
    const taxRate = canonicalTaxRate(item.pricing.tax.rate);
    if (taxRate === null) {
      block('item_tax_unrepresentable', 'the catalog tax rate cannot be stated on a quote', at);
      continue;
    }
    const description = ownerText(item.parentProduct.name, 300);
    const attributes = item.variant.attributes.map((a) => ({ name: ownerText(a.group, 60), value: ownerText(a.value, 120) }));
    if (!description || attributes.length > 10 || attributes.some((a) => !a.name || !a.value)) {
      block('catalog_text_unusable', 'the catalog description of an item cannot be printed on a quote', at);
      continue;
    }
    const rawSku = item.variant.sku ?? item.parentProduct.sku;
    const unitPrice = { amount: item.pricing.finalGross.amount, taxBasis: 'included' as const, taxRate };
    lines.push({
      position: lines.length + 1,
      itemKey: selected.productId,
      productRef: item.ref.productId,
      variantRef: item.ref.variantId,
      sku: rawSku ? ownerText(rawSku, 100) : null,
      description,
      attributes: attributes as { name: string; value: string }[],
      quantity: selected.quantity,
      unitPrice,
      amounts: quoteV2ChargeAmounts(unitPrice, String(selected.quantity)),
    });
    evidenceLines.push({ itemKey: selected.productId, asOf: item.freshness.asOf, validUntil: item.freshness.validUntil, pricingReference: OPAQUE_REFERENCE.test(item.pricing.engineVersion) ? item.pricing.engineVersion : null, availableQuantity: item.availability.availableQuantity });
  }

  let shipping: CommercialSnapshotShipping | null = null;
  let shippingEvidence: CommercialEvidence['shipping'] = null;
  const choice = state.shipping ?? null;
  const delivery = state.delivery;
  if (delivery && choice?.kind !== 'selected') {
    block('shipping_not_selected', 'a delivery destination is recorded: the customer must choose one shipping offer (or the destination must be cleared and delivery excluded)', { commune: delivery.commune });
  } else if (!delivery && choice?.kind !== 'excluded') {
    block('shipping_not_decided', 'no delivery destination is recorded and delivery was not explicitly excluded');
  } else if (!delivery) {
    shipping = { kind: 'excluded' };
  } else if (choice?.kind === 'selected') {
    if (normalizeCommuneName(choice.commune) !== normalizeCommuneName(delivery.commune)) {
      block('shipping_destination_mismatch', 'the chosen shipping offer was for another destination', { chosenFor: choice.commune, destination: delivery.commune });
    } else if (lines.length === state.items.length && lines.length > 0) {
      const resolved = await quoteShipping(deps, lines, delivery.commune, options);
      if (resolved.kind === 'blocked') {
        block(resolved.code, resolved.message, resolved.details);
      } else {
        const quote = resolved.quote;
        const offer = quote.offers.find((o) => o.carrierName === choice.carrierName && o.serviceType === choice.serviceType);
        if (!quote.serviceable || !offer) {
          block('shipping_offer_unavailable', `the shipping owner no longer offers ${choice.carrierName} ${choice.serviceType} for this order`, { carrierName: choice.carrierName, serviceType: choice.serviceType });
        } else if (offer.price.ownerNet.amount !== choice.agreedOwnerNetClp) {
          block('shipping_offer_changed', `the shipping owner now prices ${choice.carrierName} ${choice.serviceType} at ${offer.price.ownerNet.amount} CLP net, not the ${choice.agreedOwnerNetClp} CLP the customer chose`, { agreedOwnerNet: choice.agreedOwnerNetClp, currentOwnerNet: offer.price.ownerNet.amount });
        } else {
          const taxRate = canonicalTaxRate(offer.price.tax.rate);
          const commune = ownerText(quote.destination.communeName, 80);
          const carrierName = ownerText(offer.carrierName, 120);
          if (taxRate === null) block('shipping_tax_unrepresentable', 'the shipping tax rate cannot be stated on a quote');
          else if (!commune || !carrierName) block('shipping_text_unusable', 'the shipping owner answer cannot be printed on a quote');
          else {
            const amount = { amount: offer.price.ownerNet.amount, taxBasis: 'excluded' as const, taxRate };
            shipping = { kind: 'selected', carrierName, serviceType: ownerText(offer.serviceType, 120), commune, region: ownerText(quote.destination.regionName, 80), amount, amounts: quoteV2ChargeAmounts(amount, '1') };
            shippingEvidence = { asOf: quote.asOf, reference: OPAQUE_REFERENCE.test(quote.provenance.endpoint) ? quote.provenance.endpoint : null };
          }
        }
      }
    }
  }

  if (blockers.length > 0 || !shipping) return { status: 'blocked', blockers };
  const totals = quoteV2Totals({ lines: lines.map(lineInput), ...(shipping.kind === 'selected' ? { shipping: shippingInput(shipping, null) } : {}) });
  const snapshot: CommercialSnapshot = { schema: COMMERCIAL_SNAPSHOT_SCHEMA, currency: 'CLP', customer: { kind: 'guest' }, lines, shipping, totals: { net: totals.net, tax: totals.tax, gross: totals.gross } };
  const validities = [...evidenceLines.map((l) => l.validUntil), shippingEvidence ? new Date(Date.parse(shippingEvidence.asOf) + SHIPPING_FRESHNESS_TTL_MS).toISOString() : null].filter((v): v is string => v !== null);
  const validUntil = validities.length > 0 ? validities.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
  return { status: 'ready', previewId: previewIdOf(snapshot), snapshot, evidence: { lines: evidenceLines, shipping: shippingEvidence, validUntil } };
}

/**
 * The exact Quote V2 CreateQuoteRequest for a ready snapshot: the same body
 * shape quote.create@2 sends (Model B), customer = guest, expectedTotals =
 * the snapshot totals (the owner refuses any arithmetic difference with 422).
 */
export function quoteRequestOf(snapshot: CommercialSnapshot, evidence: CommercialEvidence, correlation: QuoteV2CreateRequest['externalCorrelation']): QuoteV2CreateRequest {
  const asOf = new Map(evidence.lines.map((l) => [l.itemKey, l]));
  return {
    externalCorrelation: { ...correlation },
    customer: { kind: 'guest' },
    lines: snapshot.lines.map((line) => {
      const proof = asOf.get(line.itemKey)!;
      return { ...lineInput(line), pricingProvenance: { sourceSystem: CATALOG_SOURCE_SYSTEM, ...(proof.pricingReference ? { reference: proof.pricingReference } : {}), asOf: proof.asOf } };
    }),
    ...(snapshot.shipping.kind === 'selected' ? { shipping: shippingInput(snapshot.shipping, evidence.shipping) } : {}),
    expectedTotals: { ...snapshot.totals },
  };
}

function lineInput(line: CommercialSnapshotLine): QuoteV2LineInput {
  return {
    kind: 'product',
    item: {
      sourceSystem: CATALOG_SOURCE_SYSTEM,
      productRef: line.productRef,
      ...(line.variantRef !== null ? { variantRef: line.variantRef } : {}),
      ...(line.sku ? { sku: line.sku } : {}),
      description: line.description,
      ...(line.attributes.length > 0 ? { attributes: line.attributes.map((a) => ({ ...a })) } : {}),
    },
    quantity: { value: String(line.quantity), unit: 'unit' },
    unitPrice: { ...line.unitPrice },
  };
}

function shippingInput(shipping: Extract<CommercialSnapshotShipping, { kind: 'selected' }>, evidence: CommercialEvidence['shipping']): QuoteV2ShippingInput {
  return {
    carrier: { name: shipping.carrierName },
    ...(shipping.serviceType ? { serviceType: { name: shipping.serviceType } } : {}),
    destination: { commune: shipping.commune, ...(shipping.region ? { region: shipping.region } : {}), country: 'CL' },
    amount: { ...shipping.amount },
    ...(evidence ? { sourceQuote: { sourceSystem: SHIPPING_SOURCE_SYSTEM, ...(evidence.reference ? { reference: evidence.reference } : {}), asOf: evidence.asOf } } : {}),
  };
}

type ShippingResolution =
  | { readonly kind: 'quoted'; readonly quote: Awaited<ReturnType<ShippingService['quote']>> }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string; readonly details: Record<string, string | number | boolean | null> };

/** A fresh order-basis Shipping quote for these lines. Validation answers are blockers; outages propagate. */
async function quoteShipping(deps: { readonly catalog: CatalogPort; readonly shipping: ShippingService }, lines: readonly CommercialSnapshotLine[], commune: string, options: CallOptions): Promise<ShippingResolution> {
  try {
    const basis = await resolveOrderBasis(deps.catalog, lines.map((l) => ({ productId: l.itemKey, quantity: l.quantity })), options);
    return { kind: 'quoted', quote: await deps.shipping.quote({ destination: { commune }, basis: { type: 'order', ...basis } }, options) };
  } catch (error) {
    if (error instanceof DomainError && (error.category === 'validation' || error.category === 'not_found')) {
      return { kind: 'blocked', code: 'shipping_not_quotable', message: `the order cannot be priced for delivery: ${error.message}`, details: { ownerCode: error.code } };
    }
    throw error;
  }
}

/** Owner text as-is (trimmed), or null when it cannot be printed (control characters, empty, too long). */
function ownerText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 && trimmed.length <= max && OWNER_TEXT.test(trimmed) ? trimmed : null;
}
