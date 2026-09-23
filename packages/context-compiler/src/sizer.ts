/**
 * Estimates how much of the context budget a value consumes. A port, so that
 * provider-specific tokenizers stay outside the compiler; what matters here is
 * that the estimate is deterministic and reproducible, not exact per provider.
 */
export interface ContextSizer {
  /** Stable identifier recorded in every compiled context. */
  readonly id: string;
  estimate(value: unknown): number;
}

/**
 * Default sizer: UTF-8 bytes of the JSON serialization / 4, rounded up (key
 * order does not change the length, so no canonicalization is needed). Summing
 * item estimates over-approximates the estimate of the whole document, so a
 * budget checked on the parts also holds for the whole.
 */
export class Utf8BytesSizer implements ContextSizer {
  readonly id = 'utf8-bytes-div4.v1';

  estimate(value: unknown): number {
    return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 4);
  }
}
