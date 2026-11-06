import { registerAgentDefinitions } from '@r4/api';
import { PlatformError } from '@r4/contracts';
import { ProductionConfigError, declaredExecutionMode, loadProductionConfig, profileLabel } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SALES_AGENT_DIR, SALES_MIGRATIONS_DIR, isSalesCandidateDefinition, loadSalesAgentDefinition } from '../definition.js';
import { SALES_AGENT_ID } from '../ids.js';
import { SALES_PRODUCTION_PROFILES, salesProductionAgentVersion, salesProductionProfile } from './profile-v8.js';
import { SALES_LANE_PROFILES } from './profile-v14.js';

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
  options: { readonly definitionsDir?: string; readonly lane?: boolean } = {},
): Promise<number> {
  try {
    // Production must be positively established; nothing is guessed or defaulted.
    if (declaredExecutionMode(env) !== 'production') throw new ProductionConfigError('production_mode_not_declared', 'R4_EXECUTION_MODE must be "production" for the production bootstrap');
    const { config } = loadProductionConfig(env);
    // (ADR-045) --lane: only the lane profile's own definition, from a directory holding just that file.
    const lane = options.lane ? SALES_LANE_PROFILES.find((p) => profileLabel(p) === config.policyProfile) : undefined;
    if (options.lane && !lane) throw new ProductionConfigError('invalid_production_config', `--lane requires R4_PROD_POLICY_PROFILE to be a Sales lane profile (${SALES_LANE_PROFILES.map(profileLabel).join(', ')})`);
    if (!lane && !salesProductionProfile(config.policyProfile)) {
      throw new ProductionConfigError('invalid_production_config', `R4_PROD_POLICY_PROFILE=${config.policyProfile} is not a Sales production profile (${SALES_PRODUCTION_PROFILES.map(profileLabel).join(', ')})`);
    }
    const databaseUrl = env.R4_DATABASE_URL;
    if (!databaseUrl || !DATABASE_URL.test(databaseUrl)) throw new ProductionConfigError('production_config_incomplete', 'R4_DATABASE_URL (postgres://) of the production deployment is required');
    const level = env.R4_LOG_LEVEL === 'info' || env.R4_LOG_LEVEL === 'debug' ? env.R4_LOG_LEVEL : 'warn';
    const laneDir = lane ? mkdtempSync(join(tmpdir(), 'r4-sales-lane-')) : null;
    let report: Awaited<ReturnType<typeof registerAgentDefinitions>>;
    try {
      if (lane && laneDir) {
        const version = salesProductionAgentVersion(lane);
        if (!isSalesCandidateDefinition(version)) throw new ProductionConfigError('invalid_production_config', `the lane definition v${version} is not a candidate file`);
        writeFileSync(join(laneDir, `sales.v${version}.agent.json`), JSON.stringify(loadSalesAgentDefinition(version)));
      }
      report = await registerAgentDefinitions({
        databaseUrl,
        directory: laneDir ?? options.definitionsDir ?? SALES_AGENT_DIR,
        agentIds: [SALES_AGENT_ID],
        migrationDirectories: [SALES_MIGRATIONS_DIR],
        logger: createLogger({ service: 'r4-production-bootstrap', level }),
      });
    } finally {
      if (laneDir) rmSync(laneDir, { recursive: true, force: true });
    }
    io.out(`production Sales bootstrap${lane ? ` (lane ${profileLabel(lane)})` : ''}:`);
    if (report.registered.length > 0) io.out(`registered: ${report.registered.join(', ')}`);
    if (report.unchanged.length > 0) io.out(`unchanged: ${report.unchanged.join(', ')}`);
    return 0;
  } catch (error) {
    const { code, message } = describeError(error);
    io.err(`error: ${code}: ${message}`);
    return 1;
  }
}
