import type { CompiledContext, CompiledContextItem } from '@r4/contracts';
import type { FakeModelScript, ModelRequest } from '@r4/model-gateway';
import { CAPABILITY_IDS } from '../ids.js';
import type { FactValue, WorkspaceOperation } from '../workspace/model.js';

/**
 * Scripted stand-in for the model, for deterministic CI only. Each entry is
 * one model call; it may read the compiled context it receives (exactly
 * what a real model would receive) to pick ids and versions. It proves the
 * platform semantics along a plausible trajectory; it says nothing about
 * what a real model would decide — that is what `sales:live` observes.
 */
export type ScriptedStep = (view: ContextView) => Record<string, unknown>;

export interface ObservationView {
  readonly observationId: string;
  readonly capabilityId: string;
  readonly outcome: string;
  readonly payload: unknown;
  readonly error: { code: string; details?: unknown } | null;
  readonly freshness: string;
}

export interface WorkspaceView {
  readonly workspaceVersion: number;
  readonly customer: { identity: string };
  readonly facts: Record<string, { value: unknown }>;
  readonly deliveryDestination: { commune: string } | null;
  readonly selection: { productId: string; quantity: number; catalogEvidence: { observationId: string; current: boolean } | null }[];
  readonly shippingEvidence: { observationId: string; destination: string; forCurrentDestination: boolean; forCurrentSelection: boolean; current: boolean }[];
  readonly quotes: { quoteNumber: string }[];
}

export interface CatalogProductView {
  readonly name: string;
  readonly price: { readonly kind: 'exact' | 'from'; readonly finalGross: { readonly amount: number } } | null;
  readonly sellability: string;
  /** A verbatim owner specification, or null when the evidence has none (never guessed). */
  specification(name: string): string | null;
}

export class ContextView {
  readonly request: ModelRequest;
  readonly context: CompiledContext;

  constructor(request: ModelRequest) {
    if (!request.context) throw new Error('the model request carries no compiled context');
    this.request = request;
    this.context = request.context;
  }

  get workspace(): WorkspaceView {
    const item = this.context.sections.authoritativeState.find((i) => i.sourceId === 'sales.workspace');
    if (!item) throw new Error('no Sales workspace in context');
    return item.content as unknown as WorkspaceView;
  }

  /** Observations the model can see (current ones and expired history), oldest first. */
  observations(capabilityId?: string): ObservationView[] {
    return [...this.context.sections.observations, ...this.context.sections.history]
      .filter((i) => i.kind === 'observation')
      .map((i) => ({ ...(i.content as unknown as Omit<ObservationView, 'freshness'>), freshness: i.freshness }))
      .filter((o) => capabilityId === undefined || o.capabilityId === capabilityId)
      .sort((a, b) => a.observationId.localeCompare(b.observationId));
  }

  latest(capabilityId: string): ObservationView {
    const found = this.observations(capabilityId).at(-1);
    if (!found) throw new Error(`no observation of ${capabilityId} in context`);
    return found;
  }

  /**
   * The newest current (not expired) catalog evidence for a product key: what
   * a grounded answer may quote — the owner's price summary, availability and
   * (from a product context) its verbatim specifications. Nothing is computed.
   */
  product(productKey: string): CatalogProductView {
    for (const o of this.observations().reverse()) {
      if (o.freshness === 'expired' || o.outcome !== 'succeeded') continue;
      type Found = { status?: string; productKey?: string; facts?: { name: string; specifications: { name: string; value: string }[] }; derived?: { price: CatalogProductView['price']; availability: { sellability: string } } };
      type Hit = { productKey: string; name: string; price: CatalogProductView['price']; availability: { sellability: string } };
      const payload = o.payload as (Found & { results?: Hit[] }) | null;
      if (o.capabilityId === CAPABILITY_IDS.productContext && payload?.status === 'found' && payload.productKey === productKey && payload.facts && payload.derived) {
        const specifications = payload.facts.specifications;
        return { name: payload.facts.name, price: payload.derived.price, sellability: payload.derived.availability.sellability, specification: (name) => specifications.find((s) => s.name === name)?.value ?? null };
      }
      const hit = o.capabilityId === CAPABILITY_IDS.catalogSearch ? payload?.results?.find((r) => r.productKey === productKey) : undefined;
      if (hit) return { name: hit.name, price: hit.price, sellability: hit.availability.sellability, specification: () => null };
    }
    throw new Error(`no current catalog evidence for ${productKey}`);
  }

  goals(): CompiledContextItem[] {
    return this.context.sections.goals;
  }

  get rootGoalId(): string {
    const root = this.goals().find((g) => (g.content as { isRoot?: boolean; origin: string }).isRoot ?? (g.content as { origin: string }).origin === 'requester');
    if (!root) throw new Error('no root goal in context');
    return (root.content as { goalId: string }).goalId;
  }

  goal(matches: RegExp): string {
    const goal = this.goals().find((g) => matches.test((g.content as { description: string }).description));
    if (!goal) throw new Error(`no active goal matches ${String(matches)}`);
    return (goal.content as { goalId: string }).goalId;
  }

  /** Current observation ids a proposal can cite: catalog evidence of the selection and shipping for the current destination. */
  quoteEvidence(): string[] {
    const ws = this.workspace;
    const ids = ws.selection.flatMap((s) => (s.catalogEvidence?.current ? [s.catalogEvidence.observationId] : []));
    const shipping = ws.shippingEvidence.filter((s) => s.forCurrentDestination && s.current).at(-1);
    return [...new Set([...ids, ...(shipping ? [shipping.observationId] : [])])];
  }
}

// --- decision builders (the model-facing protocol, r4.agent_decision.v4) ---

export const respond = (text: string | ((v: ContextView) => string)): ScriptedStep => (v) => ({ type: 'respond', content: typeof text === 'string' ? text : text(v) });
export const waitForCustomer = (reason = 'waiting for the customer'): ScriptedStep => () => ({ type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason });
export const read = (capabilityId: string, args: Record<string, unknown> | ((v: ContextView) => Record<string, unknown>) = {}): ScriptedStep => (v) => ({ type: 'read_capability', capabilityId, arguments: typeof args === 'function' ? args(v) : args });
export const update = (operations: WorkspaceOperation[] | ((v: ContextView) => WorkspaceOperation[])): ScriptedStep => (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations: typeof operations === 'function' ? operations(v) : operations } });
export const proposeQuote = (customer: Record<string, unknown> | ((v: ContextView) => Record<string, unknown>), extra: Record<string, unknown> = {}): ScriptedStep => (v) => {
  const evidence = v.quoteEvidence();
  return {
    type: 'propose_action',
    capabilityId: CAPABILITY_IDS.quoteCreate,
    arguments: { workspaceVersion: v.workspace.workspaceVersion, customer: typeof customer === 'function' ? customer(v) : customer, ...extra },
    ...(evidence.length > 0 ? { evidenceRefs: evidence } : {}),
  };
};

/** The customer as the Customer owner has them on file (from the latest customer.get_context observation). */
export const customerOnFile = (v: ContextView): Record<string, unknown> => {
  const payload = v.latest(CAPABILITY_IDS.customerContext).payload as { identity: string; customer?: { displayName: string; contact: { email: string | null; phone: string | null } } };
  if (payload.identity !== 'provisional' || !payload.customer) throw new Error('the customer is not on file');
  const { displayName, contact } = payload.customer;
  return { name: displayName, ...(contact.email ? { email: contact.email } : {}), ...(contact.phone ? { phone: contact.phone } : {}) };
};
export const createGoal = (description: string, parent: (v: ContextView) => string = (v) => v.rootGoalId, makeCurrent = true): ScriptedStep => (v) => ({ type: 'manage_goal', change: { operation: 'create', parentGoalId: parent(v), description, successCriteria: [], makeCurrent } });
export const focusGoal = (goal: (v: ContextView) => string): ScriptedStep => (v) => ({ type: 'manage_goal', change: { operation: 'focus', goalId: goal(v) } });
export const completeGoal = (goal: (v: ContextView) => string): ScriptedStep => (v) => ({ type: 'manage_goal', change: { operation: 'complete', goalId: goal(v) } });
export const consult = (question: string): ScriptedStep => () => ({ type: 'request_consultation', question, contextRefs: [] });

// --- workspace operation shorthands ---

export const fact = (key: string, value: FactValue, statedBy: 'customer' | 'agent' = 'customer'): WorkspaceOperation => ({ op: 'record_fact', key, value, statedBy });
export const add = (productId: string, quantity = 1): WorkspaceOperation => ({ op: 'add_item', productId, quantity });
export const remove = (productId: string): WorkspaceOperation => ({ op: 'remove_item', productId });
export const setQuantity = (productId: string, quantity: number): WorkspaceOperation => ({ op: 'set_item_quantity', productId, quantity });
export const replace = (productId: string, withProductId: string, quantity = 1): WorkspaceOperation => ({ op: 'replace_item', productId, withProductId, quantity });
export const destination = (commune: string): WorkspaceOperation => ({ op: 'set_delivery_destination', commune });

export const clp = (amount: number): string => `$${amount.toLocaleString('es-CL')}`;

/** The observed quote (receipt-backed) as the model sees it. */
export function observedQuote(v: ContextView): { quoteNumber: string; total: { amount: number }; validUntil: string; lines: { productId: string; unitPrice: { amount: number } }[] } {
  const quote = v.observations(CAPABILITY_IDS.quoteCreate).filter((o) => o.outcome === 'succeeded').at(-1);
  if (!quote) throw new Error('no receipt-backed quote observation in context');
  // An action observation carries its receipt: the owner's answer is `result`.
  return (quote.payload as { receiptId: string; result: unknown }).result as never;
}

/** A FakeModelProvider script: the steps in order, one per model call. */
export function scriptedAgent(steps: readonly ScriptedStep[]): FakeModelScript {
  return (request, index) => {
    const step = steps[index];
    if (!step) return { type: 'provider_error', message: `scripted agent has no step for model call ${index + 1}` };
    return { type: 'structured', data: step(new ContextView(request)) };
  };
}
