/**
 * (R4-I) Worker presence: current, durable evidence that an execution worker
 * process is alive AND progressing through its claim loop — so another
 * process (the channel gateway) can tell "we can receive work" from "a
 * compatible worker can process it". Generic: no channel, model provider or
 * pack semantics. One row per worker process; not an audit history.
 *
 * Freshness is evaluated on the database clock only: every renewal writes
 * `expires_at = db now + freshForMs`; a reader counts a row only while
 * `expires_at > db now`. A crashed worker simply stops renewing and expires —
 * correctness never depends on a shutdown callback.
 */

export const WORKER_EXECUTION_MODES = ['test', 'shadow', 'production'] as const;
export type WorkerExecutionMode = (typeof WORKER_EXECUTION_MODES)[number];

/** `stopping` is terminal for a process incarnation: no later renewal may return it to ready. */
export type WorkerPresenceState = 'ready' | 'not_ready' | 'stopping';

/** Bounded, machine-readable causes (never free-form error text). */
export type WorkerPresenceReason =
  /** The claim loop has been failing for at least one heartbeat interval (e.g. database errors mid-cycle). */
  | 'claim_loop_error'
  /** Graceful shutdown began: no new claims. */
  | 'shutting_down';

/** Log-safe, bounded: `<schema head>:<runtime profile>`. */
const COMPATIBILITY = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$/;
const BUILD_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A worker whose composition declares no runtime profile (tests, harnesses). */
export const UNPROFILED_RUNTIME = 'unprofiled';

/**
 * Execution-contract compatibility — deliberately narrow: the Core schema
 * head the process was built against plus the runtime profile version it
 * composes (e.g. `0008_worker_presence:<profile>@<version>`). Never
 * configuration, secrets, hosts, rollout or control state.
 */
export function workerCompatibility(schemaHead: string, runtimeProfile: string): string {
  const value = `${schemaHead}:${runtimeProfile}`;
  if (!COMPATIBILITY.test(value)) throw new Error(`invalid worker compatibility "${value}"`);
  return value;
}

export function assertBuildRef(buildRef: string | null): string | null {
  if (buildRef !== null && !BUILD_REF.test(buildRef)) throw new Error('invalid build ref: 1-64 characters [A-Za-z0-9._-]');
  return buildRef;
}

export interface WorkerPresenceIdentity {
  readonly workerId: string;
  readonly executionMode: WorkerExecutionMode;
  readonly compatibility: string;
  /** Diagnostic only (not compatibility-authoritative); null when the deployment supplies none. */
  readonly buildRef: string | null;
}

/** What a reader expects of a worker that may count toward execution readiness. */
export interface ExecutionExpectation {
  readonly executionMode: WorkerExecutionMode;
  readonly compatibility: string;
}

/** Counts over current presence rows, classified against an expectation. */
export interface WorkerPresenceSummary {
  /** Fresh, expected mode, compatible, ready: these make execution ready. */
  readonly ready: number;
  /** Fresh, expected mode, compatible, but reporting not_ready. */
  readonly notReady: number;
  /** Fresh, expected mode, compatible, shutting down. */
  readonly stopping: number;
  /** Fresh, expected mode, different execution contract. */
  readonly incompatible: number;
  /** Expired rows of the expected mode (dead or stuck workers). */
  readonly stale: number;
  /** Fresh rows of another execution mode (e.g. shadow): never count. */
  readonly otherMode: number;
  /** Distinct not_ready reasons of compatible workers. */
  readonly reasons: readonly WorkerPresenceReason[];
  /** Distinct build refs of ready workers (diagnostic). */
  readonly buildRefs: readonly string[];
}

export type ExecutionReadinessStatus = 'ready' | 'not_ready' | 'stopping' | 'incompatible' | 'stale' | 'no_worker';

/**
 * Ready ⇔ at least one fresh, compatible worker of the expected mode is
 * ready. Otherwise the most specific explanation of why not.
 */
export function executionReadinessStatus(summary: WorkerPresenceSummary): ExecutionReadinessStatus {
  if (summary.ready > 0) return 'ready';
  if (summary.notReady > 0) return 'not_ready';
  if (summary.stopping > 0) return 'stopping';
  if (summary.incompatible > 0) return 'incompatible';
  if (summary.stale > 0) return 'stale';
  return 'no_worker';
}

export interface WorkerPresenceStore {
  /** (Re)registers this process incarnation as ready: started_at, heartbeat_at and expiry from the DB clock. */
  registerWorker(identity: WorkerPresenceIdentity, freshForMs: number): Promise<void>;
  /**
   * Renews a registered worker. Never overrides `stopping`. Returns false when
   * nothing was renewed (row gone or stopping).
   */
  refreshWorker(workerId: string, update: { readonly state: 'ready' | 'not_ready'; readonly reason: WorkerPresenceReason | null }, freshForMs: number): Promise<boolean>;
  /** Stops advertising this worker (terminal for the incarnation). */
  markWorkerStopping(workerId: string): Promise<void>;
  summarizeWorkers(expected: ExecutionExpectation): Promise<WorkerPresenceSummary>;
  /** Deletes rows expired for longer than `expiredForMs`. Returns how many. */
  purgeExpiredWorkers(expiredForMs: number): Promise<number>;
}
