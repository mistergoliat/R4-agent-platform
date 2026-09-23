import { assertEvaluatorRef, fingerprint, type RubricRef } from './versioning.js';

/**
 * A semantic rubric: the instructions a judge evaluates with, the codes it
 * may report and the shape of its answer. Its identity is (id, version) and
 * its hash covers everything that can change a verdict, so an edited rubric
 * that keeps its version is detectable (see `RubricLock`).
 */
export interface Rubric {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly instructions: string;
  /** Finding codes a verdict may carry; anything else makes the answer invalid. */
  readonly allowedCodes: readonly string[];
  /** `verdict`: findings about the trajectory. `claims`: extraction of factual claims from responses. */
  readonly output: 'verdict' | 'claims';
}

export function defineRubric(rubric: Rubric): Rubric {
  assertEvaluatorRef({ id: rubric.id, version: rubric.version }, 'rubric');
  if (rubric.instructions.trim().length < 20) throw new Error(`rubric ${rubric.id} needs real instructions`);
  if (rubric.output === 'verdict' && rubric.allowedCodes.length === 0) throw new Error(`verdict rubric ${rubric.id} must allow at least one code`);
  return Object.freeze({ ...rubric, allowedCodes: Object.freeze([...rubric.allowedCodes]) });
}

export function rubricHash(rubric: Rubric): string {
  return fingerprint({ id: rubric.id, version: rubric.version, title: rubric.title, instructions: rubric.instructions, allowedCodes: [...rubric.allowedCodes].sort(), output: rubric.output });
}

export function rubricRef(rubric: Rubric): RubricRef {
  return { id: rubric.id, version: rubric.version, hash: rubricHash(rubric) };
}

/**
 * The recorded hash of every released rubric version. A pack keeps one and a
 * test checks its rubrics against it: changing a rubric's text without a new
 * version fails, so old results stay interpretable.
 */
export type RubricLock = Readonly<Record<string, string>>;

export function checkRubricLock(rubrics: readonly Rubric[], lock: RubricLock): string[] {
  const problems: string[] = [];
  for (const r of rubrics) {
    const key = `${r.id}@${r.version}`;
    const recorded = lock[key];
    if (recorded === undefined) problems.push(`${key} is not in the rubric lock (record its hash when releasing it)`);
    else if (recorded !== rubricHash(r)) problems.push(`${key} changed without a new version (hash ${rubricHash(r)} ≠ locked ${recorded})`);
  }
  return problems;
}
