import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { CreateTaskRequestInput } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { createPlatform, type Platform, type PlatformOverrides } from '@r4/api';

export const REPO_AGENTS_DIR = fileURLToPath(new URL('../../agents', import.meta.url));

export interface TestPlatformOptions extends PlatformOverrides {
  readonly agentDefinitionsDir?: string;
  readonly logger?: Logger;
}

/** Boots the real composition root against a test database. */
export function startTestPlatform(databaseUrl: string, options: TestPlatformOptions = {}): Promise<Platform> {
  const { agentDefinitionsDir, ...overrides } = options;
  return createPlatform(
    {
      databaseUrl,
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      agentDefinitionsDir: agentDefinitionsDir ?? REPO_AGENTS_DIR,
      dbPoolMax: 5,
    },
    { logger: createSilentLogger(), ...overrides },
  );
}

export const PROBE_AGENT = 'platform-probe';

/** A valid request body; overrides may deliberately make it invalid. */
export function validTaskBody(overrides: Record<string, unknown> = {}): CreateTaskRequestInput {
  return {
    taskType: 'probe.echo',
    agentId: PROBE_AGENT,
    goal: { description: 'Echo the input back as an observation-backed result', successCriteria: ['result references an observation'] },
    input: { message: 'hello' },
    ...overrides,
  };
}
