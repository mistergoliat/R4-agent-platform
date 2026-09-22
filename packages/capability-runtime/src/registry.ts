import { z } from 'zod';
import {
  PlatformError,
  capabilityDefinitionSchema,
  type CapabilityDefinition,
  type TrustedExecutionContext,
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
}

/**
 * In-process registry of capabilities available to this runtime. It is
 * configuration rebuilt deterministically at boot from code, not durable state:
 * nothing in it needs to survive a restart. Durable facts about invocations
 * live in observations.
 */
export class CapabilityRegistry {
  readonly #byKey = new Map<string, RegisteredCapability>();

  register<I, O>(registration: CapabilityRegistration<I, O>): CapabilityDefinition {
    let inputSchema: Record<string, unknown>;
    let outputSchema: Record<string, unknown>;
    try {
      inputSchema = z.toJSONSchema(registration.input, { io: 'input' });
      outputSchema = z.toJSONSchema(registration.output, { io: 'output' });
    } catch (error) {
      throw new PlatformError('validation', 'capability_schema_unrepresentable', `capability ${registration.definition.capabilityId}: schemas must be representable as JSON Schema`, { cause: String(error) });
    }

    const parsed = capabilityDefinitionSchema.safeParse({ ...registration.definition, inputSchema, outputSchema });
    if (!parsed.success) {
      throw new PlatformError('validation', 'invalid_capability_definition', `invalid capability definition: ${z.prettifyError(parsed.error)}`);
    }
    const definition = parsed.data;
    const key = registryKey(definition.capabilityId, definition.version);
    if (this.#byKey.has(key)) {
      throw new PlatformError('conflict', 'capability_already_registered', `capability ${key} is already registered`);
    }
    this.#byKey.set(key, {
      definition,
      input: registration.input,
      output: registration.output,
      handler: registration.handler as CapabilityHandler<unknown, unknown>,
    });
    return definition;
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
