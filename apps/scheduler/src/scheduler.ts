import { PlatformError, type ScheduleToken } from '@r4/contracts';
import type { StructuredLogger } from '@r4/observability';
import type { TemporalRuntime } from '@r4/task-runtime';

export interface SchedulerOptions {
  readonly temporal: TemporalRuntime;
  readonly owner: string;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly logger: StructuredLogger;
}

export type SchedulerCycle = { readonly kind: 'idle' } | { readonly kind: 'fired'; readonly scheduleId: string; readonly taskId: string; readonly scheduleKind: string };

/**
 * Scheduler (R4-E): answers "when does this task become runnable again?",
 * never "what should the agent do?". Each cycle claims one due schedule
 * (SKIP LOCKED, lease + fencing generation on the temporal clock) and fires
 * it through the Temporal Runtime: a timer wakes a wait, an expiry expires a
 * human request, a retry deadline releases a task, a due reconciliation is
 * dispatched to workers (which hold the capabilities). It has no model, no
 * capability registry and no way to execute or reconcile an effect.
 *
 * A scheduler that dies after claiming leaves a lease that expires; another
 * scheduler reclaims with a higher generation and the dead one's token is
 * refused. Its in-process timer only paces polling: removing it cannot
 * change which schedules are due or how many times a task wakes.
 */
export class Scheduler {
  readonly #options: SchedulerOptions;
  #loop: Promise<void> | null = null;
  #stopping = false;
  #wake: (() => void) | null = null;

  constructor(options: SchedulerOptions) {
    if (options.leaseMs <= 0 || options.pollMs <= 0) throw new PlatformError('validation', 'invalid_scheduler_config', 'scheduler durations must be positive');
    this.#options = options;
  }

  get owner(): string {
    return this.#options.owner;
  }

  async runOnce(): Promise<SchedulerCycle> {
    const { temporal, owner, leaseMs } = this.#options;
    const schedule = await temporal.claimSchedule(owner, leaseMs);
    if (!schedule) return { kind: 'idle' };
    const token: ScheduleToken = { scheduleId: schedule.scheduleId, taskId: schedule.taskId, owner, generation: schedule.generation };
    await temporal.fireSchedule(token);
    return { kind: 'fired', scheduleId: schedule.scheduleId, taskId: schedule.taskId, scheduleKind: schedule.kind };
  }

  start(): void {
    if (this.#loop) throw new Error('scheduler already started');
    this.#stopping = false;
    this.#loop = (async () => {
      while (!this.#stopping) {
        let cycle: SchedulerCycle = { kind: 'idle' };
        try {
          cycle = await this.runOnce();
        } catch (error) {
          // A lost lease or a transient database failure: the durable lease permits recovery.
          this.#options.logger.warn({ event: 'scheduler.cycle.failed', owner: this.#options.owner, err: error instanceof Error ? { name: error.name, message: error.message } : String(error) }, 'scheduler cycle failed');
        }
        if (cycle.kind === 'idle' && !this.#stopping) {
          await new Promise<void>((resolve) => {
            // Poll pacing only. Removing this timer cannot change which schedules are due.
            const timer = setTimeout(resolve, this.#options.pollMs);
            this.#wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.#wake = null;
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
  }
}
