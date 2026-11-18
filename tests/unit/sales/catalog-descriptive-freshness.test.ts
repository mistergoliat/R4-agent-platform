import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contextContributionSchema, type CompiledContextItem, type Observation } from '@r4/contracts';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { FixtureCatalog, type CatalogPort } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { SalesWorkspaceContextSource, catalogCapabilities, catalogDescriptiveItems, emptyWorkspace, loadCatalogDescriptiveWindowMs, type WorkspaceReader } from '@r4-sales/agent';
import { catalogDiscoverCapability } from '../../../agents/sales/src/capabilities/catalog-discover.js';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';
import { RUN, TASK, UNBOUNDED, compiler, request } from '../../fixtures/context/builders.js';

/**
 * Catalog descriptive freshness (R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS, off by default): the descriptive part of
 * an expired catalog read stays current for the window; price, stock, availability and promotion keep the owner's
 * validity. Includes the offline replay of the production turn that looped (synthetic data, same shape).
 */
const SALES_TASK = { ...TASK, taskType: 'sales.conversation' };
const execution = { taskId: SALES_TASK.taskId, runId: RUN.runId, agentId: 'sales', agentVersion: 19, correlationId: 'corr-descriptive', grantedScopes: ['catalog.read'] };
const WINDOW_MS = 300_000;
/** Catalog V2's commercial window (OD-3), shared with its response cache. */
const OWNER_TTL_MS = 15_000;
/** Keys that carry price, stock, availability, sellability, promotion or the status flags: never in a descriptive item. */
const COMMERCIAL_KEYS = /"(price|derived|availability|sellability|sellableVariants|promotion|active|listed|orderable|finalGross|finalGrossClp|regularGross|availableQuantity|discounted|formalQuote|commercial|commercialFreshness|disposition|validUntil|unit)":/u;

const reader: WorkspaceReader = {
  workspace: (taskId) => Promise.resolve(emptyWorkspace(taskId)),
  conversation: () => Promise.resolve(null),
  quoteReferences: () => Promise.resolve([]),
  transitions: () => Promise.resolve([]),
};

/**
 * Catalog's owner behaviour as audited (catalogContractService.ts): validUntil = asOf + 15 s, and a read within that
 * window answers from the per-product cache with the ORIGINAL asOf, so a cached answer is valid for less. Discover
 * hydrates through the same cache.
 */
class CatalogOwnerModel {
  readonly #asOf = new Map<string, number>();
  constructor(readonly clock: FakeClock) {}
  freshness(productKey: string) {
    const now = this.clock.now().getTime();
    const previous = this.#asOf.get(productKey);
    const asOf = previous !== undefined && now < previous + OWNER_TTL_MS ? previous : now;
    this.#asOf.set(productKey, asOf);
    return { asOf: new Date(asOf).toISOString(), cache: { hit: asOf !== now, ageMs: now - asOf }, validUntil: new Date(asOf + OWNER_TTL_MS).toISOString() };
  }
}

const NEEDS: Record<string, { need: string; candidates: string[] }> = {
  arms: { need: 'mancuernas para entrenar brazos en casa', candidates: ['DB-ADJ-24', 'KB-16'] },
  legs: { need: 'equipo para entrenar piernas en casa', candidates: ['RACK-SQ100', 'KB-COMP'] },
  bench: { need: 'banco para ejercicios en casa', candidates: ['BENCH-FID', 'BENCH-FLAT'] },
};

function setup(windowMs: number | null) {
  const clock = new FakeClock('2026-11-16T15:00:00.000Z');
  const owner = new CatalogOwnerModel(clock);
  const fixture = new FixtureCatalog({ now: () => clock.now() });
  const catalog: CatalogPort = {
    search: (r, o) => fixture.search(r, o),
    getProductContext: async (key, o) => {
      const c = await fixture.getProductContext(key, o);
      return c.status === 'found' ? { ...c, freshness: owner.freshness(key) } : c;
    },
    getItemContext: async (r, o) => {
      const c = await fixture.getItemContext(r, o);
      return c.status === 'found' ? { ...c, freshness: owner.freshness(r.itemKey.split('-V')[0]!) } : c;
    },
  };
  const discover: CatalogDiscoverPort = {
    discoverConfigured: true,
    discover: async (request) => {
      const entry = Object.values(NEEDS).find((n) => n.need === request.need)!;
      const verified = await Promise.all(
        entry.candidates.map(async (productKey) => {
          const c = await fixture.getProductContext(productKey);
          if (c.status !== 'found') throw new Error(productKey);
          const f = owner.freshness(productKey);
          return {
            productKey, name: c.facts.name, disposition: 'VERIFIED_MATCH', matchedBy: [], satisfied: ['home_training@SOURCE_NAME', 'sellable@COMMERCIAL_TRUTH'], unresolved: [], readings: [], requirements: [],
            commercial: { status: 'OBSERVED', authority: 'catalog-commercial-truth-v2', asOf: f.asOf, validUntil: f.validUntil, price: { finalGrossClp: c.derived.priceSummary?.finalGross.amount ?? null, kind: 'exact', basis: 'offerable' }, sellability: 'sellable', orderable: true },
          };
        }),
      );
      const until = verified.map((v) => v.commercial.validUntil).sort()[0]!;
      return {
        requestId: `req-${clock.now().getTime()}`, status: 'COMPLETE',
        interpretation: { need: entry.need, required: ['home_training'], preferred: [], notVerifiable: [], ambiguities: [], unrecognized: [] },
        exactMatch: null, verified, possible: [],
        completeness: { retrieval: 'COMPLETE', commercial: 'COMPLETE', exhaustive: false, moreVerifiedAvailable: false },
        absence: null, degradation: [],
        commercialFreshness: { status: 'OBSERVED', oldestAsOf: verified.map((v) => v.commercial.asOf).sort()[0]!, earliestValidUntil: until },
        warnings: [],
      } as never;
    },
  };
  const registry = new CapabilityRegistry();
  for (const r of catalogCapabilities(catalog, { variantAvailability: true, promotions: { eligibility: { promotionsAllowed: false }, now: () => clock.now() } })) registry.register(r as never);
  registry.register(catalogDiscoverCapability(discover) as never);
  const store = new InMemoryObservationStore();
  const invoker = new CapabilityInvoker({ registry, observations: store, ids: idsFrom(clock), clock, logger: createSilentLogger() });
  const source = new SalesWorkspaceContextSource(reader, windowMs === null ? {} : { catalogDescriptiveWindowMs: windowMs });
  const contexts = compiler({ policy: { budget: UNBOUNDED }, sources: [source] });
  const observations = () => [...store.byInvocation.values()];
  const compile = async () => {
    const base = request({ now: clock.now().toISOString(), observations: observations() });
    const outcome = await contexts.compile({ ...base, execution: { ...base.execution, task: SALES_TASK } });
    if (outcome.kind !== 'compiled') throw new Error(outcome.kind);
    return outcome.compiled;
  };
  const read = (capabilityId: string, args: Record<string, unknown>) => invoker.invoke({ capabilityId, arguments: args }, execution);
  return { clock, read, compile, observations, source };
}

const keysIn = (value: unknown): string => JSON.stringify(value);

describe('R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS', () => {
  it('is off unless set; 1..1800 seconds; anything else refuses (fail closed)', () => {
    expect(loadCatalogDescriptiveWindowMs({})).toBeNull();
    expect(loadCatalogDescriptiveWindowMs({ R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS: '' })).toBeNull();
    expect(loadCatalogDescriptiveWindowMs({ R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS: '0' })).toBeNull();
    expect(loadCatalogDescriptiveWindowMs({ R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS: '300' })).toBe(300_000);
    expect(loadCatalogDescriptiveWindowMs({ R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS: '1800' })).toBe(1_800_000);
    for (const bad of ['1801', '-1', '5m', '1.5', 'on', '300s']) expect(() => loadCatalogDescriptiveWindowMs({ R4_SALES_CATALOG_DESCRIPTIVE_WINDOW_SECONDS: bad }), bad).toThrow(/0 \(off\) or 1\.\.1800/);
  });
});

describe('catalog descriptive items', () => {
  it('off by default: the workspace source contributes exactly what it did before', async () => {
    const { read, clock, source } = setup(null);
    await read('catalog.get_product_context', { productKey: 'KB-COMP' });
    clock.advance(60_000);
    const items = await source.load({ now: clock.now(), scope: {} as never, execution: { task: SALES_TASK, observations: [] } } as never);
    expect(items.map((i) => i.itemId)).toEqual([`sales_workspace:${SALES_TASK.taskId}`]);
  });

  it('a product read keeps the owner validity; once it expires, only its descriptive facts stay current for the window', async () => {
    const { read, clock, compile } = setup(WINDOW_MS);
    const o = await read('catalog.get_product_context', { productKey: 'KB-COMP' });
    const payload = o.payload as { freshness: { validUntil: string }; derived: { price: unknown } };
    // The observation itself is untouched: the owner's 15 s (ADR-030), not R4's 5 minutes, not the window.
    expect(o.validUntil).toBe(payload.freshness.validUntil);
    expect(Date.parse(o.validUntil!) - Date.parse(o.observedAt)).toBe(OWNER_TTL_MS);
    expect(payload.derived.price).not.toBeNull();

    // Inside the owner window: the read is current and no copy is made.
    clock.advance(5_000);
    let ctx = await compile();
    expect(ctx.sections.observations.map((i) => i.itemId)).toEqual([`observation:${o.observationId}`]);

    // Past it: the read (with its price) is history; the descriptive copy is current and carries no commercial field.
    clock.advance(30_000);
    ctx = await compile();
    expect(ctx.sections.history.map((i) => i.itemId)).toEqual([`observation:${o.observationId}`]);
    expect(ctx.sections.history[0]).toMatchObject({ freshness: 'expired', validUntil: o.validUntil });
    const [copy] = ctx.sections.observations as [CompiledContextItem];
    expect(ctx.sections.observations).toHaveLength(1);
    expect(copy).toMatchObject({ itemId: `sales_catalog_descriptive:${o.observationId}`, kind: 'observation', authority: 'OBSERVED', freshness: 'fresh', observedAt: o.observedAt, validUntil: new Date(Date.parse(o.observedAt) + WINDOW_MS).toISOString() });
    const descriptive = (copy.content as { descriptive: Record<string, unknown> }).descriptive;
    expect(descriptive).toMatchObject({ productKey: 'KB-COMP', name: 'Kettlebell de competición', sellableItemKey: null });
    expect((descriptive.variantOptions as unknown[]).length).toBeGreaterThan(0);
    expect(keysIn(descriptive)).not.toMatch(COMMERCIAL_KEYS);
    // Nothing commercial is current anywhere: the only price in the context is in the expired read.
    expect(keysIn(ctx.sections.observations)).not.toMatch(/"(price|finalGross|availability|sellability)":/u);

    // Past the window: gone from the current context too.
    clock.advance(WINDOW_MS);
    ctx = await compile();
    expect(ctx.sections.observations).toEqual([]);
  });

  it('a Discover read: need, interpretation and candidates stay; prices, sellability, disposition and commercial codes do not', async () => {
    const { read, clock } = setup(WINDOW_MS);
    const o = await read('catalog.discover', { need: NEEDS.arms!.need });
    expect(o.validUntil).toBe((o.payload as { commercialFreshness: { earliestValidUntil: string } }).commercialFreshness.earliestValidUntil);
    clock.advance(20_000);
    const [item] = catalogDescriptiveItems([o], clock.now(), WINDOW_MS);
    const d = (item!.content as { descriptive: Record<string, unknown> }).descriptive;
    expect(d).toMatchObject({ need: NEEDS.arms!.need, candidates: [{ productKey: 'DB-ADJ-24', itemKey: null, satisfied: ['home_training@SOURCE_NAME'], unresolved: [] }, { productKey: 'KB-16' }] });
    expect(keysIn(d)).not.toMatch(COMMERCIAL_KEYS);
    expect(keysIn(d)).not.toMatch(/COMMERCIAL_TRUTH|sellable/u);
    expect(contextContributionSchema.parse(item)).toBeTruthy();
  });

  it('only the newest read of a subject counts: a newer current read needs no copy; a newer not_found removes it', () => {
    const at = (s: number) => new Date(Date.parse('2026-11-16T15:00:00.000Z') + s * 1000).toISOString();
    const obs = (id: number, payload: unknown, observedAt: string, capabilityId = 'catalog.get_product_context'): Observation => ({
      observationId: `0190a0a0-0000-7000-8000-${String(id).padStart(12, '0')}`, taskId: SALES_TASK.taskId, runId: RUN.runId, agentId: 'sales',
      source: { kind: 'capability', capabilityId, capabilityVersion: 2, invocationId: `0190a0a0-0000-7000-9000-${String(id).padStart(12, '0')}` },
      outcome: 'succeeded', payload: payload as never, error: null, observedAt, validUntil: new Date(Date.parse(observedAt) + OWNER_TTL_MS).toISOString(), provenance: {}, correlationId: 'c',
    });
    const found = { status: 'found', productKey: 'KB-16', facts: { name: 'Kettlebell 16 kg', specifications: [], variantOptions: [] }, catalogText: {}, derived: {}, inferred: {} };
    const first = obs(1, found, at(0));
    expect(catalogDescriptiveItems([first], new Date(at(20)), WINDOW_MS).map((i) => i.itemId)).toEqual([`sales_catalog_descriptive:${first.observationId}`]);
    // Not before the owner window ends, nor from the window's end on.
    expect(catalogDescriptiveItems([first], new Date(at(10)), WINDOW_MS)).toEqual([]);
    expect(catalogDescriptiveItems([first], new Date(at(300)), WINDOW_MS)).toEqual([]);
    // A newer read that is still current: the read itself is in the context, no copy of the older one.
    expect(catalogDescriptiveItems([first, obs(2, found, at(15))], new Date(at(20)), WINDOW_MS)).toEqual([]);
    // A newer not_found: the product is gone, its old description is not offered as current.
    expect(catalogDescriptiveItems([first, obs(3, { status: 'not_found', productKey: 'KB-16' }, at(5))], new Date(at(40)), WINDOW_MS)).toEqual([]);
    // A failed read and catalog.search are not covered.
    expect(catalogDescriptiveItems([{ ...first, outcome: 'failed', payload: null }, obs(4, { query: 'kb', results: [] }, at(0), 'catalog.search')], new Date(at(20)), WINDOW_MS)).toEqual([]);
  });
});

/**
 * Offline replay of the production turn of 2026-11-16 ("train arms and legs at home": 104 s, 16 model calls, 9
 * catalog.discover over the same 2–3 needs, 4 reads of one product), on synthetic fixture data of the same shape.
 *
 * The model is replaced by an agent that follows the definition rule literally ("prices and stock only from current
 * observations; if what you need is stale, expired or missing, read it again", and history is never current): before
 * answering it needs, CURRENT in the compiled context, the candidates of each need, the specifications of two
 * products and the price of the product it recommends per need. One read per model call; model calls take the
 * production-shaped durations below; Catalog behaves as audited (15 s, cache keeps asOf). Everything else is the real
 * code: Sales capabilities, CapabilityInvoker (ADR-030), ContextCompiler, SalesWorkspaceContextSource.
 */
const DURATIONS_S = [7, 5, 8, 6, 4, 7, 8, 5, 6, 7, 3, 8, 6, 7, 5, 8];
const MAX_MODEL_CALLS = 16;
const RECOMMENDED = { arms: 'DB-ADJ-24', legs: 'RACK-SQ100', bench: 'BENCH-FID' } as const;
const SPECS = ['DB-ADJ-24', 'BENCH-FID'];

type Read = { capability: 'discover' | 'product'; target: string; reason: 'candidates' | 'specs' | 'price' };

function knows(items: readonly CompiledContextItem[], now: number) {
  const contents = items.map((i) => ({ item: i, c: i.content as { capabilityId?: string; payload?: Record<string, unknown>; descriptive?: Record<string, unknown> } }));
  const candidates = (need: string) => contents.some(({ c }) => c.capabilityId === 'catalog.discover' && (c.payload?.need === need || c.descriptive?.need === need));
  const specs = (key: string) => contents.some(({ c }) => c.capabilityId === 'catalog.get_product_context' && (c.payload?.productKey === key || c.descriptive?.productKey === key));
  /** A price only from a platform observation that is current — and whose validity is exactly the owner's. */
  const price = (key: string) =>
    contents.some(({ item, c }) => {
      if (!item.itemId.startsWith('observation:') || !c.payload) return false;
      if (c.capabilityId === 'catalog.get_product_context' && c.payload.productKey === key && c.payload.derived) {
        expect(item.validUntil).toBe((c.payload.freshness as { validUntil: string }).validUntil);
        return true;
      }
      if (c.capabilityId !== 'catalog.discover') return false;
      const candidate = (c.payload.verified as { productKey: string; commercial: { status: string; validUntil: string } }[]).find((v) => v.productKey === key);
      if (!candidate || candidate.commercial.status !== 'OBSERVED' || Date.parse(candidate.commercial.validUntil) <= now) return false;
      expect(item.validUntil).toBe((c.payload.commercialFreshness as { earliestValidUntil: string }).earliestValidUntil);
      return true;
    });
  return { candidates, specs, price };
}

async function replayTurn(windowMs: number | null, rotation: number) {
  const { clock, read, compile } = setup(windowMs);
  const durations = [...DURATIONS_S.slice(rotation), ...DURATIONS_S.slice(0, rotation)];
  const reads: Read[] = [];
  for (let call = 0; call < MAX_MODEL_CALLS; call += 1) {
    const ctx = await compile();
    const k = knows(ctx.sections.observations, clock.now().getTime());
    const missing: Read | undefined =
      Object.entries(NEEDS).flatMap(([, n]): Read[] => (k.candidates(n.need) ? [] : [{ capability: 'discover', target: n.need, reason: 'candidates' }]))[0] ??
      SPECS.flatMap((key): Read[] => (k.specs(key) ? [] : [{ capability: 'product', target: key, reason: 'specs' }]))[0] ??
      Object.entries(RECOMMENDED).flatMap(([need, key]): Read[] => (k.price(key) ? [] : [{ capability: 'discover', target: NEEDS[need]!.need, reason: 'price' }]))[0];
    clock.advance(durations[call]! * 1000);
    if (!missing) return { modelCalls: call + 1, responded: true, reads };
    reads.push(missing);
    if (missing.capability === 'discover') await read('catalog.discover', { need: missing.target });
    else await read('catalog.get_product_context', { productKey: missing.target });
  }
  return { modelCalls: MAX_MODEL_CALLS, responded: false, reads };
}

function summary(r: Awaited<ReturnType<typeof replayTurn>>) {
  const seen = new Set<string>();
  const rereads = r.reads.filter((x) => (seen.has(`${x.capability}:${x.target}`) ? true : (seen.add(`${x.capability}:${x.target}`), false)));
  return {
    responded: r.responded,
    modelCalls: r.modelCalls,
    discover: r.reads.filter((x) => x.capability === 'discover').length,
    productReads: r.reads.filter((x) => x.capability === 'product').length,
    rereads: rereads.length,
    rereadsForDescriptive: rereads.filter((x) => x.reason !== 'price').length,
    rereadsForPrice: rereads.filter((x) => x.reason === 'price').length,
  };
}

describe('offline replay of the 104 s turn (rule-following agent, synthetic data)', () => {
  it('off: the turn loops to the call limit; on: descriptive re-reads disappear and every price used is current owner evidence', async () => {
    const rows: Record<string, unknown>[] = [];
    for (const rotation of [0, 3, 7]) {
      const off = summary(await replayTurn(null, rotation));
      const on = summary(await replayTurn(WINDOW_MS, rotation));
      rows.push({ rotation, arm: 'off', ...off }, { rotation, arm: 'on (300 s)', ...on });
      // Today's behaviour, reproduced: the evidence expires faster than the agent can assemble it.
      expect(off.responded).toBe(false);
      expect(off.rereadsForDescriptive).toBeGreaterThan(0);
      // With the switch: no read repeats for names, candidates or specifications; what remains is price only.
      expect(on.rereadsForDescriptive).toBe(0);
      expect(on.modelCalls).toBeLessThan(off.modelCalls);
      expect(on.responded).toBe(true);
    }
    // R4_REPLAY_OUT=<file>: the per-arm table as JSON lines (the test asserts the shape; the numbers are for the report).
    if (process.env.R4_REPLAY_OUT) writeFileSync(process.env.R4_REPLAY_OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
});
