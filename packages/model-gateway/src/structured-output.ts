import { z } from 'zod';
import type { ModelResponse } from './types.js';

export type StructuredOutputResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: { readonly kind: 'invalid_model_output'; readonly message: string };
    };

/**
 * Model output is untrusted. This is the single sanctioned way to turn a
 * model's structured data into a typed value: validate against the caller's
 * schema, and return a classified failure (never throw) when it does not fit.
 */
export function parseStructuredOutput<T>(
  response: ModelResponse,
  schema: z.ZodType<T>,
): StructuredOutputResult<T> {
  if (response.structuredData === undefined) {
    return { ok: false, error: { kind: 'invalid_model_output', message: 'response carries no structured data' } };
  }
  const parsed = schema.safeParse(response.structuredData);
  if (!parsed.success) {
    return { ok: false, error: { kind: 'invalid_model_output', message: z.prettifyError(parsed.error) } };
  }
  return { ok: true, data: parsed.data };
}
