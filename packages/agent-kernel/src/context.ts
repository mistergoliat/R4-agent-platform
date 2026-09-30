import type {
  AgentDefinition,
  AgentRun,
  AgentTask,
  Goal,
  Observation,
  ProposeActionDecision,
  ReadCapabilityDecision,
  RiskClass,
  RunStep,
} from '@r4/contracts';
import { RESPONSE_AUTHORITY_ERROR_PREFIX } from '@r4/contracts';
import { resolveExecutionLimits, type ExecutionLimits, type ExecutionPolicy, type ExecutionUsage } from './budget.js';

/** What the kernel knows about a capability. Execution stays behind the session port. */
export interface CapabilityDescriptor {
  readonly capabilityId: string;
  readonly version: number;
  readonly description: string;
  readonly riskClass: RiskClass;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * ExecutionContext: the platform facts of one kernel iteration. It holds
 * exactly
 *
 *   agent definition · task · current goal · the task's observations ·
 *   this run's own responses · budget · capabilities granted by scope
 *
 * and is rebuilt from durable state on every iteration. The kernel uses it to
 * enforce budgets and validate decisions (what is executable, what evidence
 * exists). Since R4-C2 it is NOT what the model sees: the session compiles the
 * model's context from these facts plus memory (Context Compiler) and hands
 * the kernel a CompiledContext through `prepareContext`.
 */
export interface ExecutionContext {
  readonly agent: AgentDefinition;
  readonly task: AgentTask;
  readonly run: AgentRun;
  readonly goal: Goal;
  /** The iteration about to execute (1-based). */
  readonly iteration: number;
  readonly observations: readonly Observation[];
  /** `respond` outputs already recorded by this run, so the agent knows what it said (refused drafts were never said). */
  readonly responses: readonly { readonly iteration: number; readonly content: string }[];
  /** ADR-031: drafts the response-authority validator refused since this run's last recorded response. */
  readonly responseAuthority: { readonly rejectedDrafts: number };
  /**
   * Capabilities the agent's scopes grant, with their risk class. READ ones
   * are invoked (`read_capability`); since R4-D, write classes may only be
   * proposed (`propose_action`) and are offered when the run may write at all.
   */
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly budget: { readonly limits: ExecutionLimits; readonly usage: ExecutionUsage };
}

export interface ExecutionState {
  readonly context: ExecutionContext;
  /**
   * A READ decided in an earlier iteration (possibly by a worker that died)
   * that has no observation yet. It must be executed with its recorded
   * invocation id before anything else — never re-decided.
   */
  readonly pendingRead: { readonly step: RunStep; readonly decision: ReadCapabilityDecision } | null;
  /**
   * (R4-D) An action proposed in an earlier iteration whose outcome is not
   * observed yet (the worker may have died before policy, before the call,
   * or after the effect but before its receipt). The platform resolves it
   * from its durable ledger before the model is asked anything.
   */
  readonly pendingAction: { readonly step: RunStep; readonly decision: ProposeActionDecision } | null;
}

export interface ExecutionStateInput {
  readonly agent: AgentDefinition;
  readonly task: AgentTask;
  readonly run: AgentRun;
  readonly goal: Goal;
  readonly steps: readonly RunStep[];
  readonly observations: readonly Observation[];
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly policy: ExecutionPolicy;
  readonly now: Date;
  /** (R4-D) Write commands already created for the task (action ledger). */
  readonly writeActions?: number;
  /**
   * (R4-E) A proposal of an earlier run of this task that the platform must
   * resolve before the model is asked anything (a human approved, rejected,
   * let expire or withdrew its approval request). Loaded, never executed, here.
   */
  readonly carriedAction?: { readonly step: RunStep; readonly decision: ProposeActionDecision } | null;
}

/** Pure: the same durable state always yields the same context. */
export function buildExecutionState(input: ExecutionStateInput): ExecutionState {
  const { steps } = input;
  // ADR-031: platform steps (response revalidation READs) call no model.
  const modelSteps = steps.filter((s) => s.origin !== 'platform');
  const usage: ExecutionUsage = {
    iterations: modelSteps.length,
    // Every model step records exactly one model call.
    modelCalls: modelSteps.length,
    readCapabilityCalls: steps.filter((s) => s.decision?.type === 'read_capability' && (s.outcome === 'pending' || s.outcome === 'observed')).length,
    tokens: steps.reduce((sum, s) => sum + s.usage.inputTokens + s.usage.outputTokens, 0),
    elapsedMs: Math.max(0, input.now.getTime() - Date.parse(input.run.startedAt)),
    writeActions: input.writeActions ?? 0,
  };
  const responses = steps.flatMap((s) => (s.decision?.type === 'respond' && s.outcome === 'recorded' ? [{ iteration: s.iteration, content: s.decision.content }] : []));
  let rejectedDrafts = 0;
  for (const s of steps) {
    if (s.decision?.type !== 'respond') continue;
    if (s.outcome === 'recorded') rejectedDrafts = 0;
    else if (s.outcome === 'refused' && s.error?.code.startsWith(RESPONSE_AUTHORITY_ERROR_PREFIX)) rejectedDrafts += 1;
  }
  const last = steps.at(-1);
  const pendingRead =
    last && last.outcome === 'pending' && last.decision?.type === 'read_capability' ? { step: last, decision: last.decision } : null;
  const pendingAction =
    last && last.outcome === 'pending' && last.decision?.type === 'propose_action' ? { step: last, decision: last.decision } : (input.carriedAction ?? null);

  return {
    context: {
      agent: input.agent,
      task: input.task,
      run: input.run,
      goal: input.goal,
      iteration: steps.length + 1,
      observations: input.observations,
      responses,
      responseAuthority: { rejectedDrafts },
      capabilities: input.capabilities,
      budget: { limits: resolveExecutionLimits(input.policy, input.task.budget), usage },
    },
    pendingRead,
    pendingAction,
  };
}

export function readableCapabilities(context: ExecutionContext): CapabilityDescriptor[] {
  return context.capabilities.filter((c) => c.riskClass === 'READ');
}

/**
 * (R4-D) What the model is offered: READ capabilities, plus write classes
 * when the run's write limit allows any write at all. Visible ≠ executable:
 * a proposed write still goes through policy, and its outcome only through
 * a receipt.
 */
export function visibleCapabilities(context: ExecutionContext): CapabilityDescriptor[] {
  return context.budget.limits.maxWriteActions > 0 ? [...context.capabilities] : readableCapabilities(context);
}
