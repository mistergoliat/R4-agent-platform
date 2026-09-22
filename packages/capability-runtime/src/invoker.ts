import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  PlatformError,
  jsonValueSchema,
  trustedExecutionContextSchema,
  type CapabilityFailureCode,
  type CapabilityInvocationRequest,
  type CapabilityRejectionCode,
  type Clock,
  type IdGenerator,
  type JsonValue,
  type Observation,
  type TrustedExecutionContext,
} from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import { isAuthorized, type CapabilityRegistry, type RegisteredCapability } from './registry.js';

/**
 * Durable sink for observations (implemented by the persistence adapter).
 * `record` must be idempotent on `source.invocationId`.
 */
export interface ObservationStore {
  record(observation: Observation): Promise<Observation>;
  findByInvocationId(invocationId: string): Promise<Observation | null>;
}

export interface CapabilityInvokerOptions {
  registry: CapabilityRegistry;
  observations: ObservationStore;
  ids: IdGenerator;
  clock: Clock;
  logger: StructuredLogger;
}

export interface InvokeOptions {
  /** Supplied by the runtime to make a re-invocation after a crash idempotent. */
  readonly invocationId?: string;
}

const MAX_REQUESTED_ID_LENGTH = 256;
const MAX_ERROR_MESSAGE_LENGTH = 2000;

type Outcome =
  | { kind: 'succeeded'; payload: JsonValue }
  | { kind: 'rejected'; code: CapabilityRejectionCode; message: string; details: JsonValue | null }
  | { kind: 'failed'; code: CapabilityFailureCode; message: string; details: JsonValue | null };

/**
 * The invocation contract. Every request — valid or not — produces exactly one
 * durable Observation, so an agent can always learn what actually happened and
 * replan, and nothing is ever inferred from model text.
 *
 *   resolve → authorize (scopes) → permit (R4-B: READ only) → validate args
 *   → execute with timeout → validate output → record observation
 *
 * Writes are not executable here by design: they will require the
 * ActionProposal → Policy → Execution → ActionReceipt path (R4-D).
 */
export class CapabilityInvoker {
  readonly #registry: CapabilityRegistry;
  readonly #observations: ObservationStore;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #logger: StructuredLogger;

  constructor(options: CapabilityInvokerOptions) {
    this.#registry = options.registry;
    this.#observations = options.observations;
    this.#ids = options.ids;
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  async invoke(
    request: CapabilityInvocationRequest,
    context: TrustedExecutionContext,
    options: InvokeOptions = {},
  ): Promise<Observation> {
    const execution = parseContext(context);
    const invocationId = options.invocationId ?? this.#ids.next();

    const existing = await this.#observations.findByInvocationId(invocationId);
    if (existing) return existing;

    const requestedId = String(request.capabilityId).slice(0, MAX_REQUESTED_ID_LENGTH) || 'unknown';
    const capability = this.#registry.resolve(requestedId, request.capabilityVersion);
    const started = performance.now();
    const outcome = await this.#execute(capability, request, execution, invocationId);
    const durationMs = Math.round(performance.now() - started);
    const observedAt = this.#clock.now();
    const ttl = capability?.definition.freshnessTtlMs ?? null;

    const observation: Observation = {
      observationId: this.#ids.next(),
      taskId: execution.taskId,
      runId: execution.runId,
      agentId: execution.agentId,
      source: {
        kind: 'capability',
        capabilityId: requestedId,
        capabilityVersion: capability?.definition.version ?? request.capabilityVersion ?? null,
        invocationId,
      },
      outcome: outcome.kind,
      payload: outcome.kind === 'succeeded' ? outcome.payload : null,
      error: outcome.kind === 'succeeded' ? null : { code: outcome.code, message: outcome.message, details: outcome.details },
      observedAt: observedAt.toISOString(),
      validUntil: outcome.kind === 'succeeded' && ttl !== null ? new Date(observedAt.getTime() + ttl).toISOString() : null,
      provenance: {
        runtime: 'r4.capability-runtime',
        owner: capability?.definition.owner ?? null,
        riskClass: capability?.definition.riskClass ?? null,
        attempts: outcome.kind === 'rejected' ? 0 : 1,
        durationMs,
      },
      correlationId: execution.correlationId,
    };

    const recorded = await this.#observations.record(observation);
    emitTelemetry(this.#logger, 'capability.invocation.completed', {
      taskId: execution.taskId,
      runId: execution.runId,
      agentId: execution.agentId,
      capabilityId: requestedId,
      invocationId,
      observationId: recorded.observationId,
      outcome: recorded.outcome,
      errorCode: recorded.error?.code ?? null,
      durationMs,
    });
    return recorded;
  }

  async #execute(
    capability: RegisteredCapability | undefined,
    request: CapabilityInvocationRequest,
    execution: TrustedExecutionContext,
    invocationId: string,
  ): Promise<Outcome> {
    if (!capability) {
      return reject('capability_not_found', `capability "${String(request.capabilityId).slice(0, 128)}" is not registered`);
    }
    const { definition } = capability;
    if (!isAuthorized(definition, new Set(execution.grantedScopes))) {
      return reject('scope_denied', `agent lacks required scopes for ${definition.capabilityId}`, { requiredScopes: definition.requiredScopes });
    }
    if (definition.riskClass !== 'READ') {
      return reject('execution_not_permitted', `${definition.riskClass} capabilities require the governed action path, which is not available`);
    }

    const args = capability.input.safeParse(request.arguments);
    if (!args.success) {
      return reject('invalid_arguments', 'arguments do not match the capability input schema', { issues: issuesOf(args.error) });
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, definition.timeoutMs);
    });

    let raw: unknown;
    try {
      raw = await Promise.race([
        capability.handler(args.data, { execution, invocationId, signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (controller.signal.aborted) return fail('timeout', `capability exceeded ${definition.timeoutMs}ms`);
      return fail('handler_error', truncate(error instanceof Error ? error.message : 'capability handler failed'));
    } finally {
      clearTimeout(timer);
    }
    if (raw === TIMED_OUT) return fail('timeout', `capability exceeded ${definition.timeoutMs}ms`);

    // Capability output is untrusted too: it must match the declared schema and be JSON.
    const output = capability.output.safeParse(raw);
    if (!output.success) {
      return fail('invalid_capability_output', 'capability output does not match its declared schema', { issues: issuesOf(output.error) });
    }
    const json = jsonValueSchema.safeParse(output.data);
    if (!json.success) {
      return fail('invalid_capability_output', 'capability output is not JSON-serializable');
    }
    return { kind: 'succeeded', payload: json.data };
  }
}

const TIMED_OUT = Symbol('timed_out');

function parseContext(context: TrustedExecutionContext): TrustedExecutionContext {
  const parsed = trustedExecutionContextSchema.safeParse(context);
  if (!parsed.success) {
    // A malformed trusted context is a platform bug, not an agent mistake.
    throw new PlatformError('internal', 'invalid_execution_context', z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function reject(code: CapabilityRejectionCode, message: string, details: JsonValue | null = null): Outcome {
  return { kind: 'rejected', code, message, details };
}

function fail(code: CapabilityFailureCode, message: string, details: JsonValue | null = null): Outcome {
  return { kind: 'failed', code, message, details };
}

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…` : message;
}

function issuesOf(error: z.ZodError): JsonValue {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: truncate(issue.message),
  }));
}
