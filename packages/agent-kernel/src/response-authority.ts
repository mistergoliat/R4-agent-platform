import { RESPONSE_AUTHORITY_DEFERRED, RESPONSE_AUTHORITY_DEGRADED, RESPONSE_AUTHORITY_ERROR_PREFIX, type RunStep, type TaskWait } from '@r4/contracts';

/**
 * ADR-031 (R4-J1E-R2): the response-authority recovery state of a run, derived
 * from durable steps only — never held in process memory — so a crash, a
 * restart or a durable wait cannot lose it or reset it.
 *
 *   corrections   authority-rejected drafts handed back to the model (per RUN)
 *   degraded      the run already recorded its one safe degradation
 *   pending       a draft that is durable but not yet resolved:
 *                   deferred     refused `response_authority_deferred`, waiting
 *                                for its evidence to be revalidated (`waited`
 *                                once the platform WAIT_UNTIL was recorded)
 *                   degradation  the invalid draft was recorded `..._degraded`
 *                                but the degradation itself not yet (crash)
 *
 * A run woken from a platform revalidation wait (timer or input) continues the
 * state of the run that deferred: the wait is a continuation of the same
 * response cycle, not a new budget. Any other new run starts fresh.
 */
export interface ResponseAuthorityState {
  readonly corrections: number;
  readonly degraded: boolean;
  readonly pending: PendingDraft | null;
}

export type PendingDraft =
  | { readonly kind: 'deferred'; readonly content: string; readonly waited: boolean }
  | { readonly kind: 'degradation'; readonly content: string; readonly code: string };

/** Earlier runs' interaction records (respond/wait steps and waits), as the temporal runtime projects them. */
export interface PriorInteractions {
  readonly steps: readonly RunStep[];
  readonly waits: readonly TaskWait[];
}

const FRESH: ResponseAuthorityState = { corrections: 0, degraded: false, pending: null };
/** Only a revalidation wait that ended by itself (timer) or by input hands its draft to the next run; a human takeover or a cancellation drops it. */
const CONTINUING_RESOLUTIONS = new Set<TaskWait['resolution']>(['timer', 'input']);

function apply(state: ResponseAuthorityState, step: RunStep): ResponseAuthorityState {
  const decision = step.decision;
  if (decision?.type === 'wait') {
    return step.origin === 'platform' && state.pending?.kind === 'deferred' ? { ...state, pending: { ...state.pending, waited: true } } : state;
  }
  if (decision?.type !== 'respond') return state;
  if (step.outcome === 'recorded') return { ...state, pending: null };
  const code = step.outcome === 'refused' ? step.error?.code : undefined;
  if (!code?.startsWith(RESPONSE_AUTHORITY_ERROR_PREFIX)) return state;
  if (code === RESPONSE_AUTHORITY_DEFERRED) return { ...state, pending: { kind: 'deferred', content: decision.content, waited: false } };
  if (code === RESPONSE_AUTHORITY_DEGRADED) return { ...state, degraded: true, pending: { kind: 'degradation', content: decision.content, code } };
  return { ...state, corrections: state.corrections + 1, pending: null };
}

/** Pure: the same durable records always yield the same state. */
export function responseAuthorityState(runId: string, runSteps: readonly RunStep[], prior?: PriorInteractions): ResponseAuthorityState {
  let state = FRESH;
  let previousRun: string | null = null;
  let last: RunStep | null = null;
  const continues = (endedRun: string | null, lastStep: RunStep | null) =>
    endedRun !== null &&
    lastStep?.decision?.type === 'wait' &&
    lastStep.origin === 'platform' &&
    (prior?.waits ?? []).some((w) => w.runId === endedRun && CONTINUING_RESOLUTIONS.has(w.resolution));
  for (const step of prior?.steps ?? []) {
    if (step.runId === runId) continue;
    if (step.runId !== previousRun) {
      if (!continues(previousRun, last)) state = FRESH;
      previousRun = step.runId;
    }
    state = apply(state, step);
    last = step;
  }
  if (!continues(previousRun, last)) state = FRESH;
  for (const step of runSteps) state = apply(state, step);
  return state;
}
