import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { openProductionAdministration } from '@r4/channel-gateway';
import { PlatformError } from '@r4/contracts';
import {
  ProductionConfigError,
  type ProductionAdministration,
  declaredExecutionMode,
  loadProductionConfig,
  profileLabel,
} from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { SALES_MIGRATIONS_DIR } from '../definition.js';
import { SALES_PRODUCTION_PROFILE } from './profile.js';

/**
 * `npm run production:sales:control -- <command>` — production
 * administration of the Sales deployment (R4-I, D-5/D-6).
 *
 * Trust boundary: access to the production host and its environment. This
 * is deployment tooling, NOT the operator plane: it never builds a human
 * identity, never calls the HTTP API, never loads `.env`, and needs no
 * channel or model credentials — only the production declaration and the
 * R4 database of the deployment. Every change is attributed to
 * `platform:production-control` (a production-host administrative action,
 * not a verified individual).
 */
export const CONTROL_USAGE = [
  'usage: production:sales:control <command>',
  '  autonomy status',
  '  autonomy off --reason "<reason>"',
  '  autonomy on --reason "<reason>"          (does NOT release held tasks)',
  '  holds list                               (tasks held because autonomy was disabled)',
  '  holds release --task <task-id> --reason "<reason>"   (one task; autonomy must be on)',
].join('\n');

export type ControlCommand =
  | { readonly kind: 'autonomy-status' }
  | { readonly kind: 'autonomy-set'; readonly enabled: boolean; readonly reason: string }
  | { readonly kind: 'holds-list' }
  | { readonly kind: 'holds-release'; readonly taskId: string; readonly reason: string };

export class ControlUsageError extends Error {
  readonly code = 'invalid_command';
}

function options(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    const value = args[i + 1];
    if (!name.startsWith('--') || !allowed.includes(name.slice(2))) throw new ControlUsageError(`unexpected argument: ${name}`);
    if (Object.hasOwn(out, name.slice(2))) throw new ControlUsageError(`${name} given twice`);
    if (value === undefined || value.startsWith('--')) throw new ControlUsageError(`${name} needs a value`);
    out[name.slice(2)] = value;
  }
  for (const name of allowed) if (!Object.hasOwn(out, name)) throw new ControlUsageError(`--${name} is required`);
  return out;
}

function reasonOf(value: string): string {
  if (value.trim().length === 0) throw new ControlUsageError('--reason must state the operational reason (it is recorded in the audit)');
  return value;
}

/** Strict: exactly the documented commands, no defaults for a reason, no bulk release. */
export function parseControlCommand(argv: readonly string[]): ControlCommand {
  const [group, verb, ...rest] = argv;
  if (group === 'autonomy' && verb === 'status' && rest.length === 0) return { kind: 'autonomy-status' };
  if (group === 'autonomy' && (verb === 'on' || verb === 'off')) return { kind: 'autonomy-set', enabled: verb === 'on', reason: reasonOf(options(rest, ['reason']).reason!) };
  if (group === 'holds' && verb === 'list' && rest.length === 0) return { kind: 'holds-list' };
  if (group === 'holds' && verb === 'release') {
    const o = options(rest, ['task', 'reason']);
    return { kind: 'holds-release', taskId: o.task!, reason: reasonOf(o.reason!) };
  }
  throw new ControlUsageError(`unknown command: ${argv.join(' ') || '(none)'}`);
}

export interface ControlIo {
  out(line: string): void;
  err(line: string): void;
}

const DATABASE_URL = /^postgres(ql)?:\/\//;

/** Never echo a connection string (it may carry credentials). */
function redact(message: string): string {
  return message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted database url]');
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof ControlUsageError) return { code: error.code, message: error.message };
  if (error instanceof PlatformError || error instanceof ProductionConfigError) return { code: error.code, message: redact(error.message) };
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unexpected_failure';
  return { code, message: redact(error instanceof Error ? error.message : String(error)) };
}

/**
 * Runs one control command against the deployment's database. Returns the
 * process exit code: 0 done, 2 invalid command, 1 refused or failed
 * (configuration, schema, database, eligibility, mutation).
 */
export async function runProductionControl(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: ControlIo): Promise<number> {
  let command: ControlCommand;
  try {
    command = parseControlCommand(argv);
  } catch (error) {
    const { code, message } = describeError(error);
    io.err(`error: ${code}: ${message}\n${CONTROL_USAGE}`);
    return 2;
  }
  try {
    // Production must be positively established; nothing is guessed or defaulted.
    if (declaredExecutionMode(env) !== 'production') throw new ProductionConfigError('production_mode_not_declared', 'R4_EXECUTION_MODE must be "production" for production control');
    const { config } = loadProductionConfig(env);
    if (config.policyProfile !== profileLabel(SALES_PRODUCTION_PROFILE)) {
      throw new ProductionConfigError('invalid_production_config', `R4_PROD_POLICY_PROFILE=${config.policyProfile} is not the Sales production profile ${profileLabel(SALES_PRODUCTION_PROFILE)}`);
    }
    const databaseUrl = env.R4_DATABASE_URL;
    if (!databaseUrl || !DATABASE_URL.test(databaseUrl)) throw new ProductionConfigError('production_config_incomplete', 'R4_DATABASE_URL (postgres://) of the production deployment is required');
    const level = env.R4_LOG_LEVEL === 'info' || env.R4_LOG_LEVEL === 'debug' ? env.R4_LOG_LEVEL : 'warn';
    const logger = createLogger({ service: 'r4-production-control', level });
    // Refuses a database whose schema (Core + Sales) is not current before anything is read or changed.
    const { admin, close } = await openProductionAdministration({
      databaseUrl,
      migrationDirectories: [SALES_MIGRATIONS_DIR],
      logger,
      correlationId: `production-control:${hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'host'}:${process.pid}:${randomBytes(4).toString('hex')}`,
    });
    try {
      io.out(JSON.stringify(await execute(admin, command), null, 2));
      return 0;
    } finally {
      await close();
    }
  } catch (error) {
    const { code, message } = describeError(error);
    io.err(`error: ${code}: ${message}`);
    return 1;
  }
}

async function execute(admin: ProductionAdministration, command: ControlCommand): Promise<unknown> {
  switch (command.kind) {
    case 'autonomy-status': {
      const s = await admin.autonomyStatus();
      return {
        autonomy: s.autonomyEnabled ? 'enabled' : 'disabled',
        lastChange: s.global ? { at: s.global.changedAt, reason: s.global.reason, by: s.global.changedBy, version: s.global.version } : null,
        channels: s.channels.map((c) => ({ scope: c.scope, autonomy: c.autonomyEnabled ? 'enabled' : 'disabled', at: c.changedAt, reason: c.reason, by: c.changedBy })),
      };
    }
    case 'autonomy-set': {
      const r = await admin.setAutonomy(command.enabled, command.reason);
      return { autonomy: r.autonomyEnabled ? 'enabled' : 'disabled', scope: r.scope, version: r.version, at: r.changedAt, reason: r.reason, by: r.changedBy, heldTasks: 'unchanged (release each one with: holds release --task <id> --reason "...")' };
    }
    case 'holds-list':
      return { holds: await admin.holds() };
    case 'holds-release': {
      const r = await admin.releaseHold(command.taskId, command.reason);
      return { released: { taskId: r.taskId, requestId: r.request.requestId, status: r.request.status }, taskStatus: r.taskStatus, next: 'the normal worker claims the task when it is runnable; nothing was executed or sent' };
    }
  }
}
