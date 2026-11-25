import { describe, expect, it } from 'vitest';
import { PRODUCT_GRAPH_KIND, presentOpenProposals, presentProposal, productGraphSchema } from '@r4-graph/curator';
import type { ArtifactProposal } from '@r4/persistence-postgres';

/**
 * ADR-058 Decision 12 (G7a): every open proposal reads as a question with what each answer does, its group and the
 * products. These cases pin the templates of each kind of change.
 */
const graph = productGraphSchema.parse({
  schemaVersion: 1,
  labels: { 'sub:a': 'Lo reemplaza', 'sub:b': 'Lo reemplaza', 'ld:a': 'Discos para cargarla', 'ld:b': 'Máquinas e implementos que carga' },
  products: {
    P1: { n: 'Polea de Muro 1.0 ZR Series | PROmachine', act: true, price: 599990, kind: 'CABLE_STATION' },
    P2: { n: 'Polea Alta/Remo ZR Series | PROmachine', act: true, price: 399990, kind: 'CABLE_STATION' },
    P3: { n: 'Barra Olímpica 20kg', act: true, price: 149990, kind: 'OLY_BAR' },
    P4: { n: 'Disco Bumper 10kg', act: true, price: 53990, kind: 'PLATE_OLY' },
    P5: { n: 'Disco Bumper 20kg', act: true, price: 89990, kind: 'PLATE_OLY' },
  },
  view: { P1: { 'sub:a': ['P2'] }, P2: { 'sub:b': ['P1'] }, P3: { 'ld:a': ['P4'] }, P4: { 'ld:b': ['P3'] } },
  unreviewed: [],
});
const asked = new Map([['P1', 7], ['P3', 2]]);
const present = (change: unknown, summary = 'resumen') => presentProposal(graph, { summary, change }, asked);

describe('a proposal as a question (G7a)', () => {
  it('removing a replacement asks whether you would offer it; «Sí» keeps it', () => {
    expect(present({ op: 'remove_relation', area: 'sub', a: 'P1', b: 'P2' })).toEqual({
      group: 'changes', yes: 'reject',
      question: 'Si un cliente busca «Polea de Muro 1.0 ZR Series» y está agotado, ¿le ofrecerías «Polea Alta/Remo ZR Series»?',
      ifYes: 'Pesín sigue ofreciendo «Polea Alta/Remo ZR Series» como reemplazo de «Polea de Muro 1.0 ZR Series».',
      ifNo: 'Pesín deja de ofrecer «Polea Alta/Remo ZR Series» como reemplazo de «Polea de Muro 1.0 ZR Series».',
      text: 'resumen', asked: 7,
      products: [{ key: 'P1', name: 'Polea de Muro 1.0 ZR Series', price: 599990, active: true }, { key: 'P2', name: 'Polea Alta/Remo ZR Series', price: 399990, active: true }],
    });
  });

  it('other relations use the readable label; adding relations asks about them all', () => {
    expect(present({ op: 'remove_relation', area: 'ld', a: 'P3', b: 'P4' })).toMatchObject({ group: 'changes', yes: 'reject', question: 'Para «Barra Olímpica 20kg», ¿«Disco Bumper 10kg» va en «Discos para cargarla»?' });
    expect(present({ op: 'add_relations', relations: [['ld', 'P3', 'P4'], ['ld', 'P3', 'P5']] })).toMatchObject({
      group: 'changes', yes: 'approve', question: 'Para «Barra Olímpica 20kg», ¿van «Disco Bumper 10kg», «Disco Bumper 20kg» en «Discos para cargarla»?',
    });
  });

  it('a kind is named by products of that kind, never by its code', () => {
    const p = present({ op: 'set_kind', key: 'P5', kind: 'CABLE_STATION' });
    expect(p).toMatchObject({ group: 'changes', yes: 'approve', question: '¿«Disco Bumper 20kg» es del mismo tipo que «Polea de Muro 1.0 ZR Series», «Polea Alta/Remo ZR Series»?' });
    expect(p.question).not.toContain('CABLE_STATION');
  });

  it('what does not change Pesín today goes to the bulk group; a notice has no question', () => {
    expect(present({ op: 'mark_reviewed', relations: [['sub', 'P1', 'P2'], ['ld', 'P3', 'P4']] })).toMatchObject({ group: 'bulk', yes: 'approve', question: expect.stringContaining('El curador revisó 2 relaciones') });
    expect(present({ op: 'set_muscles', key: 'P1', muscles: ['espalda', 'brazos'] })).toMatchObject({ group: 'bulk', question: '¿«Polea de Muro 1.0 ZR Series» trabaja espalda, brazos?' });
    expect(present(null, 'Falta el diámetro')).toMatchObject({ group: 'notice', question: null, yes: null, ifYes: null, ifNo: null, text: 'Falta el diámetro', products: [], asked: 0 });
  });

  it('an unknown change is still shown, as a change without a question', () => {
    expect(present({ op: 'something_new' })).toMatchObject({ group: 'changes', question: null, yes: null });
  });
});

describe('presenting the open proposals', () => {
  const open = (over: Partial<ArtifactProposal>): ArtifactProposal => ({
    proposalId: 'x', kind: PRODUCT_GRAPH_KIND, baseVersion: 2, source: 'graph-curator:r1', fingerprint: 'f', summary: 's', evidence: { rule: 'R' },
    change: null, state: 'proposed', createdAt: '2026-11-25T00:00:00Z', decidedBy: null, decidedAt: null, decisionNote: null, appliedVersion: null, ...over,
  });

  it('re-proposes each with its own source and base version, only adding the presentation; unchanged ones are skipped', async () => {
    const calls: { source: string; baseVersion: number; proposals: { fingerprint: string; evidence: Record<string, unknown>; change: unknown }[] }[] = [];
    const current = presentProposal(graph, { summary: 's', change: null }, asked);
    const artifacts = {
      current: () => Promise.resolve({ version: 3, content: graph, contentSha256: 'x', signedBy: 'o', signedAt: '' }),
      proposals: () => Promise.resolve([
        open({ fingerprint: 'a', change: { op: 'remove_relation', area: 'sub', a: 'P1', b: 'P2' } }),
        open({ fingerprint: 'b', source: 'graph-curator-agent:b1', baseVersion: 3 }),
        open({ fingerprint: 'c', evidence: { rule: 'R', presentation: current } }),
      ]),
      propose: (input: (typeof calls)[number]) => { calls.push(input); return Promise.resolve({ created: 0, refreshed: input.proposals.length, reopened: 0, skipped: 0 }); },
    };
    const r = await presentOpenProposals(artifacts as never, asked);
    expect(r).toEqual({ open: 3, updated: 2, groups: { changes: 1, bulk: 0, notice: 2 } });
    expect(calls.map((c) => [c.source, c.baseVersion, c.proposals.map((p) => p.fingerprint)])).toEqual([['graph-curator:r1', 2, ['a']], ['graph-curator-agent:b1', 3, ['b']]]);
    expect(calls[0]!.proposals[0]).toMatchObject({ change: { op: 'remove_relation' }, evidence: { rule: 'R', presentation: { group: 'changes', yes: 'reject' } } });
  });
});
