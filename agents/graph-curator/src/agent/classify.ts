import { z } from 'zod';
import { MUSCLE_GROUPS } from '../classify.js';
import type { ProductGraph } from '../graph.js';
import type { KindsView, ProductSheetView } from './capabilities.js';

/**
 * ADR-058 G4: what the graph-curator agent must return for one product, and the deterministic check its result goes
 * through before it becomes a proposal. Model output is untrusted: a result whose kind is not in the closed list, whose
 * evidence does not appear verbatim in the sheet, or that classifies without evidence is refused, never proposed.
 */
export const classificationSchema = z.strictObject({
  kind: z.string().max(60).nullable(),
  muscles: z.array(z.enum(MUSCLE_GROUPS)).max(MUSCLE_GROUPS.length),
  evidence: z.array(z.strictObject({ field: z.string().min(1).max(120), value: z.string().min(1).max(500) })).max(10),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type Classification = z.infer<typeof classificationSchema>;

export type ClassificationCheck =
  | { readonly ok: true; readonly classification: Classification }
  | { readonly ok: false; readonly violations: readonly string[] };

export const norm = (s: string) => s.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();

/** Where a cited field's value lives in the sheet the agent read (the same view the capability returned). */
export function sheetValue(sheet: ProductSheetView, field: string): string | null {
  const f = norm(field);
  if (f === 'nombre' || f === 'name') return sheet.name;
  const spec = sheet.specifications.find((s) => norm(s.name) === f)?.value ?? null;
  // «Categoría» is both the store category and, on many sheets, a specification (e.g. «Olímpico»): either counts.
  if (f === 'categoría' || f === 'categoria' || f === 'category') return [sheet.category, spec].filter((v) => v !== null).join(' | ') || null;
  return spec;
}

/** The evaluation the agent's result must pass (also its regression check). */
export function checkClassification(data: unknown, sheet: ProductSheetView, vocabulary: ReadonlySet<string>): ClassificationCheck {
  const parsed = classificationSchema.safeParse(data);
  if (!parsed.success) return { ok: false, violations: [`shape: ${parsed.error.issues[0]?.path.join('.') || '(root)'} ${parsed.error.issues[0]?.message ?? ''}`.trim()] };
  const c = parsed.data;
  const violations: string[] = [];
  if (!sheet.found) violations.push('the product has no sheet');
  if (c.kind !== null && !vocabulary.has(c.kind)) violations.push(`kind ${c.kind} is not in the closed list`);
  if ((c.kind !== null || c.muscles.length) && !c.evidence.length) violations.push('a classification without evidence');
  for (const e of c.evidence) {
    const value = sheetValue(sheet, e.field);
    if (value === null) violations.push(`evidence field «${e.field}» is not in the sheet`);
    else if (!norm(value).includes(norm(e.value))) violations.push(`evidence «${e.field}: ${e.value}» does not appear in the sheet`);
  }
  return violations.length ? { ok: false, violations } : { ok: true, classification: c };
}

/** The closed list of kinds the agent may use: those the graph already uses, with counts and example names. */
export function kindVocabulary(g: ProductGraph): KindsView {
  const byKind = new Map<string, string[]>();
  for (const p of Object.values(g.products)) if (p.kind) (byKind.get(p.kind) ?? byKind.set(p.kind, []).get(p.kind)!).push((p.n ?? '').split('|')[0]!.trim());
  return { kinds: [...byKind].sort((a, b) => b[1].length - a[1].length).map(([kind, names]) => ({ kind, products: names.length, examples: names.slice(0, 3) })) };
}

/**
 * Which products to classify, in the owner's order (2026-11-24): the most asked about to Pesín first, then sellable
 * ones, then by how related they are. Only active graph products without a kind (no rule classified them).
 */
export function classificationTargets(g: ProductGraph, asked: ReadonlyMap<string, number>, sellable: (key: string) => boolean, limit: number): string[] {
  const degree = (k: string) => Object.values(g.view[k] ?? {}).reduce((n, l) => n + l.length, 0);
  return Object.entries(g.products)
    .filter(([, p]) => p.act !== false && p.kind === null)
    .map(([k]) => k)
    .sort((a, b) => (asked.get(b) ?? 0) - (asked.get(a) ?? 0) || Number(sellable(b)) - Number(sellable(a)) || degree(b) - degree(a) || a.localeCompare(b))
    .slice(0, limit);
}
