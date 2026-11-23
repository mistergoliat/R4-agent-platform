import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArtifacts, type Pool } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, composeNextVersion, importSignedGraph, migrateGraph, readSignedGraph, runCuration, type ProductSheetPort } from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * ADR-058 G3: a curator run proposes; a person approves or rejects; compose builds the next version (unsigned) with the
 * approved changes; signing it makes it current. A rejected or applied finding is not proposed again.
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'ld:a': 'Discos', 'ld:b': 'Barras' },
  products: { P1: { n: 'Barra', act: true, price: 1, kind: 'MIXED' }, P2: { n: 'Disco', act: true, price: 1, kind: 'MIXED' } },
  view: { P1: { 'ld:a': ['P2'] }, P2: { 'ld:b': ['P1'] } },
};
// P1 renamed; P2 left the catalog.
const catalog: ProductSheetPort = {
  getProductContext(key) {
    if (key !== 'P1') return Promise.resolve({ status: 'not_found' as const });
    return Promise.resolve({ status: 'found' as const, facts: { name: 'Barra nueva', status: { active: true }, category: null, specifications: [] }, derived: { availability: { sellability: 'sellable' }, priceSummary: null } });
  },
};
const run = () => runCuration({ pool, artifacts, catalog }, { startedBy: 'oidc:owner', concurrency: 1, tailMisses: 2 });

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

describe('graph proposals (ADR-058 G3)', () => {
  it('a run proposes each finding once, with its change and effect', async () => {
    expect((await run()).proposals).toEqual({ created: 2, skipped: 0 });
    expect((await run()).proposals).toEqual({ created: 0, skipped: 2 });
    const proposed = await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed');
    expect(proposed.map((p) => [(p.evidence as { rule: string }).rule, p.change]).sort()).toEqual([
      ['DISCONTINUED', { op: 'deactivate', key: 'P2' }],
      ['RENAMED', { op: 'rename', key: 'P1', name: 'Barra nueva' }],
    ]);
    expect(proposed[0]!.evidence).toHaveProperty('effect');
  });

  it('approve one, reject the other; compose applies only the approved one and leaves the version unsigned', async () => {
    const byRule = Object.fromEntries((await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).map((p) => [(p.evidence as { rule: string }).rule, p.proposalId]));
    expect(await artifacts.decide({ kind: PRODUCT_GRAPH_KIND, proposalIds: [byRule.RENAMED!], decision: 'approved', decidedBy: 'oidc:owner', note: null, correlationId: 'd1' })).toEqual({ decided: 1, skipped: 0 });
    expect(await artifacts.decide({ kind: PRODUCT_GRAPH_KIND, proposalIds: [byRule.DISCONTINUED!, byRule.RENAMED!], decision: 'rejected', decidedBy: 'oidc:owner', note: 'sigue en bodega', correlationId: 'd2' })).toEqual({ decided: 1, skipped: 1 });

    const composed = await composeNextVersion(artifacts, { createdBy: 'oidc:owner', correlationId: 'k' });
    expect(composed).toMatchObject({ version: 2, created: true, applied: 1 });
    expect((await readSignedGraph(artifacts))!.version).toBe(1);
    expect((await artifacts.versions(PRODUCT_GRAPH_KIND)).map((v) => [v.version, v.signatures, v.current])).toEqual([[2, 0, false], [1, 1, true]]);
    expect(await composeNextVersion(artifacts, { createdBy: 'oidc:owner', correlationId: 'k2' })).toBeNull();

    await artifacts.sign({ kind: PRODUCT_GRAPH_KIND, version: 2, signedBy: 'oidc:owner', note: null, correlationId: 's' });
    const signed = (await readSignedGraph(artifacts))!;
    expect([signed.version, signed.graph.products.P1!.n, signed.graph.products.P2!.act]).toEqual([2, 'Barra nueva', true]);
    expect((await artifacts.proposals(PRODUCT_GRAPH_KIND, 'applied')).map((p) => p.appliedVersion)).toEqual([2]);
  });

  it('after signing, a new run does not bring back the rejected finding nor the applied one', async () => {
    expect((await run()).proposals).toEqual({ created: 0, skipped: 1 });
    expect(await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).toEqual([]);
    const events = (await pool.query(`select to_state, count(*)::int as n from artifact_proposal_events group by to_state order by to_state`)).rows;
    expect(events).toEqual([{ to_state: 'applied', n: 1 }, { to_state: 'approved', n: 1 }, { to_state: 'proposed', n: 2 }, { to_state: 'rejected', n: 1 }]);
  });
});
