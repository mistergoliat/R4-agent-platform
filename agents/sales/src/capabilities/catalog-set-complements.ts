import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { CatalogPort, CatalogProductContext } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { LANE_CAPABILITY_IDS, SCOPES } from '../ids.js';
import { CATALOG_FRESHNESS_TTL_MS } from './catalog.js';
import { domainRead, readDefinition } from './common.js';

/**
 * EXPERIMENT ONLY (graph A/B, owner OK 2026-11-18, cap US$2; never merged, never in web QA or production).
 * `catalog.set_complements` stands in for the relation endpoint Catalog would publish once the store's product graph
 * is transcribed and signed: given anchor products, the products that go with them, by relation. The relations come
 * from an exported file (offline review of the store's graph); every candidate's price and sellability are read live
 * from Catalog, and only sellable candidates are returned. R4 computes no relation: it reads them.
 */
export const setComplementsInput = z.strictObject({
  anchorKeys: z.array(z.string().regex(/^P\d+$/u)).min(1).max(3),
  maxUnitPriceClp: z.int().min(1).max(100_000_000).optional(),
  perRelation: z.int().min(1).max(5).default(3),
});

const candidate = z.strictObject({ productKey: z.string(), name: z.string(), finalGrossClp: z.int().nullable(), sellability: z.string() });
export const setComplementsOutput = z.strictObject({
  meaning: z.string(),
  anchors: z.array(z.strictObject({ productKey: z.string(), name: z.string().nullable(), inGraph: z.boolean() })),
  relations: z.array(z.strictObject({ anchorKey: z.string(), relation: z.string(), candidates: z.array(candidate) })),
  validUntil: z.string().nullable(),
});
export type SetComplementsView = z.infer<typeof setComplementsOutput>;

interface GraphFile {
  readonly labels: Record<string, string>;
  readonly products: Record<string, { n: string | null; act: boolean | null; price: number | null }>;
  readonly view: Record<string, Record<string, string[]>>;
}

const MEANING =
  'Store-curated relations: what goes with each anchor (the bar for a rack, plates for a bar, collars, a bench that fits inside the rack, the floor under it). Physical fit was checked from the products\' declared data where a relation says so; it is a proposal of the store, not a guarantee beyond the relation stated. Candidates are sellable now, cheapest first.';
// Relations most useful to complete a set come first; the rest follow.
const ORDER = ['rb:a', 'bpc:a', 'bpc:b', 'col:a', 'br:b', 'br:a', 'rb:b', 'ld:a', 'acc:b', 'ec:a', 'ec:b', 'nu:b', 'nu:a', 'st:b', 'st:a', 'acc:a', 'col:b', 'ld:b', 'vr:a', 'vr:b'];
const MAX_RELATIONS = 8;

/** Up to `n` items spread evenly over a list already sorted by price (cheap, middle, dear). */
export function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1 || 1))]!);
}

function liveOf(context: CatalogProductContext): { name: string; finalGrossClp: number | null; sellability: string; validUntil: string | null } | null {
  if (context.status !== 'found') return null;
  return {
    name: context.facts.name,
    finalGrossClp: context.derived.priceSummary?.finalGross.amount ?? null,
    sellability: context.derived.availability.sellability,
    validUntil: context.freshness.validUntil ?? null,
  };
}

export function catalogSetComplementsCapability(catalog: CatalogPort, graphFile: string): CapabilityRegistration<z.infer<typeof setComplementsInput>, SetComplementsView> {
  const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as GraphFile;
  return {
    definition: readDefinition({
      capabilityId: LANE_CAPABILITY_IDS.catalogSetComplements,
      description:
        'Given 1 to 3 anchor products (productKey, e.g. the rack or the bar of a set), returns the products that go with each one, grouped by relation ("Barras que apoyan en este rack", "Discos sugeridos", "Collarines", "Bancos para usar dentro", floor, accessories…), each candidate sellable now with its current price (CLP, tax included), cheapest first, at most perRelation per relation (default 3). Optional maxUnitPriceClp drops dearer candidates. Use it to complete a set around a chosen product in one read instead of searching for each part.',
      owner: 'catalog',
      requiredScopes: [SCOPES.catalogRead],
      freshnessTtlMs: CATALOG_FRESHNESS_TTL_MS,
      timeoutMs: 20_000,
    }),
    input: setComplementsInput,
    output: setComplementsOutput,
    ownerValidUntil: (output) => output.validUntil,
    handler: (input, context) =>
      domainRead(async () => {
        const options = { signal: context.signal, correlationId: context.execution.correlationId };
        const price = (k: string) => graph.products[k]?.price ?? Number.MAX_SAFE_INTEGER;
        const groups: { anchorKey: string; area: string; picks: string[] }[] = [];
        for (const anchor of input.anchorKeys) {
          const view = graph.view[anchor] ?? {};
          for (const area of ORDER.filter((a) => view[a]?.length)) {
            const pool = view[area]!.filter((k) => graph.products[k]?.act !== false && (input.maxUnitPriceClp === undefined || price(k) <= input.maxUnitPriceClp)).sort((a, b) => price(a) - price(b));
            if (pool.length) groups.push({ anchorKey: anchor, area, picks: spread(pool, input.perRelation * 2) });
          }
        }
        const kept = groups.slice(0, MAX_RELATIONS);
        // ponytail: one Catalog read per candidate, all in parallel (≤ 8 relations × 2·perRelation); batch if Catalog rate-limits.
        const keys = [...new Set(kept.flatMap((g) => g.picks))];
        const live = new Map(await Promise.all(keys.map(async (k) => [k, liveOf(await catalog.getProductContext(k, options).catch((): CatalogProductContext => ({ status: 'not_found', productKey: k })))] as const)));
        const relations = kept
          .map((g) => ({
            anchorKey: g.anchorKey,
            relation: (graph.labels[g.area] ?? g.area).replace(/ \(nueva\)$/u, ''),
            candidates: g.picks
              .map((k) => ({ k, l: live.get(k) }))
              .filter(({ l }) => l && l.sellability === 'sellable' && (input.maxUnitPriceClp === undefined || (l.finalGrossClp ?? 0) <= input.maxUnitPriceClp))
              .slice(0, input.perRelation)
              .map(({ k, l }) => ({ productKey: k, name: l!.name, finalGrossClp: l!.finalGrossClp, sellability: l!.sellability })),
          }))
          .filter((r) => r.candidates.length > 0);
        const until = relations.flatMap((r) => r.candidates.map((c) => live.get(c.productKey)?.validUntil ?? null)).filter((v): v is string => v !== null);
        return {
          meaning: MEANING,
          anchors: input.anchorKeys.map((k) => ({ productKey: k, name: graph.products[k]?.n ?? null, inGraph: Boolean(graph.view[k]) })),
          relations,
          validUntil: until.length ? until.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null,
        };
      }),
  };
}
