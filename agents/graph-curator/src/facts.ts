import type { CatalogFact, CatalogView, Finding } from './rules.js';

/** A fact a person answered once in R4 (ADR-058 Decision 10): for a product (subject), a sheet field and its value. */
export interface ProductFact {
  readonly subject: string;
  readonly field: string;
  readonly value: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

const PRODUCT_KEY = /^P[1-9]\d{0,8}$/u;

/**
 * The catalog as the curator should read it: each sheet plus the facts R4 has for it (a fact fills a field the sheet
 * lacks; the sheet wins when it already declares it). Each fact the sheet still lacks is a `FACT_NOT_IN_SHEET` notice:
 * the list to fix the store in batch. It closes by itself once the sheet has the field.
 */
export function withFacts(catalog: CatalogView, facts: readonly ProductFact[]): { catalog: Map<string, CatalogFact | 'not_found' | 'failed'>; notices: Finding[] } {
  const merged = new Map(catalog);
  const notices: Finding[] = [];
  for (const f of facts) {
    const sheet = merged.get(f.subject);
    if (!PRODUCT_KEY.test(f.subject) || !sheet || sheet === 'not_found' || sheet === 'failed') continue;
    if ((sheet.specs[f.field] ?? '').trim() !== '') continue; // the sheet already has it: the fact is only the record
    merged.set(f.subject, { ...sheet, specs: { ...sheet.specs, [f.field]: f.value } });
    notices.push({
      task: 'missing_data', rule: 'FACT_NOT_IN_SHEET', productKey: f.subject, relatedKey: null,
      summary: `${sheet.name.split('|')[0]!.trim()}: «${f.field}: ${f.value}» está en R4, falta cargarlo en la ficha de la tienda`.slice(0, 500),
      evidence: { field: f.field, value: f.value, recordedBy: f.recordedBy, recordedAt: f.recordedAt, sellable: sheet.sellable },
    });
  }
  return { catalog: merged, notices };
}
