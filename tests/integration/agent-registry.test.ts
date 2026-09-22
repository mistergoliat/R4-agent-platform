import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformError, registeredAgentDefinitionSchema, systemClock } from '@r4/contracts';
import { AgentRegistry, loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, type Pool } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { REPO_AGENTS_DIR, startTestPlatform, validTaskBody } from '../support/platform.js';

let db: TestDatabase;
let pool: Pool;
let registry: AgentRegistry;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  registry = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger: createSilentLogger() });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('agent registry persistence', () => {
  it('registers definitions loaded from configuration, then reports them unchanged on re-sync', async () => {
    const loaded = (await loadAgentDefinitionsFromDirectory(REPO_AGENTS_DIR)).map((l) => l.definition);
    expect(await registry.sync(loaded)).toEqual({ registered: ['platform-probe@1'], unchanged: [] });
    expect(await registry.sync(loaded)).toEqual({ registered: [], unchanged: ['platform-probe@1'] });

    const stored = await registry.get('platform-probe');
    expect(registeredAgentDefinitionSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({ ...loaded[0], contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('refuses to change an already-registered version (immutability)', async () => {
    const [probe] = (await loadAgentDefinitionsFromDirectory(REPO_AGENTS_DIR)).map((l) => l.definition);
    const edited = { ...probe!, instructions: 'quietly changed' };
    const error = await registry.sync([edited]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe('agent_definition_version_immutable');
    expect((await registry.get('platform-probe', 1)).instructions).toBe(probe!.instructions);
  });

  it('serves the latest version by default and exact versions on request', async () => {
    const [probe] = (await loadAgentDefinitionsFromDirectory(REPO_AGENTS_DIR)).map((l) => l.definition);
    await registry.sync([{ ...probe!, version: 2, description: 'second version' }]);
    expect((await registry.get('platform-probe')).version).toBe(2);
    expect((await registry.get('platform-probe', 1)).version).toBe(1);
    expect(await registry.list()).toMatchObject([{ agentId: 'platform-probe', version: 2, description: 'second version' }]);
    await expect(registry.get('platform-probe', 7)).rejects.toMatchObject({ code: 'agent_not_found' });
    await expect(registry.get('nobody')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('task pinning to agent versions', () => {
  it('keeps a task on the version it was created with after a newer version is published', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'r4-agents-pin-'));
    const isolated = await createMigratedTestDatabase();
    try {
      const probe = JSON.parse(await readFile(join(REPO_AGENTS_DIR, 'platform-probe', 'platform-probe.agent.json'), 'utf8')) as Record<string, unknown>;
      await writeFile(join(dir, 'v1.agent.json'), JSON.stringify(probe));
      const first = await startTestPlatform(isolated.url, { agentDefinitionsDir: dir });
      const taskId = (await first.tasks.createTask({ request: validTaskBody(), requestedBy: { kind: 'service', ref: 't' }, correlationId: 'c' })).view.task.taskId;
      await first.close();

      await writeFile(join(dir, 'v2.agent.json'), JSON.stringify({ ...probe, version: 2, instructions: 'v2 instructions' }));
      const second = await startTestPlatform(isolated.url, { agentDefinitionsDir: dir });
      try {
        expect((await second.tasks.getTask(taskId)).task.agentVersion).toBe(1);
        const newTask = await second.tasks.createTask({ request: validTaskBody(), requestedBy: { kind: 'service', ref: 't' }, correlationId: 'c' });
        expect(newTask.view.task.agentVersion).toBe(2);
        const pinned = await second.tasks.createTask({ request: validTaskBody({ agentVersion: 1 }), requestedBy: { kind: 'service', ref: 't' }, correlationId: 'c' });
        expect(pinned.view.task.agentVersion).toBe(1);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await isolated.drop();
    }
  });
});
