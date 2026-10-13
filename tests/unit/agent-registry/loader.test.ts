import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlatformError } from '@r4/contracts';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { REPO_AGENTS_DIR } from '../../support/platform.js';

let dir: string;
let probe: Record<string, unknown>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'r4-agents-'));
  probe = JSON.parse(await readFile(join(REPO_AGENTS_DIR, 'platform-probe', 'platform-probe.agent.json'), 'utf8')) as Record<string, unknown>;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('agent definition loading', () => {
  it('loads and validates the repository agent definitions', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(REPO_AGENTS_DIR);
    expect(loaded.map((l) => `${l.definition.agentId}@${l.definition.version}`)).toEqual(['platform-probe@1', 'sales@3', 'sales@4', 'sales@5']); // R4-F ships the sales pack; R4-J2D adds v4 beside the immutable v3; R4-J3E adds v5 (sales-production@5 only)
    expect(loaded[0]!.source).toBe('platform-probe/platform-probe.agent.json');
  });

  it('loads nested *.agent.json files and ignores other files', async () => {
    await mkdir(join(dir, 'pack', 'nested'), { recursive: true });
    await writeFile(join(dir, 'pack', 'nested', 'a.agent.json'), JSON.stringify(probe));
    await writeFile(join(dir, 'pack', 'b.agent.json'), JSON.stringify({ ...probe, version: 2 }));
    await writeFile(join(dir, 'pack', 'README.md'), '# not a definition');
    await writeFile(join(dir, 'pack', 'notes.json'), '{"ignored": true}');
    const loaded = await loadAgentDefinitionsFromDirectory(dir);
    expect(loaded.map((l) => l.definition.version).sort()).toEqual([1, 2]);
  });

  it('reports every invalid file at once and loads nothing', async () => {
    await writeFile(join(dir, 'bad-json.agent.json'), '{ nope');
    await writeFile(join(dir, 'bad-schema.agent.json'), JSON.stringify({ ...probe, taskTypes: [] }));
    await writeFile(join(dir, 'good.agent.json'), JSON.stringify(probe));
    const error = await loadAgentDefinitionsFromDirectory(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    const problems = ((error as PlatformError).details as { problems: string[] }).problems;
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/bad-json\.agent\.json: not valid JSON/);
    expect(problems.join('\n')).toMatch(/bad-schema\.agent\.json:.*taskTypes/);
  });

  it('refuses duplicate (agentId, version) across files', async () => {
    await writeFile(join(dir, 'one.agent.json'), JSON.stringify(probe));
    await writeFile(join(dir, 'two.agent.json'), JSON.stringify(probe));
    await expect(loadAgentDefinitionsFromDirectory(dir)).rejects.toThrow(/duplicate definition platform-probe@1/);
  });

  it('fails clearly when the directory is missing', async () => {
    await expect(loadAgentDefinitionsFromDirectory(join(dir, 'missing'))).rejects.toMatchObject({ code: 'agent_definitions_dir_unreadable' });
  });
});
