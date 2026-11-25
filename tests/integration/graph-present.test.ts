import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArtifacts, type Pool } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, importSignedGraph, presentOpenProposals } from '@r4-graph/curator';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * ADR-058 G7a on the real store: presenting the open proposals only adds `evidence.presentation`. Each stays the same
 * proposal (id, state, source, base version, change, other evidence), a decided one is not touched, and a second pass
 * writes nothing.
 */
let db: TestDatabase;
let pool: Pool;
let artifacts: PostgresArtifacts;

const GRAPH = {
  schemaVersion: 1,
  labels: { 'sub:a': 'Lo reemplaza', 'sub:b': 'Lo reemplaza' },
  products: { P1: { n: 'Polea de Muro', act: true, price: 10, kind: 'CABLE_STATION' }, P2: { n: 'Polea Alta', act: true, price: 20, kind: 'CABLE_STATION' } },
  view: { P1: { 'sub:a': ['P2'] }, P2: { 'sub:b': ['P1'] } },
};

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  artifacts = new PostgresArtifacts(pool);
  await importSignedGraph(artifacts, { graph: GRAPH, unreviewed: [], signedBy: 'oidc:owner', note: null, correlationId: 'c' });
  await artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: 1, source: 'graph-curator-agent:b1', correlationId: 'c', proposals: [
    { fingerprint: 'remove', summary: 'quitar', evidence: { rule: 'AGENT_REMOVE_RELATION', reason: 'distintas' }, change: { op: 'remove_relation', area: 'sub', a: 'P1', b: 'P2' } },
    { fingerprint: 'decided', summary: 'otra', evidence: { rule: 'AGENT_REMOVE_RELATION' }, change: { op: 'remove_relation', area: 'sub', a: 'P2', b: 'P1' } },
  ] });
  await artifacts.propose({ kind: PRODUCT_GRAPH_KIND, baseVersion: 1, source: 'graph-curator:r1', correlationId: 'c', proposals: [
    { fingerprint: 'notice', summary: 'Falta un dato', evidence: { rule: 'SPEC_MISSING' }, change: null },
  ] });
  const decided = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).find((p) => p.fingerprint === 'decided')!;
  await artifacts.decide({ kind: PRODUCT_GRAPH_KIND, proposalIds: [decided.proposalId], decision: 'rejected', decidedBy: 'oidc:owner', note: null, correlationId: 'c' });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('presenting the open graph proposals (ADR-058 G7a)', () => {
  it('adds only the presentation, keeps every proposal as it was, and does nothing the second time', async () => {
    const before = await artifacts.proposals(PRODUCT_GRAPH_KIND);
    expect(await presentOpenProposals(artifacts, new Map([['P1', 3]]))).toEqual({ open: 2, updated: 2, groups: { changes: 1, bulk: 0, notice: 1 } });
    const after = await artifacts.proposals(PRODUCT_GRAPH_KIND);
    for (const b of before) {
      const a = after.find((p) => p.proposalId === b.proposalId)!;
      const { presentation, ...rest } = a.evidence as Record<string, unknown>;
      expect([a.state, a.source, a.baseVersion, a.change, a.summary, rest]).toEqual([b.state, b.source, b.baseVersion, b.change, b.summary, b.evidence]);
      expect(presentation === undefined).toBe(b.state !== 'proposed');
    }
    expect((after.find((p) => p.fingerprint === 'remove')!.evidence as { presentation: unknown }).presentation).toMatchObject({
      group: 'changes', yes: 'reject', asked: 3, question: 'Si un cliente busca «Polea de Muro» y está agotado, ¿le ofrecerías «Polea Alta»?',
    });
    expect(await presentOpenProposals(artifacts, new Map([['P1', 3]]))).toMatchObject({ open: 2, updated: 0 });
  });
});
