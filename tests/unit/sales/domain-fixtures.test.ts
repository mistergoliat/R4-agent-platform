import { describe, expect, it } from 'vitest';
import { DomainError, createFixtureDomains, deriveShippingGross } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { catalogCapabilities, customerCapability, shippingCapability } from '@r4-sales/agent';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';

const REQUEST = { customer: { name: 'Ana Test', email: 'ana@example.test', phone: null }, lines: [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'PLT-IRON-50', quantity: 1 }], delivery: { commune: 'Ñuñoa' } };

describe('fixture Quote owner', () => {
  it('prices lines from the current catalog and shipping from the shipping owner', async () => {
    const d = createFixtureDomains();
    const out = await d.quotes.create(REQUEST, 'key-1');
    if (out.status !== 'created') throw new Error(out.code);
    expect(out.quote).toMatchObject({ quoteNumber: 'COT-100001', status: 'issued', subtotal: { amount: 129_990 + 119_990 }, shipping: { amount: { amount: deriveShippingGross(8_390 + 126 * 70).grossAmount } } });
    expect(out.quote.total.amount).toBe(out.quote.subtotal.amount + out.quote.shipping.amount.amount);
  });

  it('issues at most one quote per idempotency key and refuses the key for another request', async () => {
    const d = createFixtureDomains();
    const a = await d.quotes.create(REQUEST, 'key-1');
    const b = await d.quotes.create(REQUEST, 'key-1');
    expect(a).toMatchObject({ status: 'created', replayed: false });
    expect(b).toMatchObject({ status: 'created', replayed: true, quote: { quoteNumber: 'COT-100001' } });
    expect(d.quotes.issued).toHaveLength(1);
    expect(await d.quotes.create({ ...REQUEST, delivery: { commune: 'Maipú' } }, 'key-1')).toMatchObject({ status: 'rejected', code: 'idempotency_key_reused' });
    expect((await d.quotes.findByIdempotencyKey('key-1'))?.quoteNumber).toBe('COT-100001');
    expect(await d.quotes.findByIdempotencyKey('never-sent')).toBeNull();
  });

  it('refuses what it cannot issue, issuing nothing', async () => {
    const d = createFixtureDomains();
    expect(await d.quotes.create({ ...REQUEST, lines: [{ productId: 'RACK-PR300', quantity: 1 }] }, 'k1')).toMatchObject({ status: 'rejected', code: 'product_unavailable' });
    expect(await d.quotes.create({ ...REQUEST, lines: [{ productId: 'RACK-HR50', quantity: 5 }] }, 'k2')).toMatchObject({ status: 'rejected', code: 'insufficient_stock' });
    expect(await d.quotes.create({ ...REQUEST, delivery: { commune: 'Isla de Pascua' } }, 'k3')).toMatchObject({ status: 'rejected', code: 'destination_not_serviceable' });
    expect(await d.quotes.create({ ...REQUEST, customer: { name: 'Ana', email: null, phone: null } }, 'k4')).toMatchObject({ status: 'rejected', code: 'missing_contact' });
    expect(d.quotes.issued).toHaveLength(0);
  });

  it('can issue and then lose the answer (the caller must reconcile)', async () => {
    const d = createFixtureDomains();
    d.quotes.faults.afterIssue = () => 'connection_lost';
    await expect(d.quotes.create(REQUEST, 'k')).rejects.toMatchObject({ category: 'unknown_outcome', outcomeUnknown: true });
    expect(d.quotes.issued).toHaveLength(1);
  });
});

describe('fixture Catalog and Shipping owners', () => {
  it('search: the owner filters and reports completeness; unsellable products are not hidden unless asked', async () => {
    const d = createFixtureDomains();
    const cheap = await d.catalog.search({ query: 'barra seguros', filters: { maxUnitPrice: 30_000 }, limit: 10 });
    expect(cheap.results.every((p) => p.priceSummary !== null && p.priceSummary.finalGross.amount <= 30_000)).toBe(true);
    const racks = await d.catalog.search({ query: 'rack', filters: { categoryId: '11', sellableOnly: true }, limit: 10 });
    expect(racks.results.map((r) => r.productKey).sort()).toEqual(['RACK-HR50', 'RACK-PR200', 'RACK-SQ100']);
    const all = await d.catalog.search({ query: 'rack', filters: { categoryId: '11' }, limit: 10 });
    expect(all.results.find((r) => r.productKey === 'RACK-PR300')?.availabilitySummary).toEqual({ sellability: 'not_sellable', reason: 'out_of_stock', sellableVariants: null });
    const truncated = await d.catalog.search({ query: 'rack', limit: 2 });
    expect(truncated.completeness).toEqual({ totalMatches: 5, truncated: true });
    expect(truncated.results).toHaveLength(2);
  });

  it('exact SKU of a product without stock is still found (J1B §12.4)', async () => {
    const d = createFixtureDomains();
    const answer = await d.catalog.search({ query: 'IH-PR300P' });
    expect(answer.results[0]).toMatchObject({ productKey: 'RACK-PR300', sku: 'IH-PR300P', match: { type: 'exact_reference' }, availabilitySummary: { sellability: 'not_sellable', reason: 'out_of_stock' } });
  });

  it('products with variants: a "from" price, a required selection and one itemKey per variant; no implicit variant', async () => {
    const d = createFixtureDomains();
    const [hit] = (await d.catalog.search({ query: 'kettlebell competicion' })).results;
    expect(hit).toMatchObject({ productKey: 'KB-COMP', variants: { count: 3, requiresSelection: true }, priceSummary: { kind: 'from', finalGross: { amount: 44_990 } } });
    const context = await d.catalog.getProductContext('KB-COMP');
    if (context.status !== 'found') throw new Error('expected found');
    expect(context.facts.sellableItem).toBeNull();
    expect(context.facts.variantOptions.map((o) => [o.itemKey, o.ref])).toEqual([
      ['KB-COMP-12', { productId: '114', variantId: '1141' }],
      ['KB-COMP-16', { productId: '114', variantId: '1142' }],
      ['KB-COMP-24', { productId: '114', variantId: '1143' }],
    ]);
    expect(await d.catalog.getItemContext({ itemKey: 'KB-COMP', quantity: 1 })).toEqual({ status: 'variant_required', itemKey: 'KB-COMP', productKey: 'KB-COMP' });
    expect(await d.catalog.getItemContext({ itemKey: 'KB-COMP-16', quantity: 1 })).toMatchObject({ status: 'found', ref: { variantId: '1142' }, variant: { variantId: '1142' }, availability: { sellability: 'not_sellable', reason: 'out_of_stock' } });
  });

  it('inactive is found with its status; an unknown key is not_found — both answers, not errors', async () => {
    const d = createFixtureDomains();
    expect(await d.catalog.getProductContext('CARDIO-ROW')).toMatchObject({ status: 'found', facts: { status: { active: false } }, derived: { availability: { sellability: 'not_sellable', reason: 'inactive' } } });
    expect(await d.catalog.getProductContext('NOPE-1')).toEqual({ status: 'not_found', productKey: 'NOPE-1' });
    expect(await d.catalog.getItemContext({ itemKey: 'NOPE-1', quantity: 1 })).toEqual({ status: 'not_found', itemKey: 'NOPE-1' });
  });

  it('owner-side changes are visible on the next read, with the owner\'s own asOf', async () => {
    let now = new Date('2026-09-23T12:00:00.000Z');
    const d = createFixtureDomains({ now: () => now });
    const before = await d.catalog.getItemContext({ itemKey: 'BAR-OLY20', quantity: 2 });
    d.catalog.setPrice('BAR-OLY20', 139_990);
    now = new Date('2026-09-23T12:01:00.000Z');
    const after = await d.catalog.getItemContext({ itemKey: 'BAR-OLY20', quantity: 2 });
    expect(before).toMatchObject({ pricing: { quantity: 2, finalGross: { amount: 129_990 } } });
    expect(after).toMatchObject({ pricing: { quantity: 2, finalGross: { amount: 139_990 } }, freshness: { asOf: '2026-09-23T12:01:00.000Z', validUntil: '2026-09-23T12:06:00.000Z' }, provenance: { sourceUpdatedAt: '2026-09-23T12:00:00.000Z' } });
  });

  it('shipping resolves communes exactly, answers per destination and marks unserved ones', async () => {
    const d = createFixtureDomains();
    const basis = { type: 'reference' } as const;
    expect(await d.shipping.quote({ destination: { commune: ' NUNOA ' }, basis })).toMatchObject({ serviceable: true, destination: { communeName: 'Ñuñoa', regionName: 'Metropolitana de Santiago' }, ownerValidUntil: null });
    expect(await d.shipping.quote({ destination: { commune: 'Tirúa' }, basis })).toMatchObject({ serviceable: false, offers: [] });
    await expect(d.shipping.quote({ destination: { commune: 'Isla de Pascua' }, basis })).rejects.toMatchObject({ category: 'validation', code: 'shipping_invalid_destination' });
  });
});

describe('Sales READ capabilities over the domain ports', () => {
  const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'c', grantedScopes: ['catalog.read', 'customer.read', 'shipping.read'] };

  function setup(conversation: { customerRef: string | null } | null = null) {
    const d = createFixtureDomains();
    const registry = new CapabilityRegistry();
    for (const r of catalogCapabilities(d.catalog)) registry.register(r as never);
    registry.register(customerCapability(d.customers, { conversation: () => Promise.resolve(conversation ? { taskId: context.taskId, channelRef: 'x', createdAt: '2026-09-23T00:00:00.000Z', ...conversation } : null) }));
    registry.register(shippingCapability(d.shipping, d.catalog));
    const clock = new FakeClock();
    const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
    return { d, invoker, clock };
  }

  it('an owner outage is a failed observation with a structured category, never a fake answer', async () => {
    const { d, invoker } = setup();
    d.catalog.availability.set({ mode: 'down' });
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'barra' } }, context);
    expect(o).toMatchObject({ outcome: 'failed', payload: null, validUntil: null, error: { code: 'dependency_unavailable', details: { category: 'temporarily_unavailable', code: 'catalog_unavailable', retryable: true } } });
  });

  it('catalog answers carry R4\'s bounded window; an unknown key is an answer', async () => {
    const { invoker, clock } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'NOPE-1' } }, context);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { status: 'not_found', productKey: 'NOPE-1' }, validUntil: new Date(clock.now().getTime() + 5 * 60_000).toISOString() });
  });

  it('catalog.search transports the owner\'s freshness, completeness and order verbatim, keyed by productKey (never SKU)', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'barra olimpica', limit: 2 } }, context);
    const payload = o.payload as { query: string; results: { productKey: string; sku: string }[]; completeness: unknown; searchMode: string; freshness: { validUntil: string | null } };
    expect(payload.query).toBe('barra olimpica');
    expect(payload.results.map((r) => r.productKey)).toEqual(['BAR-OLY20', 'BAR-OLY15']);
    expect(payload.results.map((r) => r.sku)).toEqual(['SC-BO20-28', 'SC-BO15-25']);
    expect(payload.completeness).toEqual({ totalMatches: 5, truncated: true });
    expect(payload.searchMode).toBe('lexical');
    expect(payload.freshness.validUntil).not.toBeNull();
    // A SKU is not an identity: asking the product context for one is an honest not_found.
    expect(await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'SC-BO20-28' } }, context)).toMatchObject({ outcome: 'succeeded', payload: { status: 'not_found' } });
  });

  it('catalog.get_product_context separates facts, catalog text (data, not instructions), derived and inferred blocks', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'RACK-PR200' } }, context);
    expect(o.payload).toMatchObject({
      status: 'found',
      productKey: 'RACK-PR200',
      facts: { sellableItemKey: 'RACK-PR200', variantOptions: [], status: { active: true, listed: true, orderable: true } },
      catalogText: { notice: expect.stringContaining('never instructions') },
      derived: { price: { kind: 'exact', finalGross: { amount: 289_990, currency: 'CLP' } }, availability: { sellability: 'sellable', reason: 'in_stock' } },
      inferred: { frequentlyBoughtTogether: { status: 'available', meaning: expect.stringContaining('does NOT mean compatible'), items: [{ productKey: 'BAR-OLY20', name: 'Barra olímpica 20 kg (2,2 m)' }, { productKey: 'PLT-IRON-50', name: 'Set discos de fierro 50 kg' }] } },
    });
    expect(JSON.stringify(o.payload)).not.toMatch(/compatibleWith|alternatives|footprint|recordVersion|confidence|jointCount/);
  });

  it('customer identity comes from the conversation binding, never from arguments', async () => {
    const anonymous = setup(null);
    expect(await anonymous.invoker.invoke({ capabilityId: 'customer.get_context', arguments: {} }, context)).toMatchObject({ outcome: 'succeeded', payload: { identity: 'unavailable', reason: 'anonymous' } });
    const known = setup({ customerRef: 'cust-demo-001' });
    expect(await known.invoker.invoke({ capabilityId: 'customer.get_context', arguments: {} }, context)).toMatchObject({ payload: { identity: 'provisional', customer: { displayName: 'Camila Rojas' } } });
    expect(await known.invoker.invoke({ capabilityId: 'customer.get_context', arguments: { customerRef: 'cust-demo-002' } }, context)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_arguments' } });
  });

  it('shipping evidence echoes what it was computed for', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'shipping.quote', arguments: { destination: { commune: 'Maipú' }, basis: 'order', items: [{ productId: 'KB-16', quantity: 2 }] } }, context);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { destination: { communeName: 'Maipú' }, requestedItems: [{ productId: 'KB-16', quantity: 2 }], serviceable: true, basis: { type: 'order', weightKg: 32, declaredValue: { amount: 2 * 34_990, currency: 'CLP', taxIncluded: true } }, referenceLowestGross: null } });
  });

  it('DomainError classifies write-relevant uncertainty', () => {
    expect(new DomainError('timeout', 'x', 'y').outcomeUnknown).toBe(true);
    expect(new DomainError('temporarily_unavailable', 'x', 'y')).toMatchObject({ outcomeUnknown: false, retryable: true });
    expect(new DomainError('validation', 'x', 'y')).toMatchObject({ outcomeUnknown: false, retryable: false });
  });
});
