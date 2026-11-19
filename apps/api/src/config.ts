import { z } from 'zod';

const configSchema = z.object({
  R4_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  R4_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  R4_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  R4_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  R4_AGENT_DEFINITIONS_DIR: z.string().min(1).default('./agents'),
  R4_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  R4_SERVICE_READER_TOKEN_SHA256: z.string().optional(),
  R4_CONSOLE_OPERATOR_KEY: z.string().optional(),
  R4_CONSOLE_OPERATORS_FILE: z.string().optional(),
  R4_API_ANONYMOUS_WRITES: z.enum(['enabled', 'disabled']).default('enabled'),
});

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: z.infer<typeof configSchema>['R4_LOG_LEVEL'];
  readonly agentDefinitionsDir: string;
  readonly dbPoolMax: number;
  /** ADR-049: SHA-256 (hex) of the read-only service token; absent = no service reader. */
  readonly serviceReaderTokenSha256?: string;
  /** ADR-050: base64url HMAC key (>= 32 bytes) of the console assertion; with the operators file, enables the adapter. */
  readonly consoleOperatorKey?: string;
  /** ADR-050: JSON array of console operators by (issuer, subject); mode 0600 on POSIX. */
  readonly consoleOperatorsFile?: string;
  /** ADR-050: 'disabled' closes the R4-B anonymous writes. Absent = 'enabled'. */
  readonly anonymousWrites?: 'enabled' | 'disabled';
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
    ...(c.R4_SERVICE_READER_TOKEN_SHA256 ? { serviceReaderTokenSha256: c.R4_SERVICE_READER_TOKEN_SHA256 } : {}),
    ...(c.R4_CONSOLE_OPERATOR_KEY !== undefined ? { consoleOperatorKey: c.R4_CONSOLE_OPERATOR_KEY } : {}),
    ...(c.R4_CONSOLE_OPERATORS_FILE !== undefined ? { consoleOperatorsFile: c.R4_CONSOLE_OPERATORS_FILE } : {}),
    anonymousWrites: c.R4_API_ANONYMOUS_WRITES,
  };
}
