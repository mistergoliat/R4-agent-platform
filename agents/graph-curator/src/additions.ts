import { kindByName, kindBySiblings, muscleGroups, substituteGroups, type MuscleGroup } from './classify.js';
import type { ProductGraph } from './graph.js';
import type { CatalogFact, CatalogView, Finding } from './rules.js';

/**
 * ADR-058 G2b: what to add for a product the graph does not have, and the muscle groups of the ones it has.
 * - Kind: its name or category (classify.ts), else the kind most of its catalog siblings in the graph have.
 * - Use, complement and storage relations (nu, ec, st) by analogy: what at least half of its peers (same kind, same
 *   category when there are enough) already have published. Physical fit (bar–plate, racks, collars, accessories)
 *   is never inferred by analogy: that is G2b-2.
 * - «Lo reemplaza»: sellable graph products sharing one of its substitute groups, closest price first.
 */
const ANALOGY_AREAS = new Set(['nu', 'ec', 'st']);
const MIN_PEERS = 3;
const MIN_SHARE = 0.5;
const MAX_RELATIONS = 40;
const MAX_SUBSTITUTES = 3;
/** Kinds the graph leaves out on purpose (the graph review's exclusions): never proposed for addition. */
const EXCLUDED_KINDS = new Set(['SERVICE', 'MERCH', 'HYPERBARIC']);

export type Relation = readonly [area: string, a: string, b: string];

export interface Addition {
  readonly kind: string;
  readonly kindBy: 'nombre' | 'categoría';
  readonly peers: number;
  readonly relations: readonly Relation[];
  readonly reasons: readonly string[];
  readonly muscles: readonly MuscleGroup[];
}

function keyOf(view: CatalogView, k: string): CatalogFact | null {
  const f = view.get(k);
  return f && f !== 'not_found' && f !== 'failed' ? f : null;
}

export function additionFor(g: ProductGraph, catalog: CatalogView, key: string, f: CatalogFact): Addition | null {
  const fact = (k: string) => keyOf(catalog, k);
  const byName = kindByName(f.name, f.category);
  const siblings = Object.entries(g.products).filter(([k]) => f.category !== null && fact(k)?.category === f.category).map(([, p]) => p.kind);
  const kind = byName ?? kindBySiblings(siblings);
  if (!kind || EXCLUDED_KINDS.has(kind)) return null;

  const sameKind = Object.entries(g.products).filter(([k, p]) => k !== key && p.kind === kind && fact(k)?.active).map(([k]) => k);
  const sameCategory = sameKind.filter((k) => fact(k)?.category === f.category);
  const peers = sameCategory.length >= MIN_PEERS ? sameCategory : sameKind;
  const relations: Relation[] = [];
  const reasons: string[] = [];
  if (peers.length >= MIN_PEERS) {
    const counts = new Map<string, number>();
    for (const p of peers) {
      for (const [directed, neighbours] of Object.entries(g.view[p] ?? {})) {
        const [area, side] = directed.split(':') as [string, string];
        if (!ANALOGY_AREAS.has(area)) continue;
        for (const x of neighbours) counts.set(`${area}|${side}|${x}`, (counts.get(`${area}|${side}|${x}`) ?? 0) + 1);
      }
    }
    const kept = [...counts].filter(([id, n]) => { const x = id.split('|')[2]!; return n / peers.length >= MIN_SHARE && x !== key && fact(x)?.active; })
      .sort((a, b) => b[1] - a[1]).slice(0, MAX_RELATIONS);
    for (const [id, n] of kept) {
      const [area, side, x] = id.split('|') as [string, string, string];
      relations.push(side === 'a' ? [area, key, x] : [area, x, key]);
      reasons.push(`${g.products[x]?.n ?? x}: ${n} de ${peers.length} productos parecidos ya lo tienen`);
    }
  }
  const price = f.price ?? 0;
  const subs = [...new Set(substituteGroups(f.name, kind).flatMap((group) =>
    Object.entries(g.products).filter(([k, p]) => k !== key && fact(k)?.sellable && substituteGroups(fact(k)!.name, p.kind).includes(group)).map(([k]) => k)))]
    .sort((a, b) => Math.abs((fact(a)?.price ?? 0) - price) - Math.abs((fact(b)?.price ?? 0) - price)).slice(0, MAX_SUBSTITUTES);
  for (const s of subs) {
    relations.push(['sub', key, s]);
    reasons.push(`${g.products[s]?.n ?? s}: lo reemplaza (mismo grupo de reemplazo, se vende)`);
  }
  if (!relations.length) return null; // nothing to add: it stays a NOT_IN_GRAPH notice
  return { kind, kindBy: byName ? 'nombre' : 'categoría', peers: peers.length, relations, reasons, muscles: muscleGroups(f.name, kind) };
}

/** Muscle groups for graph products that do not have them yet (signed ones are kept). */
export function missingMuscles(g: ProductGraph, catalog: CatalogView): Finding[] {
  const out: Finding[] = [];
  for (const [key, p] of Object.entries(g.products)) {
    if (p.muscles || p.act === false) continue;
    const f = keyOf(catalog, key);
    if (f && !f.active) continue;
    const name = f?.name ?? p.n ?? '';
    const muscles = muscleGroups(name, p.kind);
    if (!muscles.length) continue;
    out.push({ task: 'missing_data', rule: 'SET_MUSCLES', productKey: key, relatedKey: null, summary: `${p.n ?? key}: trabaja ${muscles.join(', ').replaceAll('_', ' ')}`, evidence: { kind: p.kind, muscles } });
  }
  return out;
}

/** The groups the graph or, when it has none yet, the rules give a product. */
export function musclesOf(g: ProductGraph, catalog: CatalogView, key: string): readonly MuscleGroup[] {
  const p = g.products[key];
  if (!p) return [];
  return p.muscles ?? muscleGroups(keyOf(catalog, key)?.name ?? p.n ?? '', p.kind);
}
