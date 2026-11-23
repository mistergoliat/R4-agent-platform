import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArtifacts, type Pool } from '@r4/persistence-postgres';
import { importSignedGraph, migrateGraph, runCuration, type ProductSheetPort } from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/** ADR-058 G2: an on-demand curator run over the signed graph and the catalog, stored with its findings. */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'ld:a': 'Discos', 'ld:b': 'Barras' },
  products: { P1: { n: 'Barra', act: true, price: 1, kind: 'OLY_BAR' }, P2: { n: 'Disco', act: true, price: 1, kind: 'PLATE_OLY' } },
  view: { P1: { 'ld:a': ['P2'] }, P2: { 'ld:b': ['P1'] } },
};
const sheets = (over: Record<string, 'missing' | 'fail'> = {}): ProductSheetPort => ({
  getProductContext(key) {
    if (over[key] === 'fail') return Promise.reject(new Error('catalog down'));
    if (!['P1', 'P2', 'P3'].includes(key) || over[key] === 'missing') return Promise.resolve({ status: 'not_found' as const });
    return Promise.resolve({ status: 'found' as const, facts: { name: `Producto ${key}`, status: { active: true }, category: null, specifications: [] }, derived: { availability: { sellability: 'sellable' }, priceSummary: null } });
  },
});

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  artifacts = new PostgresArtifacts(pool);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('graph curation runs (ADR-058 G2)', () => {
  it('refuses before its schema is migrated, and without a signed graph', async () => {
    await expect(runCuration({ pool, artifacts, catalog: sheets() }, { startedBy: 'oidc:owner' })).rejects.toThrow(/graph:migrate/u);
    expect(await migrateGraph(pool)).toEqual({ applied: ['0024_graph_curation'] });
    await expect(runCuration({ pool, artifacts, catalog: sheets() }, { startedBy: 'oidc:owner' })).rejects.toThrow(/no signed product graph/u);
  });

  it('stores a completed run with its findings (immutable), never touching the signed graph', async () => {
    await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [], signedBy: 'oidc:owner', note: null, correlationId: 'c-1' });
    const result = await runCuration({ pool, artifacts, catalog: sheets({ P2: 'missing' }) }, { startedBy: 'oidc:owner', concurrency: 1, tailMisses: 3 });
    expect(result).toMatchObject({ status: 'completed', graphVersion: 1, catalog: { scanned: 6, found: 2, notFound: 4, failed: 0 } });
    // P1 renamed and lacks its bar data; P2 left the catalog; P3 is new.
    expect(result.counts).toEqual({ new_or_changed: { DISCONTINUED: 1, NOT_IN_GRAPH: 1, RENAMED: 1 }, missing_data: { SET_MUSCLES: 1, SPEC_MISSING: 1 } });
    const rows = (await pool.query(`select rule, product_key, fingerprint, evidence from graph.curation_findings where run_id = $1 order by rule, product_key`, [result.runId])).rows;
    expect(rows.map((r) => `${r.rule} ${r.product_key}`)).toEqual(['DISCONTINUED P2', 'NOT_IN_GRAPH P3', 'RENAMED P1', 'SET_MUSCLES P1', 'SPEC_MISSING P1']);
    expect(rows[4]).toMatchObject({ fingerprint: 'missing_data|SPEC_MISSING|P1|', evidence: { missing: ['Diámetro de manga', 'Largo de agarre'] } });
    await expect(pool.query(`delete from graph.curation_findings where run_id = $1`, [result.runId])).rejects.toThrow();
    // Decision 9: the rename and the discontinued product were applied and published by the curator itself.
    expect(await artifacts.current('product-graph')).toMatchObject({ version: 2, signedBy: 'graph-curator:auto' });
  });

  it('a run whose catalog reads mostly fail is stored as failed, without findings', async () => {
    const result = await runCuration({ pool, artifacts, catalog: sheets({ P1: 'fail', P2: 'fail' }) }, { startedBy: 'oidc:owner', concurrency: 1, tailMisses: 3 });
    expect(result.status).toBe('failed');
    const run = (await pool.query(`select status, failure, (select count(*)::int from graph.curation_findings f where f.run_id = r.run_id) as findings from graph.curation_runs r where run_id = $1`, [result.runId])).rows[0];
    expect(run).toMatchObject({ status: 'failed', findings: 0 });
    expect(run.failure).toMatch(/catalog reads failed/u);
  });
});
