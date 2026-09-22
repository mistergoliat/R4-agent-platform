import type { RegisteredAgentDefinition } from '@r4/contracts';
import type { AgentDefinitionStore } from '@r4/agent-registry';
import { query, type Pool } from './pool.js';
import { agentDefinitionFromRow, jsonb } from './rows.js';

export class PostgresAgentDefinitionStore implements AgentDefinitionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async register(d: RegisteredAgentDefinition): Promise<{ stored: RegisteredAgentDefinition; inserted: boolean }> {
    const inserted = await query(
      this.#pool,
      `insert into agent_definitions (
         agent_id, version, schema_version, display_name, description, instructions,
         task_types, capability_scopes, skills, model_requirements, context_policy,
         budgets, delegation_policy, evaluation_profile, content_hash, registered_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16)
       on conflict (agent_id, version) do nothing
       returning *`,
      [
        d.agentId, d.version, d.schemaVersion, d.displayName, d.description, d.instructions,
        d.taskTypes, d.capabilityScopes, d.skills, jsonb(d.modelRequirements), jsonb(d.contextPolicy),
        jsonb(d.budgets), jsonb(d.delegationPolicy), jsonb(d.evaluationProfile), d.contentHash, d.registeredAt,
      ],
    );
    if (inserted.rows[0]) return { stored: agentDefinitionFromRow(inserted.rows[0]), inserted: true };
    const existing = await this.get(d.agentId, d.version);
    if (!existing) throw new Error(`agent definition ${d.agentId}@${d.version} vanished during registration`);
    return { stored: existing, inserted: false };
  }

  async get(agentId: string, version: number): Promise<RegisteredAgentDefinition | null> {
    const result = await query(this.#pool, 'select * from agent_definitions where agent_id = $1 and version = $2', [agentId, version]);
    return result.rows[0] ? agentDefinitionFromRow(result.rows[0]) : null;
  }

  async getLatest(agentId: string): Promise<RegisteredAgentDefinition | null> {
    const result = await query(this.#pool, 'select * from agent_definitions where agent_id = $1 order by version desc limit 1', [agentId]);
    return result.rows[0] ? agentDefinitionFromRow(result.rows[0]) : null;
  }

  async listLatest(): Promise<RegisteredAgentDefinition[]> {
    const result = await query(this.#pool, 'select distinct on (agent_id) * from agent_definitions order by agent_id, version desc');
    return result.rows.map(agentDefinitionFromRow);
  }
}
