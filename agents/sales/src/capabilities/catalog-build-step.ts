import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { CatalogPort, CatalogProductContext } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { LANE_CAPABILITY_IDS, SCOPES } from '../ids.js';
import { CATALOG_FRESHNESS_TTL_MS } from './catalog.js';
import { domainRead, readDefinition } from './common.js';

/**
 * EXPERIMENT ONLY (graph A/B, sequential home-gym builder, owner idea 2026-11-19; never merged, never web QA or prod).
 * `catalog.build_step` stands in for a set-builder endpoint Catalog would own: for ONE step of a home-gym build (a
 * rack, its bar, plates, a bench…), up to three options (económica, equilibrada, superior) that are compatible with
 * everything already chosen (store graph), sellable now (live Catalog) and within what remains of the budget after
 * reserving the cheapest option of each piece the chosen ones still need (a rack needs a bar and plates). Everything
 * here is deterministic: the model chooses the plan and talks; this decides compatibility, quantities and money.
 */
export const BUILD_STEPS = ['rack', 'smith', 'barra', 'discos', 'banco', 'collarines', 'piso', 'cardio', 'mancuernas', 'kettlebells', 'funcional', 'dominadas', 'colchoneta', 'maquina', 'almacenamiento'] as const;
type Step = (typeof BUILD_STEPS)[number];
const KINDS: Record<Step, readonly string[]> = {
  rack: ['SQUAT_RACK'], smith: ['SMITH'], barra: ['OLY_BAR', 'PRE_BAR'], discos: ['PLATE_OLY', 'PLATE_PACK', 'PLATE_PRE'], banco: ['BENCH', 'BENCH_STATION'],
  collarines: ['COLLAR'], piso: ['RUBBER_FLOOR', 'PLATFORM'], cardio: ['TREADMILL', 'CARDIO'], mancuernas: ['DB'], kettlebells: ['KB'],
  funcional: ['SLAM', 'SANDBAG', 'MED_BALL', 'PLYO_BOX', 'BATTLE', 'JUMP_ROPE', 'RINGS', 'SUSP', 'AGILITY'], dominadas: ['PULLUP'],
  colchoneta: ['MAT'], maquina: ['SELECTORIZED', 'PLATE_MACHINE', 'CABLE_STATION'], almacenamiento: ['STORE_DB', 'STORE_PLATE', 'STORE_BALL', 'STORE_BAR', 'STORE_KB'],
};
/** What a chosen piece still needs before it can be used. */
const NEEDS: Partial<Record<Step, readonly Step[]>> = { rack: ['barra', 'discos'], smith: ['discos'], barra: ['discos'] };
/**
 * Which chosen pieces constrain a step, in both directions (a rack chosen after its bar must still hold that bar; the
 * bench must fit the rack; the bar's own bench relations do not apply).
 */
const CONSTRAINED_BY: Partial<Record<Step, readonly Step[]>> = {
  rack: ['barra', 'banco'], smith: ['discos', 'banco'], barra: ['rack', 'smith', 'discos', 'collarines'],
  discos: ['barra', 'smith', 'maquina'], banco: ['rack', 'smith'], collarines: ['barra'], maquina: ['discos'],
};
/** A bench with its own bar rests (BENCH_STATION) is only offered once a bar is chosen. */
const NEEDS_BAR_KINDS = ['BENCH_STATION'];
/** How the store chat names each step while the tool works (progress text, Spanish, web only). */
const LABEL: Record<Step, string> = {
  rack: 'racks', smith: 'máquinas Smith', barra: 'barras', discos: 'discos', banco: 'bancos', collarines: 'collarines', piso: 'pisos',
  cardio: 'máquinas de cardio', mancuernas: 'mancuernas', kettlebells: 'kettlebells', funcional: 'implementos funcionales',
  dominadas: 'barras de dominadas', colchoneta: 'colchonetas', maquina: 'máquinas', almacenamiento: 'racks de almacenamiento',
};
const clp = (n: number) => '$' + Math.round(n).toLocaleString('es-CL');
/** Reports what the tool is doing (text ≤ 80 chars, optional catalog keys). Best effort: never awaited, never fails the read. */
export type BuildProgress = (taskId: string, detail: string, products?: readonly string[]) => void;
const TIERS = ['económica', 'equilibrada', 'superior'] as const;
const DEFAULT_PLATE_KG = 40;
const MAX_PLATE_UNITS = 4;

export const buildStepInput = z.strictObject({
  step: z.enum(BUILD_STEPS),
  // A chosen product, or one already in the visitor's cart or Mi gym (a variant key counts as its product).
  selected: z.array(z.strictObject({ productKey: z.string().regex(/^P\d+(?:-V\d+)?$/u), quantity: z.int().min(1).max(20) })).max(12).default([]),
  budgetMaxClp: z.int().min(10_000).max(100_000_000),
  targetPlateKg: z.int().min(10).max(400).optional(),
});
const option = z.strictObject({ tier: z.enum(TIERS), productKey: z.string(), name: z.string(), quantity: z.int(), unitPriceClp: z.int(), totalClp: z.int(), totalKg: z.number().nullable() });
export const buildStepOutput = z.strictObject({
  step: z.string(),
  options: z.array(option),
  selectedTotalClp: z.int(),
  remainingBudgetClp: z.int(),
  reservedForNeededClp: z.int(),
  stillNeeded: z.array(z.string()),
  reason: z.string().nullable(),
  validUntil: z.string().nullable(),
});
export type BuildStepView = z.infer<typeof buildStepOutput>;

interface GraphFile {
  readonly products: Record<string, { n: string | null; act: boolean | null; price: number | null; kind: string | null }>;
  readonly view: Record<string, Record<string, string[]>>;
}

/** Plate weight of one sellable unit, from the product name (a "Par" counts twice; lb → kg). */
export function unitKg(name: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(kg|lbs?)\b/iu.exec(name);
  if (!m) return null;
  const kg = Number(m[1]!.replace(',', '.')) * (/^lb/iu.test(m[2]!) ? 0.4536 : 1);
  return /\bpar\b/iu.test(name) && !/pack|set/iu.test(name) ? kg * 2 : kg;
}

export function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1 || 1))]!);
}

const stepOfKind = (kind: string | null): Step | null => (kind ? (BUILD_STEPS.find((s) => KINDS[s].includes(kind)) ?? null) : null);

function live(context: CatalogProductContext): { name: string; price: number | null; sellable: boolean; validUntil: string | null } | null {
  if (context.status !== 'found') return null;
  return { name: context.facts.name, price: context.derived.priceSummary?.finalGross.amount ?? null, sellable: context.derived.availability.sellability === 'sellable', validUntil: context.freshness.validUntil ?? null };
}

export function catalogBuildStepCapability(catalog: CatalogPort, graphFile: string, progress?: BuildProgress): CapabilityRegistration<z.infer<typeof buildStepInput>, BuildStepView> {
  const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as GraphFile;
  const ofStep = (k: string, s: Step) => KINDS[s].includes(graph.products[k]?.kind ?? '') && graph.products[k]?.act !== false;
  const neighbours = (k: string) => new Set(Object.entries(graph.view[k] ?? {}).filter(([a]) => !a.startsWith('vr:')).flatMap(([, l]) => l));
  /** Products of a step compatible with every chosen piece that constrains that step (CONSTRAINED_BY). */
  const pool = (s: Step, selected: readonly string[]): string[] => {
    let keys = Object.keys(graph.products).filter((k) => ofStep(k, s));
    if (!selected.some((x) => stepOfKind(graph.products[x]?.kind ?? null) === 'barra')) keys = keys.filter((k) => !NEEDS_BAR_KINDS.includes(graph.products[k]?.kind ?? ''));
    const by = CONSTRAINED_BY[s] ?? [];
    for (const k of selected.filter((x) => by.includes(stepOfKind(graph.products[x]?.kind ?? null) as Step))) {
      const n = neighbours(k);
      if ([...n].some((x) => ofStep(x, s))) keys = keys.filter((x) => n.has(x));
    }
    return keys;
  };
  const quantityFor = (s: Step, k: string, targetKg: number) => {
    if (s !== 'discos') return 1;
    const kg = unitKg(graph.products[k]?.n ?? '');
    return kg ? Math.min(MAX_PLATE_UNITS, Math.max(1, Math.ceil(targetKg / kg))) : 1;
  };
  return {
    definition: readDefinition({
      capabilityId: LANE_CAPABILITY_IDS.catalogBuildStep,
      description:
        `One step of a home-gym build. step = the piece to choose now (${BUILD_STEPS.join(', ')}); selected = the products already chosen with their quantities; budgetMaxClp = the visitor's budget ceiling (CLP, tax included); targetPlateKg = total plate load for step discos (default ${DEFAULT_PLATE_KG}). Returns up to three options (económica, equilibrada, superior) compatible with everything already chosen per the store's product relations, sellable now with current prices, with the quantity to buy (plates: enough units to reach the load) and totals, within what remains of the budget after reserving the cheapest option of each piece still needed (stillNeeded). Empty options come with a reason.`,
      owner: 'catalog',
      requiredScopes: [SCOPES.catalogRead],
      freshnessTtlMs: CATALOG_FRESHNESS_TTL_MS,
      timeoutMs: 20_000,
    }),
    input: buildStepInput,
    output: buildStepOutput,
    ownerValidUntil: (output) => output.validUntil,
    handler: (input, context) =>
      domainRead(async () => {
        const options = { signal: context.signal, correlationId: context.execution.correlationId };
        const say = (detail: string, products?: readonly string[]) => {
          try {
            progress?.(context.execution.taskId, detail.slice(0, 80), products);
          } catch {
            // A report never affects the read.
          }
        };
        const short = (k: string) => (graph.products[k]?.n ?? k).split('|')[0]!.trim().slice(0, 40);
        // A variant key (from the cart or Mi gym) stands for its product: relations are per product.
        const selected = input.selected.map((s) => ({ productKey: s.productKey.split('-')[0]!, quantity: s.quantity }));
        const anchor = selected.map((x) => x.productKey).find((k) => (CONSTRAINED_BY[input.step] ?? []).includes(stepOfKind(graph.products[k]?.kind ?? null) as Step));
        say(anchor ? 'Buscando ' + LABEL[input.step] + ' que calcen con ' + short(anchor) + '…' : 'Buscando ' + LABEL[input.step] + ' para tu gimnasio…');
        const read = async (k: string) => live(await catalog.getProductContext(k, options).catch((): CatalogProductContext => ({ status: 'not_found', productKey: k })));
        const chosen = selected.map((s) => s.productKey);
        const targetKg = input.targetPlateKg ?? DEFAULT_PLATE_KG;
        const chosenLive = await Promise.all(chosen.map(read));
        const selectedTotal = selected.reduce((sum, s, i) => sum + (chosenLive[i]?.price ?? graph.products[s.productKey]?.price ?? 0) * s.quantity, 0);
        const remaining = input.budgetMaxClp - selectedTotal;
        const have = new Set<Step>(chosen.map((k) => stepOfKind(graph.products[k]?.kind ?? null)).filter((s): s is Step => s !== null));
        have.add(input.step);
        const needed = [...new Set([...have].flatMap((s) => NEEDS[s] ?? []))].filter((s) => !have.has(s));
        // Reserve the cheapest compatible option of each piece still needed (snapshot price; live check happens at its own step).
        const reserved = needed.reduce((sum, s) => {
          const prices = pool(s, chosen).map((k) => (graph.products[k]?.price ?? Number.MAX_SAFE_INTEGER) * quantityFor(s, k, targetKg));
          return sum + (prices.length ? Math.min(...prices) : 0);
        }, 0);
        const cap = remaining - reserved;
        if (reserved > 0) say('Guardo ' + clp(reserved) + ' para ' + needed.map((s) => LABEL[s]).join(' y '));
        const total = (k: string) => (graph.products[k]?.price ?? Number.MAX_SAFE_INTEGER) * quantityFor(input.step, k, targetKg);
        // Plates must reach the load with at most MAX_PLATE_UNITS units; a weight that cannot be read is not offered.
        const reachesLoad = (k: string) => input.step !== 'discos' || (unitKg(graph.products[k]?.n ?? '') ?? 0) * quantityFor('discos', k, targetKg) >= targetKg - 1;
        const candidates = pool(input.step, chosen).filter((k) => total(k) <= cap && reachesLoad(k)).sort((a, b) => total(a) - total(b));
        say(candidates.length + ' ' + LABEL[input.step] + ' compatibles en tu presupuesto · revisando precio y stock');
        // ponytail: hydrate at most 9 spread candidates in parallel, then keep 3 sellable ones within the cap at live prices.
        const probe = spread(candidates, 9);
        const lives = await Promise.all(probe.map(read));
        const ok = probe
          .map((k, i) => ({ k, l: lives[i], q: quantityFor(input.step, k, targetKg) }))
          .filter((x) => x.l?.sellable && x.l.price !== null && x.l.price * x.q <= cap);
        const picks = spread(ok, 3);
        if (picks.length) say(picks.length === 3 ? 'Elegí 3 opciones: económica, equilibrada y superior' : 'Elegí ' + (picks.length === 1 ? '1 opción' : '2 opciones') + ' que cumplen todo', picks.map((p) => p.k));
        const tiers = picks.length === 1 ? ['equilibrada'] : picks.length === 2 ? ['económica', 'superior'] : [...TIERS];
        const validUntil = [...chosenLive, ...picks.map((p) => p.l)].map((l) => l?.validUntil ?? null).filter((v): v is string => v !== null);
        return {
          step: input.step,
          options: picks.map((p, i) => {
            const kg = input.step === 'discos' ? unitKg(p.l!.name) : null;
            return { tier: tiers[i] as (typeof TIERS)[number], productKey: p.k, name: p.l!.name, quantity: p.q, unitPriceClp: p.l!.price!, totalClp: p.l!.price! * p.q, totalKg: kg === null ? null : Math.round(kg * p.q * 10) / 10 };
          }),
          selectedTotalClp: selectedTotal,
          remainingBudgetClp: remaining,
          reservedForNeededClp: reserved,
          stillNeeded: needed,
          reason: picks.length ? null : candidates.length ? 'no compatible option is sellable now within the budget' : cap <= 0 ? 'the budget is used up by what was already chosen and the pieces it still needs' : 'no product of this step is related to what was already chosen',
          validUntil: validUntil.length ? validUntil.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null,
        };
      }),
  };
}

/**
 * EXPERIMENT ONLY (owner 2026-11-20): `catalog.replacements` — for a product the visitor wants, its status, its
 * second-selection version (same model, used) and up to `limit` sellable products that do the same job (the store
 * graph's «lo reemplaza» relation: same muscle, same cardio type, same rack or bench format, same load), closest in
 * price first, all with live Catalog prices. One read instead of searching; R4 decides nothing about what replaces what.
 */
export const replacementsInput = z.strictObject({
  productKey: z.string().regex(/^P\d+$/u),
  limit: z.int().min(1).max(4).default(3),
  maxUnitPriceClp: z.int().min(1).max(100_000_000).optional(),
});
const liveItem = z.strictObject({ productKey: z.string(), name: z.string(), finalGrossClp: z.int().nullable(), sellable: z.boolean() });
export const replacementsOutput = z.strictObject({
  product: liveItem.nullable(),
  inGraph: z.boolean(),
  secondSelection: z.array(liveItem),
  replacements: z.array(liveItem),
  validUntil: z.string().nullable(),
});
export type ReplacementsView = z.infer<typeof replacementsOutput>;

export function catalogReplacementsCapability(catalog: CatalogPort, graphFile: string, progress?: BuildProgress): CapabilityRegistration<z.infer<typeof replacementsInput>, ReplacementsView> {
  const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as GraphFile;
  const side = (k: string, ...areas: string[]) => [...new Set(areas.flatMap((a) => graph.view[k]?.[a] ?? []))].filter((x) => graph.products[x]?.act !== false);
  return {
    definition: readDefinition({
      capabilityId: LANE_CAPABILITY_IDS.catalogReplacements,
      description:
        'For one product (productKey): its current status and price, its second-selection version (the same model, used or with a cosmetic defect, sold at a discount) when one is sellable, and up to limit (default 3) sellable products that do the same job (same muscle or machine type, same cardio type, same rack or bench format, same load for free weights), closest in price first, with current prices (CLP, tax included). Optional maxUnitPriceClp drops dearer ones. Use it when the product the visitor wants cannot be bought now, or to show alternatives to a product.',
      owner: 'catalog',
      requiredScopes: [SCOPES.catalogRead],
      freshnessTtlMs: CATALOG_FRESHNESS_TTL_MS,
      timeoutMs: 20_000,
    }),
    input: replacementsInput,
    output: replacementsOutput,
    ownerValidUntil: (output) => output.validUntil,
    handler: (input, context) =>
      domainRead(async () => {
        const options = { signal: context.signal, correlationId: context.execution.correlationId };
        const say = (detail: string, products?: readonly string[]) => {
          try {
            progress?.(context.execution.taskId, detail.slice(0, 80), products);
          } catch {
            // A report never affects the read.
          }
        };
        const read = async (k: string) => live(await catalog.getProductContext(k, options).catch((): CatalogProductContext => ({ status: 'not_found', productKey: k })));
        const k = input.productKey;
        const base = await read(k);
        say('Buscando reemplazos para ' + (base?.name ?? graph.products[k]?.n ?? k).split('|')[0]!.trim().slice(0, 40) + '…');
        const used = side(k, 'vr:b');
        const similar = side(k, 'sub:a', 'sub:b');
        const ref = base?.price ?? graph.products[k]?.price ?? null;
        const distance = (x: string) => Math.abs((graph.products[x]?.price ?? Number.MAX_SAFE_INTEGER) - (ref ?? 0));
        const probe = [...similar].sort((a, b) => distance(a) - distance(b)).slice(0, input.limit * 3);
        say(similar.length + ' productos cumplen la misma función · revisando precio y stock');
        const lives = await Promise.all([...used, ...probe].map(async (x) => [x, await read(x)] as const));
        const ok = (l: Awaited<ReturnType<typeof read>>) => !!l && l.sellable && l.price !== null && (input.maxUnitPriceClp === undefined || l.price <= input.maxUnitPriceClp);
        const item = (x: string, l: NonNullable<Awaited<ReturnType<typeof read>>>) => ({ productKey: x, name: l.name, finalGrossClp: l.price, sellable: l.sellable });
        const secondSelection = lives.filter(([x, l]) => used.includes(x) && ok(l)).map(([x, l]) => item(x, l!));
        const replacements = lives.filter(([x, l]) => probe.includes(x) && ok(l)).slice(0, input.limit).map(([x, l]) => item(x, l!));
        const found = [...secondSelection, ...replacements];
        if (found.length) say('Encontré ' + found.length + (found.length === 1 ? ' opción disponible' : ' opciones disponibles'), found.map((r) => r.productKey));
        const validUntil = [base, ...lives.map(([, l]) => l)].map((l) => l?.validUntil ?? null).filter((v): v is string => v !== null);
        return {
          product: base ? { productKey: k, name: base.name, finalGrossClp: base.price, sellable: base.sellable } : null,
          inGraph: Boolean(graph.view[k]),
          secondSelection,
          replacements,
          validUntil: validUntil.length ? validUntil.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null,
        };
      }),
  };
}
