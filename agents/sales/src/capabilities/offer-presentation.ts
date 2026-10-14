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

/**
 * (R4-J3E-C1) The offer message template. Sales — not the model — writes
 * the whole commercial message the customer confirms, from the snapshot
 * only: every amount is a value the owners and the Quote V2 arithmetic
 * already produced (no arithmetic here). A new wording is a new version.
 */
export const OFFER_TEMPLATE_VERSION = 'r4-sales-offer-es-v1';
/** An offer longer than this is never presented (a channel text limit leaves no margin above it). */
export const OFFER_MESSAGE_MAX_CHARS = 3500;

/** What the template reads: the commercial snapshot's printable facts (structurally `CommercialSnapshot`). */
export interface OfferContent {
  readonly lines: readonly {
    readonly position: number;
    readonly description: string;
    readonly attributes: readonly { readonly name: string; readonly value: string }[];
    readonly quantity: number;
    readonly unitPrice: { readonly amount: number };
    readonly amounts: { readonly gross: number };
  }[];
  readonly shipping: { readonly kind: 'excluded' } | { readonly kind: 'selected'; readonly carrierName: string; readonly serviceType: string | null; readonly commune: string; readonly region: string | null; readonly amounts: { readonly gross: number } };
  readonly totals: { readonly net: number; readonly tax: number; readonly gross: number };
}

/**
 * The exact offer message (`r4-sales-offer-es-v1`) for one snapshot and its
 * reference. Fixed text has no double quotes, backslashes or channel
 * formatting marks; owner text (descriptions, carrier, places) is printed
 * as the owners wrote it.
 */
export function renderOfferMessage(content: OfferContent, reference: string): string {
  const lines = content.lines.map((line) =>
    [
      `${line.position}. ${line.description}`,
      ...(line.attributes.length > 0 ? [`Variante: ${line.attributes.map((a) => `${a.name}: ${a.value}`).join('; ')}`] : []),
      `Cantidad: ${line.quantity}; precio unitario: $${formatClp(line.unitPrice.amount)}; subtotal: $${formatClp(line.amounts.gross)}`,
    ].join('\n'),
  );
  const shipping = content.shipping.kind === 'selected'
    ? `Despacho: ${[content.shipping.carrierName, content.shipping.serviceType, `a ${content.shipping.commune}`, content.shipping.region].filter((part) => part !== null).join(', ')}: $${formatClp(content.shipping.amounts.gross)}`
    : 'Despacho: no incluido.';
  return [
    `Cotización lista para emitir (Ref. ${reference})`,
    ...lines,
    shipping,
    [`Neto: $${formatClp(content.totals.net)}`, `IVA: $${formatClp(content.totals.tax)}`, `Total: $${formatClp(content.totals.gross)} (IVA incluido)`].join('\n'),
    [
      'Condiciones: montos en pesos chilenos, con IVA incluido salvo el neto. No incluye descuentos ni otros cargos. Al emitir se verifican de nuevo precios, stock y despacho: si algo cambió, no se emite y te presento la oferta actualizada. El número y la validez de la cotización se informan al emitirla.',
      '¿Emito esta cotización? Puedes responder: Sí, emítela.',
    ].join('\n'),
  ].join('\n\n');
}

/** Whether an agent message presents this snapshot: its exact reference (as a token) and its gross total (as a number). */
export function presentsOffer(text: string | null, reference: string, gross: number): boolean {
  if (text === null) return false;
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[^0-9A-Za-z])${escaped}($|[^0-9A-Za-z])`, 'i').test(text)) return false;
  const amounts = (text.match(/\d{1,3}(?:\.\d{3})+|\d+/g) ?? []).map((n) => n.replace(/\./g, ''));
  return amounts.includes(String(gross));
}
