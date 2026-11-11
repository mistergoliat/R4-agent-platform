import type { Logger } from 'pino';
import type { OutboundChannelAdapter, ProductionStore } from '@r4/live-ops';

export interface AutonomousInput {
  readonly channel: string;
  readonly accountRef: string;
  readonly providerEventId: string;
  readonly taskId: string;
}

export interface WorkingSignalsOptions {
  readonly adapters: readonly OutboundChannelAdapter[];
  readonly store: Pick<ProductionStore, 'outboundForTask' | 'taskState'>;
  readonly logger: Logger;
  /** Re-send period while the turn has not answered (providers dismiss such an indicator after ~25 s). */
  readonly refreshMs?: number;
  /** Never signal longer than this after the inbound. */
  readonly maxMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** Task statuses in which the agent is (about to be) working on the turn. */
const EXECUTING: ReadonlySet<string> = new Set(['pending', 'running']);

interface Pending extends AutonomousInput {
  readonly since: number;
  sentAt: number;
}

/**
 * Working signal of the gateway: when an inbound starts autonomous work, the contact sees "typing…" (and a read
 * receipt) until the turn answers. Cosmetic and best effort by design:
 *   - only for autonomous dispositions (never for held/excluded conversations: no reply would follow);
 *   - fire-and-forget: it never delays, fails or changes ingestion or delivery;
 *   - in memory only: a restart at most ends an indicator early;
 *   - one entry per task (the latest inbound), dropped once an outbound of the task exists after it, once the task is
 *     no longer executing (e.g. it suspended waiting for a human without replying: "typing…" would be a lie), or after
 *     maxMs.
 */
export class WorkingSignals {
  readonly #o: Required<Omit<WorkingSignalsOptions, 'now'>> & { now: () => number };
  readonly #pending = new Map<string, Pending>();

  constructor(options: WorkingSignalsOptions) {
    this.#o = { refreshMs: 20_000, maxMs: 180_000, timeoutMs: 3_000, now: Date.now, ...options };
  }

  /** An autonomous inbound was ingested: signal now and keep the indicator alive until the turn answers. */
  started(input: AutonomousInput): void {
    const now = this.#o.now();
    const entry: Pending = { ...input, since: now, sentAt: now };
    this.#pending.set(input.taskId, entry);
    void this.#send(entry);
  }

  /** One refresh pass (the gateway runs it on a timer). */
  async tick(): Promise<void> {
    const now = this.#o.now();
    for (const [taskId, entry] of this.#pending) {
      if (now - entry.since > this.#o.maxMs) {
        this.#pending.delete(taskId);
        continue;
      }
      try {
        const outbound = await this.#o.store.outboundForTask(taskId);
        if (outbound.some((o) => Date.parse(o.createdAt) >= entry.since - 1_000)) {
          this.#pending.delete(taskId);
          continue;
        }
        // Only while the task is executing (runnable or running): a suspended/blocked/terminal task is not "typing".
        const state = await this.#o.store.taskState(taskId);
        if (!state || !EXECUTING.has(state.status)) {
          this.#pending.delete(taskId);
          continue;
        }
      } catch {
        continue; // the store is unreachable: try again next pass (cosmetic only)
      }
      if (now - entry.sentAt >= this.#o.refreshMs) {
        entry.sentAt = now;
        void this.#send(entry);
      }
    }
  }

  get pending(): number {
    return this.#pending.size;
  }

  async #send(entry: Pending): Promise<void> {
    const adapter = this.#o.adapters.find((a) => a.channel === entry.channel);
    if (!adapter?.signalWorking) return;
    const ok = await adapter.signalWorking({ accountRef: entry.accountRef, providerEventId: entry.providerEventId }, { timeoutMs: this.#o.timeoutMs }).catch(() => false);
    this.#o.logger.debug({ event: 'working_signal.sent', channel: entry.channel, taskId: entry.taskId, ok }, 'working signal');
  }
}
