import { describe, expect, it } from 'vitest';
import { DomainError, createFixtureDomains } from '@r4-adapters/domains';
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
    expect(out.quote).toMatchObject({ quoteNumber: 'COT-100001', status: 'issued', subtotal: { amount: 129_990 + 119_990 }, shipping: { amount: { amount: 9_990 + 150 * 70 } } });
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
  it('search applies no commercial rule: filters only', async () => {
    const d = createFixtureDomains();
    const cheap = await d.catalog.search({ maxUnitPrice: 30_000, limit: 50 });
    expect(cheap.results.every((p) => p.unitPrice.amount <= 30_000)).toBe(true);
    const racks = await d.catalog.search({ category: 'racks', inStockOnly: true, limit: 50 });
    expect(racks.results.map((r) => r.productId).sort()).toEqual(['RACK-HR50', 'RACK-PR200', 'RACK-SQ100']);
  });

  it('owner-side changes bump the record version (current data can change between reads)', async () => {
    const d = createFixtureDomains();
    const before = await d.catalog.getProduct('BAR-OLY20');
    d.catalog.setPrice('BAR-OLY20', 139_990);
    const after = await d.catalog.getProduct('BAR-OLY20');
    expect(after).toMatchObject({ unitPrice: { amount: 139_990 }, recordVersion: before!.recordVersion + 1 });
  });

  it('shipping answers per destination and marks unserved destinations', async () => {
    const d = createFixtureDomains();
    const items = [{ productId: 'BAR-OLY20', quantity: 1 }];
    expect(await d.shipping.quote({ destination: { commune: 'nunoa' }, items })).toMatchObject({ serviceable: true, destination: { commune: 'Ñuñoa', region: 'Metropolitana' } });
    expect(await d.shipping.quote({ destination: { commune: 'Isla de Pascua' }, items })).toMatchObject({ serviceable: false, options: [] });
  });
});

describe('Sales READ capabilities over the domain ports', () => {
  const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'c', grantedScopes: ['catalog.read', 'customer.read', 'shipping.read'] };

  function setup(conversation: { customerRef: string | null } | null = null) {
    const d = createFixtureDomains();
    const registry = new CapabilityRegistry();
    for (const r of catalogCapabilities(d.catalog)) registry.register(r as never);
    registry.register(customerCapability(d.customers, { conversation: () => Promise.resolve(conversation ? { taskId: context.taskId, channelRef: 'x', createdAt: '2026-09-23T00:00:00.000Z', ...conversation } : null) }));
    registry.register(shippingCapability(d.shipping));
    const clock = new FakeClock();
    const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
    return { d, invoker, clock };
  }

  it('an owner outage is a failed observation with a structured category, never a fake answer', async () => {
    const { d, invoker } = setup();
    d.catalog.availability.set({ mode: 'down' });
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { text: 'barra' } }, context);
    expect(o).toMatchObject({ outcome: 'failed', payload: null, validUntil: null, error: { code: 'handler_error', details: { category: 'temporarily_unavailable', code: 'catalog_unavailable', retryable: true } } });
  });

  it('catalog answers carry the owner freshness window; an unknown id is an answer', async () => {
    const { invoker, clock } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productId: 'NOPE-1' } }, context);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { found: false, productId: 'NOPE-1' }, validUntil: new Date(clock.now().getTime() + 15 * 60_000).toISOString() });
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
    const o = await invoker.invoke({ capabilityId: 'shipping.quote', arguments: { destination: { commune: 'Maipú' }, items: [{ productId: 'KB-16', quantity: 2 }] } }, context);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { destination: { commune: 'Maipú' }, requestedItems: [{ productId: 'KB-16', quantity: 2 }], serviceable: true, totalWeightKg: 32 } });
  });

  it('DomainError classifies write-relevant uncertainty', () => {
    expect(new DomainError('timeout', 'x', 'y').outcomeUnknown).toBe(true);
    expect(new DomainError('temporarily_unavailable', 'x', 'y')).toMatchObject({ outcomeUnknown: false, retryable: true });
    expect(new DomainError('validation', 'x', 'y')).toMatchObject({ outcomeUnknown: false, retryable: false });
  });
});
