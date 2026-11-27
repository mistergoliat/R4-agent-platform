import type { ArtifactProposal, NewArtifactProposal, PostgresArtifacts } from '@r4/persistence-postgres';
import { canonical } from './present.js';

/**
 * One change, one question (owner 2026-11-26: «Polea de Muro» asked twice). Two of the curator's checks can find the same
 * change, e.g. the rule SUBSTITUTE_KIND_MISMATCH and the agent's AGENT_REMOVE_RELATION both remove the same «lo
 * reemplaza», each with its own fingerprint. A new proposal whose change already stands in another proposal (being asked,
 * or decided and not yet in the graph) is not stored; a proposal refreshing itself (same fingerprint) always is. An
 * applied change may come back (a product deactivated again, a relation that returned): that is a new question.
 * `twins`: the open proposals that already ask a dropped change (a confirmed explanation approves those instead).
 */
const STANDING = new Set<string>(['proposed', 'approved', 'rejected']);
// Mechanical changes (Decision 9) apply themselves and are never asked: two rules finding the same one is fine.
const MECHANICAL = new Set<string>(['deactivate', 'activate', 'rename']);
const asked = (change: unknown) => change !== null && !MECHANICAL.has(String((change as { op?: unknown }).op));

export function withoutRepeats(existing: readonly ArtifactProposal[], incoming: readonly NewArtifactProposal[]): { proposals: NewArtifactProposal[]; twins: string[] } {
  const standing = existing.filter((p) => STANDING.has(p.state));
  const own = new Set(standing.map((p) => p.fingerprint));
  const byChange = new Map<string, ArtifactProposal>();
  for (const p of standing) if (asked(p.change) && !byChange.has(canonical(p.change))) byChange.set(canonical(p.change), p);
  const seen = new Set<string>();
  const proposals: NewArtifactProposal[] = [];
  const twins: string[] = [];
  for (const x of incoming) {
    if (!asked(x.change)) { proposals.push(x); continue; }
    const k = canonical(x.change);
    const twin = byChange.get(k);
    if (own.has(x.fingerprint) || (!twin && !seen.has(k))) { seen.add(k); proposals.push(x); continue; }
    if (twin?.state === 'proposed' && twin.fingerprint !== x.fingerprint) twins.push(twin.proposalId);
  }
  return { proposals, twins: [...new Set(twins)] };
}

/** `artifacts.propose` without repeated changes; the dropped ones count as skipped. */
export async function proposeOnce(artifacts: Pick<PostgresArtifacts, 'proposals' | 'propose'>, input: Parameters<PostgresArtifacts['propose']>[0]) {
  const { proposals, twins } = withoutRepeats(await artifacts.proposals(input.kind), input.proposals);
  const stored = await artifacts.propose({ ...input, proposals });
  return { stored: { ...stored, skipped: stored.skipped + input.proposals.length - proposals.length }, twins };
}
