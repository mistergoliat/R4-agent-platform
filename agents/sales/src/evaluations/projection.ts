import type { JsonValue } from '@r4/contracts';
import type { DomainProjection, EvaluationSubject, Position } from '@r4/evaluation';
import type { DomainProjectionProvider } from '@r4/evaluator';
import type { WorkspaceChange, WorkspaceState, WorkspaceUpdateInput } from '../workspace/model.js';
import type { PostgresSalesStore } from '../workspace/store.js';

/**
 * The Sales workspace as Quality sees it: current state, the append-only
 * transitions (each tied to the platform execution key of the governed
 * command that produced it) and quote references. Read from the pack's own
 * store; nothing is copied into R4 tables.
 */
export const SALES_WORKSPACE_PROJECTION = 'sales.workspace';
export const SALES_PROJECTION_SCHEMA = 'sales.workspace.v1';

export interface SalesProjectionData {
  readonly version: number;
  readonly state: WorkspaceState;
  readonly transitions: readonly { readonly executionKey: string; readonly outcome: 'applied' | 'rejected'; readonly fromVersion: number; readonly toVersion: number; readonly operations: WorkspaceUpdateInput['operations']; readonly changes: readonly WorkspaceChange[] }[];
  readonly quoteReferences: readonly { readonly executionKey: string; readonly quoteNumber: string; readonly basedOnWorkspaceVersion: number }[];
}

export function salesWorkspaceProjection(store: PostgresSalesStore): DomainProjectionProvider {
  return {
    projectionId: SALES_WORKSPACE_PROJECTION,
    async project(taskId: string): Promise<DomainProjection> {
      const workspace = await store.workspace(taskId);
      const data: SalesProjectionData = {
        version: workspace.version,
        state: workspace.state,
        transitions: (await store.transitions(taskId)).map((t) => ({ executionKey: t.executionKey, outcome: t.outcome, fromVersion: t.fromVersion, toVersion: t.toVersion, operations: t.operations, changes: t.changes })),
        quoteReferences: (await store.quoteReferences(taskId)).map((q) => ({ executionKey: q.executionKey, quoteNumber: q.quoteNumber, basedOnWorkspaceVersion: q.basedOnWorkspaceVersion })),
      };
      return { owner: 'sales', schemaVersion: SALES_PROJECTION_SCHEMA, data: data as unknown as DomainProjection['data'] };
    },
  };
}

/** The Sales projection of a subject, or an empty one when the subject has none. */
export function salesProjectionOf(subject: Readonly<EvaluationSubject>): SalesProjectionData {
  const p = subject.domain[SALES_WORKSPACE_PROJECTION];
  if (!p || p.schemaVersion !== SALES_PROJECTION_SCHEMA) return { version: 0, state: { facts: {}, delivery: null, items: [] }, transitions: [], quoteReferences: [] };
  return p.data as unknown as SalesProjectionData;
}

/** Where in the step log each workspace transition was decided (execution key → proposal → step). */
export function transitionPositions(subject: Readonly<EvaluationSubject>): Map<string, Position> {
  const stepPosition = new Map<string, Position>();
  for (const r of subject.runs) for (const s of r.steps) stepPosition.set(s.stepId, { run: r.sequence, iteration: s.iteration });
  const proposalStep = new Map(subject.actions.proposals.map((p) => [p.proposalId, p.stepId]));
  const out = new Map<string, Position>();
  for (const e of subject.actions.executions) {
    const at = stepPosition.get(proposalStep.get(e.proposalId) ?? '');
    if (at) out.set(e.executionKey, at);
  }
  return out;
}

/** The judge's view of the workspace: current facts, destination, selection and fact history (no internals). */
export function salesDomainView(domain: EvaluationSubject['domain']): JsonValue {
  const p = domain[SALES_WORKSPACE_PROJECTION];
  if (!p) return { workspace: null };
  const data = p.data as unknown as SalesProjectionData;
  const view = {
    workspace: {
      version: data.version,
      facts: Object.fromEntries(Object.entries(data.state.facts).map(([k, f]) => [k, f.value])),
      delivery: data.state.delivery?.commune ?? null,
      selection: data.state.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      factHistory: data.transitions.flatMap((t) => t.changes.flatMap((c) => (c.kind === 'fact' ? [{ key: c.key, from: c.from?.value ?? null, to: c.to?.value ?? null, version: t.toVersion }] : []))),
      quotes: data.quoteReferences.map((q) => q.quoteNumber),
    },
  };
  return view;
}
