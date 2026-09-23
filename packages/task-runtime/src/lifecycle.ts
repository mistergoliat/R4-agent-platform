import {
  PlatformError,
  TERMINAL_TASK_STATUSES,
  type GoalStatus,
  type TaskStatus,
} from '@r4/contracts';

/**
 * Task lifecycle. The platform — not the model — owns which transitions are
 * legal. Terminal states have no exits: a finished task is never reopened;
 * subsequent work is a new task (possibly with `parentTaskId`).
 *
 *   pending ──► running ◄──► waiting
 *     │           │  ▲ ◄──► blocked
 *     │           │  └────  requires_approval
 *     ▼           ▼
 *   cancelled / failed / completed   (terminal)
 *
 * (R4-E) `requires_approval → blocked`: a human operator takes ownership of a
 * task that was waiting for an approval (the request stays open).
 */
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['running', 'blocked', 'cancelled', 'failed'],
  running: ['waiting', 'blocked', 'requires_approval', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'blocked', 'cancelled', 'failed'],
  blocked: ['pending', 'running', 'cancelled', 'failed'],
  requires_approval: ['running', 'blocked', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function allowedTaskTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from];
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new PlatformError('conflict', 'invalid_transition', `task cannot transition from "${from}" to "${to}"`, {
      from,
      to,
      allowed: TASK_TRANSITIONS[from],
    });
  }
}

/** Goals close exactly once; a closed goal is replaced by a new goal, not reopened. */
const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  active: ['achieved', 'abandoned', 'superseded'],
  achieved: [],
  abandoned: [],
  superseded: [],
};

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (!GOAL_TRANSITIONS[from].includes(to)) {
    throw new PlatformError('conflict', 'invalid_goal_transition', `goal cannot transition from "${from}" to "${to}"`, {
      from,
      to,
      allowed: GOAL_TRANSITIONS[from],
    });
  }
}
