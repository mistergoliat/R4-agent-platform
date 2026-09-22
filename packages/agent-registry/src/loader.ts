import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { PlatformError, agentDefinitionSchema, type AgentDefinition } from '@r4/contracts';

export const AGENT_DEFINITION_FILE_SUFFIX = '.agent.json';

export interface LoadedAgentDefinition {
  readonly definition: AgentDefinition;
  readonly source: string;
}

/**
 * Loads every `*.agent.json` under `directory` (recursively) and validates it.
 * All problems are collected and reported together; nothing is partially
 * loaded. Definitions are configuration: invalid files fail the boot.
 */
export async function loadAgentDefinitionsFromDirectory(directory: string): Promise<LoadedAgentDefinition[]> {
  const files = await findDefinitionFiles(directory);
  const loaded: LoadedAgentDefinition[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const source = relative(directory, file).split('\\').join('/');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      problems.push(`${source}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const parsed = parseAgentDefinition(raw);
    if (!parsed.success) {
      problems.push(`${source}: ${parsed.message}`);
      continue;
    }
    loaded.push({ definition: parsed.definition, source });
  }

  const seen = new Map<string, string>();
  for (const { definition, source } of loaded) {
    const key = `${definition.agentId}@${definition.version}`;
    const previous = seen.get(key);
    if (previous) problems.push(`${source}: duplicate definition ${key} (also in ${previous})`);
    seen.set(key, source);
  }

  if (problems.length > 0) {
    throw new PlatformError('validation', 'invalid_agent_definitions', `invalid agent definitions:\n- ${problems.join('\n- ')}`, { problems });
  }
  return loaded.sort((a, b) => a.source.localeCompare(b.source));
}

export function parseAgentDefinition(
  raw: unknown,
): { success: true; definition: AgentDefinition } | { success: false; message: string } {
  const parsed = agentDefinitionSchema.safeParse(raw);
  return parsed.success
    ? { success: true, definition: parsed.data }
    : { success: false, message: z.prettifyError(parsed.error).replace(/\n/g, '; ') };
}

async function findDefinitionFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new PlatformError('validation', 'agent_definitions_dir_unreadable', `cannot read agent definitions directory "${directory}"`, { cause: String(error) });
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...(await findDefinitionFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(AGENT_DEFINITION_FILE_SUFFIX)) {
      files.push(path);
    }
  }
  return files;
}
