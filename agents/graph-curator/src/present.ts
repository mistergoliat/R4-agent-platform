import type { ArtifactProposal, NewArtifactProposal, PostgresArtifacts } from '@r4/persistence-postgres';
import { graphChangeSchema, type GraphChange } from './changes.js';
import { PRODUCT_GRAPH_KIND, type ProductGraph } from './graph.js';
import { readSignedGraph } from './signed.js';

/**
 * ADR-058 Decision 12 (G7a): each open proposal as a question a person can answer, with what each answer does, its
 * group and the products involved. Templates in code, no model. Stored in `evidence.presentation`, so the console only
 * shows it.
 *
 * Groups: `changes` = what Pesín recommends changes (relations, kinds, new products); `bulk` = nothing Pesín does
 * changes today (confirmations, muscle groups), fine to approve as a block after a sample; `notice` = nothing to
 * decide.
 */
export type PresentationGroup = 'changes' | 'bulk' | 'notice';

export interface Presentation {
  readonly group: PresentationGroup;
  /** A yes/no question; null for a notice (only `text`). */
  readonly question: string | null;
  /** What «Sí» means for the proposal: approve it or reject it. Null for a notice. */
  readonly yes: 'approve' | 'reject' | null;
  readonly ifYes: string | null;
  readonly ifNo: string | null;
  /** The sentence shown when there is no question (a notice), else the proposal's summary. */
  readonly text: string;
  readonly products: readonly { readonly key: string; readonly name: string; readonly price: number | null; readonly active: boolean | null }[];
  /** How often Pesín read these products in 90 days (the order inside a group, most asked first). */
  readonly asked: number;
}

const name = (g: ProductGraph, key: string) => (g.products[key]?.n ?? key).split('|')[0]!.trim();
const q = (g: ProductGraph, key: string) => `«${name(g, key)}»`;
const label = (g: ProductGraph, area: string) => g.labels[`${area}:a`] ?? area;
const list = (g: ProductGraph, keys: readonly string[], max = 4) => keys.slice(0, max).map((k) => q(g, k)).join(', ') + (keys.length > max ? ` y ${keys.length - max} más` : '');
/** Up to two other products of the same kind: a kind is named by its examples, not by its code. */
const peers = (g: ProductGraph, kind: string | null | undefined, except: string) =>
  kind ? Object.entries(g.products).filter(([k, p]) => p.kind === kind && k !== except && p.act !== false).slice(0, 2).map(([k]) => k) : [];

function questionOf(g: ProductGraph, change: GraphChange): Pick<Presentation, 'group' | 'question' | 'yes' | 'ifYes' | 'ifNo'> & { keys: string[] } {
  switch (change.op) {
    case 'remove_relation': {
      const { area, a, b } = change;
      if (area === 'sub') {
        return { group: 'changes', keys: [a, b], yes: 'reject', question: `Si un cliente busca ${q(g, a)} y está agotado, ¿le ofrecerías ${q(g, b)}?`,
          ifYes: `Pesín sigue ofreciendo ${q(g, b)} como reemplazo de ${q(g, a)}.`, ifNo: `Pesín deja de ofrecer ${q(g, b)} como reemplazo de ${q(g, a)}.` };
      }
      // Owner 2026-11-25 (Deadlift Jack Bar): say what the graph claims, so a wrong type reads as wrong; a relation that
      // is right but of another type is fixed with «Explicar» (G7b), not with No.
      return { group: 'changes', keys: [a, b], yes: 'reject', question: `En el grafo, ${q(g, a)} tiene a ${q(g, b)} en «${label(g, area)}». ¿Está bien así?`,
        ifYes: 'La relación se mantiene.', ifNo: `Se quita: Pesín deja de proponer ${q(g, b)} en «${label(g, area)}» de ${q(g, a)}. Si van juntos pero con otro tipo de relación, usa «Explicar».` };
    }
    case 'add_relations': {
      const [area, a] = change.relations[0]!;
      const bs = change.relations.filter((r) => r[0] === area && r[1] === a).map((r) => r[2]);
      return { group: 'changes', keys: [a, ...bs], yes: 'approve', question: `Para ${q(g, a)}, ¿${bs.length === 1 ? 'va' : 'van'} ${list(g, bs)} en «${label(g, area)}»?`,
        ifYes: `Pesín ${bs.length === 1 ? 'lo' : 'los'} puede proponer en «${label(g, area)}» de ${q(g, a)}.`, ifNo: 'No se agrega nada.' };
    }
    case 'add_product': {
      const others = peers(g, change.product.kind, change.key);
      return { group: 'changes', keys: [change.key, ...others], yes: 'approve',
        question: others.length ? `¿Sumamos «${change.product.n.split('|')[0]!.trim()}» al grafo como un producto del tipo de ${list(g, others)}?` : `¿Sumamos «${change.product.n.split('|')[0]!.trim()}» al grafo?`,
        ifYes: `Pesín lo puede usar al armar gimnasios y como reemplazo, con ${change.relations.length} relaciones.`, ifNo: 'Queda fuera del grafo.' };
    }
    case 'set_kind': {
      const others = peers(g, change.kind, change.key);
      return { group: 'changes', keys: [change.key, ...others], yes: 'approve',
        question: others.length ? `¿${q(g, change.key)} es del mismo tipo que ${list(g, others)}?` : `¿${q(g, change.key)} es del tipo ${change.kind}?`,
        ifYes: 'Pesín lo trata como esos productos al armar gimnasios y buscar reemplazos.', ifNo: 'Queda sin tipo, como hoy.' };
    }
    case 'set_muscles':
      return { group: 'bulk', keys: [change.key], yes: 'approve', question: `¿${q(g, change.key)} trabaja ${change.muscles.join(', ').replace(/_/gu, ' ')}?`,
        ifYes: 'Queda registrado en el grafo. Hoy no cambia lo que hace Pesín.', ifNo: 'No se registra.' };
    case 'mark_reviewed': {
      const anchors = [...new Set(change.relations.flatMap(([, a, b]) => [a, b]))];
      const counts = new Map<string, number>();
      for (const k of change.relations.flatMap(([, a, b]) => [a, b])) counts.set(k, (counts.get(k) ?? 0) + 1);
      const anchor = [...counts].sort((x, y) => y[1] - x[1])[0]![0];
      const n = change.relations.length;
      return { group: 'bulk', keys: [anchor, ...anchors.filter((k) => k !== anchor)], yes: 'approve',
        question: `El curador revisó ${n === 1 ? 'una relación' : `${n} relaciones`} de ${q(g, anchor)} y dice que ${n === 1 ? 'está bien' : 'están bien'}. ¿${n === 1 ? 'La das por revisada' : 'Las das por revisadas'}?`,
        ifYes: 'Quedan revisadas. Pesín ya las usa y sigue igual.', ifNo: 'Siguen marcadas sin revisar. Pesín las sigue usando.' };
    }
    case 'retype_relations': {
      const as = [...new Set(change.relations.map(([a]) => a))];
      const n = change.relations.length;
      const of = as.length === 1 ? ` de ${q(g, as[0]!)}` : '';
      return { group: 'changes', keys: [...as, ...change.relations.map(([, b]) => b)], yes: 'approve',
        question: `¿Cambiamos ${n === 1 ? 'la relación' : `las ${n} relaciones`}${of} de «${label(g, change.from)}» a «${label(g, change.to)}»?`,
        ifYes: `Pesín ${n === 1 ? 'la' : 'las'} usa como «${label(g, change.to)}».`, ifNo: `${n === 1 ? 'Queda' : 'Quedan'} como «${label(g, change.from)}».` };
    }
    case 'deactivate':
    case 'activate':
    case 'rename':
      // Mechanical (Decision 9): normally applied by the curator itself; shown as a change if one is ever left open.
      return { group: 'changes', keys: [change.key], yes: 'approve', question: null, ifYes: null, ifNo: null };
  }
}

/** The presentation of one proposal on the given graph (pure). */
export function presentProposal(g: ProductGraph, p: Pick<ArtifactProposal, 'summary' | 'change'>, asked: ReadonlyMap<string, number>): Presentation {
  const parsed = p.change === null ? null : graphChangeSchema.safeParse(p.change);
  const shown = parsed?.success ? questionOf(g, parsed.data) : null;
  const keys = [...new Set(shown?.keys ?? [])].slice(0, 6);
  return {
    group: shown?.group ?? (p.change === null ? 'notice' : 'changes'),
    question: shown?.question ?? null,
    yes: shown?.question ? shown.yes : null,
    ifYes: shown?.ifYes ?? null,
    ifNo: shown?.ifNo ?? null,
    text: p.summary,
    products: keys.map((key) => ({ key, name: name(g, key), price: g.products[key]?.price ?? null, active: g.products[key]?.act ?? null })),
    asked: Math.max(0, ...keys.map((k) => asked.get(k) ?? 0)),
  };
}

/** JSON with sorted keys: Postgres jsonb does not keep key order, so a stored presentation compares by content. */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Writes the presentation of every open proposal (ADR-058 G7a). Re-proposes each one with its own source, base version,
 * summary and change, only adding `evidence.presentation`, so nothing else about it changes: still open, same
 * fingerprint, same lifecycle. Runs at the end of every curator run (they refresh evidence) and on its own.
 */
export async function presentOpenProposals(artifacts: Pick<PostgresArtifacts, 'current' | 'proposals' | 'propose'>, asked: ReadonlyMap<string, number>): Promise<{ open: number; updated: number; groups: Record<PresentationGroup, number> }> {
  const signed = await readSignedGraph(artifacts);
  if (!signed) throw new Error('no signed product graph');
  const open = await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed');
  const groups: Record<PresentationGroup, number> = { changes: 0, bulk: 0, notice: 0 };
  const batches = new Map<string, { source: string; baseVersion: number; proposals: NewArtifactProposal[] }>();
  for (const p of open) {
    const presentation = presentProposal(signed.graph, p, asked);
    groups[presentation.group]++;
    const evidence = (p.evidence && typeof p.evidence === 'object' ? p.evidence : {}) as Record<string, unknown>;
    if (canonical(evidence.presentation) === canonical(presentation)) continue;
    const id = `${p.source}\n${p.baseVersion}`;
    const batch = batches.get(id) ?? batches.set(id, { source: p.source, baseVersion: p.baseVersion, proposals: [] }).get(id)!;
    batch.proposals.push({ fingerprint: p.fingerprint, summary: p.summary, evidence: { ...evidence, presentation }, change: p.change });
  }
  let updated = 0;
  for (const b of batches.values()) {
    const r = await artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: b.baseVersion, source: b.source, correlationId: 'graph-present', proposals: b.proposals });
    updated += r.refreshed;
  }
  return { open: open.length, updated, groups };
}
