import type {
  AgentDecision,
  CompiledContext,
  JsonObject,
  JsonValue,
  Observation,
  ProposeActionDecision,
  ReadCapabilityDecision,
  RunStep,
  TerminationReason,
} from '@r4/contracts';
import type { ExecutionContext, ExecutionState } from './context.js';

/**
 * Port between the kernel and durable execution. The kernel never persists
 * anything itself: every durable effect of the loop goes through this
 * interface, and an implementation must perform each call as an owner-only
 * (fenced) write — or refuse it.
 */
export interface KernelSession {
  /** Rebuilds the execution state from durable storage after verifying ownership. */
  load(): Promise<ExecutionState>;
  /**
   * The context of the model call about to be made for `context.iteration`
   * (R4-C2). The implementation compiles it and makes its ContextSnapshot
   * durable BEFORE returning — or returns the snapshot already recorded for
   * this iteration when its inputs have not changed (recovery). The kernel
   * never knows how the context was built; it only sends it.
   */
  prepareContext(context: ExecutionContext): Promise<PreparedContext>;
  /**
   * Appends a non-terminal iteration (READ → pending, propose_action → pending,
   * respond → recorded). READs get their invocation id here; proposals get
   * their proposal id and become a durable ActionProposal in the same write.
   */
  recordStep(step: StepRecord): Promise<RunStep>;
  /**
   * Executes a pending READ with its recorded invocation id and returns the
   * persisted observation — the only evidence of the result. Must be
   * idempotent: an invocation that already has an observation is not re-run.
   */
  executeRead(step: RunStep, decision: ReadCapabilityDecision): Promise<Observation>;
  /**
   * (R4-D) Resolves a pending proposed action through the platform's governed
   * path — validation, deterministic policy, command with a platform
   * execution key, attempts, receipt — from wherever its durable ledger
   * stands, and returns its persisted observation, or the termination the
   * platform already recorded when the run cannot continue (approval
   * required, outcome unknown). The kernel never sees a write handler and
   * never decides whether, how or how often a write executes.
   */
  executeAction(step: RunStep, decision: ProposeActionDecision): Promise<ActionOutcome>;
  /** Ends the run (and task) with a structured termination; `finalStep` is written atomically with it. */
  finish(ending: RunEnding): Promise<void>;
}

export type ActionOutcome =
  /** The outcome is durable (denied, rejected, or receipt-backed); the loop continues with it in context. */
  | { readonly kind: 'observed'; readonly observation: Observation }
  /** The platform ended the run itself, atomically with the evidence; the kernel only reports it. */
  | { readonly kind: 'suspended'; readonly termination: KernelTermination };

export type PreparedContext =
  /** `snapshotId` is durable: the model call below is made with exactly `context`. */
  | { readonly kind: 'ready'; readonly snapshotId: string; readonly context: CompiledContext; readonly reused: boolean }
  /** What the context policy requires does not fit its budget: no model call is possible. */
  | { readonly kind: 'budget_exhausted'; readonly limit: number; readonly required: number };

export interface StepRecord {
  readonly runId: string;
  readonly iteration: number;
  readonly decision: AgentDecision | null;
  readonly outcome: 'pending' | 'recorded' | 'refused' | 'invalid' | 'model_failed';
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** The ContextSnapshot the step's model call was made with (always set by the kernel). */
  readonly contextSnapshotId?: string | null;
}

export interface KernelTermination {
  readonly reason: TerminationReason;
  readonly code: string;
  readonly message: string;
  readonly details: JsonValue | null;
}

export interface RunEnding {
  readonly termination: KernelTermination;
  readonly result: JsonObject | null;
  readonly finalStep: StepRecord | null;
}

/** Why the kernel stopped WITHOUT ending the run. The run stays resumable. */
export type InterruptionCause =
  /** Ownership lost: another worker may own the task now. Nothing more may be written. */
  | 'lease_lost'
  /** The task left `running` (e.g. cancelled) or has no active run. */
  | 'task_not_runnable'
  /** The worker asked the kernel to stop (shutdown). */
  | 'stopped'
  /** Durable storage unreachable: nothing can be recorded, so the run is left to be resumed. */
  | 'unavailable';

/**
 * Thrown by a KernelSession to stop the loop without ending the run. Any other
 * error from the session is treated as a platform failure.
 */
export class KernelInterrupt extends Error {
  readonly interruption: InterruptionCause;

  constructor(interruption: InterruptionCause, message?: string, options?: { cause?: unknown }) {
    super(message ?? `kernel interrupted: ${interruption}`, options);
    this.name = 'KernelInterrupt';
    this.interruption = interruption;
  }
}
