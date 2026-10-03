import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pcCarrierLocationsSchema, pcCarrierQuoteSchema } from '@r4-adapters/shipping-http';

const ROOT = join(import.meta.dirname, '..', '..');
const PACKAGE = join(ROOT, 'adapters', 'domains', 'shipping', 'http');
const FIXTURES = join(PACKAGE, 'fixtures');

describe('R4-J2B Shipping boundary (pc-carrier adapter)', () => {
  it('every captured owner answer satisfies the wire schema R4 enforces (the fixtures are the oracle)', () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const body: unknown = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
      const schema = file === 'location.json' ? pcCarrierLocationsSchema : pcCarrierQuoteSchema;
      expect(schema.safeParse(body).success, file).toBe(true);
    }
  });

  it('the adapter depends on no R4 Core package', () => {
    for (const file of readdirSync(join(PACKAGE, 'src'))) {
      const imports = [...readFileSync(join(PACKAGE, 'src', file), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      expect(imports.filter((i) => !/^(\.\/|node:|zod$|@r4-adapters\/domains$)/.test(i)), file).toEqual([]);
    }
  });

  it('the Shipping port request carries only a commune and a basis: no carrier, service level, tax instruction, address or customer data', () => {
    const port = readFileSync(join(ROOT, 'adapters', 'domains', 'src', 'shipping', 'port.ts'), 'utf8');
    const request = /export interface ShippingQuoteRequest \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? '';
    const basis = /export type ShippingQuoteBasis =([\s\S]*?);\n/.exec(port)?.[1] ?? '';
    expect(request.replace(/\s+/g, ' ').trim()).toBe('readonly destination: { readonly commune: string }; readonly basis: ShippingQuoteBasis;');
    for (const forbidden of ['carrier', 'serviceLevel', 'tax', 'address', 'customer', 'phone', 'kilos', 'destino', 'total_boleta', 'items']) {
      expect(`${request}${basis}`.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });
});
