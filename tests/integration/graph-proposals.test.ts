import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArtifacts, type Pool } from '@r4/persistence-postgres';
import { AUTO_ACTOR, PRODUCT_GRAPH_KIND, composeNextVersion, importSignedGraph, migrateGraph, readSignedGraph, runCuration, undoChange, type ProductSheetPort } from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * ADR-058 G3 + Decision 9: mechanical changes apply and publish themselves (and can be undone, never to come back);
 * judgment changes wait for a person; a version built on an old base cannot be signed; notices follow the curator.
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'ld:a': 'Discos', 'ld:b': 'Barras' },
  products: { P1: { n: 'Barra', act: true, price: 1, kind: 'MIXED' }, P2: { n: 'Disco', act: true, price: 1, kind: 'MIXED' }, P3: { n: 'Disco 2', act: true, price: 1, kind: 'MIXED' } },
  view: { P1: { 'ld:a': ['P2', 'P3'] }, P2: { 'ld:b': ['P1'] }, P3: { 'ld:b': ['P1'] } },
};
// The catalog as each test sets it: P1 by name, P2 present or gone, P3 always there.
const sheets: { p1: string; p2: boolean } = { p1: 'Barra nueva', p2: false };
const catalog: ProductSheetPort = {
  getProductContext(key) {
    const name = key === 'P1' ? sheets.p1 : key === 'P2' && sheets.p2 ? 'Disco' : key === 'P3' ? 'Disco 2' : null;
    if (!name) return Promise.resolve({ status: 'not_found' as const });
    return Promise.resolve({ status: 'found' as const, facts: { name, status: { active: true }, category: null, specifications: [] }, derived: { availability: { sellability: 'sellable' }, priceSummary: null } });
  },
};
const run = () => runCuration({ pool, artifacts, catalog }, { startedBy: 'oidc:owner', concurrency: 1, tailMisses: 2 });
const byRule = async (rule: string, state: 'proposed' | 'applied' | 'undone' | 'approved') => (await artifacts.proposals(PRODUCT_GRAPH_KIND, state)).filter((p) => (p.evidence as { rule?: string }).rule === rule);

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  artifacts = new PostgresArtifacts(pool);
  await migrateGraph(pool);
  await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [], signedBy: 'oidc:owner', note: null, correlationId: 'c' });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('graph proposals (ADR-058 G3, Decision 9)', () => {
  it('mechanical changes (rename, discontinued) approve, build and publish themselves', async () => {
    const result = await run();
    expect(result.automatic).toEqual({ approved: 2, version: 2, applied: 2 });
    const signed = (await readSignedGraph(artifacts))!;
    expect([signed.version, signed.signedBy, signed.graph.products.P1!.n, signed.graph.products.P2!.act, signed.graph.view.P2]).toEqual([2, AUTO_ACTOR, 'Barra nueva', false, undefined]);
    expect((await artifacts.proposals(PRODUCT_GRAPH_KIND, 'applied')).map((p) => [p.decidedBy, p.appliedVersion])).toEqual([[AUTO_ACTOR, 2], [AUTO_ACTOR, 2]]);
    expect((await run()).automatic).toEqual({ approved: 0, version: null, applied: 0 });
  });

  it('undo puts the product back as the base version had it, and the curator never re-applies it', async () => {
    const [discontinued] = await byRule('DISCONTINUED', 'applied');
    const undone = await undoChange(artifacts, { proposalId: discontinued!.proposalId, undoneBy: 'oidc:owner', correlationId: 'u' });
    const signed = (await readSignedGraph(artifacts))!;
    expect([signed.version, undone.version, signed.signedBy, signed.graph.products.P2!.act, signed.graph.view.P2, signed.graph.products.P1!.n]).toEqual([3, 3, 'oidc:owner', true, { 'ld:b': ['P1'] }, 'Barra nueva']);
    expect((await byRule('DISCONTINUED', 'undone')).length).toBe(1);
    // P2 is still out of the catalog: the run finds it again, but the undone change stays undone.
    const again = await run();
    expect(again.automatic).toEqual({ approved: 0, version: null, applied: 0 });
    expect(again.proposals).toMatchObject({ created: 0, skipped: 1 });
    expect((await readSignedGraph(artifacts))!.version).toBe(3);
  });

  it('a version built on an old base cannot be signed: it is built again with what was published since', async () => {
    // A judgment change the owner approves and builds…
    await artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: 3, source: 'graph-curator:manual', correlationId: 'm', proposals: [{ fingerprint: 'inconsistency|SUBSTITUTE_KIND_MISMATCH|P1|P3', summary: 'quitar', evidence: { rule: 'SUBSTITUTE_KIND_MISMATCH' }, change: { op: 'remove_relation', area: 'ld', a: 'P1', b: 'P3' } }] });
    const [manual] = await byRule('SUBSTITUTE_KIND_MISMATCH', 'proposed');
    await artifacts.decide({ kind: PRODUCT_GRAPH_KIND, proposalIds: [manual!.proposalId], decision: 'approved', decidedBy: 'oidc:owner', note: null, correlationId: 'd' });
    const built = (await composeNextVersion(artifacts, { createdBy: 'oidc:owner' }))!;
    expect(built).toMatchObject({ version: 4, includes: 1 });
    // …while the curator publishes an automatic rename on top of v3.
    sheets.p1 = 'Barra renovada';
    expect((await run()).automatic).toMatchObject({ approved: 1, applied: 1, version: 5 });
    await expect(artifacts.sign({ kind: PRODUCT_GRAPH_KIND, version: 4, signedBy: 'oidc:owner', note: null, correlationId: 's' })).rejects.toMatchObject({ code: 'stale_base' });
    expect((await artifacts.versions(PRODUCT_GRAPH_KIND)).find((v) => v.version === 4)).toMatchObject({ stale: true, signatures: 0 });
    // The approved change was never applied (v4 was not signed): building again includes it on top of v5.
    const rebuilt = (await composeNextVersion(artifacts, { createdBy: 'oidc:owner' }))!;
    expect(await artifacts.sign({ kind: PRODUCT_GRAPH_KIND, version: rebuilt.version, signedBy: 'oidc:owner', note: null, correlationId: 's2' })).toMatchObject({ applied: 1 });
    const signed = (await readSignedGraph(artifacts))!;
    expect([signed.graph.products.P1!.n, signed.graph.view.P1]).toEqual(['Barra renovada', { 'ld:a': ['P2'] }]);
  });

  it('a notice still found reopens after «visto»; what a run no longer finds closes by itself and can come back', async () => {
    const kind = PRODUCT_GRAPH_KIND;
    const notice = { fingerprint: 'missing_data|SPEC_MISSING|P1|', summary: 'falta Perfiles', evidence: {}, change: null };
    const change = { fingerprint: 'inconsistency|X|P1|P2', summary: 'quitar', evidence: {}, change: { op: 'remove_relation', area: 'ld', a: 'P1', b: 'P2' } };
    const propose = (items: (typeof notice | typeof change)[]) => artifacts.propose({ kind, baseVersion: 2, source: 'graph-curator:t', correlationId: 't', proposals: items });
    expect(await propose([notice, change])).toMatchObject({ created: 2 });
    const ids = (await artifacts.proposals(kind, 'proposed')).filter((p) => p.source === 'graph-curator:t').map((p) => p.proposalId);
    await artifacts.decide({ kind, proposalIds: ids, decision: 'rejected', decidedBy: 'oidc:owner', note: null, correlationId: 'r' });
    expect(await propose([notice, change])).toEqual({ created: 0, refreshed: 0, reopened: 1, skipped: 1 });
    expect(await artifacts.resolveUnseen({ kind, sourcePrefix: 'graph-curator:t', seenFingerprints: [], resolvedBy: 'graph-curator:t2', correlationId: 'u' })).toEqual({ resolved: 1 });
    expect((await artifacts.proposals(kind, 'resolved')).map((p) => p.fingerprint)).toContain(notice.fingerprint);
    expect(await propose([notice])).toMatchObject({ created: 1 });
  });
});
