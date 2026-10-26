import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainError, FixtureCatalog, offerPriceOf, type ShippingOffer, type ShippingQuoteRequest, type ShippingService } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { QUOTE_V2_CORRELATION, buildCommercialSnapshot, quoteRequestOf, renderOfferMessage, shippingCapability, type Workspace } from '@r4-sales/agent';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';

/**
 * R4-J5: the "Pesas Chile — Despacho Directo" $1 shipping promotion, from R4's side. The Shipping owner is the
 * authority: it decides eligibility and returns the final offer. R4 forwards what the Catalog states (weight,
 * declared value) and carries the owner's answer unchanged into shipping.quote, quote.preview and quote.create.
 *
 * `promoOwner` is a scripted stand-in for the owner: each scenario TELLS it whether the owner grants the promotion
 * (the real rule, commune list and monetary basis are the owner's and still pending). Nothing in R4 decides it.
 */
const PROMO = { carrierName: 'Pesas Chile', serviceType: 'Despacho Directo' } as const;
const promoOffer = (): ShippingOffer => ({ ...PROMO, price: offerPriceOf(1), estimatedDelivery: '1 a 2 días hábiles', ownerPosition: 0 });
const expressOffer = (ownerPosition: number): ShippingOffer => ({ carrierName: 'Blue Express', serviceType: 'EXPRESS', price: offerPriceOf(10_737), estimatedDelivery: null, ownerPosition });
const DESTINATIONS: Readonly<Record<string, { communeId: string; communeName: string; regionName: string }>> = {
  Ñuñoa: { communeId: '13120', communeName: 'Ñuñoa', regionName: 'Metropolitana de Santiago' },
  Valparaíso: { communeId: '5101', communeName: 'Valparaíso', regionName: 'Valparaíso' },
};

function promoOwner(grants: (request: ShippingQuoteRequest) => boolean) {
  const requests: ShippingQuoteRequest[] = [];
  const shipping: ShippingService = {
    quote: (request) => {
      requests.push(request);
      const offers = grants(request) ? [promoOffer(), expressOffer(1)] : [expressOffer(0)];
      return Promise.resolve({
        destination: DESTINATIONS[request.destination.commune]!,
        basis: {
          type: request.basis.type,
          weightKg: request.basis.type === 'order' ? request.basis.totalWeightKg : 1,
          declaredValue: request.basis.type === 'order' ? { ...request.basis.declaredValueGross, taxIncluded: true as const } : null,
          dimensionsCm: { height: 1, width: 1, depth: 1, source: 'production_convention' as const },
        },
        serviceable: true,
        offers,
        asOf: new Date().toISOString(),
        ownerValidUntil: null,
        provenance: { owner: 'scripted-shipping', endpoint: 'scripted', ownerContractVersion: '0' },
      });
    },
  };
  return { shipping, requests };
}

const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 9, correlationId: 'c', grantedScopes: ['shipping.read'] };

function invokerFor(shipping: ShippingService, catalog: FixtureCatalog) {
  const registry = new CapabilityRegistry();
  registry.register(shippingCapability(shipping, catalog) as never);
  const clock = new FakeClock();
  return new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
}

/** A catalog whose BAR-OLY20 costs exactly `gross` (tax included), so the order's declared value is that amount. */
function catalogAt(gross: number): FixtureCatalog {
  const catalog = new FixtureCatalog();
  catalog.setPrice('BAR-OLY20', gross);
  return catalog;
}

const ITEMS = [{ productId: 'BAR-OLY20', quantity: 1 }];
const quoteOrder = (shipping: ShippingService, catalog: FixtureCatalog, commune: string) =>
  invokerFor(shipping, catalog).invoke({ capabilityId: 'shipping.quote', arguments: { destination: { commune }, basis: 'order', items: ITEMS } }, context);

const at = '2026-10-26T12:00:00.000Z';
function workspaceWith(commune: string, choice: { carrierName: string; serviceType: string; agreedOwnerNetClp: number }): Workspace {
  return {
    taskId: context.taskId,
    version: 3,
    state: {
      facts: {},
      delivery: { commune, region: null, sinceVersion: 1, updatedAt: at },
      items: ITEMS.map((i) => ({ ...i, sinceVersion: 1, updatedAt: at })),
      shipping: { kind: 'selected', commune, ...choice, sinceVersion: 2, updatedAt: at },
    },
    createdAt: at,
    updatedAt: at,
  };
}
const promoChoice = { ...PROMO, agreedOwnerNetClp: 1 };

describe('shipping.quote: the $1 offer appears exactly when the Shipping owner returns it', () => {
  // [scenario, catalog gross of the order, commune, does the OWNER grant the promotion in this scenario]
  it.each<[string, number, string, boolean]>([
    ['below the minimum', 119_990, 'Ñuñoa', false],
    ['exactly the minimum', 120_000, 'Ñuñoa', true],
    ['exactly the maximum', 499_990, 'Ñuñoa', true],
    ['above the maximum', 500_000, 'Ñuñoa', false],
    ['an eligible commune', 150_000, 'Ñuñoa', true],
    ['an ineligible commune', 150_000, 'Valparaíso', false],
  ])('%s: R4 forwards the catalog amount untouched and returns the owner offers unchanged', async (_scenario, gross, commune, granted) => {
    const owner = promoOwner(() => granted);
    const o = await quoteOrder(owner.shipping, catalogAt(gross), commune);
    // What the owner is asked to decide on: the Catalog's declared value as is, nothing R4 derived for a promotion.
    expect(owner.requests).toEqual([{ destination: { commune }, basis: { type: 'order', totalWeightKg: 20, declaredValueGross: { amount: gross, currency: 'CLP' } } }]);
    expect(o.outcome).toBe('succeeded');
    const offers = (o.payload as { offers: { carrierName: string; serviceType: string; price: { ownerNet: { amount: number }; customerGross: { amount: number } } }[] }).offers;
    const promo = offers.find((x) => x.carrierName === PROMO.carrierName && x.serviceType === PROMO.serviceType);
    if (granted) {
      expect(promo?.price).toMatchObject({ ownerNet: { amount: 1 }, customerGross: { amount: 1 } }); // $1: never 0, never "free"
      expect(offers.map((x) => x.carrierName)).toEqual(['Pesas Chile', 'Blue Express']); // owner order, nothing auto-picked
    } else {
      expect(promo).toBeUndefined();
      expect(offers).toHaveLength(1);
    }
    expect(offers.find((x) => x.carrierName === 'Blue Express')!.price.customerGross.amount).toBe(12_777);
  });

  it('the same order flips with the owner answer only: R4 has no opinion of its own', async () => {
    for (const granted of [true, false, true]) {
      const o = await quoteOrder(promoOwner(() => granted).shipping, catalogAt(150_000), 'Ñuñoa');
      expect((o.payload as { offers: { carrierName: string }[] }).offers.some((x) => x.carrierName === PROMO.carrierName)).toBe(granted);
    }
  });

  it('Shipping unavailable: a typed failed observation, no offers and no price at all', async () => {
    const down: ShippingService = { quote: () => Promise.reject(new DomainError('temporarily_unavailable', 'shipping_owner_unavailable', 'shipping service is temporarily unavailable')) };
    const o = await quoteOrder(down, catalogAt(150_000), 'Ñuñoa');
    expect(o).toMatchObject({ outcome: 'failed', error: { details: { category: 'temporarily_unavailable', code: 'shipping_owner_unavailable' } } });
    expect(o.payload ?? null).toBeNull();
  });
});

describe('quote.preview / quote.create carry the exact Shipping amount of the chosen offer', () => {
  it('a chosen $1 offer is the 1 CLP owner net in the snapshot, the offer message and the Quote request', async () => {
    const built = await buildCommercialSnapshot({ catalog: catalogAt(150_000), shipping: promoOwner(() => true).shipping }, workspaceWith('Ñuñoa', promoChoice), {}, new Date());
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') return;
    expect(built.snapshot.shipping).toMatchObject({ kind: 'selected', ...PROMO, commune: 'Ñuñoa', amount: { amount: 1, taxBasis: 'excluded', taxRate: '0.19' } });
    const message = renderOfferMessage(built.snapshot, 'Q-TEST-1');
    expect(message).toContain('Despacho: Pesas Chile, Despacho Directo, a Ñuñoa, Metropolitana de Santiago: $1\n');
    const request = quoteRequestOf(built.snapshot, built.evidence, { ...QUOTE_V2_CORRELATION, externalReference: context.taskId });
    expect(request.shipping).toMatchObject({ carrier: { name: 'Pesas Chile' }, serviceType: { name: 'Despacho Directo' }, amount: { amount: 1, taxBasis: 'excluded' } });
  });

  it('a chosen paid offer keeps its exact owner net (the J4-R5 canary case: Blue Express)', async () => {
    const built = await buildCommercialSnapshot({ catalog: catalogAt(150_000), shipping: promoOwner(() => true).shipping }, workspaceWith('Ñuñoa', { carrierName: 'Blue Express', serviceType: 'EXPRESS', agreedOwnerNetClp: 10_737 }), {}, new Date());
    expect(built.status === 'ready' && built.snapshot.shipping).toMatchObject({ carrierName: 'Blue Express', amount: { amount: 10_737 } });
  });

  it('a discount that moves the order out of the promotion: the owner withdraws the offer and the preview blocks, no price is invented', async () => {
    const catalog = catalogAt(125_000);
    // Owner stand-in: grants the promotion on the first quote, withdraws it once the Catalog states a discounted price.
    const owner = promoOwner((request) => request.basis.type === 'order' && request.basis.declaredValueGross.amount === 125_000);
    expect((await quoteOrder(owner.shipping, catalog, 'Ñuñoa')).payload).toMatchObject({ offers: [{ carrierName: 'Pesas Chile' }, { carrierName: 'Blue Express' }] });
    catalog.setPrice('BAR-OLY20', 115_000);
    const built = await buildCommercialSnapshot({ catalog, shipping: owner.shipping }, workspaceWith('Ñuñoa', promoChoice), {}, new Date());
    expect(owner.requests.at(-1)!.basis).toMatchObject({ declaredValueGross: { amount: 115_000 } });
    expect(built).toMatchObject({ status: 'blocked', blockers: [{ code: 'shipping_offer_unavailable' }] });
  });

  it('an owner that now prices the chosen service differently blocks with shipping_offer_changed (never the agreed amount silently)', async () => {
    const built = await buildCommercialSnapshot({ catalog: catalogAt(150_000), shipping: promoOwner(() => false).shipping }, workspaceWith('Ñuñoa', { carrierName: 'Blue Express', serviceType: 'EXPRESS', agreedOwnerNetClp: 1 }), {}, new Date());
    expect(built).toMatchObject({ status: 'blocked', blockers: [{ code: 'shipping_offer_changed', details: { agreedOwnerNet: 1, currentOwnerNet: 10_737 } }] });
  });

  it('Shipping unavailable at preview: the owner error propagates (nothing to quote), no snapshot with a guessed amount', async () => {
    const down: ShippingService = { quote: () => Promise.reject(new DomainError('temporarily_unavailable', 'shipping_owner_unavailable', 'down')) };
    await expect(buildCommercialSnapshot({ catalog: catalogAt(150_000), shipping: down }, workspaceWith('Ñuñoa', promoChoice), {}, new Date())).rejects.toMatchObject({ code: 'shipping_owner_unavailable' });
  });
});

describe('no R4 code decides the promotion', () => {
  const ROOT = join(import.meta.dirname, '..', '..', '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === 'dist' ? [] : e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

  it('no source under packages/, adapters/ or agents/ names the promotion, its thresholds or a commune list for it', () => {
    const rel = (file: string) => relative(ROOT, file).replace(/\\/g, '/');
    const all = ['packages', 'adapters', 'agents'].flatMap((d) => sources(join(ROOT, d)));
    expect(all.filter((file) => /despacho directo/i.test(readFileSync(file, 'utf8'))).map(rel)).toEqual([]);
    // The thresholds, on every Shipping and Quote path (120_000 elsewhere is a millisecond timeout).
    const pricingPaths = all.filter((file) => /adapters\/domains\/(src\/)?(shipping|quote)|agents\/sales\/src\/(capabilities|workspace)\//.test(rel(file)));
    expect(pricingPaths.length).toBeGreaterThan(20);
    expect(pricingPaths.filter((file) => /\b120[._]?000\b|\b499[._]?990\b/.test(readFileSync(file, 'utf8'))).map(rel)).toEqual([]);
  });

  it('the promotion lives only in the v9 guidance text, which defers to Shipping', () => {
    const v9 = JSON.parse(readFileSync(join(ROOT, 'agents/sales/sales.v9.agent.json'), 'utf8')) as { instructions: string };
    expect(v9.instructions).toMatch(/alone decides whether an order qualifies/);
  });
});
