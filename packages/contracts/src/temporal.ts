import { z } from 'zod';
import { goalDescriptionSchema, successCriteriaSchema } from './goal.js';
import { correlationIdSchema, jsonObjectSchema, nonNegativeIntSchema, positiveIntSchema, timestampSchema, uniqueArray, uuidSchema } from './primitives.js';

/**
 * R4-E temporal + human runtime contracts (ADR-021, ADR-022).
 *
 * The model may only *ask*: to wait, to consult a human, to hand the task
 * over, to change its own cognitive goals. Everything that makes such a
 * request durable — identities, owners, timestamps, versions, leases — is
 * set by the platform. These schemas are strict: a model-supplied trusted
 * field is rejected, never stripped.
 */

// ---------------------------------------------------------------------------
// Agent decisions (proposals the Temporal Runtime validates)
// ---------------------------------------------------------------------------

export const WAIT_KINDS = ['WAIT_FOR_INPUT', 'WAIT_UNTIL', 'WAIT_FOR_HUMAN', 'WAIT_FOR_APPROVAL', 'WAIT_FOR_RECONCILIATION'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/**
 * The only waits an agent can ask for. WAIT_UNTIL is interruptible: relevant
 * inbound input wakes the task before `until`. The others are entered by the
 * platform (a human request, an approval, an uncertain effect).
 */
export const waitDecisionSchema = z.strictObject({
  type: z.literal('wait'),
  condition: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('WAIT_FOR_INPUT') }),
    z.strictObject({ kind: z.literal('WAIT_UNTIL'), until: timestampSchema }),
  ]),
  /** Why the agent stops now, in its own words (shown back to it; never business truth). */
  reason: z.string().trim().min(1).max(1000).optional(),
});
export const consultationDecisionSchema = z.strictObject({
  type: z.literal('request_consultation'),
  /** Explicit question for a human: only what the human needs to answer, never reasoning. */
  question: z.string().trim().min(1).max(4000),
  contextRefs: uniqueArray(uuidSchema).max(100),
  /** Requested deadline; the platform schedules its expiry on the temporal clock. */
  expiresAt: timestampSchema.optional(),
});
export const handoffDecisionSchema = z.strictObject({
  type: z.literal('request_handoff'),
  summary: z.string().trim().min(1).max(4000),
  contextRefs: uniqueArray(uuidSchema).max(100),
});
export const goalChangeSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), parentGoalId: uuidSchema, description: goalDescriptionSchema, successCriteria: successCriteriaSchema, makeCurrent: z.boolean() }),
  z.strictObject({ operation: z.literal('focus'), goalId: uuidSchema }),
  z.strictObject({ operation: z.literal('complete'), goalId: uuidSchema }),
  z.strictObject({ operation: z.literal('abandon'), goalId: uuidSchema }),
]);
export const manageGoalDecisionSchema = z.strictObject({ type: z.literal('manage_goal'), change: goalChangeSchema });
export type GoalChange = z.infer<typeof goalChangeSchema>;
export type WaitDecision = z.infer<typeof waitDecisionSchema>;
export type ManageGoalDecision = z.infer<typeof manageGoalDecisionSchema>;
export type TemporalDecision = WaitDecision | z.infer<typeof consultationDecisionSchema> | z.infer<typeof handoffDecisionSchema> | ManageGoalDecision;

/** Why a goal change was refused. Recoverable: the agent sees it and may try again. */
export const GOAL_REJECTION_CODES = ['goal_not_found', 'goal_task_mismatch', 'goal_not_active'] as const;
export type GoalRejectionCode = (typeof GOAL_REJECTION_CODES)[number];

// ---------------------------------------------------------------------------
// Trusted inputs (constructed by trusted layers, never by a model)
// ---------------------------------------------------------------------------

// (R4-I) `autonomy.control`: change the operational autonomy controls (kill switch).
export const HUMAN_SCOPES = ['consultation.answer', 'approval.decide', 'handoff.manage', 'task.cancel', 'reconciliation.manage', 'autonomy.control'] as const;
export type HumanScope = (typeof HUMAN_SCOPES)[number];

/**
 * An authenticated human operator, built by the API's authentication adapter
 * (a seam: R4 has no production IAM yet). Never read from a request body and
 * never produced by a model.
 */
export const trustedHumanContextSchema = z.strictObject({
  humanRef: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/),
  scopes: uniqueArray(z.enum(HUMAN_SCOPES)),
  correlationId: correlationIdSchema,
});
export type TrustedHumanContext = z.infer<typeof trustedHumanContextSchema>;

/**
 * Canonical inbound input (channel-neutral). `externalKey` is the source's own
 * event identity: the same event re-delivered is one durable input and one
 * effective wake.
 */
export const inputSubmissionSchema = z.strictObject({
  externalKey: z.string().min(1).max(256),
  content: z.string().trim().min(1).max(8000),
  sourceRef: z.string().min(1).max(512),
  occurredAt: timestampSchema,
});
export type InputSubmission = z.infer<typeof inputSubmissionSchema>;

// ---------------------------------------------------------------------------
// Waits and schedules
// ---------------------------------------------------------------------------

export const WAIT_RESOLUTIONS = ['input', 'timer', 'human', 'reconciliation', 'handoff', 'cancelled'] as const;
export type WaitResolution = (typeof WAIT_RESOLUTIONS)[number];

export const taskWaitSchema = z.strictObject({
  waitId: uuidSchema,
  taskId: uuidSchema,
  runId: uuidSchema.nullable(),
  kind: z.enum(WAIT_KINDS),
  status: z.enum(['waiting', 'completed', 'cancelled']),
  resolution: z.enum(WAIT_RESOLUTIONS).nullable(),
  /** Human request, execution or null (input/timer waits). */
  referenceId: uuidSchema.nullable(),
  dueAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  correlationId: correlationIdSchema,
});
export type TaskWait = z.infer<typeof taskWaitSchema>;

/**
 * Explicit operator configuration for reconciling uncertain effects. There is
 * no built-in production value: the scheduler refuses to start without one.
 */
export const reconciliationPolicySchema = z
  .strictObject({
    maxAttempts: positiveIntSchema,
    initialBackoffMs: nonNegativeIntSchema,
    maxBackoffMs: nonNegativeIntSchema,
    deadlineMs: positiveIntSchema,
  })
  .refine((p) => p.maxBackoffMs >= p.initialBackoffMs, 'maximum backoff must cover initial backoff');
export type ReconciliationPolicy = z.infer<typeof reconciliationPolicySchema>;

export const SCHEDULE_KINDS = ['wake', 'reconciliation', 'human_expiry', 'action_retry'] as const;
export const SCHEDULE_STATUSES = ['pending', 'claimed', 'fired', 'dispatched', 'in_progress', 'completed', 'cancelled', 'exhausted'] as const;
export const scheduleSchema = z.strictObject({
  scheduleId: uuidSchema,
  taskId: uuidSchema,
  kind: z.enum(SCHEDULE_KINDS),
  referenceId: uuidSchema,
  status: z.enum(SCHEDULE_STATUSES),
  dueAt: timestampSchema,
  deadlineAt: timestampSchema.nullable(),
  policy: reconciliationPolicySchema.nullable(),
  attempts: nonNegativeIntSchema,
  owner: z.string().nullable(),
  generation: nonNegativeIntSchema,
  leaseExpiresAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  correlationId: correlationIdSchema,
});
export type Schedule = z.infer<typeof scheduleSchema>;
/** Proof of schedule ownership (scheduler or reconciling worker): owner + fencing generation. */
export interface ScheduleToken {
  readonly scheduleId: string;
  readonly taskId: string;
  readonly owner: string;
  readonly generation: number;
}

// ---------------------------------------------------------------------------
// Human requests and responses
// ---------------------------------------------------------------------------

const humanBase = {
  requestId: uuidSchema,
  taskId: uuidSchema,
  runId: uuidSchema.nullable(),
  status: z.enum(['requested', 'answered', 'approved', 'rejected', 'active', 'released', 'cancelled', 'expired']),
  humanRef: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
  correlationId: correlationIdSchema,
};
export const humanRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...humanBase, kind: z.literal('consultation'), payload: z.strictObject({ question: z.string(), contextRefs: z.array(uuidSchema) }) }),
  z.strictObject({
    ...humanBase,
    kind: z.literal('handoff'),
    /**
     * `agent`: the agent asked; `operator`: a trusted human took ownership on
     * their own initiative; `platform` (ADR-028): the platform handed the
     * task over because a run failure left no autonomous way on — `reason`
     * (a status reason code) says why, and is present exactly for it.
     */
    payload: z
      .strictObject({
        summary: z.string(),
        contextRefs: z.array(uuidSchema),
        initiatedBy: z.enum(['agent', 'operator', 'platform']),
        reason: z.string().max(128).regex(/^[a-z][a-z0-9_.]*$/).optional(),
      })
      .refine((p) => (p.initiatedBy === 'platform') === (p.reason !== undefined), { message: 'reason is present exactly for a platform-initiated handoff', path: ['reason'] }),
  }),
  z.strictObject({
    ...humanBase,
    kind: z.literal('approval'),
    payload: z.strictObject({
      proposalId: uuidSchema,
      policyDecisionId: uuidSchema,
      capabilityId: z.string(),
      capabilityVersion: positiveIntSchema,
      argumentsHash: z.string(),
      validatedArguments: jsonObjectSchema,
    }),
  }),
]);
export type HumanRequest = z.infer<typeof humanRequestSchema>;
export type Consultation = Extract<HumanRequest, { kind: 'consultation' }>;
export type ApprovalRequest = Extract<HumanRequest, { kind: 'approval' }>;
export type Handoff = Extract<HumanRequest, { kind: 'handoff' }>;

/** A human response. `responseKey` is the caller's idempotency key for this response. */
export const humanResponseSchema = z.strictObject({
  responseKey: z.string().min(1).max(256),
  outcome: z.enum(['answer', 'approve', 'reject', 'accept', 'release', 'cancel']),
  content: z.string().trim().min(1).max(8000),
});
export type HumanResponse = z.infer<typeof humanResponseSchema>;

/** Operator-initiated takeover of a task (no prior agent request needed). */
export const handoffTakeoverSchema = z.strictObject({
  responseKey: z.string().min(1).max(256),
  note: z.string().trim().min(1).max(8000),
});
export type HandoffTakeover = z.infer<typeof handoffTakeoverSchema>;

export interface ApprovalEvidence {
  readonly requestId: string;
  readonly proposalId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly argumentsHash: string;
}

/** Append-only temporal evidence (`temporal_events`). Human decisions carry `data.content`. */
export interface TemporalEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly entityId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly actorRef: string;
  readonly responseKey: string | null;
  readonly data: Record<string, unknown>;
}
export type ApprovalDecision = TemporalEvent & { readonly type: 'approval.approved' | 'approval.rejected' };

/**
 * Who may act as the task's owner right now, derived from durable records
 * only. `blockedBy` makes `blocked` unambiguous for an operator plane.
 */
export interface TaskOwnership {
  readonly owner: 'agent' | 'human' | 'none';
  readonly humanRef: string | null;
  readonly blockedBy: readonly ('human_handoff' | 'uncertain_action' | 'approval' | 'wait')[];
  readonly terminalIntent: 'cancelled' | 'failed' | null;
}
