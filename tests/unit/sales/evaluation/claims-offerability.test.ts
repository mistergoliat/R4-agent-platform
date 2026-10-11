import { describe, expect, it } from 'vitest';
import { FixtureCatalog } from '@r4-adapters/domains';
import type { Observation } from '@r4/contracts';
import type { ExtractedClaim } from '@r4/evaluation';
import { CAPABILITY_IDS, catalogDiscoverView, catalogSearchView, productContextView } from '@r4-sales/agent';
import { SalesClaimVerifier } from '@r4-sales/agent/evaluations';
import { DISCOVER_OWNER_AS_OF, DISCOVER_T0, fixedDiscover, scenarioFixture, turnFixture, type DiscoverFixture } from '../../../support/catalog-discover-contract.js';

/**
 * R4-DISCOVER-I1 §6 — the claims checker distinguishes information from an OFFER. A matching
 * number never grounds "you can buy X for $Y" by itself: the observation must be current, the
 * unit identified and sellable per the owner, the budget satisfied by an offerable price, and
 * price/stock must belong to the same itemKey the claim names. Explicit negative cases.
 */
const verifier = new SalesClaimVerifier();
let seq = 0;

function observation(capabilityId: string, payload: unknown, observedAt: string): Observation {
  seq += 1;
  return {
    observationId: `0190a0a0-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    taskId: '0190a0a0-0000-7000-8000-0000000000aa',
    runId: '0190a0a0-0000-7000-8000-0000000000bb',
    agentId: 'sales',
    source: { kind: 'capability', capabilityId, capabilityVersion: 1, invocationId: '0190a0a0-0000-7000-8000-0000000000cc' },
    outcome: 'succeeded',
    payload,
    error: null,
    observedAt,
    validUntil: null,
    provenance: {},
    correlationId: 'c',
  } as unknown as Observation;
}

const SENT = { need: 'x', constraints: {}, referenceProductKeys: [], selectedItemKeys: [], limit: 8, budgetFromWorkspace: null, unappliedWorkspaceBudgets: [] };
async function discoverObservation(fixture: DiscoverFixture, need = 'x', observedAt = DISCOVER_OWNER_AS_OF): Promise<Observation> {
  const answer = await fixedDiscover({ status: fixture.http.status, body: fixture.http.body }).port.discover({ need });
  // The view echoes what was sent: the fixture's own owner request (need, constraints).
  const constraints = (fixture.request.constraints ?? {}) as Record<string, number | boolean>;
  return observation('catalog.discover', JSON.parse(JSON.stringify(catalogDiscoverView(answer, { ...SENT, need, constraints }, DISCOVER_T0))), observedAt);
}

const claim = (type: ExtractedClaim['type'], text: string, entities: { name: string; ref?: string | null }[], attributes: ExtractedClaim['attributes'] = {}): ExtractedClaim => ({
  responseId: 'r', type, text, entities: entities.map((e) => ({ name: e.name, kind: 'product', ref: e.ref ?? null })), attributes,
});
const supported = (c: ExtractedClaim, evidence: Observation[]) => verifier.verify(c, evidence).supported;

describe('offers over catalog.search / product context (FixtureCatalog owner)', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const catalog = new FixtureCatalog({ now: () => now });
  const search = async (query: string) => observation(CAPABILITY_IDS.catalogSearch, catalogSearchView(await catalog.search({ query, limit: 10 }), query), now.toISOString());
  const context = async (key: string) => observation(CAPABILITY_IDS.productContext, productContextView(await catalog.getProductContext(key)), now.toISOString());

  it('a reference price (out of stock, no backorder → not_offerable) is information, never an offer or a budget fit', async () => {
    const evidence = [await search('power rack'), await context('RACK-PR300')];
    const pr300 = { name: 'Power Rack PR-300 Pro', ref: 'RACK-PR300' };
    expect(supported(claim('price', 'El PR-300 Pro tiene un precio de referencia de $459.990', [pr300], { amount: 459_990 }), evidence)).toBe(true);
    expect(supported(claim('price', 'Puedes comprar el PR-300 Pro por $459.990', [pr300], { amount: 459_990 }), evidence)).toBe(false);
    expect(supported(claim('price', 'El PR-300 Pro cuesta $459.990', [pr300], { amount: 459_990, offer: true }), evidence)).toBe(false);
    expect(supported(claim('price', 'El PR-300 Pro está dentro de tu presupuesto de $500.000', [pr300], { withinBudget: true, budget: 500_000 }), evidence)).toBe(false);
  });

  it('a sellable product without variants: the offer at its exact price is grounded; another amount or an over-budget claim is not', async () => {
    const evidence = [await context('RACK-PR200')];
    const pr200 = { name: 'Power Rack PR-200', ref: 'RACK-PR200' };
    const price = (evidence[0]!.payload as { derived: { price: { finalGross: { amount: number } } } }).derived.price.finalGross.amount;
    expect(supported(claim('price', `Puedes comprar el PR-200 por ${price}`, [pr200], { amount: price, offer: true }), evidence)).toBe(true);
    expect(supported(claim('price', 'Puedes comprar el PR-200 por 1', [pr200], { amount: 1, offer: true }), evidence)).toBe(false);
    expect(supported(claim('price', 'Cabe en tu presupuesto', [pr200], { amount: price, offer: true, budget: price - 1 }), evidence)).toBe(false);
  });

  it('a "from" price never certifies a variant, and a product with variants is not an identified unit', async () => {
    const evidence = [await search('kettlebell competicion'), await context('KB-COMP')];
    // from = 44 990 (KB-COMP-12, the cheapest offerable variant).
    expect(supported(claim('price', 'La kettlebell de competición cuesta desde $44.990', [{ name: 'Kettlebell de competición', ref: 'KB-COMP' }], { amount: 44_990 }), evidence)).toBe(true);
    expect(supported(claim('price', 'Puedes comprar la kettlebell de competición de 24 kg por $44.990', [{ name: 'Kettlebell de competición 24 kg', ref: 'KB-COMP-24' }], { amount: 44_990, offer: true }), evidence)).toBe(false);
    expect(supported(claim('price', 'Puedes comprar la kettlebell de competición por $44.990', [{ name: 'Kettlebell de competición', ref: 'KB-COMP' }], { amount: 44_990, offer: true }), evidence)).toBe(false);
    // "There is one within your budget" (no variant named, no explicit offer) is grounded by the offerable "from".
    expect(supported(claim('price', 'Hay una kettlebell de competición dentro de tu presupuesto de $50.000', [{ name: 'Kettlebell de competición', ref: 'KB-COMP' }], { withinBudget: true, budget: 50_000 }), evidence)).toBe(true);
  });

  it('an observation the owner had already declared expired grounds no offer', async () => {
    const stale = { ...(await context('RACK-PR200')), observedAt: '2026-01-02T00:00:00.000Z' };
    const price = (stale.payload as { derived: { price: { finalGross: { amount: number } } } }).derived.price.finalGross.amount;
    expect(supported(claim('price', 'Puedes comprarlo', [{ name: 'Power Rack PR-200', ref: 'RACK-PR200' }], { amount: price, offer: true }), [stale])).toBe(false);
  });
});

describe('offers over catalog.discover evidence (owner fixtures)', () => {
  it('the selected variant: grounded at its OWN unit price; never at the "from" price, never for the other variant (scenario 23)', async () => {
    const evidence = [await discoverObservation(scenarioFixture(23))];
    const white = { name: 'Remo Plegable Compacto blanco', ref: 'P7-V2' };
    expect(supported(claim('price', 'Puedes comprar el remo blanco por $273.700', [white], { amount: 273_700, offer: true }), evidence)).toBe(true);
    expect(supported(claim('price', 'Puedes comprar el remo blanco por $261.800', [white], { amount: 261_800, offer: true }), evidence)).toBe(false);
    expect(supported(claim('price', 'Puedes comprar el remo negro por $273.700', [{ name: 'Remo Plegable Compacto negro', ref: 'P7-V1' }], { amount: 273_700, offer: true }), evidence)).toBe(false);
    expect(supported(claim('availability', 'El remo blanco está disponible para comprar', [white], { offer: true }), evidence)).toBe(true);
  });

  it('a witness unit (certified the budget, not chosen) is no offer of that variant; the product fits the budget (turn 3)', async () => {
    const evidence = [await discoverObservation(turnFixture(3))];
    expect(supported(claim('price', 'El remo plegable está dentro de tu presupuesto de $300.000', [{ name: 'Remo Plegable Compacto', ref: 'P7' }], { withinBudget: true, budget: 300_000 }), evidence)).toBe(true);
    expect(supported(claim('price', 'Puedes comprar el remo negro por $261.800', [{ name: 'Remo Plegable Compacto negro', ref: 'P7-V1' }], { amount: 261_800, offer: true }), evidence)).toBe(false);
    expect(supported(claim('price', 'La barra de dominadas está dentro de tu presupuesto de $50.000', [{ name: 'Barra Dominadas Muro', ref: 'P6' }], { withinBudget: true, budget: 50_000 }), evidence)).toBe(false);
  });

  it('a reference price, an out-of-stock unit, an expired or an unknown commercial state ground no offer (8, 11, 14, 13)', async () => {
    expect(supported(claim('price', 'Puedes comprar la kettlebell de vinilo por $47.600', [{ name: 'Kettlebell Vinilo 20kg', ref: 'P2' }], { amount: 47_600, offer: true }), [await discoverObservation(scenarioFixture(8))])).toBe(false);
    expect(supported(claim('availability', 'La kettlebell fundida está disponible para comprar', [{ name: 'Kettlebell Fundida 20kg', ref: 'P4' }], { offer: true }), [await discoverObservation(scenarioFixture(11))])).toBe(false);
    const expired = [await discoverObservation(scenarioFixture(14))];
    expect(supported(claim('price', 'La kettlebell de hierro cuesta $47.600', [{ name: 'Kettlebell Hierro 20kg', ref: 'P1' }], { amount: 47_600 }), expired)).toBe(false);
    expect(supported(claim('price', 'Puedes comprarla por $47.600', [{ name: 'Kettlebell Hierro 20kg', ref: 'P1' }], { amount: 47_600, offer: true }), [await discoverObservation(scenarioFixture(13))])).toBe(false);
  });

  it('backorder is orderable: an offer may be grounded, an "in stock" status may not (scenario 12)', async () => {
    const evidence = [await discoverObservation(scenarioFixture(12))];
    const p3 = { name: 'Kettlebell Competencia 20kg', ref: 'P3' };
    expect(supported(claim('price', 'Puedes pedirla por $47.600', [p3], { amount: 47_600, offer: true }), evidence)).toBe(true);
    expect(supported(claim('stock', 'Está en stock', [p3], { status: 'in_stock' }), evidence)).toBe(false);
    expect(supported(claim('stock', 'Se puede pedir con entrega diferida', [p3], { status: 'backorder' }), evidence)).toBe(true);
  });

  it('an observation read after the owner window passed grounds nothing current', async () => {
    const late = await discoverObservation(scenarioFixture(1), 'x', '2026-10-09T12:00:30.000Z');
    expect(supported(claim('price', 'Puedes comprarla por $47.600', [{ name: 'Kettlebell Hierro 20kg', ref: 'P1' }], { amount: 47_600, offer: true }), [late])).toBe(false);
  });

  it('a recommendation is informative unless it presents an offer', async () => {
    const evidence = [await discoverObservation(scenarioFixture(8))];
    expect(verifier.verify(claim('recommendation', 'Te recomiendo la kettlebell de vinilo', [{ name: 'Kettlebell Vinilo 20kg', ref: 'P2' }]), evidence).supported).toBe(true);
    expect(verifier.verify(claim('recommendation', 'Te recomiendo la de vinilo, puedes comprarla ya', [{ name: 'Kettlebell Vinilo 20kg', ref: 'P2' }]), evidence).supported).toBe(false);
  });
});

describe('absence over catalog.discover evidence', () => {
  it('"there is none" is grounded only by a COMPLETE, exhaustive, empty, unqualified answer (turn 5)', async () => {
    const t5 = await discoverObservation(turnFixture(5), 'polea para entrenar espalda poco espacio');
    expect(supported(claim('availability', 'No tenemos una polea para entrenar espalda en poco espacio hasta $400.000', [{ name: 'polea para entrenar espalda en poco espacio' }], { exists: false, budget: 400_000 }), [t5])).toBe(true);
    // Empty only under the budget: the same absence without the budget is not grounded (a polea exists above it).
    expect(supported(claim('availability', 'No tenemos una polea para entrenar espalda en poco espacio', [{ name: 'polea para entrenar espalda en poco espacio' }], { exists: false }), [t5])).toBe(false);
  });

  it.each([[19, 'PARTIAL, commercial evaluation cut'], [24, 'PARTIAL, no result yet'], [13, 'DEGRADED'], [18, 'retrieval truncated']])('never from scenario %i (%s)', async (id) => {
    const o = await discoverObservation(scenarioFixture(id), 'kettlebell hierro serie');
    expect(supported(claim('availability', 'No tenemos kettlebell', [{ name: 'kettlebell' }], { exists: false }), [o])).toBe(false);
  });
});
