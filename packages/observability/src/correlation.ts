import { AsyncLocalStorage } from 'node:async_hooks';
import { correlationIdSchema, uuidv7 } from '@r4/contracts';

/**
 * Correlation context propagated implicitly through async call chains so every
 * log line can be related to the request, task, run and agent that caused it.
 * It is diagnostic context only — never a source of durable state.
 */
export interface CorrelationContext {
  readonly correlationId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly agentId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Adds fields (e.g. taskId once known) to the current context for the rest of `fn`. */
export function withCorrelationFields<T>(
  fields: Omit<Partial<CorrelationContext>, 'correlationId'>,
  fn: () => T,
): T {
  const current = storage.getStore();
  const next: CorrelationContext = { correlationId: current?.correlationId ?? uuidv7(), ...current, ...fields };
  return storage.run(next, fn);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

/**
 * Accepts a caller-supplied correlation id only if it is well-formed; otherwise
 * a fresh one is generated. Untrusted header values never reach logs verbatim.
 */
export function resolveCorrelationId(candidate: unknown): string {
  const value: unknown = Array.isArray(candidate) ? candidate[0] : candidate;
  const parsed = correlationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : uuidv7();
}
