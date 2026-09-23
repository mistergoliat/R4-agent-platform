import type { RecordedModelCall } from './recording.js';
import type { ConversationState } from './runtime.js';

/**
 * How a reference the model cited relates to what exists. Mechanical only:
 * it says which id space a string belongs to, never whether citing it was
 * a good idea.
 */
export type CitedRefKind =
  | 'observation_id' // an observation of this task (what the protocol asks for)
  | 'observation_item_id' // the context item id of an observation (`observation:<id>`), not the id itself
  | 'context_item_id' // some other item id of the context the model saw
  | 'context_item_record_id' // an id shown inside another context item (its item id, provenance or content), e.g. a conversation turn's record
  | 'receipt_id'
  | 'proposal_id'
  | 'goal_id'
  | 'product_id'
  | 'unknown';

export interface CitedRef {
  readonly ref: string;
  readonly kind: CitedRefKind;
  /** Whether the platform would accept it as evidence (an observation id of this task). */
  readonly acceptable: boolean;
  /** For an observation (or its item id): whether that observation was in the context of this call, and in which section. */
  readonly inContext: boolean | null;
  readonly section: string | null;
  /** The context item that was matched, if any. */
  readonly matchedItemId: string | null;
}

export interface DecisionTrace {
  readonly runSequence: number;
  readonly iteration: number;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly finishReason: string | null;
  readonly latencyMs: number | null;
  readonly decisionType: string | null;
  readonly capabilityId: string | null;
  readonly citedRefs: readonly CitedRef[];
  /**
   * For decisions the platform rejected only (accepted ones are on their run
   * step): the decision document, or the structure of unparseable output.
   */
  readonly rejectedDecision: unknown;
  readonly observationsInContext: number;
}

/**
 * Joins the live harness's recorded model calls with durable run steps (one
 * model call per step, in order, per run) and classifies every reference a
 * decision cited against the context snapshot of that same call.
 */
export function traceDecisions(state: ConversationState, calls: readonly RecordedModelCall[]): DecisionTrace[] {
  const observationIds = new Set(state.observations.map((o) => o.observationId));
  const receiptIds = new Set(state.ledger.receipts.map((r) => r.receiptId));
  const proposalIds = new Set(state.ledger.proposals.map((p) => p.proposalId));
  const goalIds = new Set(state.goals.map((g) => g.goalId));
  const productIds = new Set<string>();
  for (const o of state.observations) collectProductIds(o.payload, productIds);

  const traces: DecisionTrace[] = [];
  for (const { run, steps, contexts } of [...state.runs].sort((a, b) => a.run.sequence - b.run.sequence)) {
    const runCalls = calls.filter((c) => c.runId === run.runId && c.error === null);
    const ordered = [...steps].sort((a, b) => a.iteration - b.iteration);
    ordered.forEach((step, i) => {
      const call = runCalls[i] ?? null;
      const decision = (step.decision ?? call?.decision ?? null) as Record<string, unknown> | null;
      const context = contexts.filter((c) => c.iteration === step.iteration).at(-1);
      const itemIds = new Set(context?.itemIds ?? []);
      const classify = (ref: string): CitedRef => {
        const cited = (kind: CitedRefKind, itemId: string | null = null): CitedRef => ({
          ref,
          kind,
          acceptable: kind === 'observation_id',
          inContext: itemId === null ? null : itemIds.has(itemId),
          section: itemId === null ? null : (context?.sectionByItem[itemId] ?? null),
          matchedItemId: itemId,
        });
        if (observationIds.has(ref)) return cited('observation_id', `observation:${ref}`);
        const bare = ref.startsWith('observation:') ? ref.slice('observation:'.length) : null;
        if (bare !== null && observationIds.has(bare)) return cited('observation_item_id', ref);
        if (itemIds.has(ref)) return cited('context_item_id', ref);
        const holder = context?.itemByMentionedId[ref];
        if (holder !== undefined) return cited('context_item_record_id', holder);
        if (receiptIds.has(ref)) return cited('receipt_id');
        if (proposalIds.has(ref)) return cited('proposal_id');
        if (goalIds.has(ref)) return cited('goal_id');
        if (productIds.has(ref)) return cited('product_id');
        return cited('unknown');
      };
      traces.push({
        runSequence: run.sequence,
        iteration: step.iteration,
        outcome: step.outcome,
        errorCode: step.error?.code ?? null,
        finishReason: call?.finishReason ?? null,
        latencyMs: call?.latencyMs ?? null,
        decisionType: typeof decision?.type === 'string' ? decision.type : null,
        capabilityId: typeof decision?.capabilityId === 'string' ? decision.capabilityId : null,
        citedRefs: citedRefsOf(decision).map(classify),
        rejectedDecision: step.decision === null ? (call?.decision ?? call?.unparsedShape ?? null) : null,
        observationsInContext: [...itemIds].filter((id) => id.startsWith('observation:')).length,
      });
    });
  }
  return traces;
}

/** Every evidence-like reference field of the decision protocol, whatever the decision type. */
export function citedRefsOf(decision: Record<string, unknown> | null): string[] {
  if (decision === null) return [];
  const result = decision.result as { evidence?: unknown } | undefined;
  return [decision.evidenceRefs, decision.contextRefs, result?.evidence].flatMap((list) => (Array.isArray(list) ? list.map((r) => String(r)) : []));
}

function collectProductIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) for (const v of value) collectProductIds(v, into);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'productId' && typeof v === 'string') into.add(v);
      else collectProductIds(v, into);
    }
  }
}

/** One governed write, end to end: proposal → policy decision → command → receipt (ids and outcomes only). */
export interface GovernanceTrace {
  readonly proposalId: string;
  readonly capabilityId: string;
  readonly iteration: number;
  readonly evidenceRefs: readonly string[];
  readonly policy: { readonly outcome: string; readonly reasonCode: string | null } | null;
  readonly command: { readonly executionId: string; readonly status: string } | null;
  readonly receipt: { readonly receiptId: string; readonly status: string; readonly externalOperationRef: string | null; readonly errorCode: string | null } | null;
}

export function traceGovernance(state: ConversationState): GovernanceTrace[] {
  const { proposals, decisions, executions, receipts } = state.ledger;
  return proposals.map((p) => {
    const decision = decisions.find((d) => d.proposalId === p.proposalId);
    const execution = executions.find((e) => e.proposalId === p.proposalId);
    const receipt = receipts.find((r) => r.proposalId === p.proposalId);
    return {
      proposalId: p.proposalId,
      capabilityId: p.capabilityId,
      iteration: p.iteration,
      evidenceRefs: p.evidenceRefs,
      policy: decision ? { outcome: decision.outcome, reasonCode: decision.reasonCode ?? null } : null,
      command: execution ? { executionId: execution.executionId, status: execution.status } : null,
      receipt: receipt ? { receiptId: receipt.receiptId, status: receipt.status, externalOperationRef: receipt.externalOperationRef, errorCode: receipt.error?.code ?? null } : null,
    };
  });
}
