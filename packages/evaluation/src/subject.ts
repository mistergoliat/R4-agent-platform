import { z } from 'zod';
import {
  actionAttemptSchema,
  actionExecutionSchema,
  actionProposalSchema,
  actionReceiptSchema,
  goalSchema,
  nonNegativeIntSchema,
  observationSchema,
  policyDecisionSchema,
  runStatusSchema,
  runStepSchema,
  runTerminationSchema,
  runUsageSchema,
  taskStatusSchema,
  taskWaitSchema,
  timestampSchema,
  uuidSchema,
} from '@r4/contracts';

/**
 * EvaluationSubject (R4-G): the canonical, finished trajectory of one task as
 * Quality sees it. It is a read model rebuilt from durable R4 state (or from a
 * fixture shaped exactly like it) — never from log text — and it is the only
 * input any evaluator receives. It contains decisions, observations, the
 * governed-action ledger, goals, waits and pack-supplied domain projections;
 * it contains no chain-of-thought (R4 never stores any) and no secret.
 *
 * The subject is a projection, not a copy of truth: execution truth stays in
 * its owners' stores. When an evaluation run keeps a snapshot of it, that
 * snapshot is an immutable evaluation artifact, separate from the source.
 */
export const SUBJECT_SCHEMA_VERSION = 'r4.evaluation_subject.v1';

export const contextSnapshotMetaSchema = z.strictObject({
  snapshotId: uuidSchema,
  runId: uuidSchema,
  iteration: z.int().positive(),
  attempt: z.int().positive(),
  estimatedTokens: nonNegativeIntSchema,
  includedTokensByKind: z.record(z.string(), nonNegativeIntSchema),
  includedTokensBySource: z.record(z.string(), nonNegativeIntSchema),
  compactedCount: nonNegativeIntSchema,
  includedItemIds: z.array(z.string()),
  excludedItemIds: z.array(z.string()),
});
export type ContextSnapshotMeta = z.infer<typeof contextSnapshotMetaSchema>;

export const subjectTurnSchema = z.strictObject({
  index: z.int().positive(),
  kind: z.enum(['input', 'human_response']),
  /** The context item id under which the platform showed this turn to the model. */
  itemRef: z.string().min(1),
  text: z.string(),
  at: timestampSchema,
});
export type SubjectTurn = z.infer<typeof subjectTurnSchema>;

export const subjectRunSchema = z.strictObject({
  runId: uuidSchema,
  sequence: z.int().positive(),
  status: runStatusSchema,
  termination: runTerminationSchema.nullable(),
  usage: runUsageSchema,
  recoveries: nonNegativeIntSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  /** The latest turn this run could see (null when no context snapshot shows one). */
  turnIndex: z.int().positive().nullable(),
  steps: z.array(runStepSchema),
  contexts: z.array(contextSnapshotMetaSchema),
});
export type SubjectRun = z.infer<typeof subjectRunSchema>;

/** Position in the step log: order is never taken from timestamps of different clocks. */
export const positionSchema = z.strictObject({ run: z.int().positive(), iteration: z.int().positive() });
export type Position = z.infer<typeof positionSchema>;

export const subjectResponseSchema = z.strictObject({
  /** The id of the run step that recorded the `respond` decision. */
  responseId: uuidSchema,
  runId: uuidSchema,
  position: positionSchema,
  turnIndex: z.int().positive().nullable(),
  text: z.string(),
  /** Observations whose items were in the context of the call that produced this response. */
  evidenceInContext: z.array(uuidSchema),
  snapshotId: uuidSchema.nullable(),
});
export type SubjectResponse = z.infer<typeof subjectResponseSchema>;

export const domainProjectionSchema = z.strictObject({
  /** Pack that owns the projected state. */
  owner: z.string().min(1).max(64),
  schemaVersion: z.string().min(1).max(64),
  data: z.json(),
});
export type DomainProjection = z.infer<typeof domainProjectionSchema>;

/**
 * Per-call metadata recorded by a harness around the model provider (never
 * by the platform, which persists only validated decisions). Optional: when
 * present it refines protocol failures (e.g. two decisions vs. trailing text)
 * and gives per-call latency. It never contains output text.
 */
export const modelCallRecordSchema = z.strictObject({
  index: z.int().positive(),
  runId: uuidSchema.nullable(),
  finishReason: z.string().nullable(),
  inputTokens: nonNegativeIntSchema.nullable(),
  outputTokens: nonNegativeIntSchema.nullable(),
  /** Only when the provider exposes a count; never reasoning text. */
  reasoningTokens: nonNegativeIntSchema.nullable(),
  latencyMs: nonNegativeIntSchema,
  /** Structure of an unparseable output: decision documents found and characters outside them. */
  unparsedShape: z.strictObject({ chars: nonNegativeIntSchema, jsonDocuments: z.array(z.string().nullable()), otherTextChars: nonNegativeIntSchema }).nullable(),
  error: z.string().max(500).nullable(),
});
export type ModelCallRecord = z.infer<typeof modelCallRecordSchema>;

export const evaluationSubjectSchema = z.strictObject({
  schemaVersion: z.literal(SUBJECT_SCHEMA_VERSION),
  subjectId: z.string().min(1),
  source: z.strictObject({ kind: z.enum(['durable', 'fixture']), ref: z.string().min(1).max(512) }),
  task: z.strictObject({
    taskId: uuidSchema,
    taskType: z.string(),
    agentId: z.string(),
    agentVersion: z.int().positive(),
    status: taskStatusSchema,
    statusReason: z.string().nullable(),
    rootGoalId: uuidSchema.nullable(),
    currentGoalId: uuidSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
  agent: z.strictObject({ agentId: z.string(), version: z.int().positive(), contentHash: z.string().nullable() }),
  turns: z.array(subjectTurnSchema),
  runs: z.array(subjectRunSchema),
  responses: z.array(subjectResponseSchema),
  observations: z.array(observationSchema),
  actions: z.strictObject({
    proposals: z.array(actionProposalSchema),
    policyDecisions: z.array(policyDecisionSchema),
    executions: z.array(actionExecutionSchema),
    attempts: z.array(actionAttemptSchema),
    receipts: z.array(actionReceiptSchema),
  }),
  goals: z.array(goalSchema),
  goalTransitions: z.array(z.strictObject({ type: z.string(), goalId: z.string(), at: timestampSchema })),
  temporal: z.strictObject({
    waits: z.array(taskWaitSchema),
    humanRequests: z.array(z.strictObject({ requestId: uuidSchema, kind: z.string(), status: z.string(), createdAt: timestampSchema })),
  }),
  domain: z.record(z.string(), domainProjectionSchema),
  modelCalls: z.array(modelCallRecordSchema).nullable(),
});
export type EvaluationSubject = z.infer<typeof evaluationSubjectSchema>;

export function parseEvaluationSubject(value: unknown): EvaluationSubject {
  const parsed = evaluationSubjectSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid EvaluationSubject: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// --- helpers every evaluator uses -------------------------------------------------

export function comparePositions(a: Position, b: Position): number {
  return a.run === b.run ? a.iteration - b.iteration : a.run - b.run;
}

export type SubjectStep = EvaluationSubject['runs'][number]['steps'][number] & { readonly position: Position; readonly turnIndex: number | null };

/** Every step in log order, with its position and turn. */
export function stepsOf(subject: EvaluationSubject): SubjectStep[] {
  return [...subject.runs]
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((r) => [...r.steps].sort((a, b) => a.iteration - b.iteration).map((s) => ({ ...s, position: { run: r.sequence, iteration: s.iteration }, turnIndex: r.turnIndex })));
}

/** Position of the step that produced each observation. */
export function observationPositions(subject: EvaluationSubject): Map<string, Position> {
  const out = new Map<string, Position>();
  for (const s of stepsOf(subject)) if (s.observationId) out.set(s.observationId, s.position);
  return out;
}

/** Position of the step that proposed each action. */
export function proposalPositions(subject: EvaluationSubject): Map<string, Position> {
  const byStep = new Map(stepsOf(subject).map((s) => [s.stepId, s.position]));
  const out = new Map<string, Position>();
  for (const p of subject.actions.proposals) {
    const at = byStep.get(p.stepId);
    if (at) out.set(p.proposalId, at);
  }
  return out;
}
