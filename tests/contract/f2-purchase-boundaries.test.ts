import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_PURPOSES } from '@r4-adapters/domains';
import { checkoutModeOf } from '@r4-adapters/checkout-http';

/**
 * F2 tripwires (docs/architecture/R4_F2_WORK_ITEMS.md). Each one pins a fact the approved O-5/O-6 records rely on.
 * When a work item changes the fact on purpose, update the test together with the work item that authorizes it.
 */
const ROOT = join(__dirname, '..', '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(path).isDirectory() ? files(path) : /\.(ts|mjs)$/.test(name) ? [path] : [];
  });
const rel = (f: string) => f.slice(ROOT.length + 1).replaceAll('\\', '/');
/** Everything that composes or runs a production profile: the profiles, both compositions, the operator CLIs and every app. */
const PRODUCTION = () => [
  ...files(join(ROOT, 'agents/sales/src/production')),
  ...files(join(ROOT, 'agents/sales/src/cli')),
  ...files(join(ROOT, 'apps')),
  join(ROOT, 'agents/sales/src/composition.ts'),
];

describe('F2 purchase boundaries', () => {
  it('F2-R01/R02: no production profile, composition, CLI or app enables or calls the purchase-act recording', () => {
    const wired = PRODUCTION().filter((f) => /purchaseActRecording|purchaseActEvidence|purchase-act|recordCheckoutPurchaseRequestWithAct/.test(readFileSync(f, 'utf8')));
    expect(wired.map(rel)).toEqual([]);
  }, 60_000);

  it('F2-R02: only checkout.start_purchase records an act, and only when the flag is exactly true', () => {
    const callers = [...files(join(ROOT, 'agents')), ...files(join(ROOT, 'apps')), ...files(join(ROOT, 'adapters'))]
      .filter((f) => !rel(f).endsWith('workspace/store.ts'))
      .filter((f) => /recordCheckoutPurchaseRequestWithAct\(/.test(readFileSync(f, 'utf8')));
    expect(callers.map(rel)).toEqual(['agents/sales/src/capabilities/checkout.ts']);
    expect(readFileSync(join(ROOT, 'agents/sales/src/capabilities/checkout.ts'), 'utf8')).toContain('deps.purchaseActRecording === true ? purchaseActEvidence(');
  }, 60_000);

  it('F2-R03: nothing in R4 supplies a customer access grant to Checkout yet (no grant source exists)', () => {
    // A supplier SETS the field (`customerAccessGrant: …`); the port only declares it optional and the client only reads it.
    const suppliers = [...files(join(ROOT, 'agents')), ...files(join(ROOT, 'apps')), ...files(join(ROOT, 'adapters'))].filter((f) => /customerAccessGrant\s*:/.test(readFileSync(f, 'utf8')));
    expect(suppliers.map(rel)).toEqual([]);
  }, 60_000);

  it('F2-R04: R4 does not request the CIA purpose `purchase` until H3 is published (F2-C01/C03)', () => {
    expect(CUSTOMER_PURPOSES).not.toContain('purchase');
  });

  it('F2 rule: R4 has no production Checkout mode', () => {
    expect(checkoutModeOf({ R4_CHECKOUT_MODE: 'sandbox' })).toBe('sandbox');
    for (const mode of ['production', 'live', 'real']) expect(() => checkoutModeOf({ R4_CHECKOUT_MODE: mode })).toThrow();
  });
});
