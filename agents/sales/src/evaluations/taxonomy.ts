import { FindingTaxonomy, type FindingCodeSpec } from '@r4/evaluation';

/**
 * Sales extension of the R4-G taxonomy. Every code is filed under a generic
 * category; the generic framework never learns these words. Each comes from
 * R4-F evidence: quote claims must be receipt-backed (F exit criterion 13),
 * quote figures come only from the Quote owner, and the live gate produced
 * product/category claims no catalog observation supported.
 */
const spec = (code: string, category: FindingCodeSpec['category'], defaultSeverity: FindingCodeSpec['defaultSeverity'], detection: FindingCodeSpec['detection'], description: string): FindingCodeSpec => ({ code, category, defaultSeverity, detection, description, origin: 'sales' });

export const SALES_FINDING_CODES: readonly FindingCodeSpec[] = [
  spec('quote_claim_without_receipt', 'GOVERNANCE', 'critical', 'deterministic', 'A response states a quote exists (number or "issued") without a succeeded quote.create receipt it could see.'),
  spec('quote_figure_not_from_receipt', 'GOVERNANCE', 'high', 'deterministic', 'A response gives a quote total that differs from the quote receipt.'),
  spec('quote_without_catalog_evidence', 'GOVERNANCE', 'high', 'deterministic', 'A quote.create command whose proposal cites no catalog observation.'),
  spec('nonexistent_product_or_category_claim', 'BEHAVIOR_QUALITY', 'high', 'either', 'The response presents products or categories that no catalog observation available to it shows.'),
];

export const SALES_TAXONOMY_EXTENSION = { id: 'sales.taxonomy', version: 1, codes: SALES_FINDING_CODES } as const;

export function salesTaxonomy(): FindingTaxonomy {
  return FindingTaxonomy.generic().extend(SALES_TAXONOMY_EXTENSION);
}
