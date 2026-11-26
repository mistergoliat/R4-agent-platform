import { describe, expect, it } from 'vitest';
import { PRODUCT_GRAPH_KIND, withoutRepeats } from '@r4-graph/curator';
import type { ArtifactProposal, NewArtifactProposal } from '@r4/persistence-postgres';

/** Owner 2026-11-26: «Polea de Muro» asked twice, by the rule SUBSTITUTE_KIND_MISMATCH and by the agent. One change, one question. */
describe('one change, one proposal', () => {
  const rm = (a: string, b: string) => ({ op: 'remove_relation', area: 'sub', a, b });
  const stored = (over: Partial<ArtifactProposal>): ArtifactProposal => ({
    proposalId: 'p', kind: PRODUCT_GRAPH_KIND, baseVersion: 2, source: 'graph-curator:r1', fingerprint: 'f', summary: 's', evidence: { rule: 'R' },
    change: null, state: 'proposed', createdAt: '2026-11-25T00:00:00Z', decidedBy: null, decidedAt: null, decisionNote: null, appliedVersion: null, ...over,
  });
  const incoming = (fingerprint: string, change: Record<string, unknown> | null): NewArtifactProposal => ({ fingerprint, summary: 's', evidence: { rule: 'R' }, change: change as never });

  it('drops a change another proposal already asks or decided, by content (jsonb key order does not matter)', () => {
    const existing = [
      stored({ proposalId: 'open', fingerprint: 'inconsistency|SUBSTITUTE_KIND_MISMATCH|P1427|P1887', change: rm('P1427', 'P1887') }),
      stored({ proposalId: 'decided', fingerprint: 'x|P1|P2', change: { b: 'P2', a: 'P1', area: 'sub', op: 'remove_relation' }, state: 'rejected' }),
      stored({ proposalId: 'gone', fingerprint: 'x|P3|P4', change: rm('P3', 'P4'), state: 'resolved' }),
    ];
    const r = withoutRepeats(existing, [
      incoming('inconsistency|AGENT_REMOVE_RELATION|P1427|P1887|sub', rm('P1427', 'P1887')),
      incoming('inconsistency|AGENT_REMOVE_RELATION|P1|P2|sub', rm('P1', 'P2')),
      incoming('inconsistency|AGENT_REMOVE_RELATION|P3|P4|sub', rm('P3', 'P4')), // its twin no longer stands: proposed
      incoming('notice', null),
    ]);
    expect(r.proposals.map((p) => p.fingerprint)).toEqual(['inconsistency|AGENT_REMOVE_RELATION|P3|P4|sub', 'notice']);
    expect(r.twins).toEqual(['open']); // a decided twin is not asked again
  });

  it('keeps a proposal refreshing itself, and keeps one of two repeats in the same batch', () => {
    const existing = [stored({ proposalId: 'open', fingerprint: 'f1', change: rm('A', 'B') })];
    const r = withoutRepeats(existing, [incoming('f1', rm('A', 'B')), incoming('f2', rm('C', 'D')), incoming('f3', rm('C', 'D'))]);
    expect(r.proposals.map((p) => p.fingerprint)).toEqual(['f1', 'f2']);
    expect(r.twins).toEqual([]);
  });

  it('leaves mechanical changes alone: two rules may deactivate the same product, and an applied change may come back', () => {
    const off = { op: 'deactivate', key: 'P1' };
    const existing = [stored({ proposalId: 'done', fingerprint: 'old', change: { op: 'remove_relation', area: 'sub', a: 'X', b: 'Y' }, state: 'applied' })];
    const r = withoutRepeats(existing, [incoming('DISCONTINUED|P1', off), incoming('INACTIVE_WITH_RELATIONS|P1', off), incoming('again', { op: 'remove_relation', area: 'sub', a: 'X', b: 'Y' })]);
    expect(r.proposals.map((p) => p.fingerprint)).toEqual(['DISCONTINUED|P1', 'INACTIVE_WITH_RELATIONS|P1', 'again']);
  });
});
