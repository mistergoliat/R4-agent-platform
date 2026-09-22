import { z } from 'zod';

const configSchema = z.object({
  R4_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  R4_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  R4_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  R4_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  R4_AGENT_DEFINITIONS_DIR: z.string().min(1).default('./agents'),
  R4_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: z.infer<typeof configSchema>['R4_LOG_LEVEL'];
  readonly agentDefinitionsDir: string;
  readonly dbPoolMax: number;
}

/** Configuration comes only from the environment; invalid config fails the boot. */
export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  return {
    databaseUrl: c.R4_DATABASE_URL,
    host: c.R4_HTTP_HOST,
    port: c.R4_HTTP_PORT,
    logLevel: c.R4_LOG_LEVEL,
    agentDefinitionsDir: c.R4_AGENT_DEFINITIONS_DIR,
    dbPoolMax: c.R4_DB_POOL_MAX,
  };
}
