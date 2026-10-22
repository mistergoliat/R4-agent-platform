import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainError, type CustomerPurchasePage, type CustomerSalesContext } from '@r4-adapters/domains';
import { CUSTOMER_PROFILE_ROUTE, pinnedContract } from '@r4-adapters/customer-http';
import { answer, byId, clientWith, CONTRACT, FIXTURES, fixture, fixtureFiles, fixtureText, get, grantFor, MANIFEST, PACKAGE, ROOT } from '../unit/customer-profile/support.js';

// R4-J4-R2 contract tests: the Customer Profile adapter against the owner's v1-rc1 artifacts,
// copied byte for byte from MS-pesaschile-customer-profile at 47db415 (tag cp-sales-context-v1-rc1).
// These are CONTRACT tests over fixtures: they do not prove end-to-end interoperability.

type SourceEntry = { file: string; ownerPath: string; gitBlob: string; sha256: string; contentSha256: string };
const SOURCE = JSON.parse(readFileSync(join(CONTRACT, 'SOURCE.json'), 'utf8')) as { ownerCommit: string; ownerTag: { name: string; object: string }; revision: string; files: SourceEntry[] };
const lf = (path: string) => Buffer.from(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const contentHash = (text: string) => sha256(JSON.stringify(JSON.parse(text)));

describe('pinned owner artifacts (provenance)', () => {
  it('records the owner commit, tag and revision', () => {
    expect(SOURCE.ownerCommit).toBe('47db415e1ebf67b5e6770dbdcfc697880b6e5f76');
    expect(SOURCE.ownerTag).toEqual({ name: 'cp-sales-context-v1-rc1', object: '0a5ac6718d3df4900afe86b732c00bf1e1421440' });
    expect(SOURCE.revision).toBe('v1-rc1');
  });

  it('every copied file is byte-identical to the owner blob it records (34 fixtures, MANIFEST, 2 schemas, owner SOURCE.json)', () => {
    const copied = [...fixtureFiles().map((file) => `fixtures/${file}`), ...readdirSync(CONTRACT).filter((file) => file !== 'SOURCE.json').map((file) => `contract/${file}`)].sort();
    expect(SOURCE.files.map((entry) => entry.file).sort()).toEqual(copied);
    expect(copied).toHaveLength(38);
    for (const entry of SOURCE.files) {
      const bytes = lf(join(PACKAGE, entry.file));
      expect(sha256(bytes), entry.file).toBe(entry.sha256);
      expect(contentHash(bytes.toString('utf8')), entry.file).toBe(entry.contentSha256);
      // The git blob id of the owner object (sha1 over "blob <len>\0" + bytes).
      expect(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest('hex'), entry.file).toBe(entry.gitBlob);
    }
  });

  it('the owner MANIFEST and the owner SOURCE.json agree with the copies (hashes of fixtures, schemas and manifest)', () => {
    for (const entry of MANIFEST.fixtures) expect(contentHash(fixtureText(entry.file)), entry.file).toBe(entry.sha256);
    const owner = JSON.parse(readFileSync(join(CONTRACT, 'owner-SOURCE.json'), 'utf8')) as { schemas: { response: { sha256: string }; request: { sha256: string } }; manifestSha256: string };
    expect(contentHash(readFileSync(join(CONTRACT, 'customer-sales-context-v1.schema.json'), 'utf8'))).toBe(owner.schemas.response.sha256);
    expect(contentHash(readFileSync(join(CONTRACT, 'customer-sales-context-request-v1.schema.json'), 'utf8'))).toBe(owner.schemas.request.sha256);
    expect(contentHash(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8'))).toBe(owner.manifestSha256);
  });

  it('R4-J4-R3: the runtime loads the pinned v1-rc2 schemas (hash-checked) and both v1-rc1 request fixtures still validate', () => {
    const contract = pinnedContract();
    expect(contract).toMatchObject({ ownerCommit: 'bbd766ef4b32c0ceb1065f9b7791f63f46798ef9', revision: 'v1-rc2' });
    for (const file of ['request-sales-context.json', 'request-purchase-history.json']) expect(contract.validateRequest(fixture(file)), file).toBe(true);
  });
});

type Expected = { kind: 'context'; value: CustomerSalesContext } | { kind: 'page'; value: CustomerPurchasePage } | { kind: 'error'; category: string; code: string; ownerCode?: string };
const VU = '2026-10-15T12:15:00.000Z';
const item = (productName: string | null, lastPurchasedOn: string, totalQuantity: number, orderCount: number, lineKind = 'standard') => ({ productName, catalogKey: null, lastPurchasedOn, totalQuantity, orderCount, lineKind });
const page = (items: ReturnType<typeof item>[], extra: Partial<{ hasMore: boolean; nextOffset: number | null; datePrecision: string }> = {}) =>
  ({ kind: 'page', value: { status: 'available', items, offset: 0, hasMore: false, nextOffset: null, datePrecision: 'day_timezone_unverified', validUntil: VU, ...extra } }) as Expected;
const NORMAL = [item('Rack sintetico', '2026-09-28', 1, 1), item('Disco sintetico 10 kg - Color : Rojo', '2026-03-14', 4, 2), item('Barra olimpica sintetica 20 kg', '2025-11-03', 1, 1)];

/** What the port answers for every owner response fixture (specification §5, §7). */
const EXPECTED: Record<string, Expected> = {
  SC01: { kind: 'context', value: { status: 'available', purchaseHistory: 'present', validUntil: VU } },
  SC02: { kind: 'context', value: { status: 'available', purchaseHistory: 'none', validUntil: VU } },
  SC03: { kind: 'context', value: { status: 'available', purchaseHistory: 'unknown', validUntil: VU } },
  SC04: { kind: 'context', value: { status: 'not_found', validUntil: VU } },
  SC05: { kind: 'context', value: { status: 'withheld', validUntil: VU } },
  SC06: { kind: 'context', value: { status: 'withheld', validUntil: VU } },
  SC07: { kind: 'context', value: { status: 'withheld', validUntil: VU } },
  SC08: { kind: 'context', value: { status: 'withheld', validUntil: VU } },
  SC09: { kind: 'error', category: 'temporarily_unavailable', code: 'profile_unavailable', ownerCode: 'prestashop_unavailable' },
  PH01: page(NORMAL),
  PH02: page([]),
  PH03: page([item(null, '2026-02-10', 3, 1)]),
  PH04: page([item('Regalo sintetico', '2026-08-15', 1, 1, 'zero_price_line'), item('Banda sintetica', '2026-08-15', 0, 1)]),
  PH05: page([item('Disco sintetico 10 kg - Color : Negro', '2025-06-01', 1, 1), item('Servicio vendedor', '2025-06-01', 1, 1, 'administrative_service')]),
  PH06: page([item('Producto descontinuado sintetico', '2026-01-01', 1, 1)]),
  PH07: page([item('Muñequera sintetica', '2026-01-01', 1, 1)], { datePrecision: 'day' }),
  PH08: page(NORMAL.slice(0, 2), { hasMore: true, nextOffset: 2 }),
  PH09: { kind: 'error', category: 'temporarily_unavailable', code: 'history_unavailable' },
  PH10: { kind: 'page', value: { status: 'not_found', validUntil: VU } },
  PH11: { kind: 'page', value: { status: 'withheld', validUntil: VU } },
  PH12: { kind: 'page', value: { status: 'withheld', validUntil: VU } },
  PH13: { kind: 'error', category: 'temporarily_unavailable', code: 'profile_unavailable', ownerCode: 'prestashop_timeout' },
};

async function run(id: string) {
  const entry = byId(id);
  const body = fixture(entry.file);
  const { client, calls } = clientWith(() => answer(entry.httpStatus!, body));
  const requested = (get(body, 'facts.purchasedProducts.page') as { limit: number; offset: number } | null | undefined) ?? { limit: 10, offset: 0 };
  const customerRef = body.customerRef as string;
  const call = entry.purpose === 'sales_context'
    ? client.getSalesContext(customerRef, grantFor())
    : client.getPurchaseHistory(customerRef, grantFor(), { limit: requested.limit, offset: requested.offset });
  const result = await call.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  return { result, calls };
}

describe('every owner response fixture maps to the port (C: fixtures pinned at 47db415)', () => {
  it('covers the 22 response fixtures of the MANIFEST', () => {
    expect(MANIFEST.fixtures.filter((entry) => entry.kind === 'response').map((entry) => entry.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s', async (id, expected) => {
    const { result, calls } = await run(id);
    expect(calls).toHaveLength(1);
    if (expected.kind === 'error') {
      expect(result.ok).toBe(false);
      const error = (result as { error: DomainError }).error;
      expect(error).toBeInstanceOf(DomainError);
      expect({ category: error.category, code: error.code }).toEqual({ category: expected.category, code: expected.code });
      if (expected.ownerCode) expect(error.details.ownerCode).toBe(expected.ownerCode);
    } else {
      expect(result).toEqual({ ok: true, value: expected.value });
    }
  });
});

describe('every owner error fixture maps to a DomainError category (specification §9)', () => {
  const ERRORS: Record<string, { category: string; code: string }> = {
    E01: { category: 'validation', code: 'invalid_customer_ref' },
    E02: { category: 'validation', code: 'invalid_purpose' },
    E03: { category: 'unauthorized', code: 'profile_unauthorized' },
    E04: { category: 'unauthorized', code: 'profile_unauthorized' },
    E05: { category: 'unauthorized', code: 'profile_unauthorized' },
    E06: { category: 'contract_violation', code: 'unexpected_status' },
    E07: { category: 'validation', code: 'request_too_large' },
    E08: { category: 'validation', code: 'unsupported_media_type' },
    E09: { category: 'temporarily_unavailable', code: 'internal_error' },
    E10: { category: 'temporarily_unavailable', code: 'request_budget_exceeded' },
  };

  it('covers the 10 error fixtures', () => {
    expect(MANIFEST.fixtures.filter((entry) => entry.kind === 'error').map((entry) => entry.id).sort()).toEqual(Object.keys(ERRORS).sort());
  });

  it.each(Object.entries(ERRORS))('%s', async (id, expected) => {
    const entry = byId(id);
    const { client } = clientWith(() => answer(entry.httpStatus!, fixture(entry.file)));
    const error = await client.getSalesContext('prestashop_customer:900000201', grantFor()).catch((caught: unknown) => caught as DomainError);
    expect(error).toBeInstanceOf(DomainError);
    expect({ category: (error as DomainError).category, code: (error as DomainError).code }).toEqual(expected);
    // 401 and 403 are never not_found nor unavailable (I5); requiredScope is a diagnostic only.
    if (id === 'E04') expect((error as DomainError).details.requiredScope).toBe('customer.sales_context.read');
    if (id === 'E05') expect((error as DomainError).details.requiredScope).toBeNull();
  });
});

describe('package boundaries', () => {
  const sources = readdirSync(join(PACKAGE, 'src')).map((file) => ({ file, text: readFileSync(join(PACKAGE, 'src', file), 'utf8') }));

  it('the adapter depends on no R4 Core package: only node:, ajv, ajv-formats, the domain ports and its own files', () => {
    for (const { file, text } of sources) {
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      expect(imports.filter((specifier) => !/^(\.\/[\w-]+\.js|node:[\w/]+|ajv\/dist\/2020\.js|ajv-formats|@r4-adapters\/domains)$/.test(specifier)), file).toEqual([]);
    }
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(manifest.dependencies).toEqual({ '@r4-adapters/domains': '*', ajv: '8.20.0', 'ajv-formats': '3.0.1' });
  });

  it('calls exactly one route, the sales-context capability (no predictive, PII or v1 customer routes: I12)', () => {
    const all = sources.map((source) => source.text).join('\n');
    expect(CUSTOMER_PROFILE_ROUTE).toBe('/v1/capabilities/customer/sales-context');
    expect([...all.matchAll(/'\/v1\/[^']*'/g)].map((match) => match[0])).toEqual(["'/v1/capabilities/customer/sales-context'"]);
    expect(all).not.toMatch(/\/v1\/customers|\/rfm|\/cluster|\/clv|\/affinity|\/intelligence|commercial-profile|\/profile'/);
  });

  // R4-J4-R3 (R3.5): the readers are now used by the capability registrations (customer-v2.ts) and their
  // only composition, the synthetic one (customer-synthetic.ts). Nothing else in Sales may reach them:
  // no production profile, CLI, bootstrap, composition root or agent definition (J4-R4 is not authorized).
  // SEC-S6: the RR-1 versions (customer-v3.ts: get_context@3, get_purchase_history@2) are under the same rule.
  it('no Sales profile, registry or definition binds the adapters or the boundary-C readers (J4-R4 is not authorized)', () => {
    const salesFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? salesFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') || entry.name.endsWith('.json') ? [join(dir, entry.name)] : []));
    const users = salesFiles(join(ROOT, 'agents', 'sales'))
      .filter((file) => !file.includes('node_modules') && !file.includes(`${join('agents', 'sales', 'dist')}`))
      .filter((file) => /customer-http|identity-http|customer-profile-outputs|customer-v2|customer-v3|customer-synthetic|customerContextV3Capability|customerPurchaseHistoryV2Capability|readCustomerContextV2|readCustomerPurchaseHistoryV1|get_purchase_history/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));
    expect(users.sort()).toEqual([
      'agents/sales/package.json',
      'agents/sales/src/capabilities/customer-profile-outputs.ts',
      'agents/sales/src/capabilities/customer-synthetic.ts',
      'agents/sales/src/capabilities/customer-v2.ts',
      'agents/sales/src/capabilities/customer-v3.ts',
      // SEC-S5: the identity verification capabilities (CIA start client types), synthetic composition only.
      'agents/sales/src/capabilities/identity-verification.ts',
    ]);
  });
});
