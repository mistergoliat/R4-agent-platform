import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArtifacts, type Pool } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, importSignedGraph, migrateGraph, readSignedGraph, runCuration, undoChange, type ProductSheetPort } from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * ADR-058 Decision 9 fix: a product the store deactivates loses its relations automatically; when the store reactivates
 * it, it gets them back automatically (except those with products still inactive), and «Deshacer» reverts that whole.
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'nu:a': 'Se usa con', 'nu:b': 'Complementos' },
  products: {
    P1: { n: 'Rodilleras', act: true, price: 1, kind: 'MIXED' }, P2: { n: 'Rack A', act: true, price: 1, kind: 'MIXED' },
    P3: { n: 'Rack B', act: true, price: 1, kind: 'MIXED' }, P4: { n: 'Rack C', act: true, price: 1, kind: 'MIXED' },
  },
  view: { P1: { 'nu:a': ['P2', 'P3', 'P4'] }, P2: { 'nu:b': ['P1'] }, P3: { 'nu:b': ['P1'] }, P4: { 'nu:b': ['P1'] } },
};
// Which products the store has active right now.
const active = new Set(['P1', 'P2', 'P3', 'P4']);
const catalog: ProductSheetPort = {
  getProductContext(key) {
    if (!['P1', 'P2', 'P3', 'P4'].includes(key)) return Promise.resolve({ status: 'not_found' as const });
    return Promise.resolve({ status: 'found' as const, facts: { name: GRAPH.products[key as 'P1'].n, status: { active: active.has(key) }, category: null, specifications: [] }, derived: { availability: { sellability: active.has(key) ? 'sellable' : 'not_sellable' }, priceSummary: null } });
  },
};
const run = () => runCuration({ pool, artifacts, catalog }, { startedBy: 'oidc:owner', concurrency: 1, tailMisses: 2 });
const current = async () => (await readSignedGraph(artifacts))!.graph;

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

describe('reactivation restores relations (ADR-058 D9 fix)', () => {
  it('deactivated: loses its relations; reactivated: gets back those with products still active', async () => {
    active.delete('P1'); // the knee sleeves are disabled in the store…
    active.delete('P4'); // …and so is one of the racks
    expect((await run()).automatic).toMatchObject({ applied: 3 }); // P1 discontinued + inactive with relations, P4 discontinued
    let g = await current();
    expect([g.products.P1!.act, g.view.P1, g.view.P2]).toEqual([false, undefined, undefined]);

    active.add('P1'); // the store enables the knee sleeves again; rack C stays disabled
    const back = await run();
    expect(back.automatic).toMatchObject({ applied: 1 });
    g = await current();
    expect([g.products.P1!.act, g.view.P1, g.view.P2, g.view.P4]).toEqual([true, { 'nu:a': ['P2', 'P3'] }, { 'nu:b': ['P1'] }, undefined]);
    const [reactivated] = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'applied')).filter((p) => (p.evidence as { rule?: string }).rule === 'REACTIVATED');
    expect(reactivated!.summary).toMatch(/recupera 2 relaciones/u);
  });

  it('«Deshacer» reverts the whole reactivation', async () => {
    const [reactivated] = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'applied')).filter((p) => (p.evidence as { rule?: string }).rule === 'REACTIVATED');
    await undoChange(artifacts, { proposalId: reactivated!.proposalId, undoneBy: 'oidc:owner', correlationId: 'u' });
    const g = await current();
    expect([g.products.P1!.act, g.view.P1]).toEqual([false, undefined]);
  });
});
