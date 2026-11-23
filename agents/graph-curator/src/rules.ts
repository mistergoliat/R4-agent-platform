import type { ProductGraph } from './graph.js';

/**
 * ADR-058 G2: the curator's deterministic rules, no model. They compare the signed graph with the live catalog and
 * report; nothing is changed (approving and signing are the console's, G3).
 */

/** What the curator reads of one product sheet (Catalog V2 product context). */
export interface CatalogFact {
  readonly name: string;
  readonly active: boolean;
  readonly sellable: boolean;
  readonly category: string | null;
  readonly price: number | null;
  /** Specification name → value, as the sheet declares them. */
  readonly specs: Readonly<Record<string, string>>;
}
/** Per product key: its sheet, `not_found`, or `failed` (the read failed: no rule concludes anything from it). */
export type CatalogView = ReadonlyMap<string, CatalogFact | 'not_found' | 'failed'>;

export type FindingTask = 'new_or_changed' | 'missing_data' | 'inconsistency';
export interface Finding {
  readonly task: FindingTask;
  readonly rule: string;
  readonly productKey: string;
  readonly relatedKey: string | null;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}
export const fingerprintOf = (f: Pick<Finding, 'task' | 'rule' | 'productKey' | 'relatedKey'>): string => [f.task, f.rule, f.productKey, f.relatedKey ?? ''].join('|');

/**
 * The data each kind needs so its compatibility can be decided (the «falta dato» classes of the graph review). A list
 * of alternatives means any one of them is enough.
 */
export const REQUIRED_SPECS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  PLATE_OLY: [['Diámetro interno']],
  PLATE_FRACTIONAL: [['Diámetro interno']],
  PLATE_PRE: [['Diámetro interno']],
  COLLAR: [['Diámetro interno']],
  OLY_BAR: [['Diámetro de manga'], ['Largo de agarre']],
  SPECIALTY_BAR: [['Diámetro de manga']],
  TECH_BAR: [['Diámetro de manga']],
  CURL_BAR: [['Diámetro de manga']],
  SQUAT_RACK: [['Perfiles']],
  RACK_ACC: [['Perfiles']],
  BENCH: [['Peso máximo de usuario', 'Peso máximo de carga']],
  SPECIALTY_BENCH: [['Peso máximo de usuario', 'Peso máximo de carga']],
  BENCH_STATION: [['Peso máximo de usuario', 'Peso máximo de carga']],
};

/** Areas that say «use it together»: a pair that is also a «Lo reemplaza» is a contradiction. */
const COMPLEMENT_AREAS = new Set(['acc', 'rb', 'ec', 'nu', 'br', 'st', 'ld', 'col', 'bpc']);

const shortName = (name: string): string => name.split('|')[0]!.replace(/\s+/gu, ' ').trim();
const areaOf = (directed: string): string => directed.split(':')[0]!;

function neighbours(g: ProductGraph, key: string): { area: string; key: string }[] {
  return Object.entries(g.view[key] ?? {}).flatMap(([directed, keys]) => keys.map((k) => ({ area: areaOf(directed), key: k })));
}

export function curate(g: ProductGraph, catalog: CatalogView): Finding[] {
  const out: Finding[] = [];
  const fact = (k: string): CatalogFact | null => { const f = catalog.get(k); return f && f !== 'not_found' && f !== 'failed' ? f : null; };
  const add = (task: FindingTask, rule: string, productKey: string, relatedKey: string | null, summary: string, evidence: Record<string, unknown>) => out.push({ task, rule, productKey, relatedKey, summary: summary.slice(0, 500), evidence });

  // 1. New or changed products.
  for (const [key, f] of catalog) {
    if (f === 'not_found' || f === 'failed' || !f.active || g.products[key]) continue;
    add('new_or_changed', 'NOT_IN_GRAPH', key, null, `Producto activo que no está en el grafo (nuevo, o sin ninguna relación todavía): ${shortName(f.name)}`, { name: f.name, category: f.category, sellable: f.sellable, price: f.price });
  }
  for (const [key, p] of Object.entries(g.products)) {
    const seen = catalog.get(key);
    if (seen === undefined || seen === 'failed') continue;
    const relations = neighbours(g, key).length;
    const name = p.n ?? key;
    if (p.act !== false && (seen === 'not_found' || !seen.active)) {
      add('new_or_changed', 'DISCONTINUED', key, null, `${name}: ${seen === 'not_found' ? 'ya no está en el catálogo' : 'quedó inactivo'} y tiene ${relations} relaciones publicadas`, { catalog: seen === 'not_found' ? 'not_found' : 'inactive', relations });
      continue;
    }
    if (seen === 'not_found') continue;
    if (p.act === false && seen.active) add('new_or_changed', 'REACTIVATED', key, null, `${name} volvió a estar activo`, { relations, sellable: seen.sellable });
    if (p.n !== null && shortName(seen.name).toLowerCase() !== shortName(p.n).toLowerCase()) add('new_or_changed', 'RENAMED', key, null, `Cambió de nombre: «${shortName(p.n)}» → «${shortName(seen.name)}»`, { before: p.n, after: seen.name });
  }

  // 2. Missing data on the sheets (active products of the kinds that need it), sellable first.
  const missing: Finding[] = [];
  for (const [key, p] of Object.entries(g.products)) {
    const f = fact(key);
    const required = p.kind ? REQUIRED_SPECS[p.kind] : undefined;
    if (!f || !f.active || !required) continue;
    const lacks = required.filter((alternatives) => !alternatives.some((s) => (f.specs[s] ?? '').trim() !== '')).map((alternatives) => alternatives.join(' o '));
    if (lacks.length) missing.push({ task: 'missing_data', rule: 'SPEC_MISSING', productKey: key, relatedKey: null, summary: `${shortName(f.name)}: falta ${lacks.join(', ')} en la ficha`, evidence: { kind: p.kind, missing: lacks, sellable: f.sellable } });
  }
  out.push(...missing.sort((a, b) => Number(b.evidence.sellable) - Number(a.evidence.sellable)));

  // 3. Inconsistencies.
  const sellable = (k: string) => fact(k)?.sellable === true;
  for (const [key, p] of Object.entries(g.products)) {
    const f = fact(key);
    const rel = neighbours(g, key);
    const name = p.n ?? key;
    if (f && !f.active && rel.length) {
      const activeNeighbours = rel.filter((r) => fact(r.key)?.active).length;
      if (activeNeighbours) add('inconsistency', 'INACTIVE_WITH_RELATIONS', key, null, `${name} está inactivo y sigue relacionado con ${activeNeighbours} productos activos`, { relations: rel.length, activeNeighbours });
    }
    if (f?.sellable && rel.length === 0) add('inconsistency', 'SELLABLE_UNRELATED', key, null, `${name} se vende y no tiene ninguna relación`, { kind: p.kind });
    const subs = rel.filter((r) => r.area === 'sub');
    const subsKnown = subs.every((s) => { const c = catalog.get(s.key); return c !== undefined && c !== 'failed'; });
    if (f?.active && !f.sellable && subsKnown && !subs.some((s) => sellable(s.key))) add('inconsistency', 'NO_SELLABLE_SUBSTITUTE', key, null, `${name} no se puede vender y no tiene un reemplazo vendible`, { substitutes: subs.length });
    for (const s of subs) {
      if (key >= s.key) continue; // each pair once
      const other = g.products[s.key];
      if (p.kind && other?.kind && p.kind !== other.kind) add('inconsistency', 'SUBSTITUTE_KIND_MISMATCH', key, s.key, `«Lo reemplaza» entre tipos distintos: ${name} (${p.kind}) y ${other.n ?? s.key} (${other.kind})`, { kinds: [p.kind, other.kind] });
      const alsoComplement = rel.find((r) => r.key === s.key && COMPLEMENT_AREAS.has(r.area));
      if (alsoComplement) add('inconsistency', 'SUBSTITUTE_AND_COMPLEMENT', key, s.key, `${name} y ${other?.n ?? s.key} son a la vez reemplazo y complemento («${alsoComplement.area}»)`, { area: alsoComplement.area });
    }
  }
  return out;
}

/** Findings per task and rule, for the run row and the console. */
export function countFindings(findings: readonly Finding[]): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const f of findings) (counts[f.task] ??= {})[f.rule] = ((counts[f.task] ??= {})[f.rule] ?? 0) + 1;
  return counts;
}
