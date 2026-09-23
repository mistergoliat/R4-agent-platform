import { z } from 'zod';
import { canonicalJson, fingerprint, sha256Hex } from '@r4/contracts';

/**
 * Identity of everything that judges a trajectory. An evaluator or rubric
 * without an explicit id and version cannot be registered: a result must stay
 * interpretable after the logic or the rubric that produced it changes, so a
 * material change is a new version, never a silent edit.
 */
export const evaluatorIdSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, 'must be a dotted, namespaced lowercase id');
export const versionSchema = z.int().positive();

export const evaluatorRefSchema = z.strictObject({ id: evaluatorIdSchema, version: versionSchema });
export type EvaluatorRef = z.infer<typeof evaluatorRefSchema>;

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const rubricRefSchema = z.strictObject({ id: evaluatorIdSchema, version: versionSchema, hash: sha256Schema });
export type RubricRef = z.infer<typeof rubricRefSchema>;

export function evaluatorKey(ref: EvaluatorRef): string {
  return `${ref.id}@${ref.version}`;
}

/** Throws unless `ref` names a well-formed evaluator identity. */
export function assertEvaluatorRef(ref: unknown, what = 'evaluator'): EvaluatorRef {
  const parsed = evaluatorRefSchema.safeParse(ref);
  if (!parsed.success) throw new Error(`${what} must declare a namespaced id and a positive integer version: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export { canonicalJson, fingerprint, sha256Hex };

/** Stable, content-derived identifier (hex prefix of a sha256 over canonical JSON). */
export function stableId(prefix: string, value: unknown, length = 24): string {
  return `${prefix}_${fingerprint(value).slice(0, length)}`;
}
