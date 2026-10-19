import { z } from 'zod';
import {
  CATALOG_KEY_PATTERN,
  DomainError,
  type CallOptions,
  type CustomerAccessGrant,
  type CustomerProfilePort,
  type CustomerPurpose,
  type IdentityResolution,
} from '@r4-adapters/domains';

/**
 * R4-J4-R2: boundary C of ADR-039 (what the model may observe), for the future
 * `customer.get_context@2` and `customer.get_purchase_history@1` (specification R4-J4-R1 §6, §7).
 *
 * NOT REGISTERED: no capability registry, profile or definition references this module (J4-R4
 * registers them in sales-production@8, not authorized). It fixes the input and output schemas,
 * the allowlist projection from the CustomerProfilePort and the byte bounds, so that:
 * - the purpose is the capability's (each reader calls exactly one port operation);
 * - the inputs carry no identifier: the customer comes only from an identity resolution
 *   (J4-R3), never from the model;
 * - no customer reference, grant, account state, lineKind or unknown field reaches the output;
 * - an output above its byte bound fails the invocation without any partial payload.
 */

const timestamp = z.iso.datetime({ offset: false });
const isoDate = z.iso.date();

export const UNAVAILABLE_REASONS = ['anonymous', 'not_linked', 'not_verified', 'not_authorized', 'not_on_file', 'withheld'] as const;
const unavailable = z.strictObject({ identity: z.literal('unavailable'), reason: z.enum(UNAVAILABLE_REASONS) });

export const customerContextV2Input = z.strictObject({});
export const customerContextV2Output = z.union([
  unavailable,
  z.strictObject({ identity: z.literal('verified'), purchaseHistory: z.enum(['present', 'none', 'unknown']), validUntil: timestamp }),
]);

export const PURCHASE_HISTORY_MAX_OFFSET = 40;
export const customerPurchaseHistoryV1Input = z.strictObject({
  offset: z.int().min(0).max(PURCHASE_HISTORY_MAX_OFFSET).default(0),
  limit: z.int().min(1).max(10).default(5),
});
export const customerPurchaseHistoryV1Output = z.union([
  unavailable,
  z.strictObject({
    identity: z.literal('verified'),
    meaning: z.literal('purchased_historically_not_ownership'),
    quantityBasis: z.literal('gross_units_not_net_of_returns'),
    datePrecision: z.enum(['day', 'day_timezone_unverified']),
    items: z
      .array(
        z.strictObject({
          productName: z.string().min(1).max(120).nullable(),
          catalogKey: z.string().regex(CATALOG_KEY_PATTERN).nullable(),
          lastPurchasedOn: isoDate,
          totalQuantity: z.int().min(0),
          orderCount: z.int().min(1),
        }),
      )
      .max(10),
    page: z.strictObject({ offset: z.int().min(0), returned: z.int().min(0), hasMore: z.boolean(), nextOffset: z.int().nullable() }),
    validUntil: timestamp,
  }),
]);

export type CustomerContextV2Output = z.infer<typeof customerContextV2Output>;
export type CustomerPurchaseHistoryV1Output = z.infer<typeof customerPurchaseHistoryV1Output>;

/** Serialized output bounds, UTF-8 bytes (specification §8). */
export const CONTEXT_OUTPUT_MAX_BYTES = 300;
export const HISTORY_OUTPUT_MAX_BYTES = 8 * 1024;
const NAME_MAX_CODE_POINTS = 120;

/** Deterministic truncation to 120 code points (119 + `…`), never splitting a surrogate pair. */
export function boundedProductName(name: string | null): string | null {
  if (name === null) return null;
  const codePoints = [...name];
  return codePoints.length <= NAME_MAX_CODE_POINTS ? name : `${codePoints.slice(0, NAME_MAX_CODE_POINTS - 1).join('')}…`;
}

/** Fails the invocation when the serialized output exceeds its bound: nothing is cut to fit. */
export function assertOutputBytes(output: unknown, maxBytes: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  if (bytes > maxBytes) throw new DomainError('contract_violation', 'output_too_large', `the capability output is ${bytes} bytes, above ${maxBytes}`, { bytes, maxBytes });
}

type Unavailable = { identity: 'unavailable'; reason: (typeof UNAVAILABLE_REASONS)[number] };

/** §7 rows 1–4: an identity that is not verified ends here, with no Customer Profile call. */
function unavailableOf(resolution: IdentityResolution | null): Unavailable | null {
  if (resolution === null) return { identity: 'unavailable', reason: 'anonymous' };
  switch (resolution.status) {
    case 'verified':
      return null;
    case 'not_linked':
      return { identity: 'unavailable', reason: 'not_linked' };
    case 'not_authorized':
      return { identity: 'unavailable', reason: 'not_authorized' };
    default:
      // not_verified, ambiguous and conflicted are one answer to the model; telemetry keeps the status.
      return { identity: 'unavailable', reason: 'not_verified' };
  }
}

/** A verified resolution must carry a live grant covering the purpose (§4: otherwise incoherent_grant). */
function coherentGrant(resolution: Extract<IdentityResolution, { status: 'verified' }>, purpose: CustomerPurpose, now: Date): CustomerAccessGrant {
  const { grant } = resolution;
  const expiresAt = Date.parse(grant?.expiresAt ?? '');
  if (!grant || !Number.isFinite(expiresAt) || expiresAt <= now.getTime() || !grant.purposes.includes(purpose)) {
    throw new DomainError('contract_violation', 'incoherent_grant', 'the verified identity carries no live grant for this purpose');
  }
  return grant;
}

/** §7 rows 6–7: `not_on_file` only when CP has no such customer; never used to hide an existing account. */
function notDisclosed(status: 'not_found' | 'withheld'): Unavailable {
  return { identity: 'unavailable', reason: status === 'not_found' ? 'not_on_file' : 'withheld' };
}

/** min(CP validUntil ?? ∞, grant.expiresAt): always present for a verified output (§7). */
function effectiveValidUntil(cpValidUntil: string | null, grant: CustomerAccessGrant): string {
  const grantMs = Date.parse(grant.expiresAt);
  const cpMs = cpValidUntil === null ? Number.POSITIVE_INFINITY : Date.parse(cpValidUntil);
  return new Date(Math.min(cpMs, grantMs)).toISOString();
}

export async function readCustomerContextV2(
  resolution: IdentityResolution | null,
  port: Pick<CustomerProfilePort, 'getSalesContext'>,
  options: CallOptions & { readonly now: Date },
): Promise<CustomerContextV2Output> {
  const early = unavailableOf(resolution);
  if (early) return early;
  const verified = resolution as Extract<IdentityResolution, { status: 'verified' }>;
  const grant = coherentGrant(verified, 'sales_context', options.now);
  const context = await port.getSalesContext(verified.customerRef, grant, options);
  const output: CustomerContextV2Output =
    context.status !== 'available'
      ? notDisclosed(context.status)
      : { identity: 'verified', purchaseHistory: context.purchaseHistory, validUntil: effectiveValidUntil(context.validUntil, grant) };
  const parsed = customerContextV2Output.parse(output);
  assertOutputBytes(parsed, CONTEXT_OUTPUT_MAX_BYTES);
  return parsed;
}

export async function readCustomerPurchaseHistoryV1(
  resolution: IdentityResolution | null,
  input: z.input<typeof customerPurchaseHistoryV1Input>,
  port: Pick<CustomerProfilePort, 'getPurchaseHistory'>,
  options: CallOptions & { readonly now: Date },
): Promise<CustomerPurchaseHistoryV1Output> {
  const page = customerPurchaseHistoryV1Input.parse(input);
  const early = unavailableOf(resolution);
  if (early) return early;
  const verified = resolution as Extract<IdentityResolution, { status: 'verified' }>;
  const grant = coherentGrant(verified, 'purchase_history', options.now);
  const result = await port.getPurchaseHistory(verified.customerRef, grant, page, options);
  if (result.status !== 'available') return notDisclosed(result.status);

  // AP-10: an administrative service is never shown as purchased equipment; any other unknown kind
  // is excluded too. A free physical item (zero_price_line) stays.
  const shown = result.items.filter((item) => item.lineKind === 'standard' || item.lineKind === 'zero_price_line');
  const output: CustomerPurchaseHistoryV1Output = {
    identity: 'verified',
    meaning: 'purchased_historically_not_ownership',
    quantityBasis: 'gross_units_not_net_of_returns',
    datePrecision: result.datePrecision,
    items: shown.map((item) => ({
      productName: boundedProductName(item.productName),
      catalogKey: item.catalogKey,
      lastPurchasedOn: item.lastPurchasedOn,
      totalQuantity: item.totalQuantity,
      orderCount: item.orderCount,
    })),
    page: {
      offset: result.offset,
      returned: shown.length,
      hasMore: result.hasMore,
      nextOffset: result.nextOffset !== null && result.nextOffset <= PURCHASE_HISTORY_MAX_OFFSET ? result.nextOffset : null,
    },
    validUntil: effectiveValidUntil(result.validUntil, grant),
  };
  const parsed = customerPurchaseHistoryV1Output.parse(output);
  assertOutputBytes(parsed, HISTORY_OUTPUT_MAX_BYTES);
  return parsed;
}
