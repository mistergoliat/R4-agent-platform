import type {
  AgentDecision,
  JsonObject,
  JsonValue,
  Observation,
  ReadCapabilityDecision,
  RunStep,
  TerminationReason,
} from '@r4/contracts';
import type { ExecutionState } from './context.js';

/**
 * Port between the kernel and durable execution. The kernel never persists
 * anything itself: every durable effect of the loop goes through this
 * interface, and an implementation must perform each call as an owner-only
 * (fenced) write — or refuse it.
 */
export interface KernelSession {
  /** Rebuilds the execution state from durable storage after verifying ownership. */
  load(): Promise<ExecutionState>;
  /** Appends a non-terminal iteration (READ → pending, respond → recorded). READs get their invocation id here. */
  recordStep(step: StepRecord): Promise<RunStep>;
  /**
   * Executes a pending READ with its recorded invocation id and returns the
   * persisted observation — the only evidence of the result. Must be
   * idempotent: an invocation that already has an observation is not re-run.
   */
  executeRead(step: RunStep, decision: ReadCapabilityDecision): Promise<Observation>;
  /** Ends the run (and task) with a structured termination; `finalStep` is written atomically with it. */
  finish(ending: RunEnding): Promise<void>;
}

export interface StepRecord {
  readonly runId: string;
  readonly iteration: number;
  readonly decision: AgentDecision | null;
  readonly outcome: 'pending' | 'recorded' | 'refused' | 'invalid' | 'model_failed';
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
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
