import { FixtureCatalog } from './catalog/fixture.js';
import { FixtureCustomerDirectory } from './customer/fixture.js';
import { FixtureQuoteService } from './quote/fixture.js';
import { FixtureShipping } from './shipping/fixture.js';

/** The four fixture owners wired to each other the way the real owners would be. */
export interface FixtureDomains {
  readonly customers: FixtureCustomerDirectory;
  readonly catalog: FixtureCatalog;
  readonly shipping: FixtureShipping;
  readonly quotes: FixtureQuoteService;
}

export function createFixtureDomains(options: { now?: () => Date } = {}): FixtureDomains {
  const now = options.now ?? (() => new Date());
  const catalog = new FixtureCatalog({ now });
  const shipping = new FixtureShipping({ now });
  return { customers: new FixtureCustomerDirectory(), catalog, shipping, quotes: new FixtureQuoteService({ catalog, shipping, now }) };
}
