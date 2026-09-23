import type { CallOptions } from '../shared/errors.js';

/**
 * Customer port. The Customer owner is the authority for who a customer is
 * and what is on file. Identity stays provisional (a channel reference such
 * as a phone-derived ref): this port never creates, merges or promotes a
 * customer record, and an unknown reference is an answer (`null`), not an
 * error.
 *
 * The live adapter (Customer Service / Profile public API) is pending: no
 * contract for it is documented in this repository.
 */
export interface CustomerProfile {
  readonly customerRef: string;
  readonly displayName: string;
  readonly contact: { readonly email: string | null; readonly phone: string | null };
  readonly preferredCommune: string | null;
  readonly previousPurchases: readonly { readonly productId: string; readonly purchasedAt: string }[];
}

export interface CustomerDirectory {
  getContext(customerRef: string, options?: CallOptions): Promise<CustomerProfile | null>;
}
