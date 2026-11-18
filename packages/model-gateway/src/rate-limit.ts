import { performance } from 'node:perf_hooks';

/**
 * Per-process request-rate guard for a model provider account: at most `maxRequests` calls START in any rolling
 * `windowMs`. A rolling window, not a token bucket: a bucket of capacity N refilled at N/min admits up to 2N starts in
 * one minute, which a provider counting N per rolling (or calendar) minute answers with 429. The default window is
 * 61 s: one second of margin for network jitter between our clock and the provider's.
 *
 * Every call reserves the earliest start that keeps the window, in arrival order (FIFO, no starvation), then sleeps
 * once until it (one timer per waiter, no polling). A call whose start is further away than it may wait reserves
 * nothing and is refused at once: waiting longer would only end in a timeout.
 *
 * ponytail: one process, one budget. Processes sharing a key split it statically (R4_MODEL_RATE_GUARD_AND_CAPACITY.md);
 * a cross-process limiter (PostgreSQL) only when the split measurably starves a process.
 */
export class RequestRateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly #now: () => number;
  /** Start times of the last `maxRequests` reservations, ascending. */
  readonly #starts: number[] = [];

  constructor(maxRequests: number, options: { readonly windowMs?: number; readonly now?: () => number } = {}) {
    if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new Error('maxRequests must be a positive integer');
    this.maxRequests = maxRequests;
    this.windowMs = options.windowMs ?? 61_000;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Reserves the next start and returns how long to wait for it (ms), or null (nothing reserved) when that exceeds `maxWaitMs`. */
  reserve(maxWaitMs: number): number | null {
    const now = this.#now();
    const last = this.#starts.at(-1) ?? now;
    const start = Math.max(now, last, this.#starts.length < this.maxRequests ? now : this.#starts[0]! + this.windowMs);
    if (start - now > maxWaitMs) return null;
    this.#starts.push(start);
    if (this.#starts.length > this.maxRequests) this.#starts.shift();
    return start - now;
  }

  /**
   * Waits for a start within `maxWaitMs`. Resolves with the time waited (ms), or null when refused (nothing reserved);
   * rejects with the signal's reason when it aborts while waiting.
   * ponytail: an aborted waiter keeps its reservation (one start of the window lost); fine at a few aborts per hour.
   */
  async acquire(maxWaitMs: number, signal?: AbortSignal): Promise<number | null> {
    signal?.throwIfAborted();
    const wait = this.reserve(maxWaitMs);
    if (wait === null || wait <= 0) return wait;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason instanceof Error ? signal!.reason : new Error('aborted'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, wait);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return wait;
  }
}
