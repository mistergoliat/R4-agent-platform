import { AvailabilitySwitch } from '../shared/availability.js';
import type { CallOptions } from '../shared/errors.js';
import type { CustomerDirectory, CustomerProfile } from './port.js';

/** Fixture customers (fictitious people; test data only). */
export const FIXTURE_CUSTOMERS: readonly CustomerProfile[] = [
  {
    customerRef: 'cust-demo-001',
    displayName: 'Camila Rojas',
    contact: { email: 'camila.rojas@example.test', phone: '+56900000001' },
    preferredCommune: 'Ñuñoa',
    previousPurchases: [{ productId: 'KB-16', purchasedAt: '2026-03-14T15:00:00.000Z' }],
  },
  {
    customerRef: 'cust-demo-002',
    displayName: 'Diego Fuentes',
    contact: { email: null, phone: '+56900000002' },
    preferredCommune: null,
    previousPurchases: [],
  },
];

export class FixtureCustomerDirectory implements CustomerDirectory {
  /** What this implementation is, for a shadow composition's binding check (R4-H): an in-memory, deterministic owner. */
  readonly bindingKind = 'fixture' as const;
  readonly availability = new AvailabilitySwitch('customer');
  readonly #customers: Map<string, CustomerProfile>;

  constructor(customers: readonly CustomerProfile[] = FIXTURE_CUSTOMERS) {
    this.#customers = new Map(customers.map((c) => [c.customerRef, c]));
  }

  async getContext(customerRef: string, options?: CallOptions): Promise<CustomerProfile | null> {
    await this.availability.enter(options);
    return this.#customers.get(customerRef) ?? null;
  }
}
