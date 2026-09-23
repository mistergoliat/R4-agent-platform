import { z } from 'zod';
import type { JsonValue } from '@r4/contracts';
import type { Finding } from './finding.js';
import type { EvaluationRun } from './pipeline.js';
import { fingerprint } from './versioning.js';

/**
 * RegressionCase (R4-G "Learning"): a failure or edge case that must stay in
 * the corpus. Learning here means knowledge — observed failure → structured
 * finding → reviewed regression case → future benchmark — never an agent
 * that rewrites itself: nothing in this module (or in Quality) writes agent
 * instructions, registries, policies or deployment configuration.
 *
 * A case is created `proposed` (by a person or by promoting a finding) and
 * becomes `active` only with a recorded human review. Changing what a case
 * expects is a new version; the corpus lock detects edits that keep the
 * version (same mechanism as rubrics).
 */
export const REGRESSION_SCHEMA_VERSION = 'r4.regression_case.v1' as const;

const OUTCOME_PATHS = ['technical.status', 'technical.valid', 'goal.status', 'goal.rootPreserved', 'goal.objective', 'business.status', 'quality.status', 'governance.status'] as const;

export const regressionExpectationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('finding_present'), code: z.string(), minCount: z.int().positive().default(1) }),
  z.strictObject({ kind: z.literal('finding_absent'), code: z.string() }),
  z.strictObject({ kind: z.literal('outcome'), path: z.enum(OUTCOME_PATHS), equals: z.union([z.string(), z.boolean()]) }),
  z.strictObject({ kind: z.literal('business_outcome'), code: z.string() }),
  z.strictObject({ kind: z.literal('metric'), name: z.string(), min: z.number().optional(), max: z.number().optional(), equals: z.number().optional() }),
]);
export type RegressionExpectation = z.infer<typeof regressionExpectationSchema>;

export const regressionCaseSchema = z
  .strictObject({
    schemaVersion: z.literal(REGRESSION_SCHEMA_VERSION),
    id: z.string().regex(/^REG-\d{4}$/),
    version: z.int().positive(),
    title: z.string().trim().min(5).max(200),
    origin: z.strictObject({
      kind: z.enum(['live_run', 'scripted_scenario', 'fixture', 'evaluation_finding']),
      /** Where it was observed (artifact path, scenario id, run id). Never private data. */
      ref: z.string().min(1).max(300),
      observedAt: z.string().nullable(),
      note: z.string().max(500),
    }),
    createdFromEvaluation: z.strictObject({ evaluationRunId: z.string(), findingId: z.string() }).nullable(),
    /** The reproducible input: a fixture trajectory or a scenario of the corpus. */
    fixture: z.strictObject({ kind: z.enum(['trajectory', 'scenario']), ref: z.string().min(1).max(200) }),
    expectations: z.array(regressionExpectationSchema).min(1).max(20),
    tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/)).max(20),
    status: z.enum(['proposed', 'active', 'retired']),
    review: z.strictObject({ reviewer: z.string().min(1).max(120), reviewedAt: z.string(), decision: z.literal('accepted') }).nullable(),
  })
  .refine((c) => c.status === 'proposed' || c.review !== null, { message: 'an active or retired regression case needs a recorded human review', path: ['review'] });
export type RegressionCase = z.infer<typeof regressionCaseSchema>;
export type RegressionCaseInput = z.input<typeof regressionCaseSchema>;

export function defineRegressionCase(input: RegressionCaseInput): RegressionCase {
  return regressionCaseSchema.parse(input);
}

/** Identity of what a case asserts (status and review excluded: accepting a case does not change it). */
export function regressionCaseHash(c: RegressionCase): string {
  return fingerprint({ id: c.id, version: c.version, fixture: c.fixture, expectations: c.expectations });
}

export type RegressionLock = Readonly<Record<string, string>>;

export function checkRegressionLock(cases: readonly RegressionCase[], lock: RegressionLock): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    const key = `${c.id}@${c.version}`;
    if (seen.has(key)) problems.push(`${key} is defined twice`);
    seen.add(key);
    const recorded = lock[key];
    if (recorded === undefined) problems.push(`${key} is not in the regression lock`);
    else if (recorded !== regressionCaseHash(c)) problems.push(`${key} changed without a new version`);
  }
  return problems;
}

/**
 * Promotion seam: a finding observed in an evaluation becomes a PROPOSED
 * case pointing at a reproducible fixture. It is inert until a person
 * reviews it (`acceptRegressionCase`); nothing is promoted automatically.
 */
export function proposeRegressionCase(input: { id: string; title: string; finding: Finding; run: Pick<EvaluationRun, 'evaluationRunId' | 'startedAt' | 'subject'>; fixture: RegressionCase['fixture']; tags?: readonly string[]; note?: string }): RegressionCase {
  return defineRegressionCase({
    schemaVersion: REGRESSION_SCHEMA_VERSION,
    id: input.id,
    version: 1,
    title: input.title,
    origin: { kind: 'evaluation_finding', ref: `${input.run.subject.source.kind}:${input.run.subject.source.ref}`, observedAt: input.run.startedAt, note: input.note ?? `promoted from finding ${input.finding.code} (${input.finding.findingId})` },
    createdFromEvaluation: { evaluationRunId: input.run.evaluationRunId, findingId: input.finding.findingId },
    fixture: input.fixture,
    expectations: [{ kind: 'finding_present', code: input.finding.code, minCount: 1 }],
    tags: [...(input.tags ?? []), input.finding.category.toLowerCase()],
    status: 'proposed',
    review: null,
  });
}

export function acceptRegressionCase(c: RegressionCase, review: { reviewer: string; reviewedAt: string }): RegressionCase {
  return regressionCaseSchema.parse({ ...c, status: 'active', review: { ...review, decision: 'accepted' } });
}

export interface RegressionCheck {
  readonly caseId: string;
  readonly version: number;
  readonly passed: boolean;
  readonly expectations: readonly { readonly expectation: RegressionExpectation; readonly passed: boolean; readonly actual: JsonValue }[];
}

export function checkRegressionCase(c: RegressionCase, run: EvaluationRun): RegressionCheck {
  const findings = run.result.findings;
  const expectations = c.expectations.map((e) => {
    switch (e.kind) {
      case 'finding_present': {
        const n = findings.filter((f) => f.code === e.code).length;
        return { expectation: e, passed: n >= e.minCount, actual: n };
      }
      case 'finding_absent': {
        const n = findings.filter((f) => f.code === e.code).length;
        return { expectation: e, passed: n === 0, actual: n };
      }
      case 'outcome': {
        const [group, field] = e.path.split('.') as [keyof EvaluationRun['result']['outcome'], string];
        const actual = (run.result.outcome[group] as Record<string, JsonValue>)[field] ?? null;
        return { expectation: e, passed: actual === e.equals, actual };
      }
      case 'business_outcome': {
        const codes = run.result.outcome.business.outcomes.map((o) => o.code);
        return { expectation: e, passed: codes.includes(e.code), actual: codes };
      }
      case 'metric': {
        const value = run.result.metrics[e.name]?.value ?? null;
        const passed = value !== null && (e.equals === undefined || value === e.equals) && (e.min === undefined || value >= e.min) && (e.max === undefined || value <= e.max);
        return { expectation: e, passed, actual: value };
      }
    }
  });
  return { caseId: c.id, version: c.version, passed: expectations.every((x) => x.passed), expectations };
}
