import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import {
  CUSTOMER_REF_PATTERN,
  DomainError,
  type CustomerDatePrecision,
  type CustomerLineKind,
  type CustomerPurchaseItem,
  type CustomerPurchasePage,
  type CustomerPurchasePageRequest,
  type CustomerPurpose,
  type CustomerSalesContext,
} from '@r4-adapters/domains';
import type { CustomerProfileLifecycle } from './config.js';

/**
 * Wire rules of `customer-profile.sales-context` v1-rc1 (owner commit 47db415), as R4 enforces them.
 *
 * Tolerant reader (decision R4-J4-R2, specification R4-J4-R1 §5, owner README "consumers must
 * tolerate additive fields within schemaVersion 1"):
 *   1. invariants on the ORIGINAL answer: known forbidden fields (even with a null value), the
 *      other purpose's component, foreign or echoed customerRef, schemaVersion and contract;
 *   2. allowlist projection: only the fields v1-rc1 defines survive; unknown additive fields are
 *      dropped here and are never forwarded, persisted, logged or used for any decision;
 *   3. the pinned JSON Schema (copied byte for byte from the owner, hash-checked) validates the
 *      PROJECTION, so every known field keeps its exact type, enum, pattern and requiredness;
 *   4. semantic rules: HTTP/status coherence, lifecycle, freshness, page and order;
 *   5. mapping to the CustomerProfilePort types.
 * The owner schema itself is closed (additionalProperties: false); validating the original answer
 * with it would cancel the tolerance the contract promises, so it is applied to the projection.
 */

const CONTRACT = 'customer-profile.sales-context';
const CONTRACT_DIR = new URL('../contract/', import.meta.url);
const RESPONSE_SCHEMA_FILE = 'customer-sales-context-v1.schema.json';
const REQUEST_SCHEMA_FILE = 'customer-sales-context-request-v1.schema.json';
const MAX_TTL_MS = 15 * 60_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const MAX_DEPTH = 32;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const violation = (code: string, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}) =>
  new DomainError('contract_violation', code, message, details);

// ---------------------------------------------------------------------------------------------
// Pinned schemas
// ---------------------------------------------------------------------------------------------

export class CustomerProfileContractPinError extends Error {
  override readonly name = 'CustomerProfileContractPinError';
}

type PinnedSource = { readonly ownerCommit: string; readonly revision: string; readonly files: readonly { readonly file: string; readonly sha256: string }[] };

const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => Ajv2020;

export interface PinnedContract {
  readonly ownerCommit: string;
  readonly revision: string;
  readonly validateContext: ValidateFunction;
  readonly validateRequest: ValidateFunction;
}

let pinned: PinnedContract | undefined;

/** Loads the copied v1-rc1 schemas once, refusing any byte that differs from contract/SOURCE.json. */
export function pinnedContract(): PinnedContract {
  if (pinned) return pinned;
  const source = JSON.parse(readFileSync(new URL('SOURCE.json', CONTRACT_DIR), 'utf8')) as PinnedSource;
  const load = (file: string): object => {
    const bytes = readFileSync(new URL(file, CONTRACT_DIR));
    const normalized = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    const expected = source.files.find((entry) => entry.file === `contract/${file}`)?.sha256;
    if (!expected || createHash('sha256').update(normalized).digest('hex') !== expected) {
      throw new CustomerProfileContractPinError(`contract/${file} does not match the pinned owner copy (${source.ownerCommit})`);
    }
    return JSON.parse(normalized.toString('utf8')) as object;
  };
  const response = load(RESPONSE_SCHEMA_FILE) as { $id: string };
  const request = load(REQUEST_SCHEMA_FILE);
  // Same settings as the owner's contract test: strict, strictTypes off only for the conditional
  // subschemas (`if: { properties: ... }`) that intentionally omit `type`.
  const ajv = addFormats(new Ajv2020({ strict: true, strictTypes: false, allErrors: false }));
  ajv.addSchema(response);
  const validateContext = ajv.getSchema(`${response.$id}#/$defs/contextResponse`);
  if (!validateContext) throw new CustomerProfileContractPinError('the pinned response schema has no contextResponse');
  pinned = { ownerCommit: source.ownerCommit, revision: source.revision, validateContext, validateRequest: ajv.compile(request) };
  return pinned;
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

export type WireRequest =
  | { readonly customerRef: string; readonly purpose: 'sales_context' }
  | { readonly customerRef: string; readonly purpose: 'purchase_history'; readonly page: { readonly limit: number; readonly offset: number } };

/** The request body in the contract's key order, validated against the pinned request schema. */
export function serializeRequest(request: WireRequest): string {
  const body = request.purpose === 'sales_context'
    ? { customerRef: request.customerRef, purpose: request.purpose }
    : { customerRef: request.customerRef, purpose: request.purpose, page: { limit: request.page.limit, offset: request.page.offset } };
  if (!pinnedContract().validateRequest(body)) {
    throw new DomainError('validation', 'invalid_request', 'the Customer Profile request is outside the v1-rc1 request schema');
  }
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------------------------
// 1. Invariants on the original answer
// ---------------------------------------------------------------------------------------------

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Out of the J4 purposes by contract (F2 §3): amounts, derived metrics, PrestaShop ids, SKUs, raw account data. */
const MINIMIZATION_KEYS = new Set(
  [
    'spend', 'derived', 'amount', 'amounts', 'price', 'unitPrice', 'totalSpent', 'totalSpentTaxIncl', 'totalPaid', 'totalProducts',
    'totalShipping', 'totalDiscounts', 'currency', 'monetary', 'productId', 'productAttributeId', 'id_product', 'id_product_attribute',
    'referenceAtLastPurchase', 'productRefNamespace', 'productReference', 'reference', 'sku', 'ean13', 'upc', 'isOperationalAccount',
    'customerSince', 'firstPurchased', 'firstPurchasedAt', 'firstPurchasedSourceDate', 'productRowPresent', 'lineKindBasis', 'timeOfDay',
    'utcInstant', 'orderId', 'id_order', 'orderIds',
  ].map(normalizeKey),
);

/** PII and predictive data (specification §10.3); `productName` and `nameAtLastPurchase` are allowed. */
const SENSITIVE_KEYS = new Set(
  [
    'firstname', 'lastname', 'displayName', 'name', 'email', 'phone', 'mobile', 'rut', 'address', 'orderReference', 'id_customer',
    'customerId', 'masterCustomerId', 'birthday', 'birthdate', 'gender', 'rfm', 'cluster', 'clv', 'affinity', 'intelligence',
    'prediction', 'propensity', 'churn',
  ].map(normalizeKey),
);

/** Rejects a known forbidden field anywhere in the answer, whatever its value (null included). */
export function assertNoForbiddenFields(value: unknown): void {
  const visit = (node: unknown, path: string, depth: number, parentKey: string | null): void => {
    if (depth > MAX_DEPTH) throw violation('invalid_response', 'the Customer Profile answer is nested beyond the contract');
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1, parentKey));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, entry] of Object.entries(node)) {
      const normalized = normalizeKey(key);
      const at = path === '' ? key : `${path}.${key}`;
      if (SENSITIVE_KEYS.has(normalized)) throw violation('sensitive_field_present', `the Customer Profile answer carries a sensitive field at ${safePath(at)}`, { path: safePath(at) });
      // `state` is only forbidden inside `account`: v1-rc1 reduces it to primaryState.
      if (MINIMIZATION_KEYS.has(normalized) || (parentKey === 'account' && normalized === 'state')) {
        throw violation('purpose_minimization_violated', `the Customer Profile answer carries a field outside the J4 purposes at ${safePath(at)}`, { path: safePath(at) });
      }
      visit(entry, at, depth + 1, key);
    }
  };
  visit(value, '', 0, null);
}

/** Paths are made of keys only (never values); bounded and restricted to safe characters. */
function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_.[\]]/g, '?').slice(0, 120);
}

function assertOriginalInvariants(raw: JsonObject, expected: { readonly customerRef: string; readonly purpose: CustomerPurpose }): void {
  assertNoForbiddenFields(raw);
  if (raw.schemaVersion !== 1) throw violation('unsupported_schema_version', 'the Customer Profile answer is not schemaVersion 1');
  if (raw.contract !== CONTRACT) throw violation('unsupported_contract', 'the Customer Profile answer names another contract');
  if (typeof raw.customerRef === 'string' && !CUSTOMER_REF_PATTERN.test(raw.customerRef)) {
    throw violation('foreign_customer_ref', 'the Customer Profile answer carries a customer reference outside the prestashop_customer namespace');
  }
  if (raw.customerRef !== expected.customerRef) throw violation('customer_ref_mismatch', 'the Customer Profile answer is about another customer reference');
  if (raw.purpose !== expected.purpose) throw violation('purpose_mismatch', 'the Customer Profile answer is for another purpose');
  const facts = raw.facts;
  if (facts !== null && typeof facts === 'object' && !Array.isArray(facts)) {
    const other = expected.purpose === 'sales_context' ? 'purchasedProducts' : 'purchaseSummary';
    if (other in facts) throw violation('purpose_minimization_violated', `the ${expected.purpose} answer carries the component of the other purpose`, { path: `facts.${other}` });
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Allowlist projection
// ---------------------------------------------------------------------------------------------

type Shape = { readonly kind: 'leaf' } | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Shape>> } | { readonly kind: 'array'; readonly item: Shape };

const leaf: Shape = { kind: 'leaf' };
const object = (fields: Record<string, Shape>): Shape => ({ kind: 'object', fields });
const array = (item: Shape): Shape => ({ kind: 'array', item });
const leaves = (...names: string[]) => Object.fromEntries(names.map((name) => [name, leaf]));

const POLICY = object(leaves('policyVersion', 'purchaseEligibility', 'validityIsAsOf', 'orderUnit', 'splitCheckoutsMayCountMultipleTimes', 'channelPolicy', 'inheritsAllRowsArePaidRule'));
const FACTS: Record<CustomerPurpose, Shape> = {
  sales_context: object({ meaning: leaf, policy: POLICY, purchaseSummary: object(leaves('status', 'reason', 'hasValidOrders')) }),
  purchase_history: object({
    meaning: leaf,
    policy: POLICY,
    purchasedProducts: object({
      ...leaves('status', 'reason'),
      items: array(object(leaves('nameAtLastPurchase', 'catalogKey', 'quantityPurchasedGross', 'validOrderCount', 'lastPurchasedSourceDate', 'lineKind'))),
      page: object(leaves('limit', 'offset', 'returned', 'hasMore', 'order')),
    }),
  }),
};

const responseShape = (purpose: CustomerPurpose): Shape =>
  object({
    ...leaves('schemaVersion', 'contract', 'purpose', 'status', 'completeness', 'customerRef', 'limitations', 'warnings'),
    statusDetail: object(leaves('code', 'retryable')),
    account: object(leaves('primaryState')),
    facts: FACTS[purpose],
    freshness: object({ ...leaves('asOf', 'validUntil', 'source'), cache: object(leaves('hit', 'ageMs')) }),
    provenance: object({
      ...leaves('service', 'contract', 'contractStatus', 'serviceBuildRef', 'authorizationBasis', 'sources', 'timezoneStatus', 'correlationId'),
      policyVersions: object(leaves('facts', 'operationalAccounts', 'administrativeLines')),
    }),
  });

/** Keeps only the fields the shape names. A value of the wrong kind is kept as is: the schema rejects it. */
export function project(value: Json, shape: Shape): Json {
  if (shape.kind === 'leaf') return value;
  if (shape.kind === 'array') return Array.isArray(value) ? value.map((entry) => project(entry, shape.item)) : value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: JsonObject = {};
  for (const [key, fieldShape] of Object.entries(shape.fields)) {
    if (Object.hasOwn(value, key)) out[key] = project(value[key]!, fieldShape);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 3–5. Schema on the projection, semantic rules, mapping
// ---------------------------------------------------------------------------------------------

type ContextAnswer = {
  schemaVersion: 1;
  purpose: CustomerPurpose;
  status: 'available' | 'not_found' | 'not_applicable' | 'degraded';
  statusDetail: { code: string; retryable: boolean } | null;
  completeness: 'complete' | 'partial' | null;
  customerRef: string;
  account: { primaryState: 'active' | 'inactive' | 'guest' | 'deleted' | 'operational' } | null;
  facts: null | {
    policy: { policyVersion: string };
    purchaseSummary?: { status: 'available' | 'unavailable'; reason: string | null; hasValidOrders: boolean | null };
    purchasedProducts?: {
      status: 'available' | 'unavailable';
      reason: string | null;
      items: { nameAtLastPurchase: string | null; catalogKey: null; quantityPurchasedGross: number; validOrderCount: number; lastPurchasedSourceDate: string; lineKind: CustomerLineKind }[] | null;
      page: { limit: number; offset: number; returned: number; hasMore: boolean } | null;
    };
  };
  freshness: { asOf: string; validUntil: string | null };
  provenance: {
    contractStatus: 'candidate' | 'approved' | 'deprecated';
    serviceBuildRef: string | null;
    authorizationBasis: 'service_scope_only' | 'customer_grant_verified';
    policyVersions: { facts: string };
    timezoneStatus: 'unverified' | 'confirmed_utc' | 'confirmed_america_santiago';
    correlationId: string | null;
  };
  warnings: string[];
};

/** What R4 keeps about an accepted answer for telemetry: codes only, never facts. */
export interface AnswerDiagnostics {
  readonly cpStatus: ContextAnswer['status'];
  readonly cpStatusCode: string | null;
  readonly primaryState: string | null;
  readonly completeness: string | null;
  readonly contractStatus: string;
  readonly authorizationBasis: string;
  readonly policyVersion: string | null;
  readonly serviceBuildRef: string | null;
  readonly timezoneStatus: string;
  readonly correlationEcho: string | null;
}

export interface ReadContext {
  readonly customerRef: string;
  readonly purpose: CustomerPurpose;
  readonly page?: CustomerPurchasePageRequest;
  readonly httpStatus: 200 | 503;
  readonly lifecycle: CustomerProfileLifecycle;
  /** True only when R4 sent a per-customer grant (never, until D2). */
  readonly grantSent: boolean;
  readonly now: Date;
}

/** Steps 1–4: returns the validated projection of a 200/503 answer, or throws a contract_violation. */
export function readContextAnswer(raw: unknown, context: ReadContext): { answer: ContextAnswer; diagnostics: AnswerDiagnostics } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw violation('invalid_response', 'the Customer Profile answer is not a JSON object');
  assertOriginalInvariants(raw as JsonObject, context);

  const projected = project(raw as JsonObject, responseShape(context.purpose));
  const validate = pinnedContract().validateContext;
  if (!validate(projected)) {
    const first = validate.errors?.[0];
    throw violation('invalid_response', `the Customer Profile answer violates the pinned v1-rc1 schema at ${safePath(first?.instancePath || '/')}`, {
      schemaPath: safePath(first?.instancePath || '/'),
      keyword: first?.keyword ?? null,
    });
  }
  const answer = projected as unknown as ContextAnswer;

  // HTTP and status agree: 503 is exactly the degraded envelope.
  if ((context.httpStatus === 503) !== (answer.status === 'degraded')) {
    throw violation('invalid_response', `HTTP ${context.httpStatus} does not match status ${answer.status}`, { httpStatus: context.httpStatus });
  }

  // Lifecycle (AP-05). R4 never sent a grant, so an answer claiming a verified grant is incoherent.
  const { contractStatus, authorizationBasis } = answer.provenance;
  if (authorizationBasis === 'customer_grant_verified' && !context.grantSent) {
    throw violation('authorization_basis_incoherent', 'the Customer Profile answer claims a verified customer grant that R4 never sent');
  }
  if (contractStatus === 'deprecated') throw violation('contract_not_approved', 'the Customer Profile contract is deprecated');
  if (context.lifecycle === 'real') {
    if (contractStatus !== 'approved') throw violation('contract_not_approved', 'a real Customer binding requires contractStatus approved');
    if (authorizationBasis !== 'customer_grant_verified') throw violation('authorization_basis_insufficient', 'a real Customer binding requires a verified customer grant');
  }

  // SR-01: the facts policy and the provenance declare the same version.
  if (answer.facts !== null && answer.facts.policy.policyVersion !== answer.provenance.policyVersions.facts) {
    throw violation('invalid_response', 'the facts policy version does not match the provenance');
  }

  assertFreshness(answer, context.now);

  // SR-09: a partial answer says so.
  if (answer.completeness === 'partial' && !answer.warnings.includes('partial_context')) throw violation('invalid_response', 'a partial answer without partial_context');

  if (context.purpose === 'purchase_history') assertPage(answer, context.page!);

  return {
    answer,
    diagnostics: {
      cpStatus: answer.status,
      cpStatusCode: answer.statusDetail?.code ?? null,
      primaryState: answer.account?.primaryState ?? null,
      completeness: answer.completeness,
      contractStatus,
      authorizationBasis,
      policyVersion: answer.facts?.policy.policyVersion ?? null,
      serviceBuildRef: answer.provenance.serviceBuildRef,
      timezoneStatus: answer.provenance.timezoneStatus,
      correlationEcho: answer.provenance.correlationId,
    },
  };
}

function assertFreshness(answer: ContextAnswer, now: Date): void {
  const asOf = Date.parse(answer.freshness.asOf);
  if (asOf > now.getTime() + FUTURE_SKEW_MS) throw violation('freshness_incoherent', 'the Customer Profile answer is dated in the future');
  const { validUntil } = answer.freshness;
  if (answer.status === 'degraded') {
    if (validUntil !== null) throw violation('freshness_incoherent', 'a degraded answer declares a validity');
    return;
  }
  if (validUntil === null) return;
  const ttl = Date.parse(validUntil) - asOf;
  if (!(ttl > 0 && ttl <= MAX_TTL_MS)) throw violation('freshness_incoherent', 'validUntil is not within 15 minutes after asOf');
  if (Date.parse(validUntil) <= now.getTime()) throw violation('freshness_expired', 'the Customer Profile facts had already expired when they arrived');
}

function assertPage(answer: ContextAnswer, requested: CustomerPurchasePageRequest): void {
  const products = answer.facts?.purchasedProducts;
  if (answer.status !== 'available' || !products || products.status !== 'available') return;
  const items = products.items!;
  const page = products.page!;
  if (page.limit !== requested.limit || page.offset !== requested.offset) throw violation('page_incoherent', 'the Customer Profile page is not the requested one');
  if (page.returned !== items.length || items.length > page.limit) throw violation('page_incoherent', 'page.returned does not match the items');
  if (items.length < page.limit && page.hasMore) throw violation('page_incoherent', 'a short page claims more items');
  for (let index = 1; index < items.length; index += 1) {
    if (items[index]!.lastPurchasedSourceDate > items[index - 1]!.lastPurchasedSourceDate) throw violation('order_violation', 'the Customer Profile page is not in the declared order');
  }
}

/** Primary states whose facts are not disclosed (AP-09; guest and inactive provisionally). */
const DISCLOSABLE = new Set(['active']);

export function toSalesContext(answer: ContextAnswer): CustomerSalesContext {
  const validUntil = answer.freshness.validUntil;
  if (answer.status === 'not_found') return { status: 'not_found', validUntil };
  if (answer.status === 'not_applicable' || !DISCLOSABLE.has(answer.account!.primaryState)) return { status: 'withheld', validUntil };
  const summary = answer.facts!.purchaseSummary!;
  const purchaseHistory = summary.status !== 'available' ? 'unknown' : summary.hasValidOrders ? 'present' : 'none';
  return { status: 'available', purchaseHistory, validUntil };
}

export function toPurchasePage(answer: ContextAnswer): CustomerPurchasePage {
  const validUntil = answer.freshness.validUntil;
  if (answer.status === 'not_found') return { status: 'not_found', validUntil };
  if (answer.status === 'not_applicable' || !DISCLOSABLE.has(answer.account!.primaryState)) return { status: 'withheld', validUntil };
  const products = answer.facts!.purchasedProducts!;
  // Never a partial list: an unavailable component is a failure (specification §5, §7 case 9).
  if (products.status !== 'available') {
    throw new DomainError('temporarily_unavailable', 'history_unavailable', 'the Customer Profile purchase history is not available', { ownerReason: products.reason });
  }
  const page = products.page!;
  const datePrecision: CustomerDatePrecision = answer.provenance.timezoneStatus === 'unverified' ? 'day_timezone_unverified' : 'day';
  const items: CustomerPurchaseItem[] = products.items!.map((item) => ({
    productName: item.nameAtLastPurchase,
    catalogKey: item.catalogKey,
    lastPurchasedOn: item.lastPurchasedSourceDate,
    totalQuantity: item.quantityPurchasedGross,
    orderCount: item.validOrderCount,
    lineKind: item.lineKind,
  }));
  return {
    status: 'available',
    items,
    offset: page.offset,
    hasMore: page.hasMore,
    nextOffset: page.hasMore ? page.offset + page.returned : null,
    datePrecision,
    validUntil,
  };
}

/** Owner error codes are diagnostics only: kept when they look like a code, never echoed otherwise. */
export function ownerCodeOf(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

export function requiredScopeOf(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z]+(\.[a-z_]+)+$/.test(value) ? value : null;
}
