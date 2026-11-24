import type { PostgresArtifacts } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, productGraphSchema, type ProductGraph } from './graph.js';
import type { Relation } from './additions.js';
import type { Finding } from './rules.js';

/** How far back a reactivated product looks for the relations it had (versions, newest first). */
const HISTORY_LIMIT = 20;

/** The relations a product has in a graph, as [area, a, b]. */
function relationsOf(g: ProductGraph, key: string): Relation[] {
  return Object.entries(g.view[key] ?? {}).flatMap(([directed, neighbours]) => {
    const [area, side] = directed.split(':') as [string, string];
    return neighbours.map((n): Relation => (side === 'a' ? [area, key, n] : [area, n, key]));
  });
}

/**
 * ADR-058 Decision 9 fix (owner 2026-11-24): a product the store reactivates gets back the relations it had in the last
 * version where it was active, except those with products that are not active in the current graph. The reactivation
 * stays automatic; «Deshacer» reverts it whole (the product goes back to how the base version had it).
 */
export async function withRestoredRelations(
  artifacts: Pick<PostgresArtifacts, 'versions' | 'version'>,
  current: ProductGraph,
  findings: readonly Finding[],
): Promise<Finding[]> {
  const reactivated = findings.filter((f) => f.rule === 'REACTIVATED');
  if (!reactivated.length) return [...findings];
  const history = (await artifacts.versions(PRODUCT_GRAPH_KIND)).slice(0, HISTORY_LIMIT);
  const graphs = new Map<number, ProductGraph | null>();
  const graphOf = async (version: number): Promise<ProductGraph | null> => {
    if (!graphs.has(version)) {
      const v = await artifacts.version(PRODUCT_GRAPH_KIND, version);
      const parsed = v ? productGraphSchema.safeParse(v.content) : null;
      graphs.set(version, parsed?.success ? parsed.data : null);
    }
    return graphs.get(version)!;
  };
  const restored = new Map<string, Relation[]>();
  for (const f of reactivated) {
    for (const { version } of history) {
      const g = await graphOf(version);
      const p = g?.products[f.productKey];
      if (!g || !p || p.act === false) continue;
      const relations = relationsOf(g, f.productKey).filter(([, a, b]) => {
        const other = a === f.productKey ? b : a;
        return current.products[other] && current.products[other].act !== false;
      });
      if (relations.length) { restored.set(f.productKey, relations); break; }
    }
  }
  return findings.map((f) => {
    const restore = f.rule === 'REACTIVATED' ? restored.get(f.productKey) : undefined;
    return restore ? { ...f, summary: `${f.summary}; recupera ${restore.length} relaciones`.slice(0, 500), evidence: { ...f.evidence, restore } } : f;
  });
}
