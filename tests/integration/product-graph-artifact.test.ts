import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArtifacts, type Pool } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, importSignedGraph, readSignedGraph } from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * ADR-058 G1: Core's minimal Artifact (immutable versions, append-only signatures, current = signed last) and the
 * product graph stored and read through it.
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  artifacts = new PostgresArtifacts(pool);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

const sign = (kind: string, version: number) => artifacts.sign({ kind, version, signedBy: 'owner', note: null, correlationId: `t-${kind}-${version}` });

describe('Artifact (Core, opaque)', () => {
  it('versions are immutable; equal content (any key order) reuses the latest version', async () => {
    const a = await artifacts.createVersion({ kind: 'test.doc', content: { x: 1, y: [1, 2] }, createdBy: 'owner', note: null });
    const same = await artifacts.createVersion({ kind: 'test.doc', content: { y: [1, 2], x: 1 }, createdBy: 'owner', note: null });
    const b = await artifacts.createVersion({ kind: 'test.doc', content: { x: 2 }, createdBy: 'owner', note: 'segunda' });
    expect([a.created, a.version.version, same.created, same.version.version, b.created, b.version.version]).toEqual([true, 1, false, 1, true, 2]);
    expect(a.version.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    await expect(pool.query(`update artifact_versions set note = 'x' where kind = 'test.doc'`)).rejects.toThrow();
    await expect(pool.query(`delete from artifact_versions where kind = 'test.doc'`)).rejects.toThrow();
  });

  it('current = the version signed last; going back is signing an older version again (nothing removed)', async () => {
    expect(await artifacts.current('test.doc')).toBeNull();
    expect(await sign('test.doc', 1)).toMatchObject({ version: 1, replacesVersion: null });
    await expect(sign('test.doc', 1)).rejects.toMatchObject({ code: 'already_current' });
    expect(await sign('test.doc', 2)).toMatchObject({ version: 2, replacesVersion: 1 });
    expect(await artifacts.current('test.doc')).toMatchObject({ version: 2, content: { x: 2 }, signedBy: 'owner' });
    expect(await sign('test.doc', 1)).toMatchObject({ version: 1, replacesVersion: 2 });
    expect(await artifacts.current('test.doc')).toMatchObject({ version: 1, content: { x: 1, y: [1, 2] } });
    await expect(sign('test.doc', 9)).rejects.toMatchObject({ code: 'artifact_version_not_found' });
    expect((await pool.query(`select count(*)::int as n from artifact_signatures where kind = 'test.doc'`)).rows[0].n).toBe(3);
    await expect(pool.query(`delete from artifact_signatures where kind = 'test.doc'`)).rejects.toThrow();
  });
});

const GRAPH = {
  schemaVersion: 1,
  labels: { 'rb:a': 'Barras que apoyan en este rack', 'rb:b': 'Racks donde apoya', 'col:a': 'Collarines', 'col:b': 'Barras' },
  products: {
    P10: { n: 'Rack', act: true, price: 500000, kind: 'RACK' },
    P20: { n: 'Barra', act: true, price: 150000, kind: 'BAR' },
    P30: { n: 'Collarín', act: true, price: 20000 },
  },
  view: {
    P10: { 'rb:a': ['P20'] },
    P20: { 'rb:b': ['P10'], 'col:b': ['P30'] },
    P30: { 'col:a': ['P20'] },
  },
};

describe('product graph as a signed Artifact (ADR-058 G1)', () => {
  it('a relation marked unreviewed must be a published one: nothing is stored otherwise', async () => {
    await expect(importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [['col', 'P20', 'P30']], signedBy: 'owner', note: null, correlationId: 'g-bad' })).rejects.toThrow(/not a published relation/u);
    expect(await artifacts.current(PRODUCT_GRAPH_KIND)).toBeNull();
  });

  it('imports and signs the baseline once; the tools read it back validated, with its unreviewed marks', async () => {
    const first = await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [['col', 'P30', 'P20']], signedBy: 'owner', note: 'línea base', correlationId: 'g-1' });
    expect(first).toMatchObject({ version: 1, created: true, signed: true, stats: { products: 3, relations: 2, unreviewed: 1 } });
    const again = await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [['col', 'P30', 'P20']], signedBy: 'owner', note: 'línea base', correlationId: 'g-2' });
    expect(again).toMatchObject({ version: 1, created: false, signed: false, contentSha256: first.contentSha256 });
    const signed = await readSignedGraph(artifacts);
    expect(signed).toMatchObject({ version: 1, signedBy: 'owner', contentSha256: first.contentSha256 });
    expect(signed!.graph.unreviewed).toEqual([['col', 'P30', 'P20']]);
    expect(signed!.graph.products.P30).toEqual({ n: 'Collarín', act: true, price: 20000, kind: null });
  });
});
