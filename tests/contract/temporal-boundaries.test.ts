import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_DECISION_TYPES,
  agentDecisionSchema,
  handoffTakeoverSchema,
  humanResponseSchema,
  inputSubmissionSchema,
  trustedHumanContextSchema,
} from '@r4/contracts';

/**
 * R4-E boundaries (ADR-021, ADR-022): time, human authority and cognitive
 * goals are platform-governed; none of them opens a path around the Policy
 * Engine, the Action Runtime's ownership of attempts, or the Agent Kernel's
 * isolation from state.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const rel = (file: string) => relative(ROOT, file).split('\\').join('/');
const text = (file: string) => readFileSync(file, 'utf8');
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}
const runtimeSources = ['packages', 'apps'].flatMap((root) => sources(join(ROOT, root)));
const scheduler = sources(join(ROOT, 'apps/scheduler/src')).map(text).join('\n');
const temporalRuntime = text(join(ROOT, 'packages/task-runtime/src/temporal-runtime.ts'));
const api = text(join(ROOT, 'apps/api/src/app.ts'));
const kernel = sources(join(ROOT, 'packages/agent-kernel/src')).map(text).join('\n');
const migration = text(join(ROOT, 'packages/persistence-postgres/migrations/0005_temporal_human_runtime.sql'));

describe('the scheduler owns time, nothing else', () => {
  it('cannot reach models, capabilities, policy, the kernel, the context compiler or the worker app', () => {
    const pkg = JSON.parse(text(join(ROOT, 'apps/scheduler/package.json'))) as { dependencies: Record<string, string> };
    for (const forbidden of ['@r4/worker', '@r4/model-gateway', '@r4/capability-runtime', '@r4/policy-engine', '@r4/agent-kernel', '@r4/context-compiler']) {
      expect(Object.keys(pkg.dependencies)).not.toContain(forbidden);
    }
    expect(scheduler).not.toMatch(/@r4\/(worker|model-gateway|capability-runtime|policy-engine|agent-kernel|context-compiler)/);
    expect(scheduler).not.toMatch(/\.execute\(|\.reconcile\(|ActionRuntime|ActionExecutor|CapabilityRegistry|claimReconciliation|claimNext/);
  });

  it('claims and fires only through the Temporal Runtime, whose time is the database temporal clock', () => {
    expect(scheduler).toMatch(/temporal\.claimSchedule\(/);
    expect(scheduler).toMatch(/temporal\.fireSchedule\(/);
    const store = text(join(ROOT, 'packages/persistence-postgres/src/temporal-store.ts'));
    const claims = store.match(/async claim(DueSchedule|Reconciliation)[\s\S]*?\n {2}}\n/g) ?? [];
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      expect(claim).toMatch(/for update skip locked/);
      expect(claim).toMatch(/generation = s\.generation \+ 1/);
      expect(claim).toMatch(/r4_now\(\)/);
      expect(claim).not.toMatch(/clock_timestamp|now\(\)(?<!r4_now\(\))/);
    }
    // C1 leases keep their own clock: the temporal clock never governs task leases.
    for (const file of ['packages/persistence-postgres/src/execution-store.ts', 'packages/persistence-postgres/src/task-store.ts']) expect(text(join(ROOT, file))).not.toMatch(/r4_now/);
  });

  it('never uses an in-memory timer as authority: the only timers pace polling', () => {
    const timers = runtimeSources.filter((f) => /setTimeout|setInterval/.test(text(f))).map(rel).sort();
    expect(timers).toEqual(['apps/scheduler/src/scheduler.ts', 'apps/worker/src/worker.ts', 'packages/capability-runtime/src/action-executor.ts', 'packages/capability-runtime/src/invoker.ts', 'packages/model-gateway/src/gateway.ts'].filter((f) => timers.includes(f)));
    for (const file of ['packages/task-runtime/src/temporal-runtime.ts', 'packages/task-runtime/src/action-runtime.ts', 'apps/worker/src/session.ts']) expect(text(join(ROOT, file))).not.toMatch(/setTimeout|setInterval/);
  });
});

describe('human authority never bypasses governed execution', () => {
  it('the Temporal Runtime (human collaboration) evaluates no policy and creates no command, attempt or receipt', () => {
    expect(temporalRuntime).not.toMatch(/\.evaluate\(|insertPolicyDecision|insertActionExecution|insertActionAttempt|finishActionAttempt|insertActionReceipt|ActionExecutor|executionKey/);
    expect(api).not.toMatch(/\.evaluate\(|ActionRuntime|ActionExecutor|insertAction/);
  });

  it('approval is evidence for a NEW policy evaluation; only the Action Runtime evaluates policy', () => {
    const matches = runtimeSources.filter((f) => /\.evaluate\(\{/.test(text(f))).map(rel);
    expect(matches).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    const actions = text(join(ROOT, 'packages/task-runtime/src/action-runtime.ts'));
    expect(actions).toMatch(/approval: approvalEvidence/);
    expect(actions).toMatch(/argumentsMatch: approval\.payload\.argumentsHash === fingerprint\(command\.validatedArguments\)/);
    const engine = text(join(ROOT, 'packages/policy-engine/src/engine.ts'));
    expect(engine).toMatch(/approval_scope_mismatch/);
  });

  it('attempt creation (execution, replay AND reconciliation) belongs to the Action Runtime alone', () => {
    const writers = (method: string) => runtimeSources.filter((f) => new RegExp(`uow\\.${method}\\(`).test(text(f))).map(rel);
    expect(writers('insertActionAttempt')).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    expect(writers('finishActionAttempt')).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    expect(writers('insertActionReceipt')).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    // The worker's reconciler only sequences: claim (runtime) → reconcile call (executor) → record (runtime).
    const reconciler = text(join(ROOT, 'apps/worker/src/reconciliation.ts'));
    expect(reconciler).toMatch(/actions\.claimReconciliation\(/);
    expect(reconciler).toMatch(/actions\.recordReconciliation\(/);
    expect(reconciler).not.toMatch(/uow\.|insert|executionKey:|executionKeyFor/);
    // The execution key is derived in exactly one place, from the durable execution id.
    expect(runtimeSources.filter((f) => /`r4x_\$\{/.test(text(f))).map(rel)).toEqual(['packages/task-runtime/src/action-runtime.ts']);
  });

  it('a human identity only ever comes from the trusted adapter seam, never from a body or a model', () => {
    for (const schema of [humanResponseSchema, handoffTakeoverSchema, inputSubmissionSchema]) {
      expect(Object.keys(schema.shape)).not.toContain('humanRef');
      expect(Object.keys(schema.shape)).not.toContain('scopes');
    }
    expect(api).toMatch(/deps\.humanContext\?\.\(request\)/);
    expect(api).not.toMatch(/request\.body[^)]*humanRef|headers\[['"]x-human/);
    expect(kernel).not.toMatch(/TrustedHumanContext|humanRef|trustedHumanContextSchema/);
    expect(trustedHumanContextSchema.safeParse({ humanRef: 'model', scopes: ['everything'], correlationId: 'c' }).success).toBe(false);
  });
});

describe('the model can only ask', () => {
  it('cannot forge ownership, identity, time or schedule fields in any temporal decision', () => {
    const base: Record<string, Record<string, unknown>> = {
      wait: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' } },
      request_consultation: { type: 'request_consultation', question: 'q', contextRefs: [] },
      request_handoff: { type: 'request_handoff', summary: 's', contextRefs: [] },
      manage_goal: { type: 'manage_goal', change: { operation: 'focus', goalId: '0190a0a0-0000-7000-8000-000000000000' } },
    };
    const forged = ['taskId', 'runId', 'humanRef', 'scopes', 'owner', 'generation', 'leaseExpiresAt', 'dueAt', 'createdAt', 'updatedAt', 'version', 'status', 'scheduleId', 'waitId', 'requestId'];
    for (const [type, decision] of Object.entries(base)) {
      expect(AGENT_DECISION_TYPES).toContain(type);
      expect(agentDecisionSchema.safeParse(decision).success, type).toBe(true);
      for (const field of forged) expect(agentDecisionSchema.safeParse({ ...decision, [field]: 'x' }).success, `${type}.${field}`).toBe(false);
    }
    // Nested: the wait condition and the goal change are strict too.
    expect(agentDecisionSchema.safeParse({ type: 'wait', condition: { kind: 'WAIT_UNTIL', until: '2030-01-01T00:00:00.000Z', owner: 'x' } }).success).toBe(false);
    expect(agentDecisionSchema.safeParse({ type: 'wait', condition: { kind: 'WAIT_FOR_APPROVAL' } }).success).toBe(false); // platform-entered waits only
    expect(agentDecisionSchema.safeParse({ type: 'manage_goal', change: { operation: 'focus', goalId: '0190a0a0-0000-7000-8000-000000000000', taskId: 'x' } }).success).toBe(false);
    expect(agentDecisionSchema.safeParse({ type: 'manage_goal', change: { operation: 'reopen', goalId: '0190a0a0-0000-7000-8000-000000000000' } }).success).toBe(false);
  });

  it('goal changes are validated against the task that owns the lease, and are not side effects', () => {
    expect(temporalRuntime).toMatch(/target\.taskId !== task\.taskId/);
    expect(temporalRuntime).toMatch(/lockOwnedExecution\(uow, token\)/);
    // manage_goal never reaches the Action Runtime / Policy Engine.
    const session = text(join(ROOT, 'apps/worker/src/session.ts'));
    expect(session).toMatch(/temporal\.decide\(/);
    expect(temporalRuntime).not.toMatch(/ActionRuntime|authorizer/);
  });
});

describe('durable guards in the schema', () => {
  it('blocks autonomous execution under a human owner, terminal status under uncertainty, and uncertainty without work', () => {
    expect(migration).toMatch(/create function task_temporal_guard\(\)[\s\S]*kind = 'handoff' and status in \('requested','active'\)[\s\S]*a human owns the task: no autonomous claim/);
    expect(migration).toMatch(/task has an effect whose outcome is not established/);
    expect(migration).toMatch(/create constraint trigger action_executions_uncertain_has_work[\s\S]*deferrable initially deferred/);
    expect(migration).toMatch(/create trigger action_executions_schedule_reconciliation after insert or update of status on action_executions/);
    for (const table of ['temporal_events', 'task_inputs', 'task_terminal_intents', 'goal_transitions']) {
      expect(migration).toMatch(new RegExp(`create trigger ${table}_immutable before update or delete on ${table}`));
    }
  });

  it('never edits an earlier migration', () => {
    expect(migration).toMatch(/0001–0004 stay byte-for-byte intact/);
  });
});
