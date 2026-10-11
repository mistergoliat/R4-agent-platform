import { describe, expect, it } from 'vitest';
import { createFixtureDomains, type CatalogDiscoverPort } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import {
  CAPABILITY_IDS,
  NON_PRODUCTION_CAPABILITY_IDS,
  budgetCoherence,
  catalogDiscoverCapability,
  catalogDiscoverInput,
  composeSales,
  guardDiscoverText,
  loadSalesAgentDefinition,
  workspaceBudgets,
  type CatalogDiscoverView,
  type FactValue,
} from '@r4-sales/agent';
import { SALES_PRODUCTION_PROFILES } from '@r4-sales/agent/production';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';
import { DISCOVER_OWNER_AS_OF, fixedDiscover, replayDiscover, scenarioFixture, turnFixture } from '../../support/catalog-discover-contract.js';

/**
 * R4-DISCOVER-I1: the model-visible catalog.discover capability — input boundary, pre-send
 * guards, coherence with the Sales workspace, the owner's answers read through R4's policy,
 * and typed failures as observations. Owner answers come from the owner fixtures.
 */
const TASK = '0190a0a0-0000-7000-8000-0000000000aa';
const context = { taskId: TASK, runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'corr-i1', grantedScopes: ['catalog.read'] };

const workspaceWith = (facts: Record<string, FactValue>) => ({
  workspace: () => Promise.resolve({ state: { facts: Object.fromEntries(Object.entries(facts).map(([k, value]) => [k, { value, statedBy: 'customer' as const, note: null, sinceVersion: 1, updatedAt: DISCOVER_OWNER_AS_OF }])), delivery: null, items: [] } }),
});

function setup(port: CatalogDiscoverPort, facts: Record<string, FactValue> = {}, now = DISCOVER_OWNER_AS_OF) {
  const registry = new CapabilityRegistry();
  const clock = new FakeClock(now);
  registry.register(catalogDiscoverCapability({ discover: port, workspaces: workspaceWith(facts), now: () => clock.now() }) as never);
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
  const invoke = (args: Record<string, unknown>) => invoker.invoke({ capabilityId: 'catalog.discover', arguments: args }, context);
  return { invoke, clock };
}

const view = (o: { payload: unknown }) => o.payload as CatalogDiscoverView;
const candidate = (v: CatalogDiscoverView, key: string) => v.candidates.find((c) => c.productKey === key)!;

describe('catalog.discover — model-visible input', () => {
  it('accepts the need, a use context, typed constraints, reference products, chosen variants and at most eight candidates', () => {
    expect(catalogDiscoverInput.safeParse({ need: 'máquina para entrenar espalda', useContext: 'poco espacio', constraints: { maxUnitPriceClp: 300_000, maxLengthCm: 180 }, referenceProductKeys: ['P7'], selectedItemKeys: ['P7-V2'], limit: 8 }).success).toBe(true);
    expect(catalogDiscoverInput.parse({ need: 'kettlebell' }).limit).toBe(5);
  });

  it.each([
    ['nine candidates', { need: 'kettlebell', limit: 9 }],
    ['a customer identity field', { need: 'kettlebell', customerId: 'C-1' }],
    ['contact data fields', { need: 'kettlebell', email: 'a@b.cl' }],
    ['the conversation', { need: 'kettlebell', conversation: [{ role: 'user', text: 'hola' }] }],
    ['an unsupported constraint', { need: 'kettlebell', constraints: { color: 'rojo' } }],
    ['a mutating action', { need: 'kettlebell', action: 'add_to_cart' }],
    ['a need longer than the bound', { need: 'x'.repeat(201) }],
    ['a price as text in the constraint', { need: 'kettlebell', constraints: { maxUnitPriceClp: '300.000' } }],
  ])('refuses %s', (_name, args) => {
    expect(catalogDiscoverInput.safeParse(args).success).toBe(false);
  });

  it('the description routes: conceptual needs here, names/SKUs to catalog.search, known keys to product context', () => {
    const registry = new CapabilityRegistry();
    registry.register(catalogDiscoverCapability({ discover: fixedDiscover({ status: 200, body: {} }).port, workspaces: workspaceWith({}), now: () => new Date() }) as never);
    const definition = registry.resolve('catalog.discover')!.definition;
    expect(definition).toMatchObject({ riskClass: 'READ', requiredScopes: ['catalog.read'], retryPolicy: { maxAttempts: 1 }, owner: 'catalog' });
    expect(definition.description).toMatch(/CONCEPTUAL/);
    expect(definition.description).toMatch(/catalog\.search/);
    expect(definition.description).toMatch(/catalog\.get_product_context/);
    const fields = Object.keys((definition.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(fields.sort()).toEqual(['constraints', 'limit', 'need', 'referenceProductKeys', 'selectedItemKeys', 'useContext']);
  });
});

describe('catalog.discover — pre-send guards (the owner stays the authority)', () => {
  it.each([
    ['a transcript with speakers', 'Cliente: necesito entrenar espalda. Agente: ¿cuánto espacio?'],
    ['several lines', 'necesito entrenar espalda\ntengo poco espacio'],
    ['an e-mail', 'kettlebell para ana@example.com'],
    ['a phone', 'kettlebell, llamar al +56 9 8765 4321'],
    ['a RUT', 'kettlebell para 12.345.678-5'],
    ['a street address', 'kettlebell despacho a calle Los Aromos 1234'],
  ])('refuses %s before anything is sent, without echoing the value', async (_name, need) => {
    const { port, requests } = fixedDiscover({ status: 200, body: scenarioFixture(3).http.body });
    const o = await setup(port).invoke({ need });
    expect(o.outcome).toBe('failed');
    expect(o.error).toMatchObject({ details: { category: 'validation', discoverFailure: 'INVALID_REQUEST', retryable: false } });
    expect(JSON.stringify(o.error)).not.toMatch(/ana@example|8765|12\.345|Aromos/);
    expect(requests).toHaveLength(0);
  });

  it.each(['máquina para entrenar espalda', 'kettlebell de 20 kg', 'barra de 2,2 m', 'para depto pequeño de 40 m2', 'poco espacio', 'rack de 215 cm de alto', 'polea para entrenar espalda'])('lets an ordinary need through: %s', (need) => {
    expect(() => guardDiscoverText('need', need)).not.toThrow();
  });
});

describe('catalog.discover — budget coherence with the Sales workspace (existing conversational state)', () => {
  it('derives budgets from the facts the agent recorded, whatever the key (budget, presupuesto_clp …)', () => {
    const budgets = workspaceBudgets({ state: { facts: {
      budget: { value: { amount: 300_000, currency: 'CLP' }, statedBy: 'customer', note: null, sinceVersion: 1, updatedAt: '' },
      presupuesto_maquina: { value: 250_000, statedBy: 'agent', note: null, sinceVersion: 2, updatedAt: '' },
      space: { value: 'poco espacio', statedBy: 'customer', note: null, sinceVersion: 1, updatedAt: '' },
      budget_usd: { value: { amount: 300, currency: 'USD' }, statedBy: 'customer', note: null, sinceVersion: 1, updatedAt: '' },
    }, delivery: null, items: [] } });
    expect(budgets).toEqual([{ key: 'budget', amountClp: 300_000 }, { key: 'presupuesto_maquina', amountClp: 250_000 }]);
  });

  it('a structured budget must be the CURRENT recorded one: unrecorded, replaced or retracted values are refused', () => {
    expect(budgetCoherence(300_000, [{ key: 'budget', amountClp: 300_000 }])).toEqual({ applied: 'budget', unapplied: [] });
    expect(() => budgetCoherence(300_000, [])).toThrow(/recorded in the Sales workspace first/);
    // The customer raised it to 400 000 and the workspace was corrected: the old 300 000 can no longer be sent.
    expect(() => budgetCoherence(300_000, [{ key: 'budget', amountClp: 400_000 }])).toThrow(/not the customer's current recorded budget/);
    expect(budgetCoherence(undefined, [{ key: 'budget', amountClp: 400_000 }])).toEqual({ applied: null, unapplied: [{ key: 'budget', amountClp: 400_000 }] });
  });

  it('the handler applies the rule before calling the owner and reports what it sent', async () => {
    const turn3 = turnFixture(3);
    const replay = replayDiscover([turn3]);
    const coherent = await setup(replay.port, { budget: { amount: 300_000, currency: 'CLP' } }).invoke({ need: 'máquina para entrenar espalda', useContext: 'poco espacio', constraints: { maxUnitPriceClp: 300_000 }, limit: 8 });
    expect(coherent.outcome).toBe('succeeded');
    expect(view(coherent).request).toMatchObject({ need: 'máquina para entrenar espalda poco espacio', constraints: { maxUnitPriceClp: 300_000 }, budgetFromWorkspace: 'budget' });
    const stale = await setup(replay.port, { budget: { amount: 400_000, currency: 'CLP' } }).invoke({ need: 'máquina para entrenar espalda', useContext: 'poco espacio', constraints: { maxUnitPriceClp: 300_000 }, limit: 8 });
    expect(stale.error).toMatchObject({ details: { code: 'budget_not_current', discoverFailure: 'INVALID_REQUEST' } });
    expect(replay.requests).toHaveLength(1);
  });
});

describe('catalog.discover — the owner\'s states as R4 reads them', () => {
  const read = async (id: number, now = DISCOVER_OWNER_AS_OF) => view(await setup(fixedDiscover({ status: 200, body: scenarioFixture(id).http.body }).port, {}, now).invoke({ need: 'kettlebell' }));

  it('VERIFIED vs POSSIBLE: a POSSIBLE match is presented with caveats and never as meeting its unresolved requirements', async () => {
    const v = await read(16);
    expect(v.candidates.every((c) => c.disposition === 'POSSIBLE_MATCH' && c.reading.presentation === 'POSSIBILITY_WITH_CAVEATS')).toBe(true);
    expect(v.reading.labels).toEqual(expect.arrayContaining(['MAY_PRESENT_POSSIBILITIES_WITH_CAVEATS', 'CANNOT_ASSERT_NO_PRODUCTS_EXIST']));
    for (const c of v.candidates) for (const r of c.reading.requirements.filter((x) => x.state !== 'SATISFIED')) expect(c.reading.forbiddenClaims).toContain(`MEETS:${r.code}`);
  });

  it('UNKNOWN / UNSUPPORTED requirements are never turned into SATISFIED (scenario 21)', async () => {
    const v = await read(21);
    expect(v.reading.askCustomer.reasons).toContain('UNSUPPORTED_REQUIREMENT');
    for (const c of v.candidates) expect(c.reading.allowedClaims).not.toContain('MEETS:compatible_with:rack');
  });

  it('a preference (small space) is never asserted as met', async () => {
    const v = await read(4);
    for (const c of v.candidates) expect(c.reading.forbiddenClaims).toContain('MEETS:USE_CONTEXT:SMALL_SPACE');
  });

  it('a reference price (not orderable) is information only: no current price, no offer, no budget (scenario 8)', async () => {
    const p2 = candidate(await read(8), 'P2');
    expect(p2.reading.allowedClaims).toContain('PRICE_REFERENCE_ONLY');
    expect(p2.reading.forbiddenClaims).toEqual(expect.arrayContaining(['PRICE_CURRENT', 'ORDERABLE_NOW', 'WITHIN_BUDGET', 'IN_STOCK']));
    expect(p2.reading.presentation).toBe('WITH_COMMERCIAL_CAVEAT');
  });

  it('a "from" price is not a variant\'s price: the customer must choose (scenario 9)', async () => {
    const v = await read(9);
    const p5 = candidate(v, 'P5');
    expect(p5.reading).toMatchObject({ unitBasis: 'UNDETERMINED', allowedClaims: expect.arrayContaining(['PRICE_FROM']) });
    expect(p5.reading.forbiddenClaims).toEqual(expect.arrayContaining(['PRICE_CURRENT', 'VARIANT_FIXED']));
    expect(p5.reading.next).toContainEqual({ action: 'SELECT_ITEM', capability: CAPABILITY_IDS.productContext, key: 'P5' });
    expect(v.reading.askCustomer.reasons).toContain('VARIANT_CHOICE');
  });

  it('a selected variant that does not exist is reported, never priced (scenario 10)', async () => {
    const v = await read(10);
    expect(v.interpretation.selection.notFound).toEqual(['P5-V99']);
    expect(v.reading.askCustomer.reasons).toContain('SELECTED_VARIANT_NOT_FOUND');
    expect(candidate(v, 'P5').itemKey).not.toBe('P5-V99');
    expect(candidate(v, 'P5').reading.allowedClaims).not.toContain('VARIANT_FIXED');
  });

  it('the fixed variant is priced on its own unit: price and stock of the same itemKey (scenario 23)', async () => {
    const p7 = candidate(await read(23), 'P7');
    expect(p7).toMatchObject({ itemKey: 'P7-V2', commercial: { status: 'OBSERVED', price: { kind: 'from', finalGrossClp: 261_800 }, unit: { itemKey: 'P7-V2', finalGrossClp: 273_700 } } });
    expect(p7.reading).toMatchObject({ unitBasis: 'SELECTED', presentation: 'PURCHASABLE' });
    expect(p7.reading.allowedClaims).toEqual(expect.arrayContaining(['VARIANT_FIXED', 'PRICE_CURRENT', 'WITHIN_BUDGET']));
    expect(p7.reading.next).toContainEqual(expect.objectContaining({ action: 'CONFIRM_ITEM', key: 'P7-V2' }));
  });

  it('out of stock is not orderable; backorder is orderable but not "in stock" (scenarios 11, 12)', async () => {
    const p4 = candidate(await read(11), 'P4');
    expect(p4.reading.forbiddenClaims).toEqual(expect.arrayContaining(['ORDERABLE_NOW', 'IN_STOCK', 'PRICE_CURRENT']));
    const p3 = candidate(await read(12), 'P3');
    expect(p3.reading.allowedClaims).toEqual(expect.arrayContaining(['BACKORDER', 'ORDERABLE_NOW']));
    expect(p3.reading.forbiddenClaims).toContain('IN_STOCK');
  });

  it('an expired commercial observation is never current: the owner said EXPIRED (14), or R4\'s clock passed validUntil', async () => {
    const expired = await read(14);
    expect(expired.reading.labels).toContain('REQUIRE_FRESH_COMMERCIAL_LOOKUP');
    for (const c of expired.candidates) expect(c.reading.allowedClaims.filter((x) => !x.startsWith('MEETS:'))).toEqual([]);
    const late = await read(1, '2026-10-09T12:00:20.000Z');
    expect(candidate(late, 'P1').reading).toMatchObject({ commercial: 'EXPIRED', presentation: 'WITH_COMMERCIAL_CAVEAT' });
    expect(candidate(late, 'P1').reading.allowedClaims).not.toContain('PRICE_CURRENT');
  });

  it('COMPLETE is not exhaustive: no "these are all" (17); PARTIAL never "none exist" (19, 24); truncated retrieval (18)', async () => {
    const complete = await read(17);
    expect(complete.status).toBe('COMPLETE');
    expect(complete.completeness.exhaustive).toBe(false);
    expect(complete.reading.answerForbidden).toEqual(expect.arrayContaining(['COMPLETE_LIST', 'NONE_EXIST']));
    for (const id of [18, 19, 24]) {
      const v = await read(id);
      expect(v.status).toBe('PARTIAL');
      expect(v.reading.canAssertNoneExist).toBe(false);
      expect(v.reading.answerForbidden).toContain('NONE_EXIST');
    }
    expect((await read(24)).absence).toMatchObject({ reason: 'COMMERCIAL_EVALUATION_INCOMPLETE' });
  });

  it('DEGRADED with commercial truth down: candidates without price or stock, retry later, never "no products" (13); a partial owner failure keeps the certified ones (20)', async () => {
    const down = await read(13);
    expect(down.status).toBe('DEGRADED');
    expect(down.reading).toMatchObject({ canAssertNoneExist: false, retryable: true });
    for (const c of down.candidates) expect(c.reading.commercial).toBe('UNKNOWN');
    const partial = await read(20);
    expect(candidate(partial, 'P1').reading.allowedClaims).toContain('WITHIN_BUDGET');
    expect(partial.reading.labels).toEqual(expect.arrayContaining(['COMMERCIAL_TRUTH_DEGRADED', 'RETRY_LATER']));
  });

  it('an ambiguous need asks the customer, with the readings and the products under each (15)', async () => {
    const v = await read(15);
    expect(v.reading.askCustomer).toEqual({ needed: true, reasons: ['AMBIGUOUS_NEED'] });
    expect(v.interpretation.ambiguities[0]!.readings.map((r) => [r.readingId, r.candidates])).toEqual([['A', ['P12']], ['B', ['P13']]]);
  });

  it('the observation carries the owner\'s commercial window (ADR-030): validUntil is the owner\'s earliest', async () => {
    const o = await setup(fixedDiscover({ status: 200, body: scenarioFixture(1).http.body }).port).invoke({ need: 'kettlebell' });
    expect(view(o).freshness.validUntil).toBe('2026-10-09T12:00:15.000Z');
    expect(o.validUntil).toBe('2026-10-09T12:00:15.000Z');
  });
});

describe('catalog.discover — typed failures become failed observations (never "no products")', () => {
  it.each([
    [401, 'unauthorized', 'AUTH_FAILED', false],
    [503, 'capability_disabled', 'DISABLED', false],
    [503, 'capability_not_ready', 'NOT_READY', true],
    [503, 'capability_saturated', 'SATURATED', true],
    [500, 'internal_error', 'SERVICE_ERROR', false],
  ] as const)('HTTP %i %s → %s', async (status, code, failure, retryable) => {
    const o = await setup(fixedDiscover({ status, body: { error: { code, message: 'm', correlationId: 'c', retryable } } }).port).invoke({ need: 'kettlebell' });
    expect(o.outcome).toBe('failed');
    expect(o.payload).toBeNull();
    expect(o.error).toMatchObject({ details: { discoverFailure: failure, retryable } });
  });
});

describe('catalog.discover — composition and production boundary', () => {
  const noDb = { query: () => Promise.reject(new Error('no database')), connect: () => Promise.reject(new Error('no database')) } as never;
  const model = { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) };
  const scopes = loadSalesAgentDefinition().capabilityScopes;

  it('is not registered unless a Discover binding is provided; with one it is a READ visible under catalog.read', () => {
    const without = composeSales({ pool: noDb, domains: createFixtureDomains(), modelProvider: model });
    expect(without.capabilities.discover(scopes).map((c) => c.capabilityId)).not.toContain('catalog.discover');
    const withDiscover = composeSales({ pool: noDb, domains: { ...createFixtureDomains(), catalogDiscover: fixedDiscover({ status: 200, body: {} }).port }, modelProvider: model });
    const visible = withDiscover.capabilities.discover(scopes).find((c) => c.capabilityId === 'catalog.discover');
    expect(visible).toMatchObject({ riskClass: 'READ' });
    // catalog.search keeps serving nominal searches: Discover replaces nothing.
    expect(withDiscover.capabilities.discover(scopes).map((c) => c.capabilityId)).toEqual(expect.arrayContaining(['catalog.search', 'catalog.get_product_context']));
  });

  it('no production profile lists it (FEATURE_ENABLED_IN_PRODUCTION=NO), and it is not a production capability id', () => {
    expect(SALES_PRODUCTION_PROFILES.length).toBe(4);
    for (const profile of SALES_PRODUCTION_PROFILES) {
      expect(JSON.stringify(profile)).not.toContain(NON_PRODUCTION_CAPABILITY_IDS.catalogDiscover);
    }
    expect(Object.values(CAPABILITY_IDS)).not.toContain('catalog.discover');
  });
});
