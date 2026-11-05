/** Identifiers of the Sales agent pack. Namespaced by owner; none of them exists in R4 Core. */
export const SALES_AGENT_ID = 'sales';
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

export const SCOPES = {
  customerRead: 'customer.read',
  catalogRead: 'catalog.read',
  shippingRead: 'shipping.read',
  workspaceWrite: 'sales.workspace.write',
  quoteCreate: 'quote.create',
} as const;

export const WORKSPACE_SOURCE_ID = 'sales.workspace';
