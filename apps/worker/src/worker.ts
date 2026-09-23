import type { AgentTask, TaskLease } from '@r4/contracts';
import { KernelInterrupt, type AgentKernel, type KernelOutcome, type KernelSession } from '@r4/agent-kernel';
import { emitTelemetry, runWithCorrelation, type StructuredLogger } from '@r4/observability';
import type { ExecutionRuntime } from '@r4/task-runtime';
import type { Reconciler } from './reconciliation.js';

export interface WorkerOptions {
  readonly workerId: string;
  readonly execution: ExecutionRuntime;
  readonly kernel: AgentKernel;
  /** Builds the durable session for one claimed task. */
  readonly sessions: (claim: { readonly lease: TaskLease; readonly task: AgentTask }) => KernelSession;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  /** (R4-E) Settles due reconciliation of uncertain effects before any task is claimed. */
  readonly reconciler?: Reconciler;
  readonly logger: StructuredLogger;
}

export type WorkerCycle =
  | { readonly kind: 'idle' }
  /** (R4-E) One reconcile attempt of an uncertain effect was made; no task was executed. */
  | { readonly kind: 'reconciled'; readonly taskId: string; readonly executionId: string; readonly outcome: 'resolved' | 'rescheduled' | 'exhausted' }
  /** The claimed run had exhausted its recoveries and was abandoned by the platform. */
  | { readonly kind: 'abandoned'; readonly taskId: string; readonly runId: string }
  | {
      readonly kind: 'executed';
      readonly taskId: string;
      readonly runId: string;
      readonly claim: 'started' | 'resumed';
      readonly takeover: boolean;
      readonly outcome: KernelOutcome;
    };

/**
 * Worker: an executor, not an authority. It claims a task, keeps its lease
 * alive with heartbeats while the kernel runs, and gives the lease back when
 * it stops early. It holds no execution state of its own: which task it runs,
 * how far the run got and what was observed all live in PostgreSQL, so any
 * worker can take over. One task at a time per worker; run several workers
 * for parallelism.
 */
export class Worker {
  readonly #options: WorkerOptions;
  #loop: Promise<void> | null = null;
  #stopping = false;
  #current: AbortController | null = null;
  #wake: (() => void) | null = null;

  constructor(options: WorkerOptions) {
    this.#options = options;
  }

  get workerId(): string {
    return this.#options.workerId;
  }

  /** Polls and executes tasks until `stop()`. Failures of one cycle never stop the loop. */
  start(): void {
    if (this.#loop) throw new Error('worker already started');
    this.#stopping = false;
    emitTelemetry(this.#options.logger, 'worker.started', { workerId: this.#options.workerId, leaseDurationMs: this.#options.leaseDurationMs, heartbeatIntervalMs: this.#options.heartbeatIntervalMs });
    this.#loop = (async () => {
      while (!this.#stopping) {
        let cycle: WorkerCycle = { kind: 'idle' };
        try {
          cycle = await this.runOnce();
        } catch (error) {
          // E.g. database unavailable while claiming: back off and retry.
          this.#options.logger.warn({ workerId: this.#options.workerId, err: describe(error) }, 'worker cycle failed');
        }
        if (cycle.kind === 'idle' && !this.#stopping) await this.#sleep(this.#options.pollIntervalMs);
      }
    })();
  }

  /**
   * Graceful stop: no new claims; the running kernel is interrupted at its
   * next boundary and the lease is released so another worker resumes the
   * run immediately instead of waiting for expiry.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#current?.abort(new KernelInterrupt('stopped'));
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
    emitTelemetry(this.#options.logger, 'worker.stopped', { workerId: this.#options.workerId });
  }

  /** Settles one due reconciliation, or claims at most one task and executes it until the run ends or is interrupted. */
  async runOnce(): Promise<WorkerCycle> {
    const { execution, workerId, leaseDurationMs, reconciler } = this.#options;
    // Reconciliation before cognition: no effect stays ambiguous while this worker could settle it.
    if (reconciler) {
      const reconciled = await reconciler.runOnce();
      if (reconciled.kind === 'reconciled') return reconciled;
    }
    const claim = await execution.claimNext({ workerId, leaseDurationMs });
    if (!claim) return { kind: 'idle' };
    if (claim.kind === 'abandoned') return { kind: 'abandoned', taskId: claim.task.taskId, runId: claim.run.runId };

    const { lease, task, run } = claim;
    const controller = new AbortController();
    this.#current = controller;
    const heartbeat = this.#heartbeat(lease, controller);
    try {
      const session = this.#options.sessions({ lease, task });
      const outcome = await runWithCorrelation(
        { correlationId: task.correlationId, taskId: task.taskId, runId: run.runId, agentId: task.agentId },
        () => this.#options.kernel.run(session, { signal: controller.signal, workerId }),
      );
      if (outcome.kind === 'interrupted') await this.#afterInterruption(lease, run.runId, outcome.cause);
      return { kind: 'executed', taskId: task.taskId, runId: run.runId, claim: claim.kind, takeover: claim.kind === 'resumed' && claim.takeover, outcome };
    } finally {
      heartbeat.stop();
      this.#current = null;
    }
  }

  async #afterInterruption(lease: TaskLease, runId: string, cause: KernelInterrupt['interruption']): Promise<void> {
    const { logger, workerId, execution } = this.#options;
    if (cause === 'lease_lost') {
      // Not ours anymore: write nothing, not even a release.
      emitTelemetry(logger, 'lease.lost', { taskId: lease.taskId, runId, workerId, generation: lease.generation, detectedBy: 'write_fenced' });
      return;
    }
    // stopped / unavailable / task not runnable: hand ownership back so the run
    // (if still running) can be resumed without waiting for the lease to expire.
    await execution.releaseLease(lease).catch((error: unknown) => {
      logger.warn({ taskId: lease.taskId, workerId, err: describe(error) }, 'lease release failed; it will expire');
    });
  }

  /**
   * Liveness only: extends the lease, never records progress or business
   * state. When a renewal is refused, the kernel is aborted immediately:
   * with `task_not_runnable` if the task left `running` (e.g. cancelled; the
   * lease is then released), otherwise with `lease_lost` (expired or taken
   * over; nothing more is written).
   */
  #heartbeat(lease: TaskLease, controller: AbortController): { stop(): void } {
    const { execution, leaseDurationMs, heartbeatIntervalMs, logger, workerId } = this.#options;
    let stopped = false;
    let inFlight = false;
    const beat = async (): Promise<void> => {
      try {
        if (await execution.renewLease(lease, leaseDurationMs)) return;
        const state = await execution.ownershipOf(lease).catch(() => 'unknown' as const);
        if (stopped) return;
        if (state === 'task_not_running') {
          controller.abort(new KernelInterrupt('task_not_runnable'));
          return;
        }
        emitTelemetry(logger, 'lease.lost', { taskId: lease.taskId, workerId, generation: lease.generation, detectedBy: 'heartbeat', state });
        controller.abort(new KernelInterrupt('lease_lost'));
      } catch (error) {
        // Transient (e.g. database unreachable): retry on the next tick.
        // If the lease expires meanwhile, fenced writes will refuse us.
        logger.warn({ taskId: lease.taskId, workerId, err: describe(error) }, 'heartbeat failed');
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => {
      if (stopped || inFlight) return;
      inFlight = true;
      void beat();
    }, heartbeatIntervalMs);
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = done;
    }).finally(() => {
      this.#wake = null;
    });
  }
}

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message, code: (error as { code?: unknown }).code };
  return { message: String(error) };
}
