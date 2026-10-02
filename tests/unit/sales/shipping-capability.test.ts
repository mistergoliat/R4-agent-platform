import { describe, expect, it } from 'vitest';
import { DomainError, createFixtureDomains, offerPriceOf, type ShippingOffer, type ShippingQuoteRequest, type ShippingService } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { SHIPPING_FRESHNESS_TTL_MS, referenceLowestGross, resolveOrderBasis, shippingCapability } from '@r4-sales/agent';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';

const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'c', grantedScopes: ['shipping.read'] };
const offer = (carrierName: string, net: number, ownerPosition: number): ShippingOffer => ({ carrierName, serviceType: 'S', price: offerPriceOf(net), estimatedDelivery: null, ownerPosition });

function setup(shipping?: ShippingService) {
  const d = createFixtureDomains();
  const registry = new CapabilityRegistry();
  registry.register(shippingCapability(shipping ?? d.shipping, d.catalog) as never);
  const clock = new FakeClock();
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
  return { d, invoker };
}

/** A spy Shipping owner recording exactly what the application layer asked. */
function spyShipping(offers: readonly ShippingOffer[]) {
  const requests: ShippingQuoteRequest[] = [];
  const shipping: ShippingService = {
    quote: (request) => {
      requests.push(request);
      const weightKg = request.basis.type === 'order' ? request.basis.totalWeightKg : 1;
      return Promise.resolve({
        destination: { communeId: '99', communeName: 'Ñuñoa', regionName: 'Metropolitana de Santiago' },
        basis: { type: request.basis.type, weightKg, declaredValue: request.basis.type === 'order' ? { ...request.basis.declaredValueGross, taxIncluded: true } : null, dimensionsCm: { height: 1, width: 1, depth: 1, source: 'production_convention' } },
        serviceable: offers.length > 0,
        offers,
        asOf: '2026-10-02T19:30:00.000Z',
        ownerValidUntil: null,
        provenance: { owner: 'spy', endpoint: 'spy', ownerContractVersion: '0' },
      });
    },
  };
  return { shipping, requests };
}

describe('order basis resolution from the Catalog owner (never from the model)', () => {
  it('sums product weight × quantity in grams and the effective unit finalGross × quantity', async () => {
    const { d } = setup();
    // BAR-OLY20 20 kg @ 129.990, PLT-IRON-50 50 kg @ 119.990, COLLARS 0.4 kg @ 9.990
    const basis = await resolveOrderBasis(d.catalog, [{ productId: 'BAR-OLY20', quantity: 2 }, { productId: 'PLT-IRON-50', quantity: 1 }, { productId: 'COLLARS', quantity: 3 }]);
    expect(basis).toEqual({ totalWeightKg: 91.2, declaredValueGross: { amount: 2 * 129_990 + 119_990 + 3 * 9_990, currency: 'CLP' } });
  });

  it('uses the price the catalog states now (a price change is reflected, never recomputed)', async () => {
    const { d } = setup();
    d.catalog.setPrice('BAR-OLY20', 139_990);
    expect((await resolveOrderBasis(d.catalog, [{ productId: 'BAR-OLY20', quantity: 1 }])).declaredValueGross.amount).toBe(139_990);
  });

  it('fails the whole basis on an unknown item, a product needing a variant, or a product without weight', async () => {
    const { d } = setup();
    const cases: readonly [string, string][] = [
      ['NOPE-1', 'shipping_item_not_found'],
      ['KB-COMP', 'shipping_item_variant_required'],
      ['KB-COMP-12', 'shipping_item_weight_unavailable'], // the fixture product has weight only per variant: product-level weight is null
    ];
    for (const [productId, code] of cases) {
      await expect(resolveOrderBasis(d.catalog, [{ productId: 'BAR-OLY20', quantity: 1 }, { productId, quantity: 1 }]), productId).rejects.toMatchObject({ category: 'validation', code });
    }
  });
});

describe('I. referenceLowestGross (reference "from" helper, outside the adapter)', () => {
  it('is the minimum customer gross, deterministic, without reordering or selecting', () => {
    const offers = [offer('B', 4193, 0), offer('A', 3175, 1), offer('C', 3713, 2)];
    const before = JSON.stringify(offers);
    expect(referenceLowestGross(offers)).toEqual({ amount: 3778, currency: 'CLP' });
    expect(referenceLowestGross([...offers].reverse())).toEqual({ amount: 3778, currency: 'CLP' });
    expect(JSON.stringify(offers)).toBe(before);
    expect(offers.some((o) => 'selected' in o)).toBe(false);
  });

  it('is null when there is no offer', () => {
    expect(referenceLowestGross([])).toBeNull();
  });
});

describe('shipping.quote capability', () => {
  it('reference: asks the owner for the reference basis, exposes referenceLowestGross and keeps every offer in owner order', async () => {
    const spy = spyShipping([offer('Pesas Chile', 4193, 0), offer('Blue Express', 3175, 1)]);
    const { invoker } = setup(spy.shipping);
    const o = await invoker.invoke({ capabilityId: 'shipping.quote', arguments: { destination: { commune: 'Ñuñoa' }, basis: 'reference' } }, context);
    expect(spy.requests).toEqual([{ destination: { commune: 'Ñuñoa' }, basis: { type: 'reference' } }]);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { basis: { type: 'reference', weightKg: 1, declaredValue: null }, requestedItems: [], referenceLowestGross: { amount: 3778, currency: 'CLP' }, ownerValidUntil: null } });
    const payload = o.payload as { offers: { carrierName: string }[] };
    expect(payload.offers.map((x) => x.carrierName)).toEqual(['Pesas Chile', 'Blue Express']);
    expect(payload).not.toHaveProperty('selectedOffer');
  });

  it('order: resolves weight and declared value from the catalog, never auto-picks an offer', async () => {
    const spy = spyShipping([offer('Pesas Chile', 1, 0), offer('Blue Express', 3895, 1)]);
    const { invoker } = setup(spy.shipping);
    const o = await invoker.invoke({ capabilityId: 'shipping.quote', arguments: { destination: { commune: 'Ñuñoa' }, basis: 'order', items: [{ productId: 'BAR-OLY20', quantity: 1 }] } }, context);
    expect(spy.requests).toEqual([{ destination: { commune: 'Ñuñoa' }, basis: { type: 'order', totalWeightKg: 20, declaredValueGross: { amount: 129_990, currency: 'CLP' } } }]);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { requestedItems: [{ productId: 'BAR-OLY20', quantity: 1 }], referenceLowestGross: null, offers: [{ price: { ownerNet: { amount: 1 }, customerGross: { amount: 1 } } }, { price: { ownerNet: { amount: 3895 } } }] } });
  });

  it('the model cannot pass weight, price, carrier or address, and the basis/items pairing is enforced', async () => {
    const { invoker } = setup();
    for (const args of [
      { destination: { commune: 'Ñuñoa' }, basis: 'order' },
      { destination: { commune: 'Ñuñoa' }, basis: 'reference', items: [{ productId: 'BAR-OLY20', quantity: 1 }] },
      { destination: { commune: 'Ñuñoa' }, basis: 'reference', weightKg: 1 },
      { destination: { commune: 'Ñuñoa', address: 'Av. X 123' }, basis: 'reference' },
      { destination: { commune: 'Ñuñoa' }, basis: 'reference', carrier: 'Starken' },
    ]) {
      expect(await invoker.invoke({ capabilityId: 'shipping.quote', arguments: args }, context), JSON.stringify(args)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_arguments' } });
    }
  });

  it('typed owner failures surface as failed observations with their category and code', async () => {
    const failing: ShippingService = { quote: () => Promise.reject(new DomainError('validation', 'shipping_invalid_destination', 'unknown commune')) };
    const { invoker } = setup(failing);
    const o = await invoker.invoke({ capabilityId: 'shipping.quote', arguments: { destination: { commune: 'San Migel' }, basis: 'reference' } }, context);
    expect(o).toMatchObject({ outcome: 'failed', error: { details: { category: 'validation', code: 'shipping_invalid_destination', retryable: false } } });
  });

  it('runs end to end over the fixture owner and declares an R4-side runtime freshness only', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'shipping.quote', arguments: { destination: { commune: 'nunoa' }, basis: 'reference' } }, context);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { destination: { communeName: 'Ñuñoa' }, serviceable: true, ownerValidUntil: null } });
    expect(SHIPPING_FRESHNESS_TTL_MS).toBe(15 * 60_000);
  });
});
