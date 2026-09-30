import { describe, expect, it } from 'vitest';
import { uuidv7, type JsonValue, type Observation } from '@r4/contracts';
import { AgentKernel } from '@r4/agent-kernel';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { CAPABILITY_IDS } from '@r4-sales/agent';
import { SalesCommercialEvidenceValidator } from '../../../agents/sales/src/authority/commercial-evidence.js';
import { complete, respond } from '../../support/decisions.js';
import { MemorySession } from '../../support/kernel-fixtures.js';

/** ADR-031 / R4-J1E: Sales commercial evidence enforcement before outbound. */
const NOW = new Date('2026-09-30T19:10:00.000Z');
const clock = { now: () => NOW };
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const FRESH = inMs(14_000);
const EXPIRED = inMs(-5_000);

type Product = { key: string; name: string; final: number; regular?: number; kind?: 'exact' | 'from'; sellability?: string; reason?: string; requiresSelection?: boolean };
const result = (p: Product) => ({
  productKey: p.key,
  name: p.name,
  sku: null,
  category: null,
  variants: { count: p.requiresSelection ? 2 : 0, requiresSelection: Boolean(p.requiresSelection) },
  price: { kind: p.kind ?? 'exact', basis: 'offerable', finalGross: { amount: p.final, currency: 'CLP' }, regularGross: { amount: p.regular ?? p.final, currency: 'CLP' }, discounted: (p.regular ?? p.final) > p.final },
  availability: { sellability: p.sellability ?? 'sellable', reason: p.reason ?? 'in_stock', sellableVariants: null },
  match: { type: 'name', matchedTokens: 1, totalTokens: 1 },
});
const searchPayload = (products: Product[]) => ({ query: 'q', results: products.map(result), completeness: { totalMatches: products.length, truncated: false }, searchMode: 'lexical', freshness: { asOf: NOW.toISOString(), validUntil: FRESH, cacheAgeMs: 0 } });
const contextPayload = (p: Product) => ({
  status: 'found',
  productKey: p.key,
  facts: { name: p.name, sku: null, category: null, brand: null, status: { active: true, listed: true, orderable: true }, specifications: [], sellableItemKey: p.requiresSelection ? null : p.key, variantOptions: [] },
  catalogText: { notice: 'x', shortDescription: null },
  derived: { price: result(p).price, availability: result(p).availability, publicUrl: null },
  inferred: { frequentlyBoughtTogether: { status: 'unavailable' } },
  freshness: { asOf: NOW.toISOString(), validUntil: FRESH, cacheAgeMs: 0 },
});
const observation = (capabilityId: string, payload: JsonValue, validUntil: string | null = FRESH): Observation => ({
  observationId: uuidv7(),
  taskId: '019b76da-a800-7a10-a671-ab1b6813afa3',
  runId: null,
  agentId: 'sales',
  source: { kind: 'capability', capabilityId, capabilityVersion: 1, invocationId: uuidv7() },
  outcome: 'succeeded',
  payload,
  error: null,
  observedAt: NOW.toISOString(),
  validUntil,
  provenance: {},
  correlationId: 'c',
});

const BORE20: Product = { key: 'P545', name: 'Barra Olímpica 20kg 220cm Eco Serie | PROmachine', final: 84990 };
const KB20: Product = { key: 'P186', name: 'Kettlebell Acero 20kg | HWM®', final: 56990 };
const KB24: Product = { key: 'P187', name: 'Kettlebell Acero 24kg | HWM®', final: 67990, sellability: 'not_sellable', reason: 'out_of_stock' };
const KB28: Product = { key: 'P188', name: 'Kettlebell Acero 28kg | HWM®', final: 78990 };
const COLLARINES: Product = { key: 'P2128', name: 'Par Collarines Olímpico Magnéticos | Rising', final: 15990, kind: 'from', requiresSelection: true };
const OXFORD: Product = { key: 'P2340', name: 'Colchoneta Oxford Negro/Rojo 100x50x5cm - 2da Selección | FullFit', final: 6296, regular: 13990 };
const AIRBIKE: Product = { key: 'P2297', name: 'Air Bike Hurricane 3.0 HWM®', final: 899990, sellability: 'not_sellable', reason: 'out_of_stock' };

const validator = new SalesCommercialEvidenceValidator({ clock });
const check = (content: string, observations: Observation[]) => validator.validate({ content, observations });

describe('10.2 fresh evidence + compatible claim → allowed', () => {
  it('BORE20 at its Catalog price', () => {
    const v = check('¡Sí! Barra Olímpica 20kg 220cm Eco Serie (BORE20): $84.990, con stock.', [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]))]);
    expect(v.kind).toBe('allow');
    expect(v.claims).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unit_price', subjectRef: 'P545', value: 84990, authority: 'catalog' })]));
  });

  it('a promotion: final and regular price of the same product', () => {
    expect(check('La Colchoneta Oxford de 2da selección está en $6.296 (precio normal $13.990).', [observation(CAPABILITY_IDS.catalogSearch, searchPayload([OXFORD]))]).kind).toBe('allow');
  });

  it('the customer\'s budget is not a commercial claim', () => {
    expect(check('Entra holgado en tus ~$200.000.', []).kind).toBe('allow');
  });
});

describe('10.3/10.4 stale evidence is revalidated before outbound', () => {
  it('expired evidence requires a targeted product-context READ', () => {
    const v = check('La barra está en $84.990.', [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), EXPIRED)]);
    expect(v).toMatchObject({ kind: 'revalidation_required', reads: [{ capabilityId: CAPABILITY_IDS.productContext, arguments: { productKey: 'P545' } }] });
  });

  it('refreshed and unchanged → the same draft is allowed', () => {
    const obs = [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), EXPIRED), observation(CAPABILITY_IDS.productContext, contextPayload(BORE20))];
    expect(check('La barra está en $84.990.', obs).kind).toBe('allow');
  });

  it('refreshed and changed (sellable → out_of_stock) → the draft is rejected', () => {
    const obs = [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), EXPIRED), observation(CAPABILITY_IDS.productContext, contextPayload({ ...BORE20, sellability: 'not_sellable', reason: 'out_of_stock' }))];
    const v = check('¡Sí, la tenemos! La barra está en $84.990.', obs);
    expect(v).toMatchObject({ kind: 'reject', code: 'response_authority_contradiction' });
  });

  it('refreshed and changed (new price) → the old amount is no longer supported', () => {
    const obs = [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), EXPIRED), observation(CAPABILITY_IDS.productContext, contextPayload({ ...BORE20, final: 89990 }))];
    expect(check('La barra está en $84.990.', obs).kind).toBe('reject');
  });
});

describe('10.6 out-of-stock alternatives: consistency, not censorship', () => {
  const obs = () => [observation(CAPABILITY_IDS.catalogSearch, searchPayload([KB20, KB24, KB28]))];
  it('allows mentioning the 24 kg with its price when it says it is out of stock', () => {
    expect(check('La Kettlebell Acero 20kg está en $56.990. También existe la de 24 kg a $67.990, pero actualmente está sin stock.', obs()).kind).toBe('allow');
  });
  it('rejects "hay 24 kg $67.990" (the production E2E wording)', () => {
    const v = check('Si más adelante quieres otros pesos de kettlebell, hay 24 kg $67.990, 28 kg $78.990; los de 10, 12 y 16 kg están sin stock por ahora.', obs());
    expect(v).toMatchObject({ kind: 'reject' });
    expect(v.kind === 'reject' && v.feedback).toContain('P187');
  });
  it('rejects naming an out-of-stock product as available even without a price', () => {
    expect(check('¡Sí! La Air Bike Hurricane 3.0 está disponible.', [observation(CAPABILITY_IDS.catalogSearch, searchPayload([AIRBIKE]))]).kind).toBe('reject');
    expect(check('La Air Bike Hurricane 3.0 tiene un precio de referencia de $899.990, pero hoy está sin stock y no es pedible.', [observation(CAPABILITY_IDS.catalogSearch, searchPayload([AIRBIKE]))]).kind).toBe('allow');
  });
});

describe('10.7 variant selection', () => {
  const obs = () => [observation(CAPABILITY_IDS.productContext, contextPayload(COLLARINES))];
  it('rejects stating a variant price as exact without evidence', () => {
    expect(check('Los collarines Amarillo cuestan $15.990.', obs()).kind).toBe('reject');
  });
  it('allows the "desde" price while asking for the color', () => {
    expect(check('Los Collarines Olímpicos Magnéticos Rising están desde $15.990. ¿Los quieres Rosado o Amarillo?', obs()).kind).toBe('allow');
  });
});

describe('10.8/10.9 derived totals and unsupported calculations', () => {
  const obs = () => [observation(CAPABILITY_IDS.catalogSearch, searchPayload([OXFORD])), observation(CAPABILITY_IDS.productContext, contextPayload(COLLARINES))];
  it('allows a labelled referential sum of stated Catalog prices, marked derived/estimated', () => {
    const v = check('Colchoneta $6.296 y collarines desde $15.990: total referencial $22.286.', obs());
    expect(v.kind).toBe('allow');
    expect(v.claims).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'estimated_total', authority: 'derived', value: 22286, derivation: { operation: 'sum', operands: [6296, 15990] } })]));
  });
  it('rejects the same sum stated as a final amount', () => {
    expect(check('Colchoneta $6.296 y collarines desde $15.990: son $22.286.', obs()).kind).toBe('reject');
  });
  it.each([
    ['10 % adicional', 'Colchoneta $6.296, con 10% adicional queda en $5.666.'],
    ['shipping', 'Colchoneta $6.296 más despacho $4.990.'],
    ['quantity discount', 'Colchoneta $6.296; llevando 3 te queda en $17.000.'],
  ])('rejects an invented commercial number (%s)', (_name, text) => {
    expect(check(text, obs()).kind).toBe('reject');
  });
});

describe('ADR-031 end to end in the kernel with the Sales validator', () => {
  async function run(script: FakeModelScript, seed: Observation[], read: (args: Record<string, unknown>) => { outcome: 'succeeded' | 'failed'; payload: JsonValue | null }) {
    const logger = createSilentLogger();
    const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider: new FakeModelProvider(script), logger }), logger, responseAuthority: new SalesCommercialEvidenceValidator({ clock }) });
    const session = new MemorySession({
      capabilities: [{ capabilityId: CAPABILITY_IDS.productContext, version: 1, description: 'ctx', inputSchema: { type: 'object' }, riskClass: 'READ' }],
      read: (d) => read(d.arguments),
    });
    session.observations.push(...seed);
    await kernel.run(session);
    return session;
  }

  it('10.3 stale but unchanged → one platform refresh, draft preserved and sent', async () => {
    const session = await run([respond('La barra BORE20 está en $84.990.'), complete('done')], [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), EXPIRED)], () => ({ outcome: 'succeeded', payload: contextPayload(BORE20) }));
    expect(session.steps.map((s) => [s.decision?.type, s.outcome, s.origin])).toEqual([
      ['read_capability', 'observed', 'platform'],
      ['respond', 'recorded', 'model'],
      ['complete', 'recorded', 'model'],
    ]);
    expect(session.steps[1]!.decision).toEqual({ type: 'respond', content: 'La barra BORE20 está en $84.990.' });
  });

  it('10.4 stale and changed → the draft is refused, the model corrects it once', async () => {
    const session = await run(
      [respond('¡Sí, la tenemos! La barra BORE20 está en $84.990.'), respond('La barra BORE20 ($84.990) está sin stock por ahora.'), complete('done')],
      [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), EXPIRED)],
      () => ({ outcome: 'succeeded', payload: contextPayload({ ...BORE20, sellability: 'not_sellable', reason: 'out_of_stock' }) }),
    );
    expect(session.steps.map((s) => [s.decision?.type, s.outcome, s.error?.code ?? null])).toEqual([
      ['read_capability', 'observed', null],
      ['respond', 'refused', 'response_authority_contradiction'],
      ['respond', 'recorded', null],
      ['complete', 'recorded', null],
    ]);
  });

  it('10.5 refresh failure → no commercial fact is sent as current (refused, then safe degradation)', async () => {
    const session = await run(
      [respond('La barra BORE20 está en $84.990.'), respond('La barra BORE20 sigue en $84.990.'), complete('done')],
      [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), EXPIRED)],
      () => ({ outcome: 'failed', payload: null }),
    );
    const said = session.steps.filter((s) => s.decision?.type === 'respond' && s.outcome === 'recorded').map((s) => (s.decision as { content: string }).content);
    expect(said).toEqual([new SalesCommercialEvidenceValidator().degraded()]);
    expect(said.join(' ')).not.toContain('$');
  });
});
