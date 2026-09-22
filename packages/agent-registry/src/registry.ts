import {
  PlatformError,
  fingerprint,
  type AgentDefinition,
  type AgentSummary,
  type Clock,
  type RegisteredAgentDefinition,
} from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';

/**
 * Durable store for registered definitions. `register` must be atomic and
 * must never overwrite an existing (agentId, version).
 */
export interface AgentDefinitionStore {
  /**
   * Inserts the definition if absent. Returns the stored row — the
   * pre-existing one when `inserted` is false, so callers can compare hashes.
   */
  register(definition: RegisteredAgentDefinition): Promise<{ stored: RegisteredAgentDefinition; inserted: boolean }>;
  get(agentId: string, version: number): Promise<RegisteredAgentDefinition | null>;
  getLatest(agentId: string): Promise<RegisteredAgentDefinition | null>;
  listLatest(): Promise<RegisteredAgentDefinition[]>;
}

export interface SyncReport {
  readonly registered: readonly string[];
  readonly unchanged: readonly string[];
}

/** Content hash over the full definition; any change requires a new version. */
export function definitionContentHash(definition: AgentDefinition): string {
  return fingerprint(definition);
}

/**
 * Agent Registry. Definitions come from configuration and are registered into
 * durable storage, where they become immutable per (agentId, version). Tasks
 * pin the exact version, so a task's configuration survives restarts and later
 * edits to the source files.
 */
export class AgentRegistry {
  readonly #store: AgentDefinitionStore;
  readonly #clock: Clock;
  readonly #logger: StructuredLogger;

  constructor(options: { store: AgentDefinitionStore; clock: Clock; logger: StructuredLogger }) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  /**
   * Registers new definitions and verifies existing ones are unchanged.
   * Editing an already-registered version is refused: publish a new version.
   */
  async sync(definitions: readonly AgentDefinition[]): Promise<SyncReport> {
    const registered: string[] = [];
    const unchanged: string[] = [];
    for (const definition of definitions) {
      const key = `${definition.agentId}@${definition.version}`;
      const contentHash = definitionContentHash(definition);
      const { stored, inserted } = await this.#store.register({
        ...definition,
        contentHash,
        registeredAt: this.#clock.now().toISOString(),
      });
      if (stored.contentHash !== contentHash) {
        throw new PlatformError('conflict', 'agent_definition_version_immutable', `agent definition ${key} is already registered with different content; bump "version" instead of editing it`, {
          agentId: definition.agentId,
          version: definition.version,
        });
      }
      (inserted ? registered : unchanged).push(key);
    }
    emitTelemetry(this.#logger, 'agent_definitions.synced', { registered, unchanged });
    return { registered, unchanged };
  }

  /** Exact version, or the latest registered version when omitted. */
  async resolve(agentId: string, version?: number): Promise<RegisteredAgentDefinition | null> {
    return version === undefined ? this.#store.getLatest(agentId) : this.#store.get(agentId, version);
  }

  async get(agentId: string, version?: number): Promise<RegisteredAgentDefinition> {
    const definition = await this.resolve(agentId, version);
    if (!definition) {
      throw new PlatformError('not_found', 'agent_not_found', `agent "${agentId}"${version === undefined ? '' : ` version ${version}`} not found`);
    }
    return definition;
  }

  async list(): Promise<AgentSummary[]> {
    const latest = await this.#store.listLatest();
    return latest.map((definition) => ({
      agentId: definition.agentId,
      version: definition.version,
      displayName: definition.displayName,
      description: definition.description,
      taskTypes: definition.taskTypes,
      registeredAt: definition.registeredAt,
    }));
  }
}
