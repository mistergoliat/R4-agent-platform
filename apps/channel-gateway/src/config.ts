import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const configSchema = z.object({
  R4_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  R4_GATEWAY_HOST: z.string().min(1).default('127.0.0.1'),
  R4_GATEWAY_PORT: z.coerce.number().int().min(0).max(65535).default(8090),
  R4_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  R4_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
  R4_GATEWAY_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  /** Run the delivery dispatcher in this process (one or more gateways may; dispatch is fenced per message). */
  R4_GATEWAY_DISPATCH: z.enum(['true', 'false']).default('true'),
  /** Unsettled inbound (crash between persistence and ingestion) is resumed after this age. */
  R4_GATEWAY_RESUME_AFTER_MS: z.coerce.number().int().min(1000).default(30_000),
});

export interface GatewayConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: z.infer<typeof configSchema>['R4_LOG_LEVEL'];
  readonly dbPoolMax: number;
  readonly gatewayId: string;
  readonly dispatch: boolean;
  readonly resumeAfterMs: number;
}

/** Process configuration (no production decisions here: those come from the proven production config). */
export function loadGatewayConfig(env: Readonly<Record<string, string | undefined>>): GatewayConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const c = parsed.data;
  return {
    databaseUrl: c.R4_DATABASE_URL,
    host: c.R4_GATEWAY_HOST,
    port: c.R4_GATEWAY_PORT,
    logLevel: c.R4_LOG_LEVEL,
    dbPoolMax: c.R4_DB_POOL_MAX,
    gatewayId: c.R4_GATEWAY_ID ?? `gateway:${hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'host'}:${process.pid}:${randomBytes(3).toString('hex')}`,
    dispatch: c.R4_GATEWAY_DISPATCH === 'true',
    resumeAfterMs: c.R4_GATEWAY_RESUME_AFTER_MS,
  };
}
