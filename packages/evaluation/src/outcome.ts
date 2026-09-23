import { z } from 'zod';
import type { Finding } from './finding.js';
import { evidenceRefSchema } from './finding.js';
import type { EvaluationSubject } from './subject.js';
import type { FindingCategory } from './taxonomy.js';

/**
 * TaskOutcome keeps apart what must never collapse into one "success":
 *
 *   technical  — did the platform carry the trajectory correctly to a legitimate stop?
 *   goal       — is the objective (as Goals represent it) intact / achieved?
 *   business   — what the domain says happened (reported by the pack, from receipts);
 *   quality    — what evaluators found about the agent's behavior;
 *   governance — whether governed-execution invariants held.
 *
 * A task can be technically completed, with a governed effect proven by a
 * receipt, and still have quality issues. A task waiting for input is
 * technically valid. None of these is inferred from another.
 */
export const TECHNICAL_STATUSES = ['completed', 'awaiting_input', 'awaiting_human', 'awaiting_time', 'awaiting_approval', 'awaiting_reconciliation', 'in_progress', 'failed', 'cancelled'] as const;
export const GOAL_STATUSES = ['achieved', 'in_progress', 'abandoned', 'lost', 'unknown'] as const;
export const OBJECTIVE_ASSESSMENTS = ['preserved', 'drifted', 'inconclusive', 'not_evaluated'] as const;
export const BUSINESS_STATUSES = ['reported', 'none_reported', 'not_evaluated'] as const;
export const QUALITY_STATUSES = ['no_issues_found', 'issues_found', 'critical_issues_found', 'inconclusive'] as const;
export const GOVERNANCE_STATUSES = ['no_violations', 'violations'] as const;

export const domainOutcomeSchema = z.strictObject({
  /** Pack that reports it (the generic framework defines no business outcome). */
  owner: z.string().min(1).max(64),
  code: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  evidenceRefs: z.array(evidenceRefSchema).max(20),
});
export type DomainOutcome = z.infer<typeof domainOutcomeSchema>;

const bySeverity = z.strictObject({ info: z.int(), low: z.int(), medium: z.int(), high: z.int(), critical: z.int() });

export const taskOutcomeSchema = z.strictObject({
  technical: z.strictObject({
    status: z.enum(TECHNICAL_STATUSES),
    /** A legitimate stop (completed, waiting, cancelled by a human) — false only when the trajectory broke. */
    valid: z.boolean(),
    failedRuns: z.int().nonnegative(),
    terminationCodes: z.array(z.string()),
  }),
  goal: z.strictObject({
    status: z.enum(GOAL_STATUSES),
    rootPreserved: z.boolean().nullable(),
    objective: z.enum(OBJECTIVE_ASSESSMENTS),
  }),
  business: z.strictObject({ status: z.enum(BUSINESS_STATUSES), outcomes: z.array(domainOutcomeSchema) }),
  quality: z.strictObject({
    status: z.enum(QUALITY_STATUSES),
    findingsBySeverity: bySeverity,
    /** Whether every semantic evaluator reached a verdict. */
    semanticCoverage: z.enum(['complete', 'partial', 'not_run']),
  }),
  governance: z.strictObject({ status: z.enum(GOVERNANCE_STATUSES), violations: z.int().nonnegative() }),
});
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;

/** Categories that describe the agent's behavior (as opposed to infrastructure or governance). */
export const QUALITY_CATEGORIES: readonly FindingCategory[] = ['MODEL_PROTOCOL', 'CONTEXT', 'CAPABILITY', 'GOAL', 'STATE', 'BEHAVIOR_QUALITY'];

export function technicalOutcome(subject: EvaluationSubject): TaskOutcome['technical'] {
  const failedRuns = subject.runs.filter((r) => r.status === 'failed' || r.status === 'abandoned').length;
  const terminationCodes = subject.runs.map((r) => r.termination?.code).filter((c): c is string => typeof c === 'string');
  const openWait = subject.temporal.waits.find((w) => w.status === 'waiting');
  const status = ((): TaskOutcome['technical']['status'] => {
    switch (subject.task.status) {
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'cancelled':
        return 'cancelled';
      case 'requires_approval':
        return 'awaiting_approval';
      case 'blocked':
        return openWait?.kind === 'WAIT_FOR_HUMAN' ? 'awaiting_human' : 'awaiting_reconciliation';
      case 'waiting':
        switch (openWait?.kind) {
          case 'WAIT_UNTIL':
            return 'awaiting_time';
          case 'WAIT_FOR_HUMAN':
            return 'awaiting_human';
          case 'WAIT_FOR_APPROVAL':
            return 'awaiting_approval';
          case 'WAIT_FOR_RECONCILIATION':
            return 'awaiting_reconciliation';
          default:
            return 'awaiting_input';
        }
      default:
        return 'in_progress';
    }
  })();
  return { status, valid: status !== 'failed', failedRuns, terminationCodes };
}

export function goalOutcome(subject: EvaluationSubject, objective: TaskOutcome['goal']['objective']): TaskOutcome['goal'] {
  const root = subject.goals.find((g) => g.goalId === subject.task.rootGoalId);
  if (!root) return { status: 'lost', rootPreserved: false, objective };
  const status = root.status === 'achieved' ? 'achieved' : root.status === 'active' ? 'in_progress' : 'abandoned';
  return { status, rootPreserved: root.status === 'active' || root.status === 'achieved', objective };
}

export function composeOutcome(input: {
  subject: EvaluationSubject;
  findings: readonly Finding[];
  semanticEvaluators: { readonly total: number; readonly inconclusive: number };
  objective: TaskOutcome['goal']['objective'];
  business: { readonly evaluated: boolean; readonly outcomes: readonly DomainOutcome[] };
}): TaskOutcome {
  const quality = input.findings.filter((f) => QUALITY_CATEGORIES.includes(f.category));
  const severities = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of quality) severities[f.severity] += 1;
  const coverage = input.semanticEvaluators.total === 0 ? 'not_run' : input.semanticEvaluators.inconclusive > 0 ? 'partial' : 'complete';
  const qualityStatus = severities.critical > 0 ? 'critical_issues_found' : quality.length > 0 ? 'issues_found' : coverage === 'partial' ? 'inconclusive' : 'no_issues_found';
  const violations = input.findings.filter((f) => f.category === 'GOVERNANCE').length;
  return taskOutcomeSchema.parse({
    technical: technicalOutcome(input.subject),
    goal: goalOutcome(input.subject, input.objective),
    business: { status: !input.business.evaluated ? 'not_evaluated' : input.business.outcomes.length > 0 ? 'reported' : 'none_reported', outcomes: input.business.outcomes },
    quality: { status: qualityStatus, findingsBySeverity: severities, semanticCoverage: coverage },
    governance: { status: violations > 0 ? 'violations' : 'no_violations', violations },
  });
}
