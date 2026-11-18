import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_PURPOSES } from '@r4-adapters/domains';
import { checkoutModeOf } from '@r4-adapters/checkout-http';

/**
 * F2 tripwires (docs/architecture/R4_F2_WORK_ITEMS.md). Each one pins a fact the O-5/O-6 decision records rely on.
 * When a work item changes the fact on purpose, update the test together with the work item that authorizes it.
 */
const ROOT = join(__dirname, '..', '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(path).isDirectory() ? files(path) : /\.(ts|mjs)$/.test(name) ? [path] : [];
  });

describe('F2 purchase boundaries', () => {
  it('F2-R01: the purchase-act evidence is not wired into any profile, composition or app', () => {
    const wired = [join(ROOT, 'agents/sales/src/production'), join(ROOT, 'apps')]
      .flatMap(files)
      .concat(join(ROOT, 'agents/sales/src/composition.ts'))
      .filter((f) => /purchaseActEvidence|purchase-act/.test(readFileSync(f, 'utf8')));
    expect(wired).toEqual([]);
  }, 60_000);

  it('F2-R04: R4 does not request the CIA purpose `purchase` until H3 is published (F2-C01/C03)', () => {
    expect(CUSTOMER_PURPOSES).not.toContain('purchase');
  });

  it('F2 rule: R4 has no production Checkout mode', () => {
    expect(checkoutModeOf({ R4_CHECKOUT_MODE: 'sandbox' })).toBe('sandbox');
    for (const mode of ['production', 'live', 'real']) expect(() => checkoutModeOf({ R4_CHECKOUT_MODE: mode })).toThrow();
  });
});
