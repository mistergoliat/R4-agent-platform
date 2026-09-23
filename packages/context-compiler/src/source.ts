import type {
  AgentDefinition,
  AgentRun,
  AgentTask,
  ContextContributionInput,
  Goal,
  Observation,
  RiskClass,
} from '@r4/contracts';

/** Who the context is for: one iteration of one run. */
export interface ContextScope {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentVersion: number;
  /** The iteration about to call the model (1-based). */
  readonly iteration: number;
}

/** A capability as the model may see it. Visible ≠ executable: execution stays with the platform. */
export interface VisibleCapability {
  readonly capabilityId: string;
  readonly version: number;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** (R4-D) Tells the model whether it invokes (READ) or proposes (write classes); never what policy will decide. */
  readonly riskClass?: RiskClass;
}

/** The limits the run executes under, as durable facts (no wall-clock "remaining time"). */
export interface ExecutionConstraints {
  readonly remaining: {
    readonly iterations: number;
    readonly modelCalls: number;
    readonly readCapabilityCalls: number;
    /** Null when the task declares no token budget. */
    readonly tokens: number | null;
    /** (R4-D) Write actions the task may still create. */
    readonly writeActions?: number;
  };
  /** run.startedAt + maximum run duration: absolute, so it does not change while the iteration waits. */
  readonly runDeadlineAt: string;
}

/**
 * Platform facts the execution layer already loaded under its lease for this
 * iteration. Platform sources only map them; the compiler never sees where
 * they came from. Domain sources may read `task` to scope their own queries.
 */
export interface ExecutionFacts {
  readonly agent: AgentDefinition;
  readonly task: AgentTask;
  readonly run: AgentRun;
  readonly goal: Goal;
  readonly observations: readonly Observation[];
  /** `respond` outputs recorded by this run, in order. */
  readonly responses: readonly { readonly stepId: string; readonly iteration: number; readonly content: string; readonly recordedAt: string }[];
  readonly capabilities: readonly VisibleCapability[];
  readonly constraints: ExecutionConstraints;
}

export interface ContextSourceRequest {
  readonly scope: ContextScope;
  /** Injected clock reading for this compilation (freshness is judged against it). */
  readonly now: Date;
  readonly execution: ExecutionFacts;
}

/**
 * A provider of context items. The compiler knows nothing about how a source
 * obtains its data: platform state, memory, and — later, registered from
 * outside the Core — domain state sources all implement this one interface.
 *
 * Contributions are validated strictly by the compiler, which stamps the
 * source id on every item (a source cannot speak for another). A source must
 * be deterministic: the same durable state yields the same contributions.
 */
export interface ContextSource {
  readonly id: string;
  load(request: ContextSourceRequest): Promise<readonly ContextContributionInput[]>;
}
