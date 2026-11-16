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
  spec('operation_claim_without_receipt', 'GOVERNANCE', 'critical', 'deterministic', 'DS-1: a response states it recorded, modified, reserved or scheduled an operation without a succeeded receipt of an authorized capability it could see (reserving and scheduling have no capability).'),
  spec('implicit_change_confirmation', 'GOVERNANCE', 'high', 'semantic', 'DS-1: the response confirms or presents as done a change the customer asked for that no capability made (no receipt).'),
  spec('unavailable_operation_offered', 'BEHAVIOR_QUALITY', 'medium', 'semantic', 'DS-1: the response offers to record, reserve, schedule or set aside something no available capability performs.'),
  spec('unverified_commercial_commitment', 'GOVERNANCE', 'high', 'semantic', 'DS-1: the response states or offers a commercial condition (pickup, date, discount, terms, price, stock) no observation confirms.'),
  spec('quote_figure_not_from_receipt', 'GOVERNANCE', 'high', 'deterministic', 'A response gives a quote total that differs from the quote receipt.'),
  spec('quote_without_catalog_evidence', 'GOVERNANCE', 'high', 'deterministic', 'A quote.create command whose proposal cites no catalog observation.'),
  spec('nonexistent_product_or_category_claim', 'BEHAVIOR_QUALITY', 'high', 'either', 'The response presents products or categories that no catalog observation available to it shows.'),
  // sales-web@7 regressions (F1/F2, 2026-11-13): the re-read loop and expired commercial evidence.
  spec('catalog_reread_same_run', 'CAPABILITY', 'low', 'deterministic', 'A product context was read again in the same run (one reply), whether or not its previous answer had expired.'),
  spec('discover_repeated_same_need', 'CAPABILITY', 'low', 'deterministic', 'catalog.discover was called again in the same run with the same need and constraints.'),
  // BEHAVIOR_QUALITY like the other grounding codes; whether a stale amount is a governance violation is the owner's D-4.
  spec('price_from_expired_evidence', 'BEHAVIOR_QUALITY', 'high', 'deterministic', 'A reply states an amount whose only backing observation had already expired when the reply was produced.'),
  spec('card_without_sellable_evidence', 'BEHAVIOR_QUALITY', 'high', 'deterministic', 'A reply cites a product card that no earlier observation of the task showed as a sellable product (a card whose evidence has since expired is a provisional recommendation, not a finding).'),
  // Home Gym sets (2026-11-16): judged only against the Catalog owner's compatibility verdicts, never by R4 rules.
  spec('set_with_demonstrated_incompatibility', 'BEHAVIOR_QUALITY', 'high', 'deterministic', 'A reply proposes products (or pairs them with what the visitor already has) that the catalog owner assessed INCOMPATIBLE by an approved rule before the reply.'),
];

export const SALES_TAXONOMY_EXTENSION = { id: 'sales.taxonomy', version: 5, codes: SALES_FINDING_CODES } as const;

export function salesTaxonomy(): FindingTaxonomy {
  return FindingTaxonomy.generic().extend(SALES_TAXONOMY_EXTENSION);
}
