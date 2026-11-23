import { z } from 'zod';
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
  z.strictObject({ op: z.literal('activate'), key }),
  z.strictObject({ op: z.literal('rename'), key, name: z.string().min(1).max(300) }),
  z.strictObject({ op: z.literal('remove_relation'), area: z.string().regex(/^[a-z]{1,8}$/u), a: key, b: key }),
]);
export type GraphChange = z.infer<typeof graphChangeSchema>;

const shortName = (name: string): string => name.split('|')[0]!.replace(/\s+/gu, ' ').trim();

/** The change a finding proposes, and what approving it does (shown to the person who decides). */
export function changeOf(f: Finding): { change: GraphChange | null; effect: string } {
  const relations = typeof f.evidence.relations === 'number' ? f.evidence.relations : null;
  switch (f.rule) {
    case 'DISCONTINUED':
    case 'INACTIVE_WITH_RELATIONS':
      return { change: { op: 'deactivate', key: f.productKey }, effect: `Al aprobar: queda inactivo en el grafo y se quitan sus ${relations === null ? '' : `${relations} `}relaciones.` };
    case 'REACTIVATED':
      return { change: { op: 'activate', key: f.productKey }, effect: 'Al aprobar: vuelve a estar activo en el grafo.' };
    case 'RENAMED':
      return { change: { op: 'rename', key: f.productKey, name: shortName(String(f.evidence.after)) }, effect: 'Al aprobar: el grafo usa el nombre nuevo.' };
    case 'SUBSTITUTE_KIND_MISMATCH':
    case 'SUBSTITUTE_AND_COMPLEMENT':
      return { change: { op: 'remove_relation', area: 'sub', a: f.productKey, b: f.relatedKey! }, effect: 'Al aprobar: se quita «Lo reemplaza» entre los dos.' };
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
  for (const c of changes) {
    const p = g.products[c.op === 'remove_relation' ? c.a : c.key];
    if (c.op === 'deactivate') {
      if (p) p.act = false;
      for (const other of Object.values(g.view[c.key] ?? {}).flat()) drop(other, c.key);
      delete g.view[c.key];
      g.unreviewed = g.unreviewed.filter(([, a, b]) => a !== c.key && b !== c.key);
    } else if (c.op === 'activate') {
      if (p) p.act = true;
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
