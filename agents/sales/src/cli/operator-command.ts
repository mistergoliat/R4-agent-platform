import { PlatformError } from '@r4/contracts';
import { ProductionConfigError, declaredExecutionMode, loadProductionConfig, profileLabel } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { SALES_MIGRATIONS_DIR } from '../definition.js';
import { OidcError, loadOperatorAuthConfig } from '../operator-auth/index.js';
import { inspectApprovals } from '../production/control.js';
import { SALES_PRODUCTION_PROFILES, salesProductionProfile } from '../production/profile-v7.js';
import { openApprovalInspection } from './approval-inspection.js';
import { DecisionRefused, decideApproval, whoAmI } from './operator-approval.js';

/**
 * `npm run production:sales:operator -- <command>` (R4-J3D-S, ADR-033) —
 * the human operator's approval client. Unlike `production:sales:control`
 * (host administration, which never decides for a human), every decision
 * here is made by an operator authenticated with OIDC (Google Workspace)
 * and authorized by the operator registry, through the platform's own
 * approval route. Reads the process environment only (never `.env`).
 */
export const OPERATOR_USAGE = [
  'usage: production:sales:operator <command>',
  '  whoami                                   (sign in; shows the verified identity and whether it is an authorized operator)',
  '  approvals list',
  '  approvals show --request <request-id>    (exact validated arguments and their hash)',
  '  approvals approve --request <request-id> --arguments-hash <hash> --reason "<reason>"',
  '  approvals reject  --request <request-id> --arguments-hash <hash> --reason "<reason>"',
].join('\n');

export type OperatorCommand =
  | { readonly kind: 'whoami' }
  | { readonly kind: 'approvals-list' }
  | { readonly kind: 'approvals-show'; readonly requestId: string }
  | { readonly kind: 'approvals-decide'; readonly decision: 'approve' | 'reject'; readonly requestId: string; readonly argumentsHash: string; readonly reason: string };

export class OperatorUsageError extends Error {
  readonly code = 'invalid_command';
}

/** Strict `--name value` options: every allowed option exactly once, nothing else. */
export function strictOptions(args: readonly string[], allowed: readonly string[], fail: (message: string) => Error = (m) => new OperatorUsageError(m)): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    const value = args[i + 1];
    if (!name.startsWith('--') || !allowed.includes(name.slice(2))) throw fail(`unexpected argument: ${name}`);
    if (Object.hasOwn(out, name.slice(2))) throw fail(`${name} given twice`);
    if (value === undefined || value.startsWith('--')) throw fail(`${name} needs a value`);
    out[name.slice(2)] = value;
  }
  for (const name of allowed) if (!Object.hasOwn(out, name)) throw fail(`--${name} is required`);
  return out;
}

/** approve|reject arguments (shared with the canary). */
export function parseDecision(verb: 'approve' | 'reject', rest: readonly string[], fail?: (message: string) => Error): { readonly decision: 'approve' | 'reject'; readonly requestId: string; readonly argumentsHash: string; readonly reason: string } {
  const o = strictOptions(rest, ['request', 'arguments-hash', 'reason'], fail);
  if (o.reason!.trim().length === 0) throw (fail ?? ((m: string) => new OperatorUsageError(m)))('--reason must state why (it is recorded in the audit)');
  return { decision: verb, requestId: o.request!, argumentsHash: o['arguments-hash']!, reason: o.reason! };
}

export function parseOperatorCommand(argv: readonly string[]): OperatorCommand {
  const [group, verb, ...rest] = argv;
  if (group === 'whoami' && verb === undefined) return { kind: 'whoami' };
  if (group === 'approvals' && verb === 'list' && rest.length === 0) return { kind: 'approvals-list' };
  if (group === 'approvals' && verb === 'show') return { kind: 'approvals-show', requestId: strictOptions(rest, ['request']).request! };
  if (group === 'approvals' && (verb === 'approve' || verb === 'reject')) return { kind: 'approvals-decide', ...parseDecision(verb, rest) };
  throw new OperatorUsageError(`unknown command: ${argv.join(' ') || '(none)'}`);
}

export interface OperatorIo {
  out(line: string): void;
  err(line: string): void;
}

const redact = (message: string) => message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted database url]');

export function describeOperatorError(error: unknown): { code: string; message: string } {
  if (error instanceof OperatorUsageError || error instanceof OidcError || error instanceof DecisionRefused || error instanceof PlatformError || error instanceof ProductionConfigError) return { code: error.code, message: redact(error.message) };
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unexpected_failure';
  return { code, message: redact(error instanceof Error ? error.message : String(error)) };
}

/** How the sign-in URL reaches the operator (stderr: stdout stays machine-readable JSON). */
export function printLoginUrl(io: OperatorIo, port: number): (url: string) => void {
  return (url) => io.err(`Sign in as an operator: open this URL in your browser (on a remote host, first: ssh -L ${port}:127.0.0.1:${port} <host>)\n${url}`);
}

export interface OperatorDeps {
  /** Tests: how the sign-in URL is "opened" (default: printed for the operator). */
  readonly openUrl?: (url: string) => void | Promise<void>;
  readonly fetchImpl?: typeof fetch;
}

export async function runOperator(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: OperatorIo, deps: OperatorDeps = {}): Promise<number> {
  let command: OperatorCommand;
  try {
    command = parseOperatorCommand(argv);
  } catch (error) {
    const { code, message } = describeOperatorError(error);
    io.err(`error: ${code}: ${message}\n${OPERATOR_USAGE}`);
    return 2;
  }
  try {
    if (declaredExecutionMode(env) !== 'production') throw new ProductionConfigError('production_mode_not_declared', 'R4_EXECUTION_MODE must be "production"');
    const { config } = loadProductionConfig(env);
    if (!salesProductionProfile(config.policyProfile)) throw new ProductionConfigError('invalid_production_config', `R4_PROD_POLICY_PROFILE is not a Sales production profile (${SALES_PRODUCTION_PROFILES.map(profileLabel).join(', ')})`);
    const databaseUrl = env.R4_DATABASE_URL;
    if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) throw new ProductionConfigError('production_config_incomplete', 'R4_DATABASE_URL (postgres://) of the deployment is required');
    const logger = createLogger({ service: 'r4-sales-operator', level: env.R4_LOG_LEVEL === 'info' || env.R4_LOG_LEVEL === 'debug' ? env.R4_LOG_LEVEL : 'warn' });
    const print = (value: unknown) => io.out(JSON.stringify(value, null, 2));
    if (command.kind === 'approvals-list' || command.kind === 'approvals-show') {
      const { inspection, close } = await openApprovalInspection({ databaseUrl, migrationDirectories: [SALES_MIGRATIONS_DIR], logger });
      try {
        print(await inspectApprovals(inspection, command));
        return 0;
      } finally {
        await close();
      }
    }
    const auth = loadOperatorAuthConfig(env);
    const signIn = { auth, openUrl: deps.openUrl ?? printLoginUrl(io, auth.redirectPort), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
    if (command.kind === 'whoami') {
      print(await whoAmI(signIn));
      return 0;
    }
    print({ decided: await decideApproval({ ...signIn, databaseUrl, decision: command.decision, requestId: command.requestId, reason: command.reason, argumentsHash: command.argumentsHash, logger }) });
    return 0;
  } catch (error) {
    const { code, message } = describeOperatorError(error);
    io.err(`error: ${code}: ${message}`);
    return 1;
  }
}
