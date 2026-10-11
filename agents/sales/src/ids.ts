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
 * Capabilities that exist only in non-production compositions (R4-DISCOVER-I1).
 * Kept out of CAPABILITY_IDS on purpose: no production profile lists them, and
 * the reference composition registers one only when its binding is provided.
 */
export const NON_PRODUCTION_CAPABILITY_IDS = {
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
