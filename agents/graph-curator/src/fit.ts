import type { ProductGraph } from './graph.js';
import type { CatalogFact, CatalogView, Finding } from './rules.js';
import type { Relation } from './additions.js';

/**
 * ADR-058 G2b-2: physical fit from the declared sheet data, ported from the graph review (review-bar-plate,
 * review-collar-rackbar and the trainer layer of final-decisions, owner-delegated 2026-11-17). Only declared values
 * are used: a pair whose data is missing is `needs`, and counts toward what that missing field would unblock.
 */
export type Fit = { readonly verdict: 'fit' | 'unfit'; readonly reason: string; readonly detail: string } | { readonly verdict: 'needs'; readonly missing: readonly { readonly side: 'a' | 'b'; readonly field: string }[] } | { readonly verdict: 'skip' };

/** First 2–3 digit number of a declared value («Ø50.4 mm», «50.4 ~ 50.6», «50.4 +/- 0.2» → 50.4). */
const num = (v: string | undefined): number | null => { const m = /(\d{2,3}(?:\.\d+)?)/u.exec(String(v ?? '').replace(',', '.')); return m ? Number(m[1]) : null; };
const kg = (s: string | undefined): number | null => { const m = /(\d+(?:\.\d+)?)\s?(kg|lbs?)\b/iu.exec(String(s ?? '').replace(',', '.')); return m ? (/lb/iu.test(m[2]!) ? Number(m[1]) * 0.4536 : Number(m[1])) : null; };
const short = (name: string) => name.split('|')[0]!.trim();
const isLight = (name: string) => /junior|technique/iu.test(name);
const isBumperLike = (name: string) => /bumper|crumb|caucho|rubber|technique|training/iu.test(name);
const SLEEVE = 'Diámetro de manga', BORE = 'Diámetro interno', GRIP = 'Largo de agarre';

/** Bar ↔ plate (PRG-D5 proposal: 0 ≤ bore − sleeve ≤ 3 mm), then the trainer layer (light bars, bar capacity). */
export function barPlate(bar: CatalogFact, plate: CatalogFact): Fit {
  const pn = plate.name;
  if (/atril|rack|porta discos|barra|\bb\.|banco|mancuerna|smith|jaula/iu.test(pn) || (/\bpack\b|\bset\b/iu.test(pn) && num(plate.specs[BORE]) === null)) return { verdict: 'skip' };
  const s = num(bar.specs[SLEEVE]), b = num(plate.specs[BORE]);
  if (s === null || b === null) return { verdict: 'needs', missing: [...(s === null ? [{ side: 'a' as const, field: SLEEVE }] : []), ...(b === null ? [{ side: 'b' as const, field: BORE }] : [])] };
  const c = Number((b - s).toFixed(2));
  if (c < 0) return { verdict: 'unfit', reason: 'BORE_SMALLER_THAN_SLEEVE', detail: `orificio ${b} mm < manga ${s} mm` };
  if (c > 3) return { verdict: 'unfit', reason: 'CLEARANCE_TOO_LARGE', detail: `holgura ${c} mm (orificio ${b}, manga ${s})` };
  if (isLight(bar.name) && !isBumperLike(pn)) return { verdict: 'unfit', reason: 'LIGHT_BAR_NEEDS_RUBBER', detail: `«${short(bar.name)}» es para técnica: discos de caucho livianos` };
  const cap = kg(bar.specs['Peso máximo de carga'] ?? bar.specs['Peso máximo de usuario']), pw = kg(short(pn));
  const pair = pw === null ? null : /\bpack\b|\bset\b/iu.test(pn) ? pw : 2 * pw;
  if (cap !== null && pair !== null && pair > cap) return { verdict: 'unfit', reason: 'OVER_BAR_CAPACITY', detail: `un par de ${pw!.toFixed(1).replace('.0', '')} kg supera la carga máxima de la barra (${cap.toFixed(0)} kg)` };
  return { verdict: 'fit', reason: 'DECLARED_FIT', detail: `holgura ${c} mm (orificio ${b}, manga ${s})` };
}

/** Bar ↔ collar: within 1 mm fits; smaller than the sleeve or more than 5 mm larger does not; between, a lever,
 *  aluminium or magnetic collar clamps it (CLAMP_COVERS_48 of the review). */
export function barCollar(bar: CatalogFact, collar: CatalogFact): Fit {
  const s = num(bar.specs[SLEEVE]), c = num(collar.specs[BORE]);
  if (s === null || c === null) return { verdict: 'needs', missing: [...(s === null ? [{ side: 'a' as const, field: SLEEVE }] : []), ...(c === null ? [{ side: 'b' as const, field: BORE }] : [])] };
  const d = Number((c - s).toFixed(2));
  if (d < -0.5) return { verdict: 'unfit', reason: 'COLLAR_SMALLER_THAN_SLEEVE', detail: `collarín ${c} mm < manga ${s} mm` };
  if (d > 5) return { verdict: 'unfit', reason: 'COLLAR_TOO_LARGE', detail: `collarín ${c} mm sobre manga ${s} mm: no aprieta` };
  return { verdict: 'fit', reason: d <= 1 ? 'DECLARED_FIT' : 'CLAMP_COVERS', detail: `collarín ${c} mm sobre manga ${s} mm` };
}

/** Rack ↔ bar: the bar must span the uprights; grip ≥ the rack's largest declared measure, or a standard bar (≥ 128 cm). */
export function rackBar(rack: CatalogFact, bar: CatalogFact): Fit {
  if (/accesorio|pack/iu.test(rack.name)) return { verdict: 'skip' };
  const gripText = bar.specs[GRIP] ?? '';
  if (/no apta/iu.test(gripText)) return { verdict: 'unfit', reason: 'BAR_DECLARES_NOT_FOR_RACKS', detail: `la ficha de la barra dice «${gripText}»` };
  if (/junior/iu.test(bar.name)) return { verdict: 'unfit', reason: 'KIDS_BAR', detail: 'barra infantil: no se usa en un rack' };
  const grip = Number.parseFloat(gripText.replace(',', '.'));
  if (!Number.isFinite(grip)) return { verdict: 'needs', missing: [{ side: 'b', field: GRIP }] };
  const dims = String(rack.specs['Dimensiones del producto armado'] ?? rack.specs['Dimensiones del producto'] ?? '').replace(/,/gu, '.');
  const l = Number.parseFloat(/Largo:?\s*([\d.]+)/iu.exec(dims)?.[1] ?? ''), w = Number.parseFloat(/Ancho:?\s*([\d.]+)/iu.exec(dims)?.[1] ?? '');
  const frame = Number.isFinite(l) && Number.isFinite(w) ? Math.max(l, w) : null;
  if (frame !== null && grip >= frame) return { verdict: 'fit', reason: 'DECLARED_DIMENSIONS_FIT', detail: `agarre ${grip} cm ≥ ${frame} cm, la medida mayor del rack` };
  if (grip >= 128) return { verdict: 'fit', reason: 'STANDARD_BAR', detail: `barra de largo estándar (agarre ${grip} cm)` };
  return { verdict: 'unfit', reason: 'SHORT_BAR_WIDE_FRAME', detail: `agarre ${grip} cm y el rack mide ${frame ?? '¿?'} cm: sin certeza de que apoye` };
}

/** The physical-fit areas: who is «a» in the graph, the kinds on each side, and the rule. */
export const FIT_AREAS = [
  { area: 'bpc', rule: 'FIT_MISSING_PLATES', a: ['OLY_BAR', 'PRE_BAR', 'TECH_BAR'], b: ['PLATE_OLY', 'PLATE_PRE', 'PLATE_FRACTIONAL'], fit: barPlate, what: 'discos' },
  { area: 'col', rule: 'FIT_MISSING_COLLARS', a: ['OLY_BAR', 'PRE_BAR', 'TECH_BAR', 'SPECIALTY_BAR', 'CURL_BAR'], b: ['COLLAR'], fit: barCollar, what: 'collarines' },
  { area: 'rb', rule: 'FIT_MISSING_BARS', a: ['SQUAT_RACK'], b: ['OLY_BAR', 'TECH_BAR'], fit: rackBar, what: 'barras' },
] as const;
const MAX_PER_PROPOSAL = 60;

export interface FitReport {
  readonly findings: Finding[];
  /** Per product and missing field: how many pairs it would decide. */
  readonly unblocks: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/**
 * Every pair of the fit areas among active products: declared fits the graph lacks (one proposal per «a» product and
 * area), published relations the declared data contradicts (one per pair), and what each missing field would unblock.
 */
export function physicalFit(g: ProductGraph, catalog: CatalogView): FitReport {
  const fact = (k: string): CatalogFact | null => { const f = catalog.get(k); return f && f !== 'not_found' && f !== 'failed' && f.active ? f : null; };
  const of = (kinds: readonly string[]) => Object.entries(g.products).filter(([k, p]) => p.kind !== null && kinds.includes(p.kind) && p.act !== false && fact(k)).map(([k]) => k);
  const findings: Finding[] = [];
  const unblocks = new Map<string, Map<string, number>>();
  const count = (k: string, field: string) => { const m = unblocks.get(k) ?? unblocks.set(k, new Map()).get(k)!; m.set(field, (m.get(field) ?? 0) + 1); };
  for (const spec of FIT_AREAS) {
    const bs = of(spec.b);
    for (const a of of(spec.a)) {
      const fa = fact(a)!;
      const published = new Set(g.view[a]?.[`${spec.area}:a`] ?? []);
      const missing: { b: string; detail: string }[] = [];
      for (const b of bs) {
        if (a === b) continue;
        const v = spec.fit(fa, fact(b)!);
        if (v.verdict === 'needs') { for (const m of v.missing) count(m.side === 'a' ? a : b, m.field); continue; }
        if (v.verdict === 'fit' && !published.has(b)) missing.push({ b, detail: v.detail });
        if (v.verdict === 'unfit' && published.has(b)) {
          findings.push({ task: 'inconsistency', rule: 'FIT_CONTRADICTED', productKey: a, relatedKey: b, summary: `${short(fa.name)} y ${short(fact(b)!.name)} están relacionados («${spec.area}»), pero los datos declarados dicen que no calzan: ${v.detail}`, evidence: { area: spec.area, reason: v.reason, detail: v.detail } });
        }
      }
      if (missing.length) {
        const kept = missing.slice(0, MAX_PER_PROPOSAL);
        const relations: Relation[] = kept.map((m) => [spec.area, a, m.b]);
        findings.push({ task: 'new_or_changed', rule: spec.rule, productKey: a, relatedKey: null, summary: `${short(fa.name)}: ${missing.length} ${spec.what} calzan según los datos declarados y no están en el grafo`, evidence: { area: spec.area, relations, reasons: kept.map((m) => `${short(fact(m.b)!.name)}: ${m.detail}`) } });
      }
    }
  }
  return { findings, unblocks };
}
