import { z } from 'zod';

/**
 * Shared scalar schemas. Every public boundary validates with these so that
 * identifiers have one canonical shape across API, persistence and runtime.
 */

export const uuidSchema = z.uuid();

/** Agent identifiers are human-readable, stable slugs (e.g. `platform-probe`). */
export const agentIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');

/** Generic slug used for skills, owners and evaluation profiles. */
export const slugSchema = agentIdSchema;

const dottedName = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const namespacedName = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** Task types are namespaced by the agent pack that owns them (e.g. `probe.echo`). */
export const taskTypeSchema = z
  .string()
  .max(128)
  .regex(namespacedName, 'must be a dotted, namespaced lowercase name');

/** Permission scopes granted to agents and required by capabilities. */
export const scopeSchema = z
  .string()
  .max(128)
  .regex(dottedName, 'must be a dotted lowercase name');

/** Capability identifiers are namespaced by their owner (e.g. `platform_test.get_test_fact`). */
export const capabilityIdSchema = z
  .string()
  .max(128)
  .regex(namespacedName, 'must be a dotted, namespaced lowercase name');

/**
 * Correlation identifiers may be supplied by callers, so they are constrained to
 * a log-safe alphabet and length.
 */
export const correlationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'must be 1-128 log-safe characters');

export const positiveIntSchema = z.int().positive();
export const nonNegativeIntSchema = z.int().nonnegative();

/** ISO-8601 timestamp. Runtime-produced timestamps are always UTC (`Z`). */
export const timestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof timestampSchema>;

const MAX_JSON_OBJECT_BYTES = 64 * 1024;

/**
 * JSON object used only where the schema is genuinely extensible (task input,
 * constraints, results, provenance). Size-bounded because it is untrusted input.
 */
export const jsonObjectSchema = z
  .record(z.string(), z.json())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_JSON_OBJECT_BYTES, {
    message: `must serialize to at most ${MAX_JSON_OBJECT_BYTES} bytes`,
  });
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

/** Array refinement: rejects duplicate entries. */
export function uniqueArray<T extends z.ZodType>(item: T) {
  return z.array(item).refine((values) => new Set(values).size === values.length, {
    message: 'must not contain duplicates',
  });
}

/**
 * Who asked for something. Resolved by the platform from the authenticated
 * request, never taken from model output or request bodies.
 */
export const principalSchema = z.strictObject({
  kind: z.enum(['user', 'service', 'agent', 'system', 'unauthenticated']),
  ref: z.string().min(1).max(256),
});
export type Principal = z.infer<typeof principalSchema>;
