import { z } from 'zod';
import {
  PlatformError,
  capabilityDefinitionSchema,
  type CapabilityDefinition,
  type JsonValue,
  type TrustedActionContext,
  type TrustedExecutionContext,
  type WriteRecoveryStrategy,
} from '@r4/contracts';

export interface CapabilityHandlerContext {
  readonly execution: TrustedExecutionContext;
  readonly invocationId: string;
  /** Aborted when the invocation times out; handlers should stop work. */
  readonly signal: AbortSignal;
}

export type CapabilityHandler<I, O> = (input: I, context: CapabilityHandlerContext) => Promise<O>;

/**
 * What an owner (agent pack or domain adapter) registers. The zod schemas are
 * the single source of truth: the runtime validates with them and derives the
 * JSON Schema documents exposed in the definition from them.
 */
export interface CapabilityRegistration<I, O> {
  readonly definition: Omit<CapabilityDefinition, 'inputSchema' | 'outputSchema'>;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly handler: CapabilityHandler<I, O>;
}

export interface RegisteredCapability {
  readonly definition: CapabilityDefinition;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly handler: CapabilityHandler<unknown, unknown>;
  /** (R4-D) Present only for writes registered with `registerWrite`: reachable only by the ActionExecutor. */
  readonly write?: RegisteredWriteHandlers;
}

// ---------------------------------------------------------------------------
// R4-D write capabilities
// ---------------------------------------------------------------------------

/** What a write handler receives. The execution key and context come from the platform only. */
export interface WriteHandlerContext {
  /** Platform execution key: the same for every attempt, replay and reconciliation of one command. */
  readonly executionKey: string;
  readonly execution: TrustedActionContext;
  /** 1-based attempt number of this call within the command. */
  readonly attempt: number;
  /** Aborted when the attempt times out; the outcome is then unknown to the platform. */
  readonly signal: AbortSignal;
}

/**
 * What the domain reports for one execution. `failed` and `rejected` MUST
 * mean "no effect happened"; when the handler cannot tell, it returns
 * `unknown` (or throws): the platform then never assumes either way.
 */
export type WriteExecutionResult<O> =
  | {
      readonly status: 'applied';
      readonly result: O;
      readonly resourceRef?: string;
      readonly externalOperationRef?: string;
      /** When the domain applied the effect (ISO-8601), if it reports it. */
      readonly executedAt?: string;
      /** True when the domain returned an effect applied earlier under the same key. */
      readonly replayed?: boolean;
    }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string; readonly details?: JsonValue }
  | { readonly status: 'failed'; readonly code: string; readonly message: string; readonly details?: JsonValue }
  | { readonly status: 'unknown'; readonly message: string };

/** Reconciliation additionally knows "nothing was applied for this key". */
export type WriteReconciliationResult<O> = WriteExecutionResult<O> | { readonly status: 'not_applied' };

export type WriteExecuteHandler<I, O> = (input: I, context: WriteHandlerContext) => Promise<WriteExecutionResult<O>>;
export type WriteReconcileHandler<O> = (context: WriteHandlerContext) => Promise<WriteReconciliationResult<O>>;

/**
 * A write capability as its owner registers it. The owner must declare how a
 * repeated execution is made safe; without that the capability cannot be
 * registered as executable (a plain `register` of a write class stays
 * visible but can never execute).
 */
export interface WriteCapabilityRegistration<I, O> {
  readonly definition: Omit<CapabilityDefinition, 'inputSchema' | 'outputSchema' | 'writeRecovery'>;
  readonly recovery: WriteRecoveryStrategy;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly execute: WriteExecuteHandler<I, O>;
  /** Required for `reconcile_before_retry`; optional (a last resort) for `idempotent_replay`. */
  readonly reconcile?: WriteReconcileHandler<O>;
}

export interface RegisteredWriteHandlers {
  readonly recovery: WriteRecoveryStrategy;
  readonly execute: WriteExecuteHandler<unknown, unknown>;
  readonly reconcile: WriteReconcileHandler<unknown> | null;
}

/** A write is never executable through the READ handler slot. */
const refuseReadPath: CapabilityHandler<unknown, unknown> = () =>
  Promise.reject(new PlatformError('internal', 'write_requires_governed_execution', 'write capabilities execute only through the ActionExecutor'));

/**
 * In-process registry of capabilities available to this runtime. It is
 * configuration rebuilt deterministically at boot from code, not durable state:
 * nothing in it needs to survive a restart. Durable facts about invocations
 * live in observations.
 */
export class CapabilityRegistry {
  readonly #byKey = new Map<string, RegisteredCapability>();

  register<I, O>(registration: CapabilityRegistration<I, O>): CapabilityDefinition {
    const definition = this.#define(registration.definition, registration.input, registration.output);
    this.#add({
      definition,
      input: registration.input,
      output: registration.output,
      handler: registration.handler as CapabilityHandler<unknown, unknown>,
    });
    return definition;
  }

  /**
   * (R4-D) Registers an executable write. Its handlers are held apart from the
   * READ handler slot, so the read invoker can never reach them; only the
   * ActionExecutor calls them, and only for a command the platform authorized.
   */
  registerWrite<I, O>(registration: WriteCapabilityRegistration<I, O>): CapabilityDefinition {
    const { capabilityId } = registration.definition;
    if (registration.definition.riskClass === 'READ') {
      throw new PlatformError('validation', 'invalid_capability_definition', `${capabilityId}: READ capabilities are registered with register()`);
    }
    if (registration.recovery === 'reconcile_before_retry' && registration.reconcile === undefined) {
      throw new PlatformError('validation', 'invalid_capability_definition', `${capabilityId}: reconcile_before_retry requires a reconcile handler`);
    }
    const definition = this.#define({ ...registration.definition, writeRecovery: registration.recovery }, registration.input, registration.output);
    this.#add({
      definition,
      input: registration.input,
      output: registration.output,
      handler: refuseReadPath,
      write: {
        recovery: registration.recovery,
        execute: registration.execute as WriteExecuteHandler<unknown, unknown>,
        reconcile: (registration.reconcile as WriteReconcileHandler<unknown> | undefined) ?? null,
      },
    });
    return definition;
  }

  #define(base: Omit<CapabilityDefinition, 'inputSchema' | 'outputSchema'>, input: z.ZodType, output: z.ZodType): CapabilityDefinition {
    let inputSchema: Record<string, unknown>;
    let outputSchema: Record<string, unknown>;
    try {
      inputSchema = z.toJSONSchema(input, { io: 'input' });
      outputSchema = z.toJSONSchema(output, { io: 'output' });
    } catch (error) {
      throw new PlatformError('validation', 'capability_schema_unrepresentable', `capability ${base.capabilityId}: schemas must be representable as JSON Schema`, { cause: String(error) });
    }
    const parsed = capabilityDefinitionSchema.safeParse({ ...base, inputSchema, outputSchema });
    if (!parsed.success) {
      throw new PlatformError('validation', 'invalid_capability_definition', `invalid capability definition: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }

  #add(entry: RegisteredCapability): void {
    const key = registryKey(entry.definition.capabilityId, entry.definition.version);
    if (this.#byKey.has(key)) {
      throw new PlatformError('conflict', 'capability_already_registered', `capability ${key} is already registered`);
    }
    this.#byKey.set(key, entry);
  }

  /** Exact version, or the highest registered version when omitted. */
  resolve(capabilityId: string, version?: number): RegisteredCapability | undefined {
    if (version !== undefined) return this.#byKey.get(registryKey(capabilityId, version));
    let latest: RegisteredCapability | undefined;
    for (const entry of this.#byKey.values()) {
      if (entry.definition.capabilityId !== capabilityId) continue;
      if (!latest || entry.definition.version > latest.definition.version) latest = entry;
    }
    return latest;
  }

  list(): CapabilityDefinition[] {
    return [...this.#byKey.values()].map((entry) => entry.definition).sort(compareDefinitions);
  }

  /**
   * Discovery: the capabilities an agent may see given its granted scopes.
   * A capability is visible only if every required scope is granted.
   */
  discover(grantedScopes: readonly string[]): CapabilityDefinition[] {
    const granted = new Set(grantedScopes);
    return this.list().filter((definition) => isAuthorized(definition, granted));
  }
}

export function isAuthorized(definition: CapabilityDefinition, granted: ReadonlySet<string>): boolean {
  return definition.requiredScopes.every((scope) => granted.has(scope));
}

function registryKey(capabilityId: string, version: number): string {
  return `${capabilityId}@${version}`;
}

function compareDefinitions(a: CapabilityDefinition, b: CapabilityDefinition): number {
  return a.capabilityId === b.capabilityId ? a.version - b.version : a.capabilityId.localeCompare(b.capabilityId);
}
