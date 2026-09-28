import { PlatformError, systemClock, type Clock } from '@r4/contracts';
import { AgentRegistry, loadAgentDefinitionsFromDirectory, type SyncReport } from '@r4/agent-registry';
import type { StructuredLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, createPool, migrationStatus } from '@r4/persistence-postgres';

/**
 * Explicit registration of agent definitions into a deployment's database —
 * the same boundary the API uses at boot (`loadAgentDefinitionsFromDirectory`
 * + `AgentRegistry.sync`), without the API. For deployments that run only the
 * channel gateway and the worker (neither registers definitions): an
 * auditable deployment action, never implicit at process start.
 *
 * Fail-closed: the schema (Core + `migrationDirectories`) must be current;
 * the directory must load and validate as a whole; every requested agent
 * must be present; only the requested agents are registered. An already
 * registered (agentId, version) with different content is refused by the
 * registry (`agent_definition_version_immutable`).
 */
export async function registerAgentDefinitions(options: {
  readonly databaseUrl: string;
  /** Directory of `*.agent.json` files (loaded and validated as a whole). */
  readonly directory: string;
  /** Exactly which agents to register; any other definition found is ignored. */
  readonly agentIds: readonly string[];
  readonly migrationDirectories: readonly string[];
  readonly logger: StructuredLogger;
  readonly clock?: Clock;
}): Promise<SyncReport> {
  // Load before connecting: an invalid or missing definition never touches the database.
  const loaded = await loadAgentDefinitionsFromDirectory(options.directory);
  const selected = loaded.filter((entry) => options.agentIds.includes(entry.definition.agentId));
  const missing = options.agentIds.filter((id) => !selected.some((entry) => entry.definition.agentId === id));
  if (missing.length > 0) {
    throw new PlatformError('validation', 'agent_definition_missing', `no definition found for agent(s) ${missing.join(', ')} in the definitions directory`, { missing });
  }

  const pool = createPool({ connectionString: options.databaseUrl, logger: options.logger, applicationName: 'r4-agent-registration', max: 1 });
  try {
    for (const directory of [undefined, ...options.migrationDirectories]) {
      const status = await migrationStatus(pool, directory);
      if (status.pending.length > 0 || status.modified.length > 0) {
        throw new PlatformError('unavailable', 'schema_not_current', `database schema is not current (pending: ${status.pending.join(', ') || 'none'}; modified: ${status.modified.join(', ') || 'none'})`);
      }
    }
    const registry = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: options.clock ?? systemClock, logger: options.logger });
    return await registry.sync(selected.map((entry) => entry.definition));
  } finally {
    await pool.end().catch(() => undefined);
  }
}
