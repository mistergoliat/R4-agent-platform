import type { AutonomyControlsState } from './autonomy.js';
import type { ProviderStatusEvent } from './channel.js';
import type { DispatchDecision, DispatchFacts, OutboundOrigin, OutboundStatus, SubmissionDisposition, SubmissionResult } from './delivery.js';
import type { InboundInspector } from './inspection.js';

/**
 * Persistence port of R4-I production state. Only operational state needed
 * for idempotency, conversation binding, delivery lifecycle and
 * audit/reconciliation — everything else (conversation text, decisions,
 * ownership, effects) stays with its existing owners and is only read.
 * Implementations must be durable and safe under concurrent processes
 * (unique constraints and row locks, never in-memory checks).
 */

export interface AutonomyControlRecord {
  /** `global` or `channel:<id>`. */
  readonly scope: string;
  readonly autonomyEnabled: boolean;
  readonly reason: string;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly version: number;
}

export interface AutonomyControlChange {
  readonly scope: string;
  readonly autonomyEnabled: boolean;
  readonly reason: string;
  readonly changedBy: string;
  readonly correlationId: string;
}

export type InboundStatus = 'received' | 'ingested' | 'rejected' | 'failed';

export interface InboundEventRecord {
  readonly inboundId: string;
  readonly channel: string;
  readonly providerEventId: string;
  readonly status: InboundStatus;
  /** text | unsupported | rejected */
  readonly contentKind: string;
  readonly contentType: string | null;
  /** Canonical text, kept only until the input is durable in R4 (then cleared). */
  readonly content: string | null;
  readonly contentSha256: string | null;
  readonly conversationKey: string | null;
  readonly accountRef: string | null;
  /** Delivery address, kept only until the binding holds it (then cleared). */
  readonly conversationRef: string | null;
  readonly bindingId: string | null;
  readonly taskId: string | null;
  readonly inputId: string | null;
  /** autonomous | held:<reason> | duplicate_task_input … */
  readonly disposition: string | null;
  readonly failureCode: string | null;
  readonly occurredAt: string | null;
  readonly receivedAt: string;
  readonly settledAt: string | null;
  readonly correlationId: string;
}

export interface NewInboundEvent {
  readonly inboundId: string;
  readonly channel: string;
  readonly providerEventId: string;
  readonly contentKind: 'text' | 'unsupported' | 'rejected';
  readonly contentType: string | null;
  readonly content: string | null;
  readonly contentSha256: string | null;
  readonly conversationKey: string | null;
  readonly accountRef: string | null;
  readonly conversationRef: string | null;
  readonly occurredAt: string | null;
  readonly status: 'received' | 'rejected';
  readonly failureCode: string | null;
  readonly correlationId: string;
}

/** What the inbound transaction needs, besides the event, to build the trusted context. */
export interface InspectedInbound {
  readonly inspector: InboundInspector;
  /** False for unsupported content: persisted as its marker, never inspected. */
  readonly inspectable: boolean;
  readonly senderRef: string;
  /** The adapter attests a direct conversation and senderRef is the conversation reference. */
  readonly direct: boolean;
}

export interface InboundSettlement {
  readonly status: 'ingested' | 'failed';
  readonly bindingId?: string | null;
  readonly taskId?: string | null;
  readonly inputId?: string | null;
  readonly disposition?: string | null;
  readonly failureCode?: string | null;
}

export interface ConversationBindingRecord {
  readonly bindingId: string;
  readonly channel: string;
  readonly conversationKey: string;
  readonly accountRef: string;
  readonly recipientRef: string;
  readonly taskId: string | null;
  readonly status: 'open' | 'closed';
  /** Decided once when the binding opens (stable cohort per conversation). */
  readonly autonomy: 'autonomous' | 'excluded';
  readonly eligibilityReason: string;
  readonly rolloutFingerprint: string;
  readonly profile: string;
  readonly profileFingerprint: string;
  readonly createdAt: string;
  readonly lastInboundAt: string | null;
  readonly closedAt: string | null;
  readonly closedReason: string | null;
}

export interface NewConversationBinding {
  readonly bindingId: string;
  readonly channel: string;
  readonly conversationKey: string;
  readonly accountRef: string;
  readonly recipientRef: string;
  readonly autonomy: 'autonomous' | 'excluded';
  readonly eligibilityReason: string;
  readonly rolloutFingerprint: string;
  readonly profile: string;
  readonly profileFingerprint: string;
}

export interface TaskStateFacts {
  readonly status: string;
  readonly terminalIntent: boolean;
  /** A handoff is requested or active (humans own the task). */
  readonly humanOwned: boolean;
}

export interface OutboundRecord {
  readonly outboundId: string;
  readonly origin: OutboundOrigin;
  /** The accepted `respond` step (agent origin): the durable response identity. */
  readonly responseStepId: string | null;
  readonly taskId: string;
  readonly runId: string | null;
  readonly bindingId: string;
  readonly channel: string;
  readonly idempotencyKey: string;
  readonly contentSha256: string;
  readonly status: OutboundStatus;
  readonly holdReason: string | null;
  readonly cancelReason: string | null;
  readonly duplicateOf: string | null;
  readonly providerMessageId: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: string | null;
  readonly errorClass: string | null;
  readonly errorCode: string | null;
  /** Operator origin: who wrote it; operator resolution: who settled it. */
  readonly humanRef: string | null;
  readonly resolvedBy: string | null;
  readonly profile: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatchedAt: string | null;
  readonly acceptedAt: string | null;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  readonly failedAt: string | null;
  readonly correlationId: string;
}

export interface DeliveryAttemptRecord {
  readonly outboundId: string;
  readonly attempt: number;
  readonly leaseGeneration: number;
  readonly owner: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** accepted | not_sent | rejected | unknown | null (in flight, or the process died) */
  readonly outcome: string | null;
  readonly providerMessageId: string | null;
  readonly httpStatus: number | null;
  readonly errorClass: string | null;
  readonly errorCode: string | null;
  readonly latencyMs: number | null;
}

export interface DeliveryEventRecord {
  readonly eventId: string;
  readonly channel: string;
  readonly eventKey: string;
  readonly outboundId: string | null;
  readonly providerMessageId: string;
  readonly status: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  /** applied | ignored | unmatched */
  readonly effect: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly errorCode: string | null;
}

/** Proof of dispatch ownership of one outbound: owner + fencing generation. */
export interface DispatchToken {
  readonly outboundId: string;
  readonly owner: string;
  readonly generation: number;
  readonly attempt: number;
}

export type DispatchClaim =
  | { readonly kind: 'dispatch'; readonly outbound: OutboundRecord; readonly token: DispatchToken; readonly accountRef: string; readonly recipientRef: string; readonly text: string }
  | { readonly kind: 'held'; readonly outbound: OutboundRecord; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly outbound: OutboundRecord; readonly reason: string };

export interface ClaimOutboundCommand {
  readonly owner: string;
  readonly leaseMs: number;
  /** A held outbound is re-evaluated no earlier than this. */
  readonly holdRecheckMs: number;
  readonly customerWindowMs: (channel: string) => number | null;
  readonly deniedNow: (conversationKey: string) => boolean;
  /** The pure gate (decideDispatch), called with facts read in the claim transaction. */
  readonly decide: (facts: DispatchFacts) => DispatchDecision;
}

export interface NewOperatorOutbound {
  readonly outboundId: string;
  readonly taskId: string;
  readonly text: string;
  readonly humanRef: string;
  readonly responseKey: string;
  readonly correlationId: string;
}

export interface ThreadEntry {
  /** Stable ordering cursor (`<iso time>|<id>`). */
  readonly cursor: string;
  readonly at: string;
  readonly kind: 'contact' | 'agent' | 'operator' | 'event';
  readonly text: string | null;
  readonly refs: Readonly<Record<string, string | null>>;
  readonly delivery: { readonly outboundId: string; readonly status: OutboundStatus; readonly holdReason: string | null; readonly cancelReason: string | null; readonly providerMessageId: string | null } | null;
}

export interface ConversationSummary {
  readonly bindingId: string;
  readonly channel: string;
  readonly taskId: string | null;
  readonly taskStatus: string | null;
  readonly bindingStatus: 'open' | 'closed';
  readonly autonomy: 'autonomous' | 'excluded';
  readonly humanOwned: boolean;
  readonly lastInboundAt: string | null;
  readonly createdAt: string;
}

export interface ProductionAttention {
  readonly unknownOutbound: readonly OutboundRecord[];
  readonly heldOutbound: readonly OutboundRecord[];
  readonly failedOutbound: readonly OutboundRecord[];
  readonly failedInbound: readonly InboundEventRecord[];
  readonly rejectedInbound: readonly InboundEventRecord[];
  readonly unmatchedStatusEvents: readonly DeliveryEventRecord[];
}

/** Counters derived from durable production state (never from logs). */
export interface ProductionMetrics {
  readonly inbound_received: number;
  readonly inbound_duplicate: number;
  readonly inbound_rejected: number;
  readonly inbound_failed: number;
  readonly task_created: number;
  readonly task_continued: number;
  readonly inbound_held: Readonly<Record<string, number>>;
  readonly outbound_created: number;
  readonly outbound_dispatch_attempted: number;
  readonly outbound_accepted: number;
  readonly outbound_delivered: number;
  readonly outbound_read: number;
  readonly outbound_failed: number;
  readonly outbound_unknown: number;
  readonly outbound_cancelled: Readonly<Record<string, number>>;
  readonly outbound_held_now: number;
  readonly kill_switch_blocks: number;
  readonly rollout_blocks: number;
  readonly human_handoffs: number;
  readonly approvals: number;
  readonly run_failure_recoveries: number;
  readonly model_calls: number;
  /** Governed write commands (R4-D) by capability; which of them reach a REAL owner is stated by the production profile. */
  readonly writes_by_capability: Readonly<Record<string, number>>;
  readonly latency: {
    readonly outboundDispatchMs: { readonly p50: number | null; readonly p95: number | null; readonly n: number };
    readonly deliveryConfirmationMs: { readonly p50: number | null; readonly p95: number | null; readonly n: number };
    readonly customerTurnMs: { readonly p50: number | null; readonly p95: number | null; readonly n: number };
  };
}

export interface ProductionStore {
  // Autonomy controls (kill switch). A missing row reads as DISABLED.
  readControls(): Promise<{ readonly state: AutonomyControlsState; readonly records: readonly AutonomyControlRecord[] }>;
  setControl(change: AutonomyControlChange): Promise<AutonomyControlRecord>;

  // Inbound (dedupe by provider event identity under a unique constraint).
  recordInbound(event: NewInboundEvent): Promise<{ readonly record: InboundEventRecord; readonly created: boolean }>;
  /**
   * R4-I.1 (ADR-040): one transaction under the conversation lock — duplicate check first (a
   * re-delivery is never inspected), then the trusted context (open binding, task state, database
   * clock), then the inspector, then the insert of the decided text and its sha256. `event.content`
   * is the candidate text (`contentSha256` is ignored and recomputed from the decided text).
   */
  recordInboundInspected(event: NewInboundEvent, inspected: InspectedInbound): Promise<{ readonly record: InboundEventRecord; readonly created: boolean }>;
  settleInbound(inboundId: string, settlement: InboundSettlement): Promise<void>;
  /** Received but never settled (a crash between persistence and ingestion). */
  unsettledInbound(olderThanMs: number, limit: number): Promise<InboundEventRecord[]>;

  // Conversation binding (at most one open binding per conversation, by unique constraint).
  findOpenBinding(channel: string, conversationKey: string): Promise<ConversationBindingRecord | null>;
  /** Inserts, or returns the open binding a concurrent writer created first. */
  openBinding(binding: NewConversationBinding): Promise<ConversationBindingRecord>;
  attachTask(bindingId: string, taskId: string): Promise<ConversationBindingRecord>;
  closeBinding(bindingId: string, reason: string): Promise<void>;
  touchBinding(bindingId: string, at: string): Promise<void>;
  bindingByTask(taskId: string): Promise<ConversationBindingRecord | null>;
  taskState(taskId: string): Promise<TaskStateFacts | null>;

  // Outbound (the delivery owner's state).
  /**
   * Creates the outbound of every accepted `respond` of a bound task that has
   * none yet (one per step, by unique constraint). A matching agent response
   * is created cancelled (`duplicate_content`) only when a live outbound of
   * the same task represents the same latest evaluated inbound input and the
   * candidate snapshot includes every currently durable task input.
   */
  materializeResponses(command: { readonly limit: number }): Promise<OutboundRecord[]>;
  createOperatorOutbound(command: NewOperatorOutbound): Promise<{ readonly record: OutboundRecord; readonly replayed: boolean }>;
  claimNextOutbound(command: ClaimOutboundCommand): Promise<DispatchClaim | null>;
  /** Fenced by the token; a lost lease still records provider acceptance as evidence (unknown → accepted). */
  recordSubmission(token: DispatchToken, result: SubmissionResult, disposition: SubmissionDisposition): Promise<{ readonly applied: boolean; readonly outbound: OutboundRecord }>;
  /** `dispatching` rows whose lease expired (the dispatcher died mid-call) become `unknown`. */
  expireDispatchLeases(limit: number): Promise<OutboundRecord[]>;
  applyProviderStatus(event: ProviderStatusEvent): Promise<{ readonly duplicate: boolean; readonly effect: 'applied' | 'ignored' | 'unmatched'; readonly outbound: OutboundRecord | null; readonly from: OutboundStatus | null; readonly to: OutboundStatus | null }>;
  resolveOutbound(command: { readonly outboundId: string; readonly outcome: 'delivered' | 'failed'; readonly humanRef: string; readonly note: string; readonly correlationId: string }): Promise<OutboundRecord>;
  cancelOutbound(command: { readonly outboundId: string; readonly humanRef: string; readonly reason: string; readonly correlationId: string }): Promise<OutboundRecord>;
  /** Cancels every pending agent outbound of the task (a human took over). */
  cancelPendingAgentOutbound(taskId: string, reason: string): Promise<number>;

  // Read side.
  outbound(outboundId: string): Promise<OutboundRecord | null>;
  outboundForTask(taskId: string): Promise<OutboundRecord[]>;
  attempts(outboundId: string): Promise<DeliveryAttemptRecord[]>;
  deliveryEvents(outboundId: string): Promise<DeliveryEventRecord[]>;
  thread(taskId: string): Promise<ThreadEntry[]>;
  conversations(limit: number): Promise<ConversationSummary[]>;
  attention(): Promise<ProductionAttention>;
  metrics(): Promise<ProductionMetrics>;
}
