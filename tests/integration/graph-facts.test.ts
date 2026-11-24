import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArtifactFacts, PostgresArtifacts, type Pool } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, importSignedGraph, migrateGraph, runCuration, type ProductSheetPort } from '@r4-graph/curator';
import { createSilentLogger } from '@r4/observability';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * ADR-058 Decision 10: a missing sheet field answered once in R4 closes the «falta dato» notice right away, and stays as
 * a «falta cargarlo en la tienda» notice until the store sheet declares it.
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;
let facts: PostgresArtifactFacts;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'ld:a': 'Discos', 'ld:b': 'Barras' },
  products: { P1: { n: 'Barra Power', act: true, price: 1, kind: 'OLY_BAR' }, P2: { n: 'Disco', act: true, price: 1, kind: 'MIXED' } },
  view: { P1: { 'ld:a': ['P2'] }, P2: { 'ld:b': ['P1'] } },
};
const sheet: Record<string, string> = { 'Diámetro de manga': '50 mm' }; // the store declares the sleeve, not the grip
const catalog: ProductSheetPort = {
  getProductContext(key) {
    if (key !== 'P1' && key !== 'P2') return Promise.resolve({ status: 'not_found' as const });
    const specifications = key === 'P1' ? Object.entries(sheet).map(([name, value]) => ({ name, value })) : [];
    return Promise.resolve({ status: 'found' as const, facts: { name: key === 'P1' ? 'Barra Power' : 'Disco', status: { active: true }, category: null, specifications }, derived: { availability: { sellability: 'sellable' }, priceSummary: null } });
  },
};
const run = () => runCuration({ pool, artifacts, catalog, facts }, { startedBy: 'oidc:owner', concurrency: 1, tailMisses: 2 });
const open = async (rule: string) => (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).filter((p) => (p.evidence as { rule?: string }).rule === rule);

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  artifacts = new PostgresArtifacts(pool);
  facts = new PostgresArtifactFacts(pool);
  await migrateGraph(pool);
  await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [], signedBy: 'oidc:owner', note: null, correlationId: 'c' });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('facts answered in R4 (ADR-058 Decision 10)', () => {
  it('missing grip length → answered once → the notice closes; the store list keeps it until the sheet has it', async () => {
    await run();
    expect((await open('SPEC_MISSING')).map((p) => (p.evidence as { missing: string[] }).missing)).toEqual([['Largo de agarre']]);

    await facts.record(PRODUCT_GRAPH_KIND, { subject: 'P1', field: 'Largo de agarre', value: '130 cm', source: 'console', note: null }, 'oidc:pm', 'f1');
    await facts.record(PRODUCT_GRAPH_KIND, { subject: 'P1', field: 'Largo de agarre', value: '131 cm', source: 'console', note: 'corregido' }, 'oidc:pm', 'f2');
    expect((await facts.current(PRODUCT_GRAPH_KIND, 'P1')).map((f) => f.value)).toEqual(['131 cm']); // the latest answer wins
    expect((await facts.history(PRODUCT_GRAPH_KIND, 'P1', 'Largo de agarre')).map((f) => f.value)).toEqual(['131 cm', '130 cm']);

    await run();
    expect(await open('SPEC_MISSING')).toEqual([]);
    const toStore = await open('FACT_NOT_IN_SHEET');
    expect(toStore.map((p) => p.evidence)).toEqual([expect.objectContaining({ field: 'Largo de agarre', value: '131 cm', recordedBy: 'oidc:pm' })]);

    sheet['Largo de agarre'] = '131 cm'; // someone loads it in the store
    await run();
    expect(await open('FACT_NOT_IN_SHEET')).toEqual([]);
    expect((await artifacts.proposals(PRODUCT_GRAPH_KIND, 'resolved')).map((p) => (p.evidence as { rule: string }).rule).sort()).toEqual(['FACT_NOT_IN_SHEET', 'SPEC_MISSING']);
  });

  it('facts are append-only', async () => {
    await expect(pool.query(`update artifact_facts set value = 'x'`)).rejects.toThrow();
    await expect(pool.query(`delete from artifact_facts`)).rejects.toThrow();
  });
});

describe('Pesín reads the facts (ADR-058 G5b)', () => {
  it('the Sales worker loads the current facts answered in R4 (the latest answer per field)', async () => {
    const { ProductFactsSource } = await import('@r4-sales/agent/production');
    const read = async () => (await facts.current(PRODUCT_GRAPH_KIND)).map((f) => ({ subject: f.subject, field: f.field, value: f.value }));
    const source = await ProductFactsSource.load(read, createSilentLogger());
    expect(source.of('P1')).toEqual([{ subject: 'P1', field: 'Largo de agarre', value: '131 cm' }]);
  });
});
