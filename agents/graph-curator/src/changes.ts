import { z } from 'zod';
import { MUSCLE_GROUPS } from './classify.js';
import { productGraphSchema, type ProductGraph } from './graph.js';
import type { Finding } from './rules.js';

/**
 * ADR-058 G3: the change a finding proposes to the graph (stored opaque in Core's artifact_proposals) and how an
 * approved one is applied to build the next version. A finding with no change (missing data, no substitute, not in
 * the graph, sellable unrelated) is informational: approving it acknowledges it.
 */
const key = z.string().regex(/^P[1-9]\d{0,8}$/u);
export const graphChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('deactivate'), key }),
  // A reactivated product, with the relations it had when it was last active (restore; optional).
  z.strictObject({ op: z.literal('activate'), key, restore: z.array(z.tuple([z.string().regex(/^[a-z]{1,8}$/u), key, key])).max(500).optional() }),
  z.strictObject({ op: z.literal('rename'), key, name: z.string().min(1).max(300) }),
  z.strictObject({ op: z.literal('remove_relation'), area: z.string().regex(/^[a-z]{1,8}$/u), a: key, b: key }),
  // G2b: a product the graph did not have, with its relations ([area, a, b]: view[a]['area:a'] ∋ b).
  z.strictObject({
    op: z.literal('add_product'), key,
    product: z.strictObject({ n: z.string().min(1).max(300), price: z.number().nonnegative().nullable(), kind: z.string().max(60), muscles: z.array(z.enum(MUSCLE_GROUPS)).max(MUSCLE_GROUPS.length) }),
    relations: z.array(z.tuple([z.string().regex(/^[a-z]{1,8}$/u), key, key])).max(60),
  }),
  z.strictObject({ op: z.literal('set_muscles'), key, muscles: z.array(z.enum(MUSCLE_GROUPS)).min(1).max(MUSCLE_GROUPS.length) }),
  // G4: the kind the graph-curator agent classified (from the closed list), with its cited evidence in the proposal.
  z.strictObject({ op: z.literal('set_kind'), key, kind: z.string().min(1).max(60) }),
  // G2b-2: declared physical fits the graph lacks ([area, a, b]: view[a]['area:a'] ∋ b).
  z.strictObject({ op: z.literal('add_relations'), relations: z.array(z.tuple([z.string().regex(/^[a-z]{1,8}$/u), key, key])).min(1).max(200) }),
  // G4b: unreviewed relations the graph-curator agent confirmed with cited evidence; approving clears their mark.
  z.strictObject({ op: z.literal('mark_reviewed'), relations: z.array(z.tuple([z.string().regex(/^[a-z]{1,8}$/u), key, key])).min(1).max(50) }),
]);
export type GraphChange = z.infer<typeof graphChangeSchema>;
type GraphMuscles = (typeof MUSCLE_GROUPS)[number][];

const shortName = (name: string): string => name.split('|')[0]!.replace(/\s+/gu, ' ').trim();

/** The change a finding proposes, and what approving it does (shown to the person who decides). */
export function changeOf(f: Finding): { change: GraphChange | null; effect: string } {
  const relations = typeof f.evidence.relations === 'number' ? f.evidence.relations : null;
  switch (f.rule) {
    case 'DISCONTINUED':
    case 'INACTIVE_WITH_RELATIONS':
      return { change: { op: 'deactivate', key: f.productKey }, effect: `Al aprobar: queda inactivo en el grafo y se quitan sus ${relations === null ? '' : `${relations} `}relaciones.` };
    case 'REACTIVATED': {
      const restore = f.evidence.restore as [string, string, string][] | undefined;
      return restore?.length
        ? { change: { op: 'activate', key: f.productKey, restore }, effect: `Al aprobar: vuelve a estar activo en el grafo y recupera ${restore.length} relaciones.` }
        : { change: { op: 'activate', key: f.productKey }, effect: 'Al aprobar: vuelve a estar activo en el grafo.' };
    }
    case 'RENAMED':
      return { change: { op: 'rename', key: f.productKey, name: shortName(String(f.evidence.after)) }, effect: 'Al aprobar: el grafo usa el nombre nuevo.' };
    case 'SUBSTITUTE_KIND_MISMATCH':
    case 'SUBSTITUTE_AND_COMPLEMENT':
      return { change: { op: 'remove_relation', area: 'sub', a: f.productKey, b: f.relatedKey! }, effect: 'Al aprobar: se quita «Lo reemplaza» entre los dos.' };
    case 'ADD_PRODUCT': {
      const e = f.evidence as { name: string; price: number | null; kind: string; muscles: string[]; relations: [string, string, string][] };
      return { change: { op: 'add_product', key: f.productKey, product: { n: shortName(e.name), price: e.price, kind: e.kind, muscles: e.muscles as GraphMuscles }, relations: e.relations }, effect: `Al aprobar: entra al grafo con ${e.relations.length} relaciones.` };
    }
    case 'FIT_MISSING_PLATES':
    case 'FIT_MISSING_COLLARS':
    case 'FIT_MISSING_BARS': {
      const rel = f.evidence.relations as [string, string, string][];
      return { change: { op: 'add_relations', relations: rel }, effect: `Al aprobar: se agregan ${rel.length} relaciones de calce declarado.` };
    }
    case 'FIT_CONTRADICTED':
      return { change: { op: 'remove_relation', area: String(f.evidence.area), a: f.productKey, b: f.relatedKey! }, effect: 'Al aprobar: se quita la relación que los datos declarados contradicen.' };
    case 'SET_MUSCLES':
      return { change: { op: 'set_muscles', key: f.productKey, muscles: f.evidence.muscles as GraphMuscles }, effect: 'Al aprobar: el grafo registra qué grupos trabaja.' };
    default:
      return { change: null, effect: 'Informativo: aprobarlo lo marca como visto; no cambia el grafo.' };
  }
}

/** Applies approved changes to a graph (idempotent: an already-applied change is a no-op) and validates the result. */
export function applyChanges(graph: ProductGraph, changes: readonly GraphChange[]): ProductGraph {
  const g = structuredClone(graph);
  const drop = (a: string, b: string, areas?: ReadonlySet<string>) => {
    const groups = g.view[a];
    if (!groups) return;
    for (const [directed, list] of Object.entries(groups)) {
      if (areas && !areas.has(directed.split(':')[0]!)) continue;
      groups[directed] = list.filter((k) => k !== b);
      if (!groups[directed].length) delete groups[directed];
    }
    if (!Object.keys(groups).length) delete g.view[a];
  };
  const link = (area: string, a: string, b: string) => {
    if (!g.products[a] || !g.products[b] || a === b) return;
    for (const [from, to, side] of [[a, b, 'a'], [b, a, 'b']] as const) {
      const list = ((g.view[from] ??= {})[`${area}:${side}`] ??= []);
      if (!list.includes(to)) list.push(to);
    }
  };
  for (const c of changes) {
    if (c.op === 'add_product') {
      g.products[c.key] ??= { n: c.product.n, act: true, price: c.product.price, kind: c.product.kind, ...(c.product.muscles.length ? { muscles: c.product.muscles } : {}) };
      for (const [area, a, b] of c.relations) link(area, a, b);
      continue;
    }
    if (c.op === 'add_relations') {
      for (const [area, a, b] of c.relations) link(area, a, b);
      continue;
    }
    if (c.op === 'mark_reviewed') {
      const done = new Set(c.relations.map((r) => r.join('|')));
      g.unreviewed = g.unreviewed.filter((r) => !done.has(r.join('|')));
      continue;
    }
    if (c.op === 'set_kind') {
      const target = g.products[c.key];
      if (target) target.kind = c.kind;
      continue;
    }
    if (c.op === 'set_muscles') {
      const target = g.products[c.key];
      if (target) target.muscles = c.muscles;
      continue;
    }
    const p = g.products[c.op === 'remove_relation' ? c.a : c.key];
    if (c.op === 'deactivate') {
      if (p) p.act = false;
      for (const other of Object.values(g.view[c.key] ?? {}).flat()) drop(other, c.key);
      delete g.view[c.key];
      g.unreviewed = g.unreviewed.filter(([, a, b]) => a !== c.key && b !== c.key);
    } else if (c.op === 'activate') {
      if (p) p.act = true;
      // Only with products that are still active; a missing one is skipped.
      for (const [area, a, b] of c.restore ?? []) if (g.products[a]?.act !== false && g.products[b]?.act !== false) link(area, a, b);
    } else if (c.op === 'rename') {
      if (p) p.n = c.name;
    } else {
      const only = new Set([c.area]);
      drop(c.a, c.b, only);
      drop(c.b, c.a, only);
      g.unreviewed = g.unreviewed.filter(([ar, a, b]) => !(ar === c.area && ((a === c.a && b === c.b) || (a === c.b && b === c.a))));
    }
  }
  return productGraphSchema.parse(g);
}
