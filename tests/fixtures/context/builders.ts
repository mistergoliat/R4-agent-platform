import {
  uuidv7,
  type ContextAssertion,
  type ContextContributionInput,
  type JsonValue,
  type MemoryEntry,
  type MemoryEntryInput,
  type Observation,
  memoryEntrySchema,
} from '@r4/contracts';
import {
  ContextCompiler,
  DeterministicCompactor,
  MemoryContextSource,
  platformContextSources,
  type ContextCompilationPolicyInput,
  type ContextCompileRequest,
  type ContextSource,
  type MemoryReader,
} from '@r4/context-compiler';
import { createSilentLogger, type StructuredLogger } from '@r4/observability';
import { agentFixture, goalFixture, runFixture, taskFixture } from '../../support/kernel-fixtures.js';

/**
 * Generic, domain-neutral building blocks for Context Compiler tests and
 * future evals. Nothing here names a business concept: state is "record"
 * state with keys like `record:<id>.status`.
 */

export const T0 = '2026-01-01T00:00:00.000Z';
export const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const TASK = taskFixture({ taskId: '0190e7a0-0000-7000-8000-000000000001', rootGoalId: '0190e7a0-0000-7000-8000-000000000002', currentGoalId: '0190e7a0-0000-7000-8000-000000000002' });
export const OTHER_TASK_ID = '0190e7a0-0000-7000-8000-0000000000ff';
export const RUN = runFixture(TASK, { runId: '0190e7a0-0000-7000-8000-000000000003' });
export const AGENT = agentFixture();
export const GOAL = goalFixture(TASK);

/** A source that returns fixed contributions. */
export function staticSource(id: string, items: readonly ContextContributionInput[]): ContextSource {
  return { id, load: () => Promise.resolve(items) };
}

/** In-memory MemoryReader over validated entries (the durable one is PostgresMemoryStore). */
export class FixtureMemory implements MemoryReader {
  readonly entries: MemoryEntry[] = [];
  #seq = 0;

  add(entry: Omit<MemoryEntryInput, 'entryId' | 'taskId' | 'recordedAt' | 'recordedBy' | 'correlationId'> & Partial<Pick<MemoryEntryInput, 'entryId' | 'taskId' | 'recordedBy'>>): MemoryEntry {
    this.#seq += 1;
    const parsed = memoryEntrySchema.parse({
      entryId: `0190e7a1-0000-7000-8000-${String(this.#seq).padStart(12, '0')}`,
      taskId: TASK.taskId,
      recordedAt: entry.occurredAt,
      recordedBy: { kind: 'service', ref: 'fixture' },
      correlationId: 'fixture',
      ...entry,
    });
    this.entries.push(parsed);
    return parsed;
  }

  /** A conversation turn; `assertions` are what was SAID. */
  turn(occurredAt: string, text: string, options: { role?: 'requester' | 'agent' | 'participant' | 'operator'; assertions?: ContextAssertion[]; sensitivity?: 'NORMAL' | 'SENSITIVE' } = {}): MemoryEntry {
    return this.add({
      memoryType: 'CONVERSATIONAL',
      occurredAt,
      sensitivity: options.sensitivity ?? 'NORMAL',
      content: { actor: { role: options.role ?? 'requester', ref: 'participant-1' }, text, interactionRef: 'interaction-1', assertions: options.assertions ?? [] },
    });
  }

  listForTask(taskId: string): Promise<readonly MemoryEntry[]> {
    return Promise.resolve(this.entries.filter((e) => e.taskId === taskId));
  }
}

/** Authoritative record state (as a domain state source would provide it). */
export function stateItem(key: string, value: JsonValue, options: { observedAt?: string; validUntil?: string | null; required?: boolean; version?: number; taskId?: string } = {}): ContextContributionInput {
  return {
    itemId: `state:${key}`,
    kind: 'state',
    authority: 'AUTHORITATIVE',
    temporality: options.observedAt ? 'point_in_time' : 'live',
    content: { key, value },
    assertions: [{ subject: key, value }],
    provenance: { recordType: 'fixture_record', recordId: key, recordVersion: String(options.version ?? 1) },
    createdAt: T0,
    observedAt: options.observedAt ?? null,
    validUntil: options.validUntil ?? null,
    required: options.required ?? false,
    taskId: options.taskId ?? TASK.taskId,
  };
}

export function observation(index: number, observedAt: string, options: { validUntil?: string | null; payload?: JsonValue; runId?: string | null } = {}): Observation {
  return {
    observationId: `0190e7a2-0000-7000-8000-${String(index).padStart(12, '0')}`,
    taskId: TASK.taskId,
    runId: options.runId === undefined ? RUN.runId : options.runId,
    agentId: AGENT.agentId,
    source: { kind: 'capability', capabilityId: 'platform_test.get_test_fact', capabilityVersion: 1, invocationId: `0190e7a3-0000-7000-8000-${String(index).padStart(12, '0')}` },
    outcome: 'succeeded',
    payload: options.payload ?? { index },
    error: null,
    observedAt,
    validUntil: options.validUntil ?? null,
    provenance: {},
    correlationId: TASK.correlationId,
  };
}

export interface RequestOptions {
  readonly now?: string;
  readonly iteration?: number;
  readonly observations?: readonly Observation[];
  readonly responses?: ContextCompileRequest['execution']['responses'];
  /** Ceiling from the request (e.g. the agent's maxContextTokens). */
  readonly budgetCeilingTokens?: number;
}

export function request(options: RequestOptions = {}): ContextCompileRequest {
  const iteration = options.iteration ?? 1;
  return {
    scope: { taskId: TASK.taskId, runId: RUN.runId, agentId: AGENT.agentId, agentVersion: AGENT.version, iteration },
    now: new Date(options.now ?? at(HOUR)),
    execution: {
      agent: AGENT,
      task: TASK,
      run: RUN,
      goal: GOAL,
      observations: options.observations ?? [],
      responses: options.responses ?? [],
      capabilities: [{ capabilityId: 'platform_test.get_test_fact', version: 1, description: 'Returns a synthetic test fact', inputSchema: { type: 'object' } }],
      constraints: { remaining: { iterations: 20 - iteration + 1, modelCalls: 20 - iteration + 1, readCapabilityCalls: 20, tokens: null }, runDeadlineAt: at(10 * HOUR) },
    },
    ...(options.budgetCeilingTokens === undefined ? {} : { budgetCeilingTokens: options.budgetCeilingTokens }),
  };
}

export interface CompilerOptions {
  readonly policy?: Partial<ContextCompilationPolicyInput>;
  readonly memory?: FixtureMemory;
  readonly sources?: readonly ContextSource[];
  readonly compactor?: DeterministicCompactor | null;
  readonly logger?: StructuredLogger;
}

/**
 * Platform sources + (optional) memory + extra sources, like the worker
 * composes them. Unit tests default to a FIXED(8000) budget (the bound these
 * tests were written against); unbounded behaviour is tested explicitly.
 */
export function compiler(options: CompilerOptions = {}): ContextCompiler {
  return new ContextCompiler({
    sources: [...platformContextSources(), ...(options.memory ? [new MemoryContextSource(options.memory)] : []), ...(options.sources ?? [])],
    policy: { budget: fixed(8_000), ...options.policy },
    compactor: options.compactor === undefined ? new DeterministicCompactor() : options.compactor,
    logger: options.logger ?? createSilentLogger(),
  });
}

export const newId = (): string => uuidv7(Date.parse(T0));

/** Budget policies (ADR-015): tests always say which one they run under. */
export const UNBOUNDED = { mode: 'unbounded' } as const;
export const fixed = (maxEstimatedTokens: number) => ({ mode: 'fixed', maxEstimatedTokens }) as const;
