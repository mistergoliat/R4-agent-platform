import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  FixtureCatalog,
  FixtureQuoteV2Service,
  FixtureShipping,
  type CatalogPort,
  type QuoteV2Service,
} from '@r4-adapters/domains';
import type { WriteHandlerContext } from '@r4/capability-runtime';
import { PostgresSalesStore, migrateSales, quoteCreateV2Capability, quoteCreateV2Input, workspaceUpdateInputSchema, type QuoteCreateV2Input } from '@r4-sales/agent';
import type { Pool } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-J3B offline contract matrix of quote.create@2 against the Quote V2
 * fixture owner, the fixture Catalog and Shipping owners and a real
 * PostgreSQL `sales` schema. Every test asserts the number of quotes the
 * owner actually committed: zero duplicate issuance, zero false success.
 */
let db: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  expect((await migrateSales(pool)).applied).toEqual(['0006_sales_reference_application', '0007_sales_quote_v2_issuance', '0008_sales_autonomous_quote_decisions', '0009_sales_quote_intent_evidence']);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const NOW = new Date('2026-10-08T15:00:00Z');
const newKey = () => `r4x_${randomBytes(16).toString('hex')}`;

function world(options: { catalog?: (base: FixtureCatalog) => CatalogPort; quotes?: (base: FixtureQuoteV2Service) => QuoteV2Service; pool?: Pool } = {}) {
  const store = new PostgresSalesStore(options.pool ?? pool);
  const catalog = new FixtureCatalog({ now: () => NOW });
  const shipping = new FixtureShipping({ now: () => NOW });
  const owner = new FixtureQuoteV2Service({ now: () => NOW });
  const capability = quoteCreateV2Capability({ store, quotes: options.quotes ? options.quotes(owner) : owner, catalog: options.catalog ? options.catalog(catalog) : catalog, shipping, now: () => NOW });
  const taskId = randomUUID();
  const context = (executionKey: string, attempt = 1): WriteHandlerContext => ({
    executionKey,
    attempt,
    signal: new AbortController().signal,
    execution: { taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 4, correlationId: 'it-quote-v2', grantedScopes: ['quote.create'], actor: { kind: 'service', ref: 'sales-channel-ingress' }, identityAssurance: 'provisional' },
  });
  return {
    store,
    catalog,
    shipping,
    owner,
    capability,
    taskId,
    context,
    workspace: (operations: unknown[]) => store.applyCommand({ taskId, executionKey: newKey(), input: workspaceUpdateInputSchema.parse({ operations }), unknownProducts: [], now: NOW.toISOString() }),
    execute: (input: unknown, executionKey: string, attempt = 1) => capability.execute(quoteCreateV2Input.parse(input), context(executionKey, attempt)),
    reconcile: (executionKey: string) => capability.reconcile!(context(executionKey, 2)),
  };
}

/** Over-rides one owner method of the fixture owner (transport faults the fixture has no switch for). */
function override(base: FixtureQuoteV2Service, methods: Partial<QuoteV2Service>): QuoteV2Service {
  return {
    createAndIssue: (...a) => base.createAndIssue(...a),
    getQuote: (...a) => base.getQuote(...a),
    getOperation: (...a) => base.getOperation(...a),
    lookupIdempotency: (...a) => base.lookupIdempotency(...a),
    getDocument: (...a) => base.getDocument(...a),
    ...methods,
  };
}

// --- the synthetic solution: Barra olímpica ×1 + Barra Z ×2 delivered to Ñuñoa ------------------
// Hand-computed with the owner arithmetic: 129 990 incl. → 109 235 + 20 755; 79 980 incl. → 67 210 + 12 770;
// freight NET 12 674 (8 390 + 126 × 34 kg, Fixture Courier) excl. 19 % → 2 408; totals 189 119 / 35 933 / 225 052.
const SELECTION = [
  { op: 'add_item', productId: 'BAR-OLY20', quantity: 1 },
  { op: 'add_item', productId: 'BAR-EZ', quantity: 2 },
];
const DELIVERY = { op: 'set_delivery_destination', commune: 'Ñuñoa' };
const CUSTOMER = { kind: 'person', displayName: 'Cliente Sintético R4', email: 'synthetic.r4@example.test' } as const;
const SHIPPED: QuoteCreateV2Input = {
  workspaceVersion: 1,
  customer: CUSTOMER,
  lines: [
    { itemKey: 'BAR-OLY20', quantity: 1, unitPrice: { amount: 129_990, taxBasis: 'included', taxRate: '0.19' } },
    { itemKey: 'BAR-EZ', quantity: 2, unitPrice: { amount: 39_990, taxBasis: 'included', taxRate: '0.19' } },
  ],
  shipping: { destinationCommune: 'Ñuñoa', carrierName: 'Fixture Courier', serviceType: 'NORMAL', amount: { amount: 12_674, taxBasis: 'excluded', taxRate: '0.19' } },
  expectedTotals: { net: 189_119, tax: 35_933, gross: 225_052 },
  currency: 'CLP',
};

async function shippedWorld(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  await w.workspace([...SELECTION, DELIVERY]);
  return w;
}

describe('S01–S07 commercial snapshot → issued quote', () => {
  it('S01/S04/S07 transactional issue: verified snapshot, frozen exact body, owner-issued quote with verified PDF', async () => {
    const w = await shippedWorld();
    const key = newKey();
    const outcome = await w.execute(SHIPPED, key);
    expect(outcome).toMatchObject({
      status: 'applied',
      replayed: false,
      resourceRef: expect.stringMatching(/^quote:/),
      externalOperationRef: 'PC-000001',
      result: {
        quoteNumber: 'PC-000001',
        status: 'issued',
        totals: { net: 189_119, tax: 35_933, gross: 225_052, exemptNet: 0 },
        lines: [
          { position: 1, description: 'Barra olímpica 20 kg (2,2 m)', quantity: '1', amounts: { net: 109_235, tax: 20_755, gross: 129_990 } },
          { position: 2, description: 'Barra Z 1,2 m', quantity: '2', amounts: { net: 67_210, tax: 12_770, gross: 79_980 } },
        ],
        shipping: { carrierName: 'Fixture Courier', serviceType: 'NORMAL', commune: 'Ñuñoa', amounts: { net: 12_674, tax: 2_408, gross: 15_082 } },
        validity: { policyId: 'cl-retail-5-calendar-days-v1', issueLocalDate: '2026-10-08', validThroughLocalDate: '2026-10-12' },
        document: { verification: 'verified' },
        basedOnWorkspaceVersion: 1,
      },
    });
    // The exact owner request R4 froze before sending (and would resend on every retry).
    const frozen = (await w.store.quoteV2Request(key))!;
    expect(frozen.request).toEqual({
      externalCorrelation: { sourceSystem: 'r4-sales', externalReferenceType: 'r4-task', externalReference: w.taskId },
      customer: { kind: 'person', displayName: 'Cliente Sintético R4', email: 'synthetic.r4@example.test' },
      lines: [
        { kind: 'product', item: { sourceSystem: 'catalog-service', productRef: '105', sku: 'SC-BO20-28', description: 'Barra olímpica 20 kg (2,2 m)' }, quantity: { value: '1', unit: 'unit' }, unitPrice: { amount: 129_990, taxBasis: 'included', taxRate: '0.19' }, pricingProvenance: { sourceSystem: 'catalog-service', reference: 'fixture-1', asOf: NOW.toISOString() } },
        { kind: 'product', item: { sourceSystem: 'catalog-service', productRef: '107', sku: 'SC-EZ120', description: 'Barra Z 1,2 m' }, quantity: { value: '2', unit: 'unit' }, unitPrice: { amount: 39_990, taxBasis: 'included', taxRate: '0.19' }, pricingProvenance: { sourceSystem: 'catalog-service', reference: 'fixture-1', asOf: NOW.toISOString() } },
      ],
      shipping: { carrier: { name: 'Fixture Courier' }, serviceType: { name: 'NORMAL' }, destination: { commune: 'Ñuñoa', region: 'Metropolitana de Santiago', country: 'CL' }, amount: { amount: 12_674, taxBasis: 'excluded', taxRate: '0.19' }, sourceQuote: { sourceSystem: 'pc-carrier', reference: 'in-memory', asOf: NOW.toISOString() } },
      expectedTotals: { net: 189_119, tax: 35_933, gross: 225_052 },
    });
    expect(frozen.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await w.store.quoteV2Issued(w.taskId)).toEqual([expect.objectContaining({ executionKey: key, quoteNumber: 'PC-000001', documentVerification: 'verified', validThroughLocalDate: '2026-10-12' })]);
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('S02 Catalog provenance: variant identity, SKU and attributes are the owner\'s; no shipping when no destination', async () => {
    const w = world();
    await w.workspace([{ op: 'add_item', productId: 'KB-COMP-12', quantity: 2 }, { op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }]);
    const key = newKey();
    const outcome = await w.execute({ ...SHIPPED, customer: { kind: 'guest' }, lines: [{ itemKey: 'KB-COMP-12', quantity: 2, unitPrice: { amount: 44_990, taxBasis: 'included', taxRate: '0.19' } }, SHIPPED.lines[0]], shipping: null, expectedTotals: { net: 184_848, tax: 35_122, gross: 219_970 } }, key);
    expect(outcome).toMatchObject({ status: 'applied', result: { shipping: null, totals: { gross: 219_970 } } });
    const frozen = (await w.store.quoteV2Request(key))!.request;
    expect(frozen.lines[0]!.item).toEqual({ sourceSystem: 'catalog-service', productRef: '114', variantRef: '1141', sku: 'FL-KBC-12', description: 'Kettlebell de competición', attributes: [{ name: 'Peso', value: '12 kg' }] });
    expect(frozen.customer).toEqual({ kind: 'guest' });
    expect(frozen).not.toHaveProperty('shipping');
  });

  it('S03 quantity-dependent pricing: the unit price of the exact quantity tier, never the 1-unit or "from" price', async () => {
    const tiered = (base: FixtureCatalog): CatalogPort => ({
      search: (...a) => base.search(...a),
      getProductContext: (...a) => base.getProductContext(...a),
      getItemContext: async (request, options) => {
        const item = await base.getItemContext(request, options);
        if (item.status !== 'found' || item.pricing.status !== 'available' || request.itemKey !== 'BAR-EZ' || request.quantity < 2) return item;
        return { ...item, pricing: { ...item.pricing, finalGross: { amount: 36_990, currency: 'CLP' } } };
      },
    });
    const w = await shippedWorld({ catalog: tiered });
    const atOneUnitPrice = await w.execute(SHIPPED, newKey());
    expect(atOneUnitPrice).toMatchObject({ status: 'rejected', code: 'commercial_price_changed', details: { itemKey: 'BAR-EZ', catalogUnitGross: 36_990 } });
    // 73 980 incl. → 62 168 + 11 812; totals 184 077 / 34 975 / 219 052.
    const tier = { ...SHIPPED, lines: [SHIPPED.lines[0]!, { ...SHIPPED.lines[1]!, unitPrice: { amount: 36_990, taxBasis: 'included' as const, taxRate: '0.19' } }], expectedTotals: { net: 184_077, tax: 34_975, gross: 219_052 } };
    expect(await w.execute(tier, newKey())).toMatchObject({ status: 'applied', result: { lines: [{}, { amounts: { net: 62_168, tax: 11_812, gross: 73_980 } }], totals: { gross: 219_052 } } });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('S05 a tax treatment that differs from the Catalog owner\'s is refused (products are tax-included; excluded/exempt are not representable for them)', async () => {
    const otherRate = (base: FixtureCatalog): CatalogPort => ({
      search: (...a) => base.search(...a),
      getProductContext: (...a) => base.getProductContext(...a),
      getItemContext: async (request, options) => {
        const item = await base.getItemContext(request, options);
        return item.status === 'found' && item.pricing.status === 'available' ? ({ ...item, pricing: { ...item.pricing, tax: { ...item.pricing.tax, rate: 0.105 } } }) : item;
      },
    });
    const w = await shippedWorld({ catalog: otherRate });
    expect(await w.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'commercial_price_changed', details: { catalogTaxRate: '0.105' } });
    expect(quoteCreateV2Input.safeParse({ ...SHIPPED, lines: [{ ...SHIPPED.lines[0], unitPrice: { amount: 1, taxBasis: 'exempt' } }] }).success).toBe(false);
    expect(w.owner.createCalls).toBe(0);
  });
});

describe('S08–S11 fail closed before anything is sent', () => {
  it('S08 shipping requested (destination set) but no offer selected → refused; no shipping silently omitted', async () => {
    const w = await shippedWorld();
    expect(await w.execute({ ...SHIPPED, shipping: null, expectedTotals: { net: 176_445, tax: 33_525, gross: 209_970 } }, newKey())).toMatchObject({ status: 'rejected', code: 'shipping_not_selected' });
    const noDestination = world();
    await noDestination.workspace(SELECTION);
    expect(await noDestination.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'shipping_without_destination' });
    expect(await w.execute({ ...SHIPPED, shipping: { ...SHIPPED.shipping!, destinationCommune: 'Providencia' } }, newKey())).toMatchObject({ status: 'rejected', code: 'shipping_destination_mismatch' });
    expect(w.owner.createCalls + noDestination.owner.createCalls).toBe(0);
  });

  it('S09 changed or stale commercial evidence → refused (no silent repricing): price, stock, shipping, workspace', async () => {
    const w = await shippedWorld();
    w.catalog.setPrice('BAR-OLY20', 124_990);
    expect(await w.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'commercial_price_changed', details: { catalogUnitGross: 124_990 } });
    w.catalog.setPrice('BAR-OLY20', 129_990);
    w.catalog.setStock('BAR-EZ', 1);
    expect(await w.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'insufficient_stock' });
    w.catalog.setStock('BAR-EZ', 20);
    expect(await w.execute({ ...SHIPPED, shipping: { ...SHIPPED.shipping!, amount: { ...SHIPPED.shipping!.amount, amount: 11_990 } } }, newKey())).toMatchObject({ status: 'rejected', code: 'shipping_offer_changed', details: { currentOwnerNet: 12_674 } });
    expect(await w.execute({ ...SHIPPED, shipping: { ...SHIPPED.shipping!, carrierName: 'Invented Carrier' } }, newKey())).toMatchObject({ status: 'rejected', code: 'shipping_offer_changed', details: { currentOwnerNet: null } });
    expect(await w.execute({ ...SHIPPED, lines: [SHIPPED.lines[0]!] }, newKey())).toMatchObject({ status: 'rejected', code: 'quote_lines_not_selection' });
    await w.workspace([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 3 }]);
    expect(await w.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'workspace_version_mismatch', details: { currentVersion: 2 } });
    const stale = (base: FixtureCatalog): CatalogPort => ({
      search: (...a) => base.search(...a),
      getProductContext: (...a) => base.getProductContext(...a),
      getItemContext: async (r, o) => {
        const item = await base.getItemContext(r, o);
        return item.status === 'found' ? ({ ...item, freshness: { ...item.freshness, validUntil: '2026-10-08T14:59:00.000Z' } }) : item;
      },
    });
    const old = await shippedWorld({ catalog: stale });
    expect(await old.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'catalog_evidence_stale' });
    expect(w.owner.createCalls + old.owner.createCalls).toBe(0);
  });

  it('S10 missing required customer facts are refused; nothing is fabricated for a guest', async () => {
    expect(quoteCreateV2Input.safeParse({ ...SHIPPED, customer: { kind: 'person' } }).success).toBe(false);
    expect(quoteCreateV2Input.safeParse({ ...SHIPPED, customer: { kind: 'company' } }).success).toBe(false);
    expect(quoteCreateV2Input.safeParse({ ...SHIPPED, customer: { kind: 'person', displayName: '  ' } }).success).toBe(false);
    const w = await shippedWorld();
    // The owner refuses it too (defense in depth), binding nothing.
    await expect(w.owner.createAndIssue({ externalCorrelation: { sourceSystem: 'r4-sales' }, customer: { kind: 'person' } as never, lines: [] }, newKey())).rejects.toMatchObject({ category: 'validation', code: 'validation_error' });
    const key = newKey();
    expect(await w.execute({ ...SHIPPED, customer: { kind: 'guest' } }, key)).toMatchObject({ status: 'applied' });
    expect((await w.store.quoteV2Request(key))!.request.customer).toEqual({ kind: 'guest' });
  });

  it('S11 expectedTotals that differ from the owner arithmetic → refused before sending; an owner 422 is a refusal, not an outage', async () => {
    const w = await shippedWorld();
    expect(await w.execute({ ...SHIPPED, expectedTotals: { ...SHIPPED.expectedTotals, gross: 225_053 } }, newKey())).toMatchObject({ status: 'rejected', code: 'expected_totals_mismatch', details: { computedNet: 189_119, computedTax: 35_933, computedGross: 225_052 } });
    expect(w.owner.createCalls).toBe(0);
    const refusing = await shippedWorld({ quotes: (base) => override(base, { createAndIssue: () => Promise.reject(new DomainError('validation', 'arithmetic_mismatch', 'expectedTotals do not match', { httpStatus: 422, expected_gross: 1, computed_gross: 2 })) }) });
    expect(await refusing.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'quote_arithmetic_mismatch', details: { category: 'validation', httpStatus: 422 } });
  });
});

describe('S12–S18 idempotency, asynchronous issuance and reconciliation', () => {
  it('S12 idempotent replay: the same key returns the same quote, never a second one', async () => {
    const w = await shippedWorld();
    const key = newKey();
    const first = await w.execute(SHIPPED, key);
    const again = await w.execute(SHIPPED, key, 2);
    expect(again).toMatchObject({ status: 'applied', replayed: true });
    expect(again.status === 'applied' && first.status === 'applied' && again.result.quoteId === first.result.quoteId).toBe(true);
    expect(w.owner.createCalls).toBe(2);
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('S13 same key, changed payload: R4 resends the frozen body (no repricing); the owner refuses a changed body as a conflict', async () => {
    const w = await shippedWorld();
    const key = newKey();
    await w.execute(SHIPPED, key);
    w.catalog.setPrice('BAR-OLY20', 99_990);
    const changed = { ...SHIPPED, lines: [{ ...SHIPPED.lines[0]!, unitPrice: { amount: 99_990, taxBasis: 'included' as const, taxRate: '0.19' } }, SHIPPED.lines[1]!] };
    expect(await w.execute(changed, key, 2)).toMatchObject({ status: 'applied', replayed: true, result: { totals: { gross: 225_052 } } });
    const frozen = (await w.store.quoteV2Request(key))!.request;
    const { expectedTotals: _dropped, ...withoutTotals } = frozen;
    await expect(w.owner.createAndIssue(withoutTotals, key)).rejects.toMatchObject({ category: 'conflict', code: 'idempotency_key_conflict' });
    const conflicting = await shippedWorld({ quotes: (base) => override(base, { createAndIssue: () => Promise.reject(new DomainError('conflict', 'idempotency_key_conflict', 'bound to another request', { httpStatus: 409 })) }) });
    expect(await conflicting.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'quote_idempotency_key_conflict' });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('S14/S15 HTTP 202: pending is never success; the operation and quote references are kept; reconciliation reports the issued quote', async () => {
    const w = await shippedWorld();
    w.owner.faults.issuance = () => 'async';
    const key = newKey();
    const pending = await w.execute(SHIPPED, key);
    expect(pending).toMatchObject({ status: 'unknown', message: expect.stringMatching(/PC-000001 is issuing/) });
    const accepted = await pool.query('select quote_number, operation_id from sales.quote_v2_acceptances where execution_key = $1', [key]);
    expect(accepted.rows).toEqual([{ quote_number: 'PC-000001', operation_id: w.owner.quotes[0]!.issuance!.operationId }]);
    expect(await w.store.quoteV2Issued(w.taskId)).toEqual([]);
    expect(await w.reconcile(key)).toMatchObject({ status: 'unknown' });
    w.owner.completeIssuance(w.owner.quotes[0]!.quoteId, 'succeed');
    expect(await w.reconcile(key)).toMatchObject({ status: 'applied', replayed: true, result: { quoteNumber: 'PC-000001', document: { verification: 'verified' } } });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('S16 pending operation failure: never success, never a second quote — the outcome stays for an owner operator', async () => {
    const w = await shippedWorld();
    w.owner.faults.issuance = () => 'async';
    const key = newKey();
    await w.execute(SHIPPED, key);
    w.owner.completeIssuance(w.owner.quotes[0]!.quoteId, 'fail');
    const settled = await w.reconcile(key);
    expect(settled).toMatchObject({ status: 'unknown', message: expect.stringMatching(/issuance operation failed \(document_generation_failed\).*operator/) });
    expect(await w.store.quoteV2Issued(w.taskId)).toEqual([]);
    // A same-key replay returns the same issuing quote: still no second quote.
    expect(await w.execute(SHIPPED, key, 2)).toMatchObject({ status: 'unknown' });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('S17 lost response after commit: unknown, then reconciled by key to the one committed quote', async () => {
    const w = await shippedWorld();
    w.owner.faults.afterCommit = () => 'connection_lost';
    const key = newKey();
    expect(await w.execute(SHIPPED, key)).toMatchObject({ status: 'unknown' });
    w.owner.faults.afterCommit = () => 'answer';
    expect(await w.reconcile(key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('S18 timeout: same key and frozen body; a failed lookup stays unknown; not_found is final only after the owner window', async () => {
    const w = await shippedWorld();
    w.owner.faults.afterCommit = () => 'timeout';
    const key = newKey();
    expect(await w.execute(SHIPPED, key)).toMatchObject({ status: 'unknown' });
    w.owner.availability.set({ mode: 'down' });
    expect(await w.reconcile(key)).toMatchObject({ status: 'unknown', message: expect.stringMatching(/reconciliation incomplete/) });
    w.owner.availability.set({ mode: 'up' });
    w.owner.faults.afterCommit = () => 'answer';
    expect(await w.reconcile(key)).toMatchObject({ status: 'applied' });
    expect(w.owner.quotes).toHaveLength(1);

    // not_found right after a send could still commit → unknown; long after (or never sent) → not_applied, so the platform replays the SAME key.
    const recent = await shippedWorld();
    recent.owner.availability.set({ mode: 'down' });
    const recentKey = newKey();
    expect(await recent.execute(SHIPPED, recentKey)).toMatchObject({ status: 'failed', code: 'quote_service_unavailable' });
    recent.owner.availability.set({ mode: 'up' });
    expect(await recent.reconcile(recentKey)).toMatchObject({ status: 'unknown', message: expect.stringMatching(/could still commit/) });
    const frozen = (await recent.store.quoteV2Request(recentKey))!;
    const oldKey = newKey();
    await recent.store.recordQuoteV2Request({ executionKey: oldKey, taskId: recent.taskId, workspaceVersion: 1, request: frozen.request, requestSha256: frozen.requestSha256 });
    await pool.query(`insert into sales.quote_v2_sends (execution_key, sent_at) values ($1, clock_timestamp() - interval '10 minutes')`, [oldKey]);
    expect(await recent.reconcile(oldKey)).toEqual({ status: 'not_applied' });
    const neverSent = newKey();
    await recent.store.recordQuoteV2Request({ executionKey: neverSent, taskId: recent.taskId, workspaceVersion: 1, request: frozen.request, requestSha256: frozen.requestSha256 });
    expect(await recent.reconcile(neverSent)).toEqual({ status: 'not_applied' });
    expect(await recent.reconcile(newKey())).toEqual({ status: 'not_applied' });
    expect(recent.owner.quotes).toHaveLength(0);
  });
});

describe('S19–S23 owner refusals, outages and the document boundary', () => {
  it('S19 401/403: fail closed, nothing issued, never retried as transient', async () => {
    for (const credential of ['invalid', 'forbidden'] as const) {
      const w = await shippedWorld();
      w.owner.faults.credential = () => credential;
      expect(await w.execute(SHIPPED, newKey())).toMatchObject({ status: 'failed', code: 'quote_owner_unauthorized', details: { category: 'unauthorized', retryable: false } });
      expect(w.owner.quotes).toHaveLength(0);
    }
  });

  it('S20 409 lifecycle conflict and 422 validation are refusals, distinct from the idempotency conflict', async () => {
    const lifecycle = await shippedWorld({ quotes: (base) => override(base, { createAndIssue: () => Promise.reject(new DomainError('conflict', 'operation_in_progress', 'issuing', { httpStatus: 409 })) }) });
    expect(await lifecycle.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'quote_operation_in_progress' });
    const invalid = await shippedWorld({ quotes: (base) => override(base, { createAndIssue: () => Promise.reject(new DomainError('validation', 'validation_error', 'unknown member', { httpStatus: 422 })) }) });
    expect(await invalid.execute(SHIPPED, newKey())).toMatchObject({ status: 'rejected', code: 'quote_validation_error' });
  });

  it('S21 owner unavailable before sending: failed with no effect; the retry reuses the same key and frozen body', async () => {
    const w = await shippedWorld();
    w.owner.availability.set({ mode: 'down' });
    const key = newKey();
    expect(await w.execute(SHIPPED, key)).toMatchObject({ status: 'failed', code: 'quote_service_unavailable', details: { retryable: true } });
    const frozen = (await w.store.quoteV2Request(key))!;
    w.owner.availability.set({ mode: 'up' });
    w.catalog.setPrice('BAR-OLY20', 1);
    // No re-verification, no repricing: the frozen approved body is what goes out.
    expect(await w.execute(SHIPPED, key, 2)).toMatchObject({ status: 'applied', result: { totals: { gross: 225_052 } } });
    expect((await w.store.quoteV2Request(key))!.requestSha256).toBe(frozen.requestSha256);
    const unreachable = await shippedWorld({ quotes: (base) => override(base, { createAndIssue: () => Promise.reject(new DomainError('unknown_outcome', 'http_503', 'owner 503', { httpStatus: 503 })) }) });
    // A 503 on the mutation keeps the outcome open (reconcile by key), never "nothing happened".
    expect(await unreachable.execute(SHIPPED, newKey())).toMatchObject({ status: 'unknown' });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('S22 PDF SHA-256 mismatch: the quote is issued, the document is classified mismatch (never presented as verified)', async () => {
    const w = await shippedWorld();
    w.owner.faults.document = () => 'corrupt';
    expect(await w.execute(SHIPPED, newKey())).toMatchObject({ status: 'applied', result: { document: { verification: 'mismatch' } } });
    expect(await w.store.quoteV2Issued(w.taskId)).toEqual([expect.objectContaining({ documentVerification: 'mismatch' })]);
  });

  it('S23 PDF unavailable after issue: the issued quote stands, document access is classified separately, no duplicate', async () => {
    const w = await shippedWorld();
    w.owner.faults.document = () => 'unavailable';
    const key = newKey();
    expect(await w.execute(SHIPPED, key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001', document: { verification: 'unavailable' } } });
    expect(await w.reconcile(key)).toMatchObject({ status: 'applied', replayed: true });
    expect(w.owner.quotes).toHaveLength(1);
  });
});

describe('S30 restart and recovery on the existing Sales persistence', () => {
  it('a new process (new pool, store, adapter and capability) reconciles the committed quote by key; nothing is reissued', async () => {
    const w = await shippedWorld();
    w.owner.faults.afterCommit = () => 'connection_lost';
    const key = newKey();
    expect(await w.execute(SHIPPED, key)).toMatchObject({ status: 'unknown' });
    w.owner.faults.afterCommit = () => 'answer';
    const restartedPool = openPool(db.url);
    try {
      const restarted = quoteCreateV2Capability({ store: new PostgresSalesStore(restartedPool), quotes: w.owner, catalog: new FixtureCatalog({ now: () => NOW }), shipping: new FixtureShipping({ now: () => NOW }), now: () => NOW });
      const context = w.context(key, 2);
      expect(await restarted.reconcile!(context)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
      expect(await new PostgresSalesStore(restartedPool).quoteV2Issued(w.taskId)).toHaveLength(1);
    } finally {
      await restartedPool.end();
    }
    expect(w.owner.createCalls).toBe(1);
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('the frozen records are append-only', async () => {
    const w = await shippedWorld();
    const key = newKey();
    await w.execute(SHIPPED, key);
    await expect(pool.query(`update sales.quote_v2_requests set request = '{}' where execution_key = $1`, [key])).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from sales.quote_v2_issued where execution_key = $1', [key])).rejects.toThrow(/append-only/);
  });
});
