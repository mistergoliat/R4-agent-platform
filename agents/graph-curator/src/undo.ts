import { productGraphSchema, type ProductGraph } from './graph.js';
import type { GraphChange } from './changes.js';

/** ADR-058 Decision 9: the mechanical rules whose changes apply and publish themselves (the rest waits for a person). */
export const AUTO_RULES: ReadonlySet<string> = new Set(['INACTIVE_WITH_RELATIONS', 'DISCONTINUED', 'RENAMED', 'REACTIVATED']);
/** Who decides and signs the automatic changes. */
export const AUTO_ACTOR = 'graph-curator:auto';

/**
 * «Deshacer» (Decision 9): the products a change touched go back to how `base` (the version it was built on) had them:
 * entry, relations and unreviewed marks. A removed relation comes back as `base` had it. Validates the result.
 */
export function revertChange(current: ProductGraph, base: ProductGraph, change: GraphChange): ProductGraph {
  const g = structuredClone(current);
  const relationsOf = (graph: ProductGraph, k: string) => Object.entries(graph.view[k] ?? {}).flatMap(([directed, list]) => list.map((other) => [directed, other] as const));
  const unlink = (a: string, b: string) => {
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const groups = g.view[from];
      if (!groups) continue;
      for (const directed of Object.keys(groups)) {
        groups[directed] = groups[directed]!.filter((k) => k !== to);
        if (!groups[directed].length) delete groups[directed];
      }
      if (!Object.keys(groups).length) delete g.view[from];
    }
  };
  const link = (directed: string, a: string, b: string) => {
    if (!g.products[a] || !g.products[b]) return;
    const [area, side] = directed.split(':') as [string, string];
    for (const [from, to, s] of [[a, b, side], [b, a, side === 'a' ? 'b' : 'a']] as const) {
      const list = ((g.view[from] ??= {})[`${area}:${s}`] ??= []);
      if (!list.includes(to)) list.push(to);
    }
  };
  if (change.op === 'add_relations') {
    // Each added relation goes away unless the base already had it.
    const inBase = (area: string, a: string, b: string) => (base.view[a]?.[`${area}:a`] ?? []).includes(b);
    for (const [area, a, b] of change.relations) {
      if (inBase(area, a, b)) continue;
      for (const [from, to, side] of [[a, b, 'a'], [b, a, 'b']] as const) {
        const groups = g.view[from];
        const list = groups?.[`${area}:${side}`];
        if (!groups || !list) continue;
        groups[`${area}:${side}`] = list.filter((k) => k !== to);
        if (!groups[`${area}:${side}`]!.length) delete groups[`${area}:${side}`];
        if (!Object.keys(groups).length) delete g.view[from];
      }
    }
    return productGraphSchema.parse(g);
  }
  if (change.op === 'mark_reviewed') {
    // The marks come back for the relations still published.
    const back = base.unreviewed.filter((t) => change.relations.some((r) => r.join() === t.join()) && g.view[t[1]]?.[`${t[0]}:a`]?.includes(t[2]));
    g.unreviewed.push(...back.filter((t) => !g.unreviewed.some((x) => x.join() === t.join())));
    return productGraphSchema.parse(g);
  }
  if (change.op === 'retype_relations') {
    // Each relation goes back to the type it had in the base, and the «sin revisar» mark it had comes back.
    for (const [a, b] of change.relations) {
      if (!(base.view[a]?.[`${change.from}:a`] ?? []).includes(b)) continue;
      if (!(base.view[a]?.[`${change.to}:a`] ?? []).includes(b)) {
        for (const [from, to, side] of [[a, b, 'a'], [b, a, 'b']] as const) {
          const groups = g.view[from];
          const list = groups?.[`${change.to}:${side}`];
          if (!groups || !list) continue;
          groups[`${change.to}:${side}`] = list.filter((k) => k !== to);
          if (!groups[`${change.to}:${side}`]!.length) delete groups[`${change.to}:${side}`];
          if (!Object.keys(groups).length) delete g.view[from];
        }
      }
      link(`${change.from}:a`, a, b);
      const mark = base.unreviewed.find(([ar, x, y]) => ar === change.from && x === a && y === b);
      if (mark && !g.unreviewed.some((u) => u.join() === mark.join())) g.unreviewed.push(mark);
    }
    return productGraphSchema.parse(g);
  }
  if (change.op === 'remove_relation') {
    for (const [directed, other] of relationsOf(base, change.a)) if (other === change.b && directed.startsWith(`${change.area}:`)) link(directed, change.a, change.b);
    const back = base.unreviewed.filter(([ar, a, b]) => ar === change.area && ((a === change.a && b === change.b) || (a === change.b && b === change.a)));
    g.unreviewed.push(...back.filter((t) => !g.unreviewed.some((u) => u.join() === t.join())));
    return productGraphSchema.parse(g);
  }
  const key = change.key;
  for (const [, other] of relationsOf(g, key)) unlink(key, other);
  delete g.view[key];
  const before = base.products[key];
  if (before) g.products[key] = structuredClone(before);
  else delete g.products[key];
  for (const [directed, other] of relationsOf(base, key)) link(directed, key, other);
  g.unreviewed = [...g.unreviewed.filter(([, a, b]) => a !== key && b !== key), ...base.unreviewed.filter(([, a, b]) => (a === key || b === key) && g.products[a] && g.products[b])];
  return productGraphSchema.parse(g);
}
