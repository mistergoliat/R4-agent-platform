import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { WorkerPresenceIdentity, WorkerPresenceStore } from '@r4/task-runtime';

/** Expired presence rows are kept this long for diagnosis, then purged. */
export const PRESENCE_RETENTION_MS = 24 * 60 * 60_000;
/** Purge cadence: at registration, then at most this often (never per heartbeat). */
const PURGE_EVERY_MS = 60 * 60_000;

export interface WorkerPresenceOptions {
  readonly store: WorkerPresenceStore;
  readonly identity: WorkerPresenceIdentity;
  /** Renewal window written on the DB clock (the worker's lease duration). */
  readonly freshForMs: number;
  /** Minimum spacing of renewals (the worker's heartbeat interval). */
  readonly heartbeatIntervalMs: number;
  readonly logger: StructuredLogger;
  /** Process clock, used only to pace renewals — never for expiry. */
  readonly now?: () => number;
}

/**
 * (R4-I) Publishes this worker's presence. It has NO timer of its own: it is
 * driven by the worker's actual progress — a completed claim-loop cycle, or a
 * successful lease renewal while a task runs. A process whose loop is stuck
 * stops renewing and its row expires on the database clock. Publication
 * failures are logged and never stop the worker (expiry is the fallback).
 */
export class WorkerPresence {
  readonly #options: WorkerPresenceOptions;
  readonly #now: () => number;
  #registered = false;
  #stopping = false;
  #state: 'ready' | 'not_ready' | null = null;
  #lastPublishedAt = 0;
  #lastProgressAt: number;
  #lastPurgeAt = Number.NEGATIVE_INFINITY;
  #inFlight: Promise<void> | null = null;

  constructor(options: WorkerPresenceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#lastProgressAt = this.#now();
  }

  get identity(): WorkerPresenceIdentity {
    return this.#options.identity;
  }

  /** The worker made progress (cycle completed / lease renewed): renew as ready when due. */
  progressed(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    this.#lastProgressAt = this.#now();
    if (this.#registered && this.#state === 'ready' && this.#lastPublishedAt + this.#options.heartbeatIntervalMs > this.#lastProgressAt) return Promise.resolve();
    return this.#publish('ready');
  }

  /**
   * A claim-loop cycle failed. One transient failure changes nothing (the row
   * simply is not renewed); failing for a whole heartbeat interval publishes
   * not_ready — when the database still accepts the write; otherwise expiry.
   */
  cycleFailed(): Promise<void> {
    if (this.#stopping || !this.#registered) return Promise.resolve();
    const now = this.#now();
    if (now - this.#lastProgressAt < this.#options.heartbeatIntervalMs) return Promise.resolve();
    if (this.#state === 'not_ready' && this.#lastPublishedAt + this.#options.heartbeatIntervalMs > now) return Promise.resolve();
    return this.#publish('not_ready');
  }

  /** Graceful shutdown: stop advertising first (in memory, synchronously), then persist `stopping`. */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    await this.#inFlight;
    if (!this.#registered) return;
    await this.#options.store.markWorkerStopping(this.#options.identity.workerId).then(
      () => this.#changed('stopping'),
      (error: unknown) => this.#options.logger.warn({ workerId: this.#options.identity.workerId, err: describe(error) }, 'worker presence stop not persisted; it will expire'),
    );
  }

  #publish(state: 'ready' | 'not_ready'): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#write(state).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #write(state: 'ready' | 'not_ready'): Promise<void> {
    const { store, identity, freshForMs, logger } = this.#options;
    try {
      if (state === 'ready' && !this.#registered) {
        await store.registerWorker(identity, freshForMs);
        this.#registered = true;
      } else if (!(await store.refreshWorker(identity.workerId, { state, reason: state === 'ready' ? null : 'claim_loop_error' }, freshForMs))) {
        // Row gone (or marked stopping by someone else): register again on the next progress.
        this.#registered = false;
        this.#state = null;
        return;
      }
      this.#lastPublishedAt = this.#now();
      if (this.#state !== state) this.#changed(state);
      this.#state = state;
      if (this.#lastPublishedAt - this.#lastPurgeAt >= PURGE_EVERY_MS) {
        this.#lastPurgeAt = this.#lastPublishedAt;
        await store.purgeExpiredWorkers(PRESENCE_RETENTION_MS);
      }
    } catch (error) {
      logger.warn({ workerId: identity.workerId, err: describe(error) }, 'worker presence not renewed');
    }
  }

  #changed(state: 'ready' | 'not_ready' | 'stopping'): void {
    const { identity, logger } = this.#options;
    emitTelemetry(logger, 'worker.presence.changed', { workerId: identity.workerId, state, executionMode: identity.executionMode, compatibility: identity.compatibility });
  }
}

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message, code: (error as { code?: unknown }).code };
  return { message: String(error) };
}
