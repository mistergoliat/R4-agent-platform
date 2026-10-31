import { registerAgentDefinitions } from '@r4/api';
import { PlatformError } from '@r4/contracts';
import { ProductionConfigError, declaredExecutionMode, loadProductionConfig, profileLabel } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { SALES_AGENT_DIR, SALES_MIGRATIONS_DIR } from '../definition.js';
import { SALES_AGENT_ID } from '../ids.js';
import { SALES_PRODUCTION_PROFILES, salesProductionProfile } from './profile-v9.js';

/**
 * `npm run production:sales:bootstrap` — registers the Sales AgentDefinition
 * (`agents/sales/sales.agent.json`) into the already-migrated production
 * database through the Agent Registry boundary (R4-I). Production runs the
 * channel gateway and the worker, and neither registers definitions: this is
 * the explicit, auditable deployment step that does, run after the
 * migrations and before the processes start.
 *
 * Registers `sales` only. Idempotent (`unchanged` on repeat); an already
 * registered version with different content is refused — publish a new
 * version instead. Touches nothing else: no autonomy, rollout, model,
 * channel or network other than PostgreSQL.
 */
export interface BootstrapIo {
  out(line: string): void;
  err(line: string): void;
}

const DATABASE_URL = /^postgres(ql)?:\/\//;

/** Never echo a connection string (it may carry credentials). */
function redact(message: string): string {
  return message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted database url]');
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof PlatformError || error instanceof ProductionConfigError) return { code: error.code, message: redact(error.message) };
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unexpected_failure';
  return { code, message: redact(error instanceof Error ? error.message : String(error)) };
}

/** Returns the process exit code: 0 registered or unchanged, 1 refused or failed. */
export async function runProductionBootstrap(
  env: Readonly<Record<string, string | undefined>>,
  io: BootstrapIo,
  options: { readonly definitionsDir?: string } = {},
): Promise<number> {
  try {
    // Production must be positively established; nothing is guessed or defaulted.
    if (declaredExecutionMode(env) !== 'production') throw new ProductionConfigError('production_mode_not_declared', 'R4_EXECUTION_MODE must be "production" for the production bootstrap');
    const { config } = loadProductionConfig(env);
    if (!salesProductionProfile(config.policyProfile)) {
      throw new ProductionConfigError('invalid_production_config', `R4_PROD_POLICY_PROFILE=${config.policyProfile} is not a Sales production profile (${SALES_PRODUCTION_PROFILES.map(profileLabel).join(', ')})`);
    }
    const databaseUrl = env.R4_DATABASE_URL;
    if (!databaseUrl || !DATABASE_URL.test(databaseUrl)) throw new ProductionConfigError('production_config_incomplete', 'R4_DATABASE_URL (postgres://) of the production deployment is required');
    const level = env.R4_LOG_LEVEL === 'info' || env.R4_LOG_LEVEL === 'debug' ? env.R4_LOG_LEVEL : 'warn';
    const report = await registerAgentDefinitions({
      databaseUrl,
      directory: options.definitionsDir ?? SALES_AGENT_DIR,
      agentIds: [SALES_AGENT_ID],
      migrationDirectories: [SALES_MIGRATIONS_DIR],
      logger: createLogger({ service: 'r4-production-bootstrap', level }),
    });
    io.out('production Sales bootstrap:');
    if (report.registered.length > 0) io.out(`registered: ${report.registered.join(', ')}`);
    if (report.unchanged.length > 0) io.out(`unchanged: ${report.unchanged.join(', ')}`);
    return 0;
  } catch (error) {
    const { code, message } = describeError(error);
    io.err(`error: ${code}: ${message}`);
    return 1;
  }
}
