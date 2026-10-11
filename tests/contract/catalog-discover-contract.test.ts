import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CATALOG_DISCOVER_KNOWN_REVISIONS, CatalogDiscoverError, type CatalogDiscoverAnswer } from '@r4-adapters/domains';
import { catalogDiscoverAnswerSchema } from '@r4-adapters/catalog-http';
import { catalogDiscoverView } from '@r4-sales/agent';
import {
  DISCOVER_T0,
  discoverFixture,
  discoverFixtureFiles,
  discoverFixtureHash,
  discoverFixtureText,
  discoverManifest,
  fixedDiscover,
  scenarioFixture,
  type DiscoverFixture,
} from '../support/catalog-discover-contract.js';

/**
 * R4-DISCOVER-I1 — Catalog/R4 contract of catalog.discover. Every answer here was produced by
 * the OWNER (real OperationalDiscoverService, real J1 v2 owner, SYNTHETIC catalog) and is read
 * by R4's REAL HTTP adapter and consumption policy. Simulated transport: not an end-to-end test.
 */

const SENT = { need: 'x', constraints: {}, referenceProductKeys: [], selectedItemKeys: [], limit: 8, budgetFromWorkspace: null, unappliedWorkspaceBudgets: [] };

async function read(fixture: Pick<DiscoverFixture, 'http'>, now = DISCOVER_T0) {
  const { port } = fixedDiscover({ status: fixture.http.status, body: fixture.http.body });
  const answer = await port.discover({ need: 'x' });
  return { answer, view: catalogDiscoverView(answer, SENT, now) };
}

async function failure(answer: { status: number; body: unknown; headers?: Record<string, string> }): Promise<CatalogDiscoverError> {
  const { port } = fixedDiscover(answer);
  const error = await port.discover({ need: 'kettlebell' }).then(() => null, (e: unknown) => e);
  if (!(error instanceof CatalogDiscoverError)) throw new Error(`expected a CatalogDiscoverError, got ${String(error)}`);
  return error;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The wire fields these tests mutate on purpose (to break, or extend, the contract). */
type Cand = { productKey: string; disposition: string; itemKey?: string; requirements?: unknown[]; newField?: string; commercial: { price: { basis: string }; unit: { itemKey: string } } };
type Body = {
  [key: string]: unknown;
  schemaVersion?: number; status: string; contractVersion: string; warnings: string[]; degradation: unknown[];
  lineage: { contractVersion: string } | null; exactMatch: Cand | null; verified: Cand[]; possible: Cand[];
  completeness: { retrieval: string; exhaustive: boolean; counts: { rejectedByCommercialConstraints?: number } } | null;
  commercialFreshness: { observations?: unknown } | null; interpretation: { selection: { notFound: string[] } };
};
const mutable = (body: Record<string, unknown>): Body => clone(body) as unknown as Body;

describe('catalog.discover owner fixtures — provenance', () => {
  it('every file is pinned by the owner manifest, and nothing else is in the directory', () => {
    const manifest = discoverManifest();
    expect(discoverFixtureFiles()).toEqual(Object.keys(manifest.files).sort());
    for (const [file, hash] of Object.entries(manifest.files)) expect(discoverFixtureHash(discoverFixtureText(file)), file).toBe(hash);
  });

  it('records the owner, its commit and a recognized contract revision; the contract sources were committed', () => {
    const manifest = discoverManifest();
    expect(manifest).toMatchObject({ capability: 'catalog.discover', schemaVersion: 1, route: 'POST /v2/catalog/discover', owner: { repository: 'MS-pesaschile-catalog-service', contractSourcesUncommitted: false } });
    expect(manifest.owner.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(CATALOG_DISCOVER_KNOWN_REVISIONS).toContain(manifest.contractVersion);
    expect(manifest.contractRevisions).toEqual(expect.arrayContaining([...CATALOG_DISCOVER_KNOWN_REVISIONS]));
    expect(manifest.scenarios.map((s) => s.id)).toEqual(Array.from({ length: 24 }, (_v, i) => i + 1));
    expect(manifest.r4MultiTurn.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5]);
  });

  it('R4 closed enums equal the owner\'s (published JSON Schema): a new value there is a breaking change', () => {
    const owner = JSON.parse(discoverFixtureText('response.tolerant.schema.json')) as unknown;
    const ownerEnums = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        const n = node as Record<string, unknown>;
        if (Array.isArray(n.enum)) ownerEnums.add([...(n.enum as string[])].sort().join('|'));
        Object.values(n).forEach(walk);
      }
    };
    walk(owner);
    const r4 = (schema: unknown): string[] => {
      const out: string[] = [];
      const visit = (node: unknown) => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (node && typeof node === 'object') {
          const n = node as Record<string, unknown>;
          if (Array.isArray(n.enum) && n.enum.every((v) => typeof v === 'string')) out.push([...(n.enum)].sort().join('|'));
          Object.values(n).forEach(visit);
        }
      };
      visit(schema);
      return out;
    };
    // The R4 answer schema is derived as JSON Schema (zod v4) and every closed enum it enforces must be the owner's.
    // R4 enforces the 200 statuses only (FAILED never travels as 200), a subset of the owner's status enum.
    const r4Enums = new Set(r4(zodJson()));
    for (const values of r4Enums) {
      if (values === 'COMPLETE|DEGRADED|PARTIAL') expect(ownerEnums.has('COMPLETE|DEGRADED|FAILED|PARTIAL')).toBe(true);
      else expect(ownerEnums.has(values), values).toBe(true);
    }
    expect(r4Enums.size).toBeGreaterThanOrEqual(9);
  });
});

function zodJson(): unknown {
  return z.toJSONSchema(catalogDiscoverAnswerSchema, { io: 'output', unrepresentable: 'any' });
}

describe('catalog.discover — the owner\'s 24 agent scenarios read by R4', () => {
  const scenarios = discoverManifest().scenarios.map((s) => ({ ...s, fixture: discoverFixture(s.file) }));

  it.each(scenarios.filter((s) => s.fixture.http.status === 200).map((s) => [s.id, s.key, s.fixture] as const))('scenario %i (%s): parses and R4\'s reading agrees with the owner\'s consumer expectations', async (_id, _key, fixture) => {
    const { view } = await read(fixture);
    const e = fixture.ownerConsumerExpectation!;
    if (e.status) expect(view.status).toBe(e.status);
    for (const label of e.labels) expect(view.reading.labels, label).toContain(label);
    for (const label of e.notLabels) expect(view.reading.labels, label).not.toContain(label);
    for (const [product, claims] of Object.entries(e.allowed)) {
      const candidate = view.candidates.find((c) => c.productKey === product);
      expect(candidate, product).toBeDefined();
      for (const claim of claims) expect(candidate!.reading.allowedClaims, `${product} ${claim}`).toContain(claim);
    }
    for (const [product, claims] of Object.entries(e.forbidden)) {
      const candidate = view.candidates.find((c) => c.productKey === product);
      if (!candidate) continue;
      for (const claim of claims) {
        expect(candidate.reading.allowedClaims, `${product} ${claim}`).not.toContain(claim);
        if (!claim.startsWith('MEETS:')) expect(candidate.reading.forbiddenClaims, `${product} ${claim}`).toContain(claim);
      }
    }
    for (const claim of e.answerAllowed) expect(view.reading.answerAllowed).toContain(claim);
    for (const claim of e.answerForbidden.filter((c) => c === 'COMPLETE_LIST' || c === 'NONE_EXIST')) expect(view.reading.answerForbidden).toContain(claim);
    // Invariants of R4's reading on every answer.
    for (const c of view.candidates) {
      expect(c.reading.forbiddenClaims).toEqual(expect.arrayContaining(['PURCHASE_CONFIRMED', 'BEST_FOR_CUSTOMER', 'BEST_IN_CATALOG']));
      if (c.disposition === 'POSSIBLE_MATCH') expect(c.reading.presentation).toBe('POSSIBILITY_WITH_CAVEATS');
      if (c.reading.commercial !== 'CURRENT') expect(c.reading.allowedClaims.filter((x) => !x.startsWith('MEETS:'))).toEqual([]);
      for (const r of c.reading.requirements) if (r.state !== 'SATISFIED') expect(c.reading.allowedClaims).not.toContain(`MEETS:${r.code}`);
    }
    if (view.status !== 'COMPLETE' || !view.completeness.exhaustive) expect(view.reading.answerAllowed).toEqual([]);
  });

  it('scenario 22 (personal data): the owner refuses with 400; R4 surfaces INVALID_REQUEST with issue codes, never values, never "no products"', async () => {
    const fixture = scenarioFixture(22);
    expect(fixture.http.status).toBe(400);
    const error = await failure({ status: 400, body: fixture.http.body });
    expect(error).toMatchObject({ failure: 'INVALID_REQUEST', category: 'validation', retryable: false });
    expect(String(error.details.issues)).toContain('PERSONAL_DATA@need');
    expect(JSON.stringify(error.details) + error.message).not.toMatch(/ana@example|8765/);
  });

  it('every presented answer stays under 16 KB and carries no score, signal or raw evidence', () => {
    for (const s of scenarios) {
      const text = JSON.stringify(s.fixture.http.body);
      expect(text.length, s.key).toBeLessThan(16_384);
      expect(text, s.key).not.toMatch(/"(score|signals|rawValue|constraintResults|relevance)"/);
    }
  });
});

describe('catalog.discover — revision compatibility (v1b2 ↔ v1b1)', () => {
  /** A v1b2 producer: the same answer without the three v1b1 additions. */
  function asV1b2(body: Record<string, unknown>): Record<string, unknown> {
    const b = mutable(body);
    b.contractVersion = 'catalog-discover-v1b2';
    if (b.lineage) b.lineage.contractVersion = 'catalog-discover-v1b2';
    for (const c of [...(b.exactMatch ? [b.exactMatch] : []), ...b.verified, ...b.possible]) delete c.requirements;
    if (b.completeness) delete b.completeness.counts.rejectedByCommercialConstraints;
    if (b.commercialFreshness) delete b.commercialFreshness.observations;
    return b;
  }

  it('a v1b2 answer parses; VERIFIED requirements derive from the disposition, POSSIBLE ones are never satisfied', async () => {
    const verified = await read({ http: { status: 200, body: asV1b2(scenarioFixture(3).http.body) } });
    expect(verified.view.contract).toEqual({ schemaVersion: 1, contractVersion: 'catalog-discover-v1b2', recognized: true });
    const p6 = verified.view.candidates.find((c) => c.productKey === 'P6')!;
    expect(p6.reading.requirementsSource).toBe('DERIVED_FROM_DISPOSITION');
    expect(p6.reading.allowedClaims).toContain('MEETS:ANATOMY:BACK');
    const possible = await read({ http: { status: 200, body: asV1b2(scenarioFixture(16).http.body) } });
    for (const c of possible.view.candidates) expect(c.reading.allowedClaims.some((x) => x.startsWith('MEETS:'))).toBe(false);
  });

  it('v1b1 and v1b2 readings agree on every claim of every scenario (the owner verdicts match the disposition rule)', async () => {
    for (const s of discoverManifest().scenarios) {
      const fixture = discoverFixture(s.file);
      if (fixture.http.status !== 200) continue;
      const v1b1 = await read(fixture);
      const v1b2 = await read({ http: { status: 200, body: asV1b2(fixture.http.body) } });
      for (const c of v1b1.view.candidates) {
        const other = v1b2.view.candidates.find((x) => x.productKey === c.productKey)!;
        // v1b2 is never MORE permissive than the owner's explicit verdicts.
        for (const claim of other.reading.allowedClaims) expect(c.reading.allowedClaims, `${s.key} ${c.productKey} ${claim}`).toContain(claim);
      }
      expect(v1b2.view.reading.answerAllowed).toEqual(v1b1.view.reading.answerAllowed);
    }
  });

  it('an unknown revision label with schemaVersion 1 parses but is flagged unrecognized', async () => {
    const body = { ...clone(scenarioFixture(1).http.body), contractVersion: 'catalog-discover-v9' };
    expect((await read({ http: { status: 200, body } })).view.contract.recognized).toBe(false);
  });
});

describe('catalog.discover — breaking changes are refused, additive ones accepted', () => {
  const base = () => mutable(scenarioFixture(23).http.body);

  it('accepts unknown fields and unknown codes of OPEN vocabularies', async () => {
    const b = base();
    b.newTopLevel = { x: 1 };
    b.verified[0]!.newField = 'x';
    b.warnings = [...b.warnings, 'A_NEW_WARNING'];
    b.degradation = [{ component: 'NEW_COMPONENT', cause: 'NEW_CAUSE', retryable: true }];
    b.completeness!.exhaustive = false;
    b.status = 'DEGRADED';
    const { view } = await read({ http: { status: 200, body: b } });
    expect(view.degradation).toEqual([{ component: 'NEW_COMPONENT', cause: 'NEW_CAUSE', retryable: true }]);
    expect(view.reading.labels).toContain('RETRY_LATER');
  });

  it.each([
    ['schemaVersion 2', (b: Body) => { b.schemaVersion = 2; }, 'unsupported_schema_version'],
    ['schemaVersion missing', (b: Body) => { delete b.schemaVersion; }, 'unsupported_schema_version'],
    ['a FAILED answer sent as 200', (b: Body) => { b.status = 'FAILED'; }, 'failed_answer_as_200'],
    ['an unknown closed status', (b: Body) => { b.status = 'MOSTLY_DONE'; }, 'invalid_response'],
    ['an unknown disposition', (b: Body) => { b.verified[0]!.disposition = 'LIKELY_MATCH'; }, 'invalid_response'],
    ['an unknown price basis', (b: Body) => { b.verified.find((c) => c.productKey === 'P7')!.commercial.price.basis = 'maybe'; }, 'invalid_response'],
    ['a REJECTED candidate presented', (b: Body) => { b.verified[0]!.disposition = 'REJECTED'; }, 'invalid_response'],
    ['unit facts of another itemKey', (b: Body) => { b.verified.find((c) => c.productKey === 'P7')!.commercial.unit.itemKey = 'P7-V1'; }, 'invalid_response'],
    ['exhaustive although truncated', (b: Body) => { b.completeness!.retrieval = 'TRUNCATED'; b.completeness!.exhaustive = true; }, 'invalid_response'],
    ['requirements out of order', (b: Body) => { b.verified[0]!.requirements = [...b.verified[0]!.requirements!].reverse(); }, 'invalid_response'],
    ['a POSSIBLE in verified', (b: Body) => { b.verified[0]!.disposition = 'POSSIBLE_MATCH'; }, 'invalid_response'],
    ['not JSON', null, 'unparseable_response'],
  ] as const)('refuses %s as CONTRACT_VIOLATION', async (_name, mutate, code) => {
    const b = base();
    if (mutate) mutate(b);
    const error = await failure({ status: 200, body: mutate ? b : '{not json' });
    expect(error).toMatchObject({ failure: 'CONTRACT_VIOLATION', category: 'contract_violation', code, retryable: false });
  });

  it('a selected itemKey the owner proved absent is never echoed as the candidate unit', async () => {
    const b = mutable(scenarioFixture(10).http.body);
    expect(b.interpretation.selection.notFound).toEqual(['P5-V99']);
    expect((await read({ http: { status: 200, body: b } })).view.candidates.every((c) => c.itemKey !== 'P5-V99')).toBe(true);
    b.verified[0]!.itemKey = 'P5-V99';
    expect((await failure({ status: 200, body: b })).failure).toBe('CONTRACT_VIOLATION');
  });
});

describe('catalog.discover — owner error matrix → R4 typed failures', () => {
  const matrix = discoverFixture('http-error-matrix.json') as unknown as {
    failure: Record<string, { status: number; code: string; retryable: boolean }>;
    rejection: Record<string, { status: number; code: string; retryable: boolean }>;
    boundary: Record<string, { status: number; code: string }>;
  };
  const EXPECTED: Record<string, string> = {
    invalid_request: 'INVALID_REQUEST', unsupported_schema_version: 'INVALID_REQUEST', contradictory_constraints: 'INVALID_REQUEST',
    capability_not_ready: 'NOT_READY', index_incompatible: 'NOT_READY', internal_error: 'SERVICE_ERROR',
    capability_disabled: 'DISABLED', capability_saturated: 'SATURATED', capability_shutting_down: 'NOT_READY', request_cancelled: 'NOT_READY',
    unauthorized: 'AUTH_FAILED', forbidden: 'AUTH_FAILED', payload_too_large: 'INVALID_REQUEST', unsupported_media_type: 'INVALID_REQUEST', rate_limited: 'RATE_LIMITED', contract_output_invalid: 'SERVICE_ERROR',
  };

  it.each([...Object.values(matrix.failure), ...Object.values(matrix.rejection)].map((e) => [e.code, e] as const))('%s keeps the owner\'s status meaning and retryability', async (code, entry) => {
    const error = await failure({ status: entry.status, body: { error: { code, message: 'm', correlationId: 'c', retryable: entry.retryable } }, ...(code === 'capability_saturated' ? { headers: { 'retry-after': '1' } } : {}) });
    expect(error.failure).toBe(EXPECTED[code]);
    expect(error.retryable).toBe(entry.retryable);
    expect(error.details.httpStatus).toBe(entry.status);
    if (code === 'capability_saturated') expect(error.details.retryAfterSeconds).toBe(1);
  });

  it.each(Object.values(matrix.boundary).map((e) => [e.code, e] as const))('boundary %s maps to a typed failure, never to an empty result', async (code, entry) => {
    const error = await failure({ status: entry.status, body: { error: { code, message: 'm', correlationId: 'c' } } });
    expect(error.failure).toBe(EXPECTED[code]);
    expect(error.retryable).toBe(code === 'rate_limited');
  });

  it('a 200 DEGRADED answer is an answer, not an error (commercial truth down: prices UNKNOWN, no current-price claim)', async () => {
    const { answer, view } = await read(scenarioFixture(13));
    expect(answer.status).toBe('DEGRADED');
    expect(view.reading.labels).toEqual(expect.arrayContaining(['COMMERCIAL_TRUTH_DEGRADED', 'RETRY_LATER', 'CANNOT_ASSERT_NO_PRODUCTS_EXIST']));
    for (const c of view.candidates) expect(c.commercial.status).toBe('UNKNOWN');
    expect(view.reading.answerAllowed).toEqual([]);
  });
});

export type { CatalogDiscoverAnswer };
