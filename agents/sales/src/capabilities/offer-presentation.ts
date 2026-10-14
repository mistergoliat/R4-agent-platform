/**
 * (R4-J3E-B) How an offer message is bound to one commercial snapshot, without
 * trusting the model's word: the reference is DERIVED by Sales from the
 * previewId and the workspace's commercial version, and the check reads the
 * agent message the platform actually recorded and delivered. The customer
 * only reads the reference; they never have to type it.
 */
export const OFFER_REFERENCE_PREFIX = 'Q-';

/** `Q-<first 6 hex of previewId, uppercase>-<commercial version>`, e.g. `Q-5F57B2-3`. */
export function offerReference(previewId: string, commercialVersion: number): string {
  return `${OFFER_REFERENCE_PREFIX}${previewId.slice(0, 6).toUpperCase()}-${commercialVersion}`;
}

/** The Chilean presentation of a CLP amount (`52980` → `52.980`). */
export function formatClp(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Whether an agent message presents this snapshot: its exact reference (as a token) and its gross total (as a number). */
export function presentsOffer(text: string | null, reference: string, gross: number): boolean {
  if (text === null) return false;
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[^0-9A-Za-z])${escaped}($|[^0-9A-Za-z])`, 'i').test(text)) return false;
  const amounts = (text.match(/\d{1,3}(?:\.\d{3})+|\d+/g) ?? []).map((n) => n.replace(/\./g, ''));
  return amounts.includes(String(gross));
}
