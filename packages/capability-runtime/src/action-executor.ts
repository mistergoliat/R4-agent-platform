import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  jsonObjectSchema,
  jsonValueSchema,
  timestampSchema,
  type ActionAttemptKind,
  type ActionAttemptReport,
  type ActionCommand,
  type CapabilityDefinition,
  type JsonObject,
  type JsonValue,
  type PolicyDecision,
  type WriteExecutionSemantics,
} from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { CapabilityRegistry, RegisteredCapability, WriteReconciliationResult } from './registry.js';

export interface ActionExecutorOptions {
  registry: CapabilityRegistry;
  logger: StructuredLogger;
}

/** Why a proposal cannot become a command, before any policy is asked. */
export type ActionPreparationFailure = 'capability_not_found' | 'not_a_write' | 'invalid_arguments';

export type ActionPreparation =
  | {
      readonly ok: true;
      readonly capability: CapabilityDefinition;
      /** Null when the capability has no registered write handlers: it can never execute. */
      readonly semantics: WriteExecutionSemantics | null;
      readonly validatedArguments: JsonObject;
    }
  | { readonly ok: false; readonly cause: ActionPreparationFailure; readonly message: string; readonly details: JsonValue | null };

/** A durable command together with the ALLOW decision it was created from. */
export interface AuthorizedCommand {
  readonly command: ActionCommand;
  readonly decision: PolicyDecision;
}

export interface AttemptRequest {
  readonly attemptNumber: number;
  readonly kind: ActionAttemptKind;
  /** For telemetry only. */
  readonly workerId?: string;
}

/** What one external call established (the contract the Execution Runtime records). */
export type AttemptReport = ActionAttemptReport;

const MAX_TEXT = 2000;
const MAX_REF = 512;
const codeSchema = z.string().regex(/^[a-z][a-z0-9_.]*$/).max(128);

/**
 * ActionExecutor (R4-D): the ONLY caller of write handlers — a boundary
 * separate from the READ invoker, which can never reach them.
 *
 * It executes one attempt of a command the platform has already made durable
 * together with its ALLOW decision, always with the command's platform
 * execution key, and classifies what the domain answered. It holds no state
 * and decides nothing about retries: which attempt comes next (execute,
 * replay, reconcile or none) is decided by the Execution Runtime from the
 * durable attempt log.
 *
 * Classification is conservative: only an explicit domain answer is a known
 * outcome. A timeout, a thrown error or output that fails its schema is
 * `unknown` — never success, never failure.
 */
export class ActionExecutor {
  readonly #registry: CapabilityRegistry;
  readonly #logger: StructuredLogger;

  constructor(options: ActionExecutorOptions) {
    this.#registry = options.registry;
    this.#logger = options.logger;
  }

  /** Resolves the proposed capability and validates the proposed (untrusted) arguments. */
  prepare(request: { readonly capabilityId: string; readonly arguments: unknown }): ActionPreparation {
    const capability = this.#registry.resolve(String(request.capabilityId).slice(0, 256));
    if (!capability) return { ok: false, cause: 'capability_not_found', message: 'the proposed capability is not registered', details: null };
    const { definition } = capability;
    if (definition.riskClass === 'READ') {
      return { ok: false, cause: 'not_a_write', message: `${definition.capabilityId} is READ: use read_capability`, details: null };
    }
    const args = capability.input.safeParse(request.arguments);
    if (!args.success) {
      return { ok: false, cause: 'invalid_arguments', message: 'arguments do not match the capability input schema', details: { issues: issuesOf(args.error) } };
    }
    const object = jsonObjectSchema.safeParse(args.data);
    if (!object.success) {
      return { ok: false, cause: 'invalid_arguments', message: 'validated arguments must be a JSON object', details: null };
    }
    return { ok: true, capability: definition, semantics: semanticsOf(capability), validatedArguments: object.data };
  }

  /** The command's capability exactly as it was authorized, or why it cannot execute now. */
  resolve(authorized: AuthorizedCommand): { ok: true; capability: RegisteredCapability } | { ok: false; code: string; message: string } {
    const { command, decision } = authorized;
    if (
      decision.outcome !== 'allow' ||
      decision.decisionId !== command.policyDecisionId ||
      decision.proposalId !== command.proposalId ||
      decision.capabilityId !== command.capabilityId ||
      decision.capabilityVersion !== command.capabilityVersion
    ) {
      return { ok: false, code: 'command_not_authorized', message: 'the command is not backed by an ALLOW decision for this proposal' };
    }
    const capability = this.#registry.resolve(command.capabilityId, command.capabilityVersion);
    if (!capability?.write) return { ok: false, code: 'capability_unavailable', message: `${command.capabilityId}@${command.capabilityVersion} has no registered write handlers` };
    if (capability.definition.riskClass !== command.riskClass || capability.write.recovery !== command.semantics.recovery) {
      return { ok: false, code: 'capability_changed', message: `${command.capabilityId}@${command.capabilityVersion} no longer matches the authorized command` };
    }
    return { ok: true, capability };
  }

  /**
   * Performs one attempt: execute/replay (same key, validated arguments) or
   * reconcile (lookup by key). Returns what it could establish; never throws
   * for a domain problem.
   */
  async attempt(authorized: AuthorizedCommand, request: AttemptRequest): Promise<AttemptReport> {
    const { command } = authorized;
    const telemetry = {
      taskId: command.taskId,
      runId: command.runId,
      agentId: command.trustedContext.agentId,
      proposalId: command.proposalId,
      executionId: command.executionId,
      capabilityId: command.capabilityId,
      riskClass: command.riskClass,
      workerId: request.workerId ?? null,
      attempt: request.attemptNumber,
      kind: request.kind,
    };
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    const resolved = this.resolve(authorized);
    if (!resolved.ok) {
      // The domain was not called by THIS attempt, but earlier ones may have been: unknown, not "not applied".
      return unknown(resolved.code, resolved.message, elapsed());
    }
    const { capability } = resolved;
    const write = capability.write!;
    const { definition } = capability;

    if (request.kind === 'reconcile') {
      emitTelemetry(this.#logger, 'action.reconciliation.started', telemetry);
      if (!write.reconcile) return unknown('reconcile_unsupported', 'the capability cannot reconcile', elapsed());
      const reconcile = write.reconcile;
      const report = await this.#call(definition.timeoutMs, (signal) => reconcile(this.#context(command, request, signal)), capability, elapsed, true);
      emitTelemetry(this.#logger, 'action.reconciliation.completed', { ...telemetry, outcome: report.outcome, errorCode: report.errorCode, durationMs: report.durationMs });
      return report;
    }

    emitTelemetry(this.#logger, request.kind === 'replay' ? 'action.execution.replayed' : 'action.execution.started', telemetry);
    // Arguments were validated when the command was created; validate again: the command is data too.
    const args = capability.input.safeParse(command.validatedArguments);
    if (!args.success) return unknown('invalid_command_arguments', 'command arguments no longer match the capability input schema', elapsed());
    const execute = write.execute;
    return this.#call(definition.timeoutMs, (signal) => execute(args.data, this.#context(command, request, signal)), capability, elapsed, false);
  }

  #context(command: ActionCommand, request: AttemptRequest, signal: AbortSignal) {
    return { executionKey: command.executionKey, execution: command.trustedContext, attempt: request.attemptNumber, signal };
  }

  async #call(
    timeoutMs: number,
    fn: (signal: AbortSignal) => Promise<WriteReconciliationResult<unknown>>,
    capability: RegisteredCapability,
    elapsed: () => number,
    reconciling: boolean,
  ): Promise<AttemptReport> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, timeoutMs);
    });
    let raw: unknown;
    try {
      raw = await Promise.race([fn(controller.signal), timeout]);
    } catch (error) {
      if (controller.signal.aborted) return unknown('timeout', `no answer within ${timeoutMs}ms`, elapsed());
      return unknown(reconciling ? 'reconciliation_error' : 'handler_error', truncate(error instanceof Error ? error.message : 'write handler failed'), elapsed());
    } finally {
      clearTimeout(timer);
    }
    if (raw === TIMED_OUT) return unknown('timeout', `no answer within ${timeoutMs}ms`, elapsed());
    return classify(raw, capability, elapsed(), reconciling);
  }
}

const TIMED_OUT = Symbol('timed_out');

const answerSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    result: z.unknown(),
    resourceRef: z.string().min(1).max(MAX_REF).optional(),
    externalOperationRef: z.string().min(1).max(MAX_REF).optional(),
    executedAt: timestampSchema.optional(),
    replayed: z.boolean().optional(),
  }),
  z.object({ status: z.literal('rejected'), code: codeSchema, message: z.string(), details: jsonValueSchema.optional() }),
  z.object({ status: z.literal('failed'), code: codeSchema, message: z.string(), details: jsonValueSchema.optional() }),
  z.object({ status: z.literal('unknown'), message: z.string() }),
  z.object({ status: z.literal('not_applied') }),
]);

/** Domain answers are untrusted too: the envelope and the result must match their schemas. */
function classify(raw: unknown, capability: RegisteredCapability, durationMs: number, reconciling: boolean): AttemptReport {
  const answer = answerSchema.safeParse(raw);
  if (!answer.success) return unknown('invalid_capability_output', 'the write handler answer does not match the write contract', durationMs);
  const value = answer.data;
  switch (value.status) {
    case 'applied': {
      const output = capability.output.safeParse(value.result);
      const json = output.success ? jsonValueSchema.safeParse(output.data) : null;
      // The effect may well have happened, but its evidence is unusable: unknown, never success.
      if (!output.success || !json?.success) return unknown('invalid_capability_output', 'the capability result does not match its declared schema', durationMs);
      return {
        ...base(durationMs),
        outcome: 'applied',
        result: json.data,
        resourceRef: value.resourceRef ?? null,
        externalOperationRef: value.externalOperationRef ?? null,
        executedAt: value.executedAt ?? null,
        replayed: value.replayed ?? false,
      };
    }
    case 'rejected':
    case 'failed':
      return { ...base(durationMs), outcome: value.status, errorCode: value.code, message: truncate(value.message), details: value.details ?? null };
    case 'unknown':
      return unknown('domain_unknown', truncate(value.message), durationMs);
    case 'not_applied':
      // Only a lookup can establish that nothing happened for the key.
      return reconciling ? { ...base(durationMs), outcome: 'not_applied' } : unknown('invalid_capability_output', 'an execution cannot report not_applied', durationMs);
  }
}

function base(durationMs: number): AttemptReport {
  return { outcome: 'unknown', errorCode: null, message: null, result: null, resourceRef: null, externalOperationRef: null, executedAt: null, replayed: false, details: null, durationMs };
}

function unknown(errorCode: string, message: string, durationMs: number): AttemptReport {
  return { ...base(durationMs), outcome: 'unknown', errorCode, message };
}

function semanticsOf(capability: RegisteredCapability): WriteExecutionSemantics | null {
  if (!capability.write) return null;
  const { retryPolicy } = capability.definition;
  return {
    recovery: capability.write.recovery,
    reconcileSupported: capability.write.reconcile !== null,
    maxAttempts: retryPolicy.maxAttempts,
    initialBackoffMs: retryPolicy.initialBackoffMs,
  };
}

function truncate(message: string): string {
  return message.length > MAX_TEXT ? `${message.slice(0, MAX_TEXT - 1)}…` : message;
}

function issuesOf(error: z.ZodError): JsonValue {
  return error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: truncate(issue.message) }));
}
