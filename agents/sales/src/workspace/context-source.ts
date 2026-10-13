import type { ContextContributionInput, JsonValue, Observation } from '@r4/contracts';
import type { ContextSource, ContextSourceRequest } from '@r4/context-compiler';
import { catalogEvidenceValidUntil } from '../capabilities/catalog.js';
import { CAPABILITY_IDS, SALES_TASK_TYPE, WORKSPACE_SOURCE_ID } from '../ids.js';
import { selectionOf, type Workspace } from './model.js';
import type { ConversationBinding, PostgresSalesStore, QuoteReference, WorkspaceTransition } from './store.js';

/** The read side the source needs (a narrow port over the Sales store). */
export type WorkspaceReader = Pick<PostgresSalesStore, 'workspace' | 'conversation' | 'quoteReferences' | 'transitions'>;

/**
 * Registered by the Sales composition through `WorkerBindings.contextSources`
 * (the C2 seam for state owned outside Core). It contributes one `state`
 * item per conversation: the Sales workspace as its owner — the Sales pack —
 * holds it right now. The item is AUTHORITATIVE only about Sales working
 * state (what was stated, what is selected, where delivery goes); it carries
 * no price, stock, shipping cost or quote total, and says so.
 *
 * It also annotates, deterministically from the task's observations, which
 * evidence still applies to the current state: a shipping quote obtained for
 * another destination or another selection is marked as not applicable, and
 * each selected item points at its newest catalog observation and whether it
 * is still within its freshness window — the earlier of R4's window and the
 * Catalog owner's declared `validUntil` (R4-J1B: R4 never extends the
 * owner's freshness). This is interpretation of the pack's
 * own domain, done here and not in Core — and it decides nothing: the agent
 * still chooses whether to read again.
 */
export class SalesWorkspaceContextSource implements ContextSource {
  readonly id = WORKSPACE_SOURCE_ID;
  readonly #reader: WorkspaceReader;

  constructor(reader: WorkspaceReader) {
    this.#reader = reader;
  }

  async load(request: ContextSourceRequest): Promise<readonly ContextContributionInput[]> {
    const { task, observations } = request.execution;
    // Only Sales conversations have a workspace; other packs on the same worker see nothing from this source.
    if (task.taskType !== SALES_TASK_TYPE) return [];
    const [workspace, binding, quotes, transitions] = await Promise.all([
      this.#reader.workspace(task.taskId),
      this.#reader.conversation(task.taskId),
      this.#reader.quoteReferences(task.taskId),
      this.#reader.transitions(task.taskId),
    ]);
    return [
      {
        itemId: `sales_workspace:${task.taskId}`,
        kind: 'state',
        authority: 'AUTHORITATIVE',
        temporality: 'live',
        content: projectWorkspace({ workspace, binding, quotes, transitions, observations, now: request.now }) as JsonValue,
        provenance: { recordType: 'sales_workspace', recordId: task.taskId, recordVersion: String(workspace.version), producedBy: 'sales' },
        createdAt: workspace.createdAt ?? task.createdAt,
        taskId: task.taskId,
        required: true,
      },
    ];
  }
}

export interface WorkspaceProjectionInput {
  readonly workspace: Workspace;
  readonly binding: ConversationBinding | null;
  readonly quotes: readonly QuoteReference[];
  readonly transitions: readonly WorkspaceTransition[];
  readonly observations: readonly Observation[];
  readonly now: Date;
}

/** Pure: the model-facing view of the workspace. */
export function projectWorkspace(input: WorkspaceProjectionInput): Record<string, unknown> {
  const { workspace, binding, observations, now } = input;
  const { state } = workspace;
  const selection = selectionOf(state);
  const catalog = catalogEvidence(observations, now);
  const delivery = state.delivery;
  return {
    about:
      'Sales workspace of this conversation, kept by the Sales pack: what the customer stated, the delivery destination and the products under consideration. It holds no prices, stock, shipping costs or quote totals: those exist only in observations from their owners. Change it only through sales.workspace.update.',
    workspaceVersion: workspace.version,
    customer: { identity: binding?.customerRef ? 'provisional' : 'unavailable' },
    facts: Object.fromEntries(Object.entries(state.facts).map(([key, fact]) => [key, { value: fact.value, statedBy: fact.statedBy, ...(fact.note ? { note: fact.note } : {}), sinceVersion: fact.sinceVersion }])),
    deliveryDestination: delivery ? { commune: delivery.commune, region: delivery.region, sinceVersion: delivery.sinceVersion } : null,
    selection: state.items.map((item) => {
      const evidence = catalog.get(item.productId);
      return { productId: item.productId, quantity: item.quantity, sinceVersion: item.sinceVersion, catalogEvidence: evidence ?? null };
    }),
    shippingEvidence: observations
      .filter((o) => o.source.kind === 'capability' && o.source.capabilityId === CAPABILITY_IDS.shippingQuote && o.outcome === 'succeeded')
      .flatMap((o) => {
        const payload = o.payload as { destination?: { communeName?: unknown }; requestedItems?: unknown } | null;
        const commune = typeof payload?.destination?.communeName === 'string' ? payload.destination.communeName : null;
        if (commune === null) return [];
        return [{
          observationId: o.observationId,
          destination: commune,
          forCurrentDestination: delivery !== null && sameText(commune, delivery.commune),
          forCurrentSelection: sameSelection(payload?.requestedItems, selection),
          current: isCurrent(o, now),
        }];
      }),
    quotes: input.quotes.map((q) => ({
      quoteId: q.quoteId,
      quoteNumber: q.quoteNumber,
      basedOnWorkspaceVersion: q.basedOnWorkspaceVersion,
      selectionOrDeliveryChangedSince: input.transitions.some((t) => t.outcome === 'applied' && t.toVersion > q.basedOnWorkspaceVersion && t.changes.some((c) => c.kind === 'item' || c.kind === 'delivery')),
    })),
    // (R4-J3E) Only in states written by sales.workspace.update@2 (sales-production@5): earlier projections are unchanged.
    ...(state.shipping !== undefined
      ? {
          shippingChoice:
            state.shipping === null
              ? null
              : state.shipping.kind === 'selected'
                ? { kind: 'selected', commune: state.shipping.commune, carrierName: state.shipping.carrierName, serviceType: state.shipping.serviceType, agreedOwnerNetClp: state.shipping.agreedOwnerNetClp, sinceVersion: state.shipping.sinceVersion }
                : { kind: 'excluded', sinceVersion: state.shipping.sinceVersion },
        }
      : {}),
    ...(state.quoteRequest !== undefined ? { quoteRequest: state.quoteRequest === null ? null : { previewId: state.quoteRequest.previewId, customerWords: state.quoteRequest.customerWords, sinceVersion: state.quoteRequest.sinceVersion } } : {}),
  };
}

/** Catalog keys an observation speaks about: search results' productKeys; a product context's key, sellable item and variant itemKeys. */
function catalogKeysOf(o: Observation): unknown[] {
  if (o.source.capabilityId === CAPABILITY_IDS.productContext) {
    const payload = o.payload as { status?: unknown; productKey?: unknown; facts?: { sellableItemKey?: unknown; variantOptions?: { itemKey?: unknown }[] } } | null;
    if (payload?.status !== 'found') return [];
    return [payload.productKey, payload.facts?.sellableItemKey, ...(payload.facts?.variantOptions ?? []).map((v) => v.itemKey)];
  }
  if (o.source.capabilityId === CAPABILITY_IDS.catalogSearch) return ((o.payload as { results?: { productKey?: unknown }[] } | null)?.results ?? []).map((r) => r.productKey);
  return [];
}

/** Newest successful catalog observation mentioning each catalog key, with whether it is still current (R4 and owner windows). */
function catalogEvidence(observations: readonly Observation[], now: Date): Map<string, { observationId: string; current: boolean }> {
  const out = new Map<string, { observationId: string; current: boolean; observedAt: string }>();
  for (const o of observations) {
    if (o.source.kind !== 'capability' || o.outcome !== 'succeeded') continue;
    for (const id of new Set(catalogKeysOf(o))) {
      if (typeof id !== 'string') continue;
      const previous = out.get(id);
      if (!previous || o.observedAt > previous.observedAt || (o.observedAt === previous.observedAt && o.observationId > previous.observationId)) {
        const validUntil = catalogEvidenceValidUntil(o);
        out.set(id, { observationId: o.observationId, current: validUntil === null || Date.parse(validUntil) > now.getTime(), observedAt: o.observedAt });
      }
    }
  }
  return new Map([...out].map(([id, { observationId, current }]) => [id, { observationId, current }]));
}

function isCurrent(o: Observation, now: Date): boolean {
  return o.validUntil === null || Date.parse(o.validUntil) > now.getTime();
}

function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  return norm(a) === norm(b);
}

function sameSelection(items: unknown, selection: readonly { productId: string; quantity: number }[]): boolean {
  if (!Array.isArray(items)) return false;
  const key = (list: readonly { productId: string; quantity: number }[]) => list.map((i) => `${i.productId}×${i.quantity}`).sort().join(',');
  const requested = items.filter((i): i is { productId: string; quantity: number } => typeof (i as { productId?: unknown }).productId === 'string' && typeof (i as { quantity?: unknown }).quantity === 'number');
  return requested.length === items.length && key(requested) === key(selection);
}
