import type { FindingDraft } from '../finding.js';
import type { Evaluator, EvaluationFragment } from '../evaluator.js';
import { count } from '../metrics.js';
import { stepsOf, type EvaluationSubject } from '../subject.js';

/**
 * Structural goal continuity (deterministic): is there a root goal, did it
 * stay valid across runs, where did it end, how much did goals move. It does
 * NOT decide whether the goals were good, and it never rewards `manage_goal`
 * usage — that is telemetry, reported as data. Whether the trajectory kept
 * serving the requester's real objective is a semantic question (objective
 * continuity rubric).
 */
export class GoalContinuityEvaluator implements Evaluator {
  readonly descriptor = {
    ref: { id: 'r4.goal_continuity', version: 1 },
    kind: 'deterministic' as const,
    description: 'Root goal presence, validity across runs and terminal status; goal transition counts.',
    emits: ['root_goal_missing', 'root_goal_invalidated', 'current_goal_invalid'],
    authoritativeFor: ['root_goal_missing', 'root_goal_invalidated', 'current_goal_invalid'],
  };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const findings: FindingDraft[] = [];
    const rootId = subject.task.rootGoalId;
    const root = subject.goals.find((g) => g.goalId === rootId);
    const rootTransitions = subject.goalTransitions.filter((t) => t.goalId === rootId);
    const invalidating = rootTransitions.filter((t) => t.type === 'goal.abandoned' || t.type === 'goal.superseded');
    if (!root) findings.push({ code: 'root_goal_missing', subjectRef: { kind: 'task', id: subject.task.taskId }, description: 'the task has no root goal' });
    else if ((root.status === 'abandoned' || root.status === 'superseded' || invalidating.length > 0) && subject.task.status !== 'cancelled') {
      findings.push({ code: 'root_goal_invalidated', subjectRef: { kind: 'goal', id: root.goalId }, description: `root goal is ${root.status} while the task is ${subject.task.status}`, evidenceRefs: [{ kind: 'goal', id: root.goalId }] });
    }
    const current = subject.goals.find((g) => g.goalId === subject.task.currentGoalId);
    const finished = subject.task.status === 'completed' || subject.task.status === 'cancelled' || subject.task.status === 'failed';
    if (!finished && (!current || current.status !== 'active')) {
      findings.push({ code: 'current_goal_invalid', subjectRef: { kind: 'task', id: subject.task.taskId }, description: `current goal is ${current ? current.status : 'missing'}`, ...(current ? { evidenceRefs: [{ kind: 'goal' as const, id: current.goalId }] } : {}) });
    }
    const manageGoal = stepsOf(subject as EvaluationSubject).filter((s) => s.decision?.type === 'manage_goal').length;
    return {
      findings,
      metrics: {
        rootGoalPresent: count(root ? 1 : 0),
        rootGoalValidAcrossRuns: count(root && invalidating.length === 0 && (root.status === 'active' || root.status === 'achieved') ? 1 : 0),
        goalTransitions: count(subject.goalTransitions.length),
        goals: count(subject.goals.length),
        manageGoalDecisions: count(manageGoal, 'telemetry only: goal management is not a quality target'),
      },
      data: { rootGoalStatus: root?.status ?? null, subGoals: subject.goals.filter((g) => g.goalId !== rootId).map((g) => ({ status: g.status, isCurrent: g.goalId === subject.task.currentGoalId })) },
    };
  }
}
