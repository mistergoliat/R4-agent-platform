import { DomainError, throwIfAborted, type CallOptions } from './errors.js';

/**
 * Fault switch shared by the fixture adapters, so scenarios can reproduce an
 * owner outage or a slow owner without a network. `down` fails before any
 * work (no effect); `slow` answers only after `delayMs` (callers' deadlines
 * decide whether that is a timeout).
 */
export type FixtureAvailability = { readonly mode: 'up' } | { readonly mode: 'down' } | { readonly mode: 'slow'; readonly delayMs: number };

export class AvailabilitySwitch {
  #state: FixtureAvailability = { mode: 'up' };
  readonly #owner: string;

  constructor(owner: string) {
    this.#owner = owner;
  }

  set(state: FixtureAvailability): void {
    this.#state = state;
  }

  get state(): FixtureAvailability {
    return this.#state;
  }

  /** Applies the current fault mode at the start of a call. */
  async enter(options: CallOptions | undefined): Promise<void> {
    throwIfAborted(options);
    if (this.#state.mode === 'down') throw new DomainError('temporarily_unavailable', `${this.#owner}_unavailable`, `${this.#owner} service is temporarily unavailable`);
    if (this.#state.mode === 'slow') await delay(this.#state.delayMs, options);
  }
}

export function delay(ms: number, options: CallOptions | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const signal = options?.signal;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DomainError('timeout', 'deadline_exceeded', 'the caller deadline passed before the owner answered'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
