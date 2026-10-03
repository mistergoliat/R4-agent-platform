import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainError, type ShippingQuoteBasis } from '@r4-adapters/domains';
import {
  PC_CARRIER_DIMENSIONS_CM,
  PcCarrierClient,
  ProductionShippingAdapter,
  ShippingConfigError,
  describeShippingHttpConfig,
  formatKilos,
  indexCommunes,
  loadShippingHttpConfig,
  pcCarrierLocationsSchema,
  resolveCommune,
  shippingModeOf,
  type ShippingFetch,
  type ShippingHttpConfig,
  type ShippingTelemetry,
} from '@r4-adapters/shipping-http';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const FIXTURES = join(ROOT, 'adapters', 'domains', 'shipping', 'http', 'fixtures');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const LOCATIONS = fixture('location.json');
const CONFIG: ShippingHttpConfig = { baseUrl: 'http://127.0.0.1:4020/api/pc-carrier', timeoutMs: 5000 };
const NOW = new Date('2026-10-02T19:30:00.000Z');
const REFERENCE: ShippingQuoteBasis = { type: 'reference' };
const order = (totalWeightKg: number, amount = 50_000): ShippingQuoteBasis => ({ type: 'order', totalWeightKg, declaredValueGross: { amount, currency: 'CLP' } });

interface Recorded {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
}

type Answer = { status: number; body: string } | Error | 'hang';
const json = (status: number, body: unknown): Answer => ({ status, body: JSON.stringify(body) });

/** A fake owner: answers /location with the captured tree and /carrier/v1/all with `quote`. */
function owner(quote: Answer | (() => Answer), locations: Answer = json(200, LOCATIONS)) {
  const requests: Recorded[] = [];
  const events: ShippingTelemetry[] = [];
  const fetch: ShippingFetch = (url, init) => {
    requests.push({ url: new URL(url), method: init.method, headers: init.headers });
    const path = new URL(url).pathname;
    const answer = path.endsWith('/location') ? locations : typeof quote === 'function' ? quote() : quote;
    if (answer === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ status: answer.status, text: () => Promise.resolve(answer.body) });
  };
  const adapter = new ProductionShippingAdapter({ config: CONFIG, fetch, onEvent: (e) => events.push(e), now: () => NOW });
  const quoteRequests = () => requests.filter((r) => r.url.pathname.endsWith('/carrier/v1/all'));
  return { adapter, requests, quoteRequests, events };
}

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('A. commune resolution against the owner commune catalog (exact normalized match)', () => {
  const index = indexCommunes(pcCarrierLocationsSchema.parse(LOCATIONS));

  it('"Ñuñoa", "nunoa" and " NUNOA " resolve to the same canonical owner commune', () => {
    const expected = { communeId: '99', communeName: 'Ñuñoa', regionName: 'Metropolitana de Santiago' };
    for (const input of ['Ñuñoa', 'nunoa', ' NUNOA ', 'ÑUÑOA']) expect(resolveCommune(index, input), input).toEqual(expected);
  });

  it('flattens the whole real catalog: 346 communes, none ambiguous after normalization', () => {
    expect([...index.values()].flat()).toHaveLength(346);
    expect([...index.values()].every((matches) => matches.length === 1)).toBe(true);
  });

  it('a typo, an unknown commune, a region, a city alias or an empty name fails closed — no fuzzy match, no alias', () => {
    for (const input of ['San Migel', 'Xyzabc', 'Biobío', 'Metropolitana', 'Rapa Nui', 'Santiago', '   ']) {
      expect(() => resolveCommune(index, input), input).toThrow(expect.objectContaining({ category: 'validation', code: 'shipping_invalid_destination' }) as Error);
    }
  });

  it('a normalized name matching two owner communes fails closed (ambiguous)', () => {
    const twin = indexCommunes(pcCarrierLocationsSchema.parse([
      { id_region: 1, region_name: 'Región A', ciudades: [{ id_city: 1, city_name: 'C', comunas: [{ id_comuna: 1, comuna_name: 'San Rafael' }] }] },
      { id_region: 2, region_name: 'Región B', ciudades: [{ id_city: 2, city_name: 'D', comunas: [{ id_comuna: 2, comuna_name: 'SAN RAFAÉL' }] }] },
    ]));
    expect(() => resolveCommune(twin, 'san rafael')).toThrow(expect.objectContaining({ code: 'shipping_invalid_destination', details: { reason: 'ambiguous', matches: 2 } }) as Error);
  });

  it('does not call /carrier/v1/all when the destination cannot be resolved', async () => {
    const o = owner(json(202, fixture('quote-nunoa-reference.json')));
    expect(await failure(o.adapter.quote({ destination: { commune: 'San Migel' }, basis: REFERENCE }))).toMatchObject({ category: 'validation', code: 'shipping_invalid_destination' });
    expect(o.quoteRequests()).toHaveLength(0);
    const empty = owner(json(202, fixture('quote-nunoa-reference.json')));
    expect(await failure(empty.adapter.quote({ destination: { commune: '  ' }, basis: REFERENCE }))).toMatchObject({ code: 'shipping_invalid_destination' });
    expect(empty.requests).toHaveLength(0);
  });
});

describe('B. reference basis → owner request', () => {
  it('sends destino=<owner id>, kilos=1 and 1×1×1 cm, and never total_boleta, quantity or origin_code', async () => {
    const o = owner(json(202, fixture('quote-nunoa-reference.json')));
    const quote = await o.adapter.quote({ destination: { commune: 'nunoa' }, basis: REFERENCE });
    const [request] = o.quoteRequests();
    expect(request!.method).toBe('GET');
    expect(request!.url.pathname).toBe('/api/pc-carrier/carrier/v1/all');
    expect(Object.fromEntries(request!.url.searchParams)).toEqual({ destino: '99', alto: '1', ancho: '1', largo: '1', kilos: '1' });
    for (const absent of ['total_boleta', 'quantity', 'origin_code']) expect(request!.url.searchParams.has(absent)).toBe(false);
    expect(quote.basis).toEqual({ type: 'reference', weightKg: 1, declaredValue: null, dimensionsCm: { height: 1, width: 1, depth: 1, source: 'production_convention' } });
  });

  it('sends no credential and no customer data: only accept', async () => {
    const o = owner(json(202, fixture('quote-nunoa-reference.json')));
    await o.adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: REFERENCE }, { correlationId: 'corr-7' });
    for (const r of o.requests) expect(r.headers).toEqual({ accept: 'application/json' });
  });
});

describe('C. order basis → owner request', () => {
  it('sends the exact weight, the gross declared value as total_boleta and 1×1×1 cm', async () => {
    const o = owner(json(202, fixture('quote-nunoa-order-50000.json')));
    const quote = await o.adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: order(35.125, 129_990) });
    expect(Object.fromEntries(o.quoteRequests()[0]!.url.searchParams)).toEqual({ destino: '99', alto: '1', ancho: '1', largo: '1', kilos: '35.125', total_boleta: '129990' });
    expect(quote.basis).toEqual({ type: 'order', weightKg: 35.125, declaredValue: { amount: 129_990, currency: 'CLP', taxIncluded: true }, dimensionsCm: { height: 1, width: 1, depth: 1, source: 'production_convention' } });
  });

  it('rejects zero, negative, non-finite, missing or sub-gram weight before any HTTP call (never substitutes 1 kg)', async () => {
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 0.0004]) {
      const o = owner(json(202, fixture('quote-nunoa-order-50000.json')));
      const error = await failure(o.adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: { type: 'order', totalWeightKg: weight as number, declaredValueGross: { amount: 1000, currency: 'CLP' } } }));
      expect(error, String(weight)).toMatchObject({ category: 'validation', code: 'shipping_invalid_weight' });
      expect(o.requests, String(weight)).toHaveLength(0);
    }
  });

  it('rejects a negative, fractional or non-CLP declared value before any HTTP call', async () => {
    for (const declared of [{ amount: -1, currency: 'CLP' }, { amount: 10.5, currency: 'CLP' }, { amount: 1000, currency: 'USD' }, null]) {
      const o = owner(json(202, fixture('quote-nunoa-order-50000.json')));
      const error = await failure(o.adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: { type: 'order', totalWeightKg: 10, declaredValueGross: declared as never } }));
      expect(error, JSON.stringify(declared)).toMatchObject({ category: 'validation', code: 'shipping_invalid_declared_value' });
      expect(o.requests).toHaveLength(0);
    }
  });

  it('formats kilos as plain decimals with at most 3 decimals (never exponent notation)', () => {
    expect([formatKilos(1), formatKilos(20), formatKilos(1.5), formatKilos(0.001), formatKilos(35.1254), formatKilos(1_000_000)]).toEqual(['1', '20', '1.5', '0.001', '35.125', '1000000']);
    expect(() => formatKilos(0.0001)).toThrow(expect.objectContaining({ code: 'shipping_invalid_weight' }) as Error);
  });
});

describe('D. HTTP status and failure mapping', () => {
  it('HTTP 202 is success (HTTP 200 is not required)', async () => {
    const quote = await owner(json(202, fixture('quote-nunoa-order-50000.json'))).adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: order(2) });
    expect(quote.serviceable).toBe(true);
  });

  it('maps timeout, 5xx, 429, network, 400, 401, unexpected status, malformed JSON and malformed options', async () => {
    const cases: readonly [string, Answer | (() => Answer), { category: string; code: string }][] = [
      ['5xx', json(503, { error: 'down' }), { category: 'temporarily_unavailable', code: 'shipping_owner_unavailable' }],
      ['429', json(429, {}), { category: 'temporarily_unavailable', code: 'shipping_owner_unavailable' }],
      ['network', new TypeError('fetch failed'), { category: 'temporarily_unavailable', code: 'shipping_owner_unavailable' }],
      ['400', json(400, { error: 'destination is required' }), { category: 'validation', code: 'shipping_owner_rejected_request' }],
      ['401', json(401, {}), { category: 'unauthorized', code: 'shipping_owner_unauthorized' }],
      ['404', json(404, {}), { category: 'contract_violation', code: 'shipping_owner_invalid_response' }],
      ['not json', { status: 202, body: '<html>' }, { category: 'contract_violation', code: 'shipping_owner_invalid_response' }],
      ['no options', json(202, { data: [] }), { category: 'contract_violation', code: 'shipping_owner_invalid_response' }],
      ['negative cost', json(202, { options: [{ carrier_name: 'X', service_type: 'Y', total_cost: -5 }] }), { category: 'contract_violation', code: 'shipping_owner_invalid_response' }],
      ['string cost', json(202, { options: [{ carrier_name: 'X', service_type: 'Y', total_cost: '3175' }] }), { category: 'contract_violation', code: 'shipping_owner_invalid_response' }],
      ['missing carrier', json(202, { options: [{ service_type: 'Y', total_cost: 10 }] }), { category: 'contract_violation', code: 'shipping_owner_invalid_response' }],
      ['numeric ETA', json(202, { options: [{ carrier_name: 'X', service_type: 'Y', total_cost: 10, estimated_delivery: 3 }] }), { category: 'contract_violation', code: 'shipping_owner_invalid_response' }],
    ];
    for (const [label, answer, expected] of cases) {
      expect(await failure(owner(answer).adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: REFERENCE })), label).toMatchObject(expected);
    }
  });

  it('a hung owner times out at the configured deadline', async () => {
    const requests: string[] = [];
    const fetch: ShippingFetch = (url, init) => {
      requests.push(url);
      if (url.endsWith('/location')) return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(LOCATIONS)) });
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError'))));
    };
    const adapter = new ProductionShippingAdapter({ config: { ...CONFIG, timeoutMs: 100 }, fetch });
    expect(await failure(adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: REFERENCE }))).toMatchObject({ category: 'timeout', code: 'shipping_owner_timeout', retryable: true });
  });

  it('a caller deadline already passed stops before any call', async () => {
    const o = owner(json(202, fixture('quote-empty.json')));
    expect(await failure(o.adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: REFERENCE }, { signal: AbortSignal.abort() }))).toMatchObject({ category: 'timeout', code: 'shipping_owner_timeout' });
    expect(o.requests).toHaveLength(0);
  });

  it('a broken commune catalog is a contract violation and no quote is requested', async () => {
    const o = owner(json(202, fixture('quote-empty.json')), json(200, []));
    expect(await failure(o.adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: REFERENCE }))).toMatchObject({ category: 'contract_violation', code: 'shipping_owner_invalid_response' });
    expect(o.quoteRequests()).toHaveLength(0);
  });
});

describe('E/F. offers: optional ETA and owner order preserved', () => {
  it('accepts a missing, a null and a string estimated_delivery', async () => {
    const o = owner(json(202, { options: [
      { carrier_name: 'A', service_type: 'S', total_cost: 10 },
      { carrier_name: 'B', service_type: 'S', total_cost: 20, estimated_delivery: null },
      { carrier_name: 'C', service_type: 'S', total_cost: 30, estimated_delivery: '05-10-2026' },
    ] }));
    const quote = await o.adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: REFERENCE });
    expect(quote.offers.map((x) => x.estimatedDelivery)).toEqual([null, null, '05-10-2026']);
  });

  it('keeps Starken without an ETA (real owner answer) instead of rejecting it', async () => {
    const quote = await owner(json(202, fixture('quote-temuco-reference.json'))).adapter.quote({ destination: { commune: 'Temuco' }, basis: REFERENCE });
    expect(quote.offers.map((x) => [x.carrierName, x.estimatedDelivery])).toEqual([['Blue Express', '05-10-2026'], ['Starken', null]]);
  });

  it('preserves the owner order exactly, even when it is not price-ranked', async () => {
    const quote = await owner(json(202, fixture('quote-santiago-centro-order-50000.json'))).adapter.quote({ destination: { commune: 'santiago centro' }, basis: order(1) });
    expect(quote.offers.map((x) => [x.ownerPosition, x.carrierName, x.price.ownerNet.amount])).toEqual([[0, 'Blue Express', 3175], [1, 'Starken', 2885]]);
    expect(quote).not.toHaveProperty('selectedOffer');
  });
});

describe('VAT on owner offers (net preserved, gross derived)', () => {
  it('maps every offer with the owner net untouched and the derived customer gross', async () => {
    const quote = await owner(json(202, fixture('quote-nunoa-order-50000.json'))).adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: order(2) });
    expect(quote.offers).toEqual([
      { carrierName: 'Pesas Chile', serviceType: 'Despacho Directo', price: { ownerNet: { amount: 4193, currency: 'CLP' }, tax: { policy: 'cl-iva-19@r4-j2b', rate: 0.19, amount: 797 }, customerGross: { amount: 4990, currency: 'CLP' }, grossDerivedBy: 'r4_shipping_adapter' }, estimatedDelivery: '1 a 2 días hábiles', ownerPosition: 0 },
      { carrierName: 'Blue Express', serviceType: 'EXPRESS', price: { ownerNet: { amount: 3175, currency: 'CLP' }, tax: { policy: 'cl-iva-19@r4-j2b', rate: 0.19, amount: 603 }, customerGross: { amount: 3778, currency: 'CLP' }, grossDerivedBy: 'r4_shipping_adapter' }, estimatedDelivery: '05-10-2026', ownerPosition: 1 },
    ]);
  });

  it('the Despacho Directo incentive (net 1) stays 1 CLP gross — never converted to "free"', async () => {
    const quote = await owner(json(202, fixture('quote-nunoa-order-120000.json'))).adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: order(2, 120_000) });
    expect(quote.offers[0]).toMatchObject({ carrierName: 'Pesas Chile', price: { ownerNet: { amount: 1 }, customerGross: { amount: 1 } } });
  });
});

describe('H. serviceability, freshness and provenance', () => {
  it('a resolved commune with no owner options is serviceable=false with no offers — not an error, no fallback', async () => {
    const quote = await owner(json(202, fixture('quote-empty.json'))).adapter.quote({ destination: { commune: 'Tirúa' }, basis: REFERENCE });
    expect(quote).toMatchObject({ destination: { communeName: 'Tirúa' }, serviceable: false, offers: [] });
  });

  it('asOf is the answer time; the owner publishes no validity; provenance names the owner route and contract', async () => {
    const quote = await owner(json(202, fixture('quote-nunoa-reference.json'))).adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: REFERENCE });
    expect(quote).toMatchObject({ asOf: NOW.toISOString(), ownerValidUntil: null, provenance: { owner: 'pc-carrier', endpoint: '/carrier/v1/all', ownerContractVersion: '1.2.0' } });
  });
});

describe('telemetry', () => {
  it('records operation, outcome, status, duration, offers, resolution and basis — never customer text', async () => {
    const o = owner(json(202, fixture('quote-nunoa-order-50000.json')));
    await o.adapter.quote({ destination: { commune: 'Ñuñoa' }, basis: order(2) }, { correlationId: 'corr-1' });
    expect(o.events).toEqual([
      { kind: 'owner_call', operation: 'getLocations', outcome: 'ok', httpStatus: 200, durationMs: expect.any(Number) as number, offerCount: null, errorCategory: null, errorCode: null, correlationId: 'corr-1' },
      { kind: 'owner_call', operation: 'quoteAll', outcome: 'ok', httpStatus: 202, durationMs: expect.any(Number) as number, offerCount: 2, errorCategory: null, errorCode: null, correlationId: 'corr-1' },
      { kind: 'quote', operation: 'quote', basisType: 'order', outcome: 'ok', destinationResolved: true, communeId: '99', communeName: 'Ñuñoa', offerCount: 2, serviceable: true, durationMs: expect.any(Number) as number, errorCategory: null, errorCode: null, correlationId: 'corr-1' },
    ]);
  });

  it('an unresolved destination is recorded without echoing what the customer typed', async () => {
    const o = owner(json(202, fixture('quote-empty.json')));
    await failure(o.adapter.quote({ destination: { commune: 'Av. Siempre Viva 742, San Migel' }, basis: REFERENCE }));
    expect(o.events.at(-1)).toMatchObject({ kind: 'quote', outcome: 'failed', destinationResolved: false, communeId: null, communeName: null, errorCode: 'shipping_invalid_destination' });
    expect(JSON.stringify(o.events)).not.toContain('Siempre Viva');
  });
});

describe('J. side-effect safety', () => {
  it('the client exposes exactly getLocations and quoteAll — no generic route API', () => {
    const methods = Object.getOwnPropertyNames(PcCarrierClient.prototype).filter((m) => m !== 'constructor').sort();
    expect(methods).toEqual(['getLocations', 'quoteAll']);
    expect(PC_CARRIER_DIMENSIONS_CM).toEqual({ alto: 1, ancho: 1, largo: 1 });
  });

  it('no adapter source references an owner mutation route', () => {
    const dir = join(ROOT, 'adapters', 'domains', 'shipping', 'http', 'src');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const forbidden of ['/shipping/', '/sap/', '/shipping-method', "method: 'POST'", "method: 'PATCH'", "method: 'PUT'", "method: 'DELETE'"]) expect(source, `${file}: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('configuration', () => {
  const env = { R4_SHIPPING_MODE: 'real', R4_SHIPPING_BASE_URL: 'https://ms.pesaschile.cl/api/pc-carrier', R4_SHIPPING_TIMEOUT_MS: '5000' };

  it('loads the production shape and describes it without claiming connectivity', () => {
    const config = loadShippingHttpConfig(env, { allowNetwork: true });
    expect(config).toEqual({ baseUrl: 'https://ms.pesaschile.cl/api/pc-carrier', timeoutMs: 5000 });
    expect(describeShippingHttpConfig(config)).toEqual({ binding: 'REAL', baseHost: 'ms.pesaschile.cl', timeoutMs: 5000, connectivity: 'not tested' });
  });

  it('fails closed: unset mode, unknown mode, missing values, network not allowed, plain http, bad timeout, credentials in the URL', () => {
    expect(shippingModeOf({})).toBe('not_configured');
    expect(() => shippingModeOf({ R4_SHIPPING_MODE: 'fixture' })).toThrow(ShippingConfigError);
    const bad: readonly [Record<string, string>, { allowNetwork: boolean }, string][] = [
      [{}, { allowNetwork: true }, 'shipping_config_incomplete'],
      [{ ...env, R4_SHIPPING_TIMEOUT_MS: '' }, { allowNetwork: true }, 'shipping_config_incomplete'],
      [env, { allowNetwork: false }, 'network_not_allowed'],
      [{ ...env, R4_SHIPPING_BASE_URL: 'http://ms.pesaschile.cl/api/pc-carrier' }, { allowNetwork: true }, 'invalid_shipping_config'],
      [{ ...env, R4_SHIPPING_TIMEOUT_MS: '50' }, { allowNetwork: true }, 'invalid_shipping_config'],
      [{ ...env, R4_SHIPPING_TIMEOUT_MS: '20000' }, { allowNetwork: true }, 'invalid_shipping_config'],
      [{ ...env, R4_SHIPPING_BASE_URL: 'https://u:p@ms.pesaschile.cl/api/pc-carrier' }, { allowNetwork: true }, 'invalid_shipping_config'],
      [{ ...env, R4_SHIPPING_BASE_URL: 'https://ms.pesaschile.cl/api/pc-carrier?x=1' }, { allowNetwork: true }, 'invalid_shipping_config'],
    ];
    for (const [values, options, code] of bad) expect(() => loadShippingHttpConfig(values, options), JSON.stringify(values)).toThrow(expect.objectContaining({ code }) as Error);
    expect(loadShippingHttpConfig({ ...env, R4_SHIPPING_BASE_URL: 'http://127.0.0.1:4020/api/pc-carrier' }, { allowNetwork: false }).baseUrl).toBe('http://127.0.0.1:4020/api/pc-carrier');
  });
});
