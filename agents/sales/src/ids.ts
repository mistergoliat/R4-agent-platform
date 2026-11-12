/** Identifiers of the Sales agent pack. Namespaced by owner; none of them exists in R4 Core. */
export const SALES_AGENT_ID = 'sales';
/** (ADR-046) The same Sales pack, configured for the store website chat: its own definition line, never a `sales` version. */
export const SALES_WEB_AGENT_ID = 'sales-web';
export const SALES_TASK_TYPE = 'sales.conversation';

export const CAPABILITY_IDS = {
  customerContext: 'customer.get_context',
  catalogSearch: 'catalog.search',
  productContext: 'catalog.get_product_context',
  shippingQuote: 'shipping.quote',
  workspaceUpdate: 'sales.workspace.update',
  quoteCreate: 'quote.create',
} as const;

/**
 * (R4-J3E) Capabilities of autonomous quote issuance, composed only by
 * sales-production@5 (and its isolated canary). Kept out of CAPABILITY_IDS:
 * the reference composition and @1–@4 never register them.
 */
export const AUTONOMOUS_QUOTE_CAPABILITY_IDS = {
  /** READ: the commercial snapshot the workspace would issue. */
  quotePreview: 'quote.preview',
} as const;

/**
 * (ADR-045) Capabilities of the lane profile (sales-production@13) only: Catalog V2 Discover. Kept out of
 * CAPABILITY_IDS: the reference composition and @1–@12 never register it.
 */
export const LANE_CAPABILITY_IDS = {
  /** READ: need → candidates, Catalog V2 Discover. */
  catalogDiscover: 'catalog.discover',
} as const;

/**
 * (R4 Checkout integration, contract R-2) Checkout capabilities, composed only by the checkout lane profile
 * (sales-production@15). Kept out of CAPABILITY_IDS: no earlier profile or the reference composition registers them.
 */
export const CHECKOUT_CAPABILITY_IDS = {
  /** FINANCIAL: create (or recover) the Checkout session of an issued quote and let Quote prepare the cart. */
  startPurchase: 'checkout.start_purchase',
  /** FINANCIAL: read first; a new payment attempt only when allowed; the platform sends the link. */
  requestPaymentLink: 'checkout.request_payment_link',
  /** READ: Checkout's status mapped by the contract (§6). */
  purchaseStatus: 'checkout.purchase_status',
} as const;

export const CHECKOUT_SCOPES = {
  purchase: 'checkout.purchase',
  read: 'checkout.read',
} as const;

export const SCOPES = {
  customerRead: 'customer.read',
  catalogRead: 'catalog.read',
  shippingRead: 'shipping.read',
  workspaceWrite: 'sales.workspace.write',
  quoteCreate: 'quote.create',
} as const;

export const WORKSPACE_SOURCE_ID = 'sales.workspace';
