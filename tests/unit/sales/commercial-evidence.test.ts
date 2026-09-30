import { describe, expect, it } from 'vitest';
import { uuidv7, type JsonValue, type Observation } from '@r4/contracts';
import { AgentKernel } from '@r4/agent-kernel';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { CAPABILITY_IDS } from '@r4-sales/agent';
import { REVALIDATION_EPSILON_MS, SalesCommercialEvidenceValidator } from '../../../agents/sales/src/authority/commercial-evidence.js';
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

/**
 * R4-J1E-R2: near-expiry → notBefore (never a refresh inside the owner's cached
 * window), consistency by product block (not by literal sentence), and the
 * drafts production refused although they were honest (J1 E2E, 2026-09-30).
 */
const P2340: Product = { key: 'P2340', name: 'Colchoneta Oxford Negro/Rojo 100x50x5cm - 2da Selección | FullFit (FICLE3-SU55,-1)', final: 6296, regular: 13990, sellability: 'not_sellable', reason: 'out_of_stock' };
const P872: Product = { key: 'P872', name: 'Colchoneta Oxford Negro/Rojo 100x50x5cm | FullFit', final: 13990 };
const DISCOS10: Product = { key: 'P145', name: 'Par Discos Preolímpicos 10kg | Barbell', final: 45990 };

describe('R4-J1E-R2 freshness: notBefore instead of a pointless refresh', () => {
  it('A. validUntil = now + 1.5 s (< 3 s send margin): REVALIDATION_REQUIRED with notBefore ≥ validUntil, not an immediate refresh', () => {
    const validUntil = inMs(1_500);
    const v = check('La barra está en $84.990.', [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), validUntil)]);
    expect(v).toMatchObject({ kind: 'revalidation_required', reads: [{ capabilityId: CAPABILITY_IDS.productContext, arguments: { productKey: 'P545' } }] });
    const notBefore = v.kind === 'revalidation_required' ? v.notBefore : undefined;
    expect(notBefore).toBeDefined();
    expect(Date.parse(notBefore!)).toBeGreaterThanOrEqual(Date.parse(validUntil));
    // only a small technical epsilon past the owner's validUntil: no hidden latency budget
    expect(Date.parse(notBefore!) - Date.parse(validUntil)).toBe(REVALIDATION_EPSILON_MS);
    expect(REVALIDATION_EPSILON_MS).toBeLessThanOrEqual(500);
  });

  it('expired evidence (the owner window is over) is refreshed now: no notBefore', () => {
    const v = check('La barra está en $84.990.', [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), EXPIRED)]);
    expect(v.kind).toBe('revalidation_required');
    expect(v.kind === 'revalidation_required' && v.notBefore).toBeUndefined();
  });

  it('evidence that would itself be too close at wake-up is refreshed in the same wake: notBefore covers its window too', () => {
    const near = observation(CAPABILITY_IDS.productContext, contextPayload(BORE20), inMs(1_500));
    const later = observation(CAPABILITY_IDS.productContext, contextPayload(KB20), inMs(4_000)); // fresh now, < notBefore + 3 s
    const far = observation(CAPABILITY_IDS.productContext, contextPayload(KB28), inMs(14_000));
    const v = check('La barra está en $84.990, la kettlebell de 20kg en $56.990 y la de 28kg en $78.990.', [near, later, far]);
    expect(v.kind).toBe('revalidation_required');
    if (v.kind !== 'revalidation_required') return;
    expect(v.reads.map((r) => r.arguments.productKey).sort()).toEqual(['P186', 'P545']);
    expect(v.notBefore).toBe(inMs(4_000 + REVALIDATION_EPSILON_MS));
  });

  it('B. after the wake: a new owner window with the same truth → the same draft is allowed', () => {
    const obs = [observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), inMs(-100)), observation(CAPABILITY_IDS.productContext, contextPayload(BORE20), FRESH)];
    expect(check('La barra está en $84.990.', obs).kind).toBe('allow');
  });
});

describe('R4-J1E-R2 availability consistency by product block', () => {
  const colchonetas = () => [observation(CAPABILITY_IDS.catalogSearch, searchPayload([P2340, P872]))];

  it('E. "Está a $6.296. Eso sí: ahora figura sin stock." → allow', () => {
    expect(check('Está a $6.296. Eso sí: ahora figura sin stock.', colchonetas()).kind).toBe('allow');
  });

  it('F. "Hoy figura SIN STOCK. Su precio de referencia es $6.296." → allow', () => {
    expect(check('Hoy figura SIN STOCK. Su precio de referencia es $6.296.', colchonetas()).kind).toBe('allow');
  });

  it.each([
    ['no hay stock', 'La colchoneta de 2da selección está a $6.296, pero no hay stock actualmente.'],
    ['no haya stock', 'Su precio de referencia es $6.296, pero no es una oferta válida mientras no haya stock.'],
    ['no está disponible', 'Está a $6.296. No está disponible por ahora.'],
    ['no es comprable', 'Está a $6.296. Hoy no es comprable.'],
  ])('G. bounded negation wording (%s) is availability-compatible', (_name, text) => {
    expect(check(text, colchonetas()).kind).toBe('allow');
  });

  it('H. "Hay stock a $6.296" with out_of_stock evidence → reject (even if a later sentence says otherwise)', () => {
    expect(check('Hay stock a $6.296.', colchonetas()).kind).toBe('reject');
    expect(check('Hay stock a $6.296. Eso sí: ahora figura sin stock.', colchonetas()).kind).toBe('reject');
  });

  it('a block never crosses a paragraph/bullet break', () => {
    expect(check('Está a $6.296.\n\nAhora figura sin stock.', colchonetas()).kind).toBe('reject');
  });

  it('a block ends at a sentence about another product (A\'s price + B\'s availability never mix)', () => {
    const kbs = () => [observation(CAPABILITY_IDS.catalogSearch, searchPayload([KB20, KB24, KB28]))];
    expect(check('La de 24 kg está a $67.990. La Kettlebell Acero 20kg está a $56.990. Ahora figura sin stock.', kbs()).kind).toBe('reject');
  });

  it('"los otros… / otros pesos… / los de 16 kg… sin stock" never qualifies the product that was priced', () => {
    const kbs = () => [observation(CAPABILITY_IDS.catalogSearch, searchPayload([KB20, KB24, KB28]))];
    expect(check('La de 24 kg está a $67.990. Los otros pesos están sin stock.', kbs()).kind).toBe('reject');
    expect(check('La de 24 kg está a $67.990. Los de 10, 12 y 16 kg están sin stock por ahora.', kbs()).kind).toBe('reject');
  });

  it('a block reaches at most two sentences away', () => {
    expect(check('Está a $6.296. Es de lona Oxford. Mide 100x50x5cm. Es de segunda selección. Figura sin stock.', colchonetas()).kind).toBe('reject');
  });

  it('a sellable product called out of stock next to its price is still rejected', () => {
    expect(check('La colchoneta nueva está a $13.990 pero sin stock.', [observation(CAPABILITY_IDS.catalogSearch, searchPayload([P872]))]).kind).toBe('reject');
  });

  it('same amount on two products: words stated as absent ("sin segunda selección") do not name the other one', () => {
    const obs = colchonetas();
    expect(check('La versión nueva (sin segunda selección) está a $13.990 y sí tiene stock.', obs).kind).toBe('allow');
    expect(check('La de segunda selección está a $13.990 y tiene stock.', obs).kind).toBe('reject');
  });

  it('I. "Amarillo: con stock, $15.990" with only the product-level "from" price → reject (no variant price is deduced)', () => {
    const v = check('Amarillo: con stock, $15.990', [observation(CAPABILITY_IDS.productContext, contextPayload(COLLARINES))]);
    expect(v).toMatchObject({ kind: 'reject', code: 'response_authority_contradiction' });
    expect(v.kind === 'reject' && v.feedback).toContain('desde $15.990');
  });
});

describe('R4-J1E-R2 the production drafts (J1 E2E 2026-09-30, verbatim)', () => {
  const evidence = () => [
    observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20, KB20, DISCOS10])),
    observation(CAPABILITY_IDS.productContext, contextPayload(COLLARINES)),
    observation(CAPABILITY_IDS.catalogSearch, searchPayload([P872, P2340])),
    observation(CAPABILITY_IDS.productContext, contextPayload(P2340)),
  ];

  it('step 28 (refused in production) → allow: price, then "Eso sí: ahora figura sin stock" in the next sentence of the same block', () => {
    const draft =
      'La Colchoneta Oxford Negro/Rojo 100x50x5cm **2da Selección** | FullFit (FICLE3-SU55) está a **$6.296 CLP** (precio con descuento; su precio normal es $13.990). Eso sí: ahora figura **sin stock**, por lo que no es comprable en este momento.\n\nLa misma colchoneta en versión nueva (FICLE3) está a **$13.990 CLP** y sí tiene stock.\n\n¿Quieres que sume alguna a la cotización? Si es así, recuerda que me falta la dirección de entrega y un nombre y teléfono de contacto para generarla (y confirmar el par de collarines Rising en Amarillo).';
    expect(check(draft, evidence()).kind).toBe('allow');
  });

  it('step 32 (refused in production) → allow', () => {
    const draft =
      'La Colchoneta Oxford Negro/Rojo 100x50x5cm **2da Selección** | FullFit (FICLE3-SU55) figura a **$6.296 CLP** (precio de referencia con descuento; su precio normal es $13.990). Ojo: hoy aparece **sin stock**, así que no es comprable en este momento.\n\nLa misma colchoneta en versión nueva (FICLE3, sin segunda selección) está a **$13.990 CLP** y sí tiene stock.\n\n¿Quieres que sume alguna a una cotización? Si es así, me falta la dirección de entrega y un nombre y teléfono de contacto (y confirmar el par de collarines Rising en Amarillo).';
    expect(check(draft, evidence()).kind).toBe('allow');
  });

  it('step 36 (refused in production) → allow: "hoy figura SIN STOCK … mientras no haya stock"', () => {
    const draft =
      'Revisé de nuevo la colchoneta 👇\n\n• Colchoneta Oxford Negro/Rojo 100x50x5cm - 2da Selección | FullFit: hoy figura SIN STOCK, es decir, no está disponible para compra en este momento. Su precio de referencia (con descuento) es $6.296 CLP, pero no es una oferta válida mientras no haya stock.\n\n• Colchoneta Oxford Negro/Rojo 100x50x5cm | FullFit, versión nueva (producto P872): disponible con stock, $13.990 CLP.\n\n¿Quieres que sume la versión nueva a tu cotización? Si es así, me falta la dirección de entrega y un nombre y teléfono de contacto. Queda pendiente también confirmar el par de collarines Rising en Amarillo.';
    expect(check(draft, evidence()).kind).toBe('allow');
  });

  it('step 21 (correctly refused in production) → still reject: "Amarillo: con stock, $15.990" from a product-level "desde"', () => {
    const draft =
      '¡Perfecto, Amarillo! 🙌\n\n• Par Collarines Olímpico Magnéticos | Rising — Amarillo: con stock, $15.990 CLP (el par).\n\n¿Te preparo la cotización? Para generarla me falta la dirección de entrega (y un nombre/teléfono de contacto si aún no los tengo).\n\nY dime si cotizo solo los collarines o también algo de lo que revisamos antes: barra BORE20 $84.990, par de discos de 10 kg desde $45.990, o la kettlebell de acero 20 kg a $56.990.';
    const v = check(draft, evidence());
    expect(v).toMatchObject({ kind: 'reject' });
    expect(v.kind === 'reject' && v.feedback).toContain('P2128');
  });

  it('step 48 (refused as unverifiable in production) → allow with fresh evidence; the referential total stays a derived claim', () => {
    const draft =
      'Con lo que tenemos en evaluación ahora mismo, el total referencial queda así:\n\n• Par Collarines Olímpico Magnéticos | Rising, variante Amarillo → desde $15.990 CLP\n• Colchoneta Oxford Negro/Rojo 100x50x5cm (versión nueva) | FullFit → $13.990 CLP\n\nTotal referencial: $29.980 CLP.\n\nUn detalle: en los collarines el precio es "desde", porque depende de la variante, así que ese total es referencial hasta cerrar el detalle.\n\nSi quieres que sume también la barra BORE20, la kettlebell de acero o los discos que consultaste antes, dímelo y los reviso de nuevo para incluirlos. Y para dejarte una cotización formal necesito la dirección de entrega y un nombre y teléfono de contacto. ¿Te preparo la cotización con estos dos productos?';
    const v = check(draft, evidence());
    expect(v.kind).toBe('allow');
    expect(v.claims).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'estimated_total', authority: 'derived', value: 29980, derivation: { operation: 'sum', operands: [15990, 13990] } })]));
  });

  it('step 48 near expiry (the production cache-window case) → notBefore, not an immediate refresh', () => {
    const draft = 'Collarines Rising desde $15.990 y colchoneta nueva $13.990. Total referencial: $29.980.';
    const v = check(draft, [observation(CAPABILITY_IDS.productContext, contextPayload(COLLARINES), inMs(2_200)), observation(CAPABILITY_IDS.catalogSearch, searchPayload([P872]), inMs(1_400))]);
    expect(v).toMatchObject({ kind: 'revalidation_required', notBefore: inMs(2_200 + REVALIDATION_EPSILON_MS) });
  });
});

describe('R4-J1E-R2 end to end in the kernel: near expiry → durable wait → wake → Catalog READ → send', () => {
  function kernelWith(script: FakeModelScript, validatorClock: { now: () => Date }) {
    const logger = createSilentLogger();
    return new AgentKernel({ gateway: new DefaultModelGateway({ provider: new FakeModelProvider(script), logger }), logger, responseAuthority: new SalesCommercialEvidenceValidator({ clock: validatorClock }) });
  }
  const capabilities = [{ capabilityId: CAPABILITY_IDS.productContext, version: 1, description: 'ctx', inputSchema: { type: 'object' }, riskClass: 'READ' as const }];

  it('unchanged truth: deferred without a Catalog call, then refreshed after the window and the same draft sent', async () => {
    let now = NOW;
    const moving = { now: () => now };
    const reads: unknown[] = [];
    const draft = 'Está a $6.296. Eso sí: ahora figura sin stock.';
    const first = new MemorySession({ temporal: true, capabilities, read: (d) => (reads.push(d.arguments), { outcome: 'succeeded', payload: contextPayload(P2340) }) });
    first.observations.push(observation(CAPABILITY_IDS.catalogSearch, searchPayload([P2340]), inMs(1_500)));
    await kernelWith([respond(draft)], moving).run(first);
    expect(reads).toHaveLength(0);
    const wait = first.waits[0];
    expect(wait).toMatchObject({ type: 'wait', condition: { kind: 'WAIT_UNTIL', until: inMs(1_500 + REVALIDATION_EPSILON_MS) } });
    // The durable timer fires at notBefore; a new run of the same task resolves the draft.
    now = new Date(Date.parse(inMs(1_500 + REVALIDATION_EPSILON_MS)) + 5);
    const second = MemorySession.continueFrom(first, 'timer');
    await kernelWith([complete('done')], moving).run(second);
    expect(reads).toEqual([{ productKey: 'P2340' }]);
    expect(second.steps.map((s) => [s.decision?.type, s.outcome, s.origin])).toEqual([
      ['read_capability', 'observed', 'platform'],
      ['respond', 'recorded', 'platform'],
      ['complete', 'recorded', 'model'],
    ]);
    expect(second.steps[1]!.decision).toEqual({ type: 'respond', content: draft });
  });

  it('C. material change at wake (sellable → out_of_stock): the draft is refused and corrected once', async () => {
    let now = NOW;
    const moving = { now: () => now };
    const first = new MemorySession({ temporal: true, capabilities, read: () => ({ outcome: 'succeeded', payload: contextPayload({ ...BORE20, sellability: 'not_sellable', reason: 'out_of_stock' }) }) });
    first.observations.push(observation(CAPABILITY_IDS.catalogSearch, searchPayload([BORE20]), inMs(1_000)));
    await kernelWith([respond('¡Sí, la tenemos! La barra BORE20 está en $84.990.')], moving).run(first);
    now = new Date(NOW.getTime() + 2_000);
    const second = MemorySession.continueFrom(first, 'timer');
    await kernelWith([respond('La barra BORE20 ($84.990) está sin stock por ahora.'), complete('done')], moving).run(second);
    expect(second.steps.map((s) => [s.decision?.type, s.outcome, s.error?.code ?? null])).toEqual([
      ['read_capability', 'observed', null],
      ['respond', 'refused', 'response_authority_contradiction'],
      ['respond', 'recorded', null],
      ['complete', 'recorded', null],
    ]);
  });
});
