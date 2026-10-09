import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { PlatformError } from '@r4/contracts';
import { ProductionConfigError } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { loadSchedulerConfig } from '@r4/scheduler';
import { loadWorkerConfig } from '@r4/worker';
import { HttpCatalogAdapter, loadCatalogHttpConfig } from '@r4-adapters/catalog-http';
import { ProductionShippingAdapter, loadShippingHttpConfig } from '@r4-adapters/shipping-http';
import { QuoteV2HttpClient, loadQuoteHttpConfig, quoteModeOf } from '@r4-adapters/quote-http';
import { assertCanaryReady, canaryStatus, initCanary, loadCanaryEnvironment, openCanaryApprovals, sendSynthetic, startCanaryRuntime, syntheticConversationKey, type CanaryEnvironment } from './index.js';
import { configuredModelProvider } from '../../model.js';
import { loadOperatorAuthConfig } from '../../operator-auth/index.js';
import { decideApproval } from '../operator-approval.js';
import { parseDecision, printLoginUrl } from '../operator-command.js';
import { inspectApprovals } from '../../production/control.js';

/**
 * `npm run sales:canary -- <command>` — the isolated Sales canary
 * (R4-J3D-R): the real Sales agent under sales-production@4 against a
 * dedicated, marked PostgreSQL database, with synthetic inbound and
 * locally captured outbound. Never a channel provider, never the
 * production database. Reads the process environment only (never `.env`).
 *
 * Approval decisions (R4-J3D-S, ADR-033) are made by an OIDC-authenticated,
 * registered operator through the same flow as `production:sales:operator`
 * (cli/operator-approval.ts), against the canary database only.
 */
export const CANARY_USAGE = [
  'usage: sales:canary <command>',
  '  init                                       (mark an EMPTY canary database, migrate, register Sales, enable autonomy there)',
  '  status                                     (isolation, autonomy and counts; no conversation text)',
  '  identity-key --conversation <name>         (the key to put in the canary R4_PROD_ROLLOUT_ALLOWLIST)',
  '  send --conversation <name> --text "<text>"   (one synthetic inbound through the real channel ingress)',
  '  run                                        (canary worker + scheduler + local outbound capture; until SIGINT/SIGTERM)',
  '  approvals list | approvals show --request <request-id>   (read-only)',
  '  approvals approve|reject --request <request-id> --arguments-hash <hash> --reason "<reason>"   (OIDC operator sign-in)',
].join('\n');

export type CanaryCommand =
  | { readonly kind: 'init' }
  | { readonly kind: 'status' }
  | { readonly kind: 'identity-key'; readonly conversation: string }
  | { readonly kind: 'send'; readonly conversation: string; readonly text: string }
  | { readonly kind: 'run' }
  | { readonly kind: 'approvals-list' }
  | { readonly kind: 'approvals-show'; readonly requestId: string }
  | { readonly kind: 'approvals-decide'; readonly decision: 'approve' | 'reject'; readonly requestId: string; readonly argumentsHash: string; readonly reason: string };

export class CanaryUsageError extends Error {
  readonly code = 'invalid_command';
}

function options(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    const value = args[i + 1];
    if (!name.startsWith('--') || !allowed.includes(name.slice(2))) throw new CanaryUsageError(`unexpected argument: ${name}`);
    if (Object.hasOwn(out, name.slice(2))) throw new CanaryUsageError(`${name} given twice`);
    if (value === undefined || value.startsWith('--')) throw new CanaryUsageError(`${name} needs a value`);
    out[name.slice(2)] = value;
  }
  for (const name of allowed) if (!Object.hasOwn(out, name)) throw new CanaryUsageError(`--${name} is required`);
  return out;
}

export function parseCanaryCommand(argv: readonly string[]): CanaryCommand {
  const [group, verb, ...rest] = argv;
  if (group === 'init' && verb === undefined) return { kind: 'init' };
  if (group === 'status' && verb === undefined) return { kind: 'status' };
  if (group === 'run' && verb === undefined) return { kind: 'run' };
  if (group === 'identity-key') return { kind: 'identity-key', conversation: options(argv.slice(1), ['conversation']).conversation! };
  if (group === 'send') {
    const o = options(argv.slice(1), ['conversation', 'text']);
    if (o.text!.trim().length === 0) throw new CanaryUsageError('--text must not be empty');
    return { kind: 'send', conversation: o.conversation!, text: o.text! };
  }
  if (group === 'approvals' && verb === 'list' && rest.length === 0) return { kind: 'approvals-list' };
  if (group === 'approvals' && verb === 'show') return { kind: 'approvals-show', requestId: options(rest, ['request']).request! };
  if (group === 'approvals' && (verb === 'approve' || verb === 'reject')) {
    return { kind: 'approvals-decide', ...parseDecision(verb, rest, (message) => new CanaryUsageError(message)) };
  }
  throw new CanaryUsageError(`unknown command: ${argv.join(' ') || '(none)'}`);
}

export interface CanaryIo {
  out(line: string): void;
  err(line: string): void;
}

function redact(message: string): string {
  return message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted database url]');
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof CanaryUsageError) return { code: error.code, message: error.message };
  if (error instanceof PlatformError || error instanceof ProductionConfigError) return { code: error.code, message: redact(error.message) };
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unexpected_failure';
  return { code, message: redact(error instanceof Error ? error.message : String(error)) };
}

const fetchText = async (url: string, init: Parameters<typeof fetch>[1]) => {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
};

/** The real owner bindings of sales-production@4 (fail closed on incomplete configuration). Nothing is called here. */
function realBindings(env: NodeJS.ProcessEnv, canary: CanaryEnvironment, logger: ReturnType<typeof createLogger>) {
  const allowNetwork = canary.production.config.allowNetwork;
  if (quoteModeOf(env) !== 'real') throw new ProductionConfigError('production_config_incomplete', 'R4_QUOTE_MODE must be "real" for sales-production@4');
  const catalog = new HttpCatalogAdapter({ config: loadCatalogHttpConfig(env, { allowNetwork }), fetch: fetchText, onCall: (event) => logger.info({ event: 'catalog.call', ...event }, 'catalog call') });
  const shipping = new ProductionShippingAdapter({ config: loadShippingHttpConfig(env, { allowNetwork }), fetch: fetchText, onEvent: (event) => logger.info({ event: `shipping.${event.kind}`, ...event }, 'shipping call') });
  const quotes = new QuoteV2HttpClient({ config: loadQuoteHttpConfig(env, { allowNetwork }), fetch: (url, init) => fetch(url, init), onCall: (event) => logger.info({ event: 'quote.call', ...event }, 'quote call') });
  return { catalog, shipping, quotes };
}

/** Returns the exit code: 0 done, 2 invalid command, 1 refused or failed. `run` resolves only when it stops. */
export interface CanaryDeps {
  /** Tests: how the operator sign-in URL is "opened" (default: printed). */
  readonly openUrl?: (url: string) => void | Promise<void>;
  readonly fetchImpl?: typeof fetch;
}

export async function runCanary(argv: readonly string[], env: NodeJS.ProcessEnv, io: CanaryIo, deps: CanaryDeps = {}): Promise<number> {
  let command: CanaryCommand;
  try {
    command = parseCanaryCommand(argv);
  } catch (error) {
    const { code, message } = describeError(error);
    io.err(`error: ${code}: ${message}\n${CANARY_USAGE}`);
    return 2;
  }
  const level = env.R4_LOG_LEVEL === 'info' || env.R4_LOG_LEVEL === 'debug' ? env.R4_LOG_LEVEL : 'warn';
  const logger = createLogger({ service: 'r4-sales-canary', level });
  try {
    const canary = loadCanaryEnvironment(env);
    const print = (value: unknown) => io.out(JSON.stringify(value, null, 2));
    switch (command.kind) {
      case 'init':
        print(await initCanary(canary, logger));
        return 0;
      case 'status':
        print(await canaryStatus(canary, logger));
        return 0;
      case 'identity-key':
        print({ conversation: command.conversation, conversationKey: syntheticConversationKey(canary, command.conversation), use: 'add it to R4_PROD_ROLLOUT_ALLOWLIST of the CANARY environment only' });
        return 0;
      case 'send': {
        const outcome = await sendSynthetic(canary, { conversation: command.conversation, text: command.text }, logger);
        print({ ...outcome, conversationKey: `${outcome.conversationKey.slice(0, 12)}…`, next: 'the canary worker (sales:canary run) claims the task; replies are captured locally' });
        return outcome.kind === 'failed' ? 1 : 0;
      }
      case 'approvals-list':
      case 'approvals-show': {
        const { inspection, close } = await openCanaryApprovals(canary, logger);
        try {
          print(await inspectApprovals(inspection, command));
          return 0;
        } finally {
          await close();
        }
      }
      case 'approvals-decide': {
        await assertCanaryReady(canary, logger);
        const auth = loadOperatorAuthConfig(env);
        print({
          decided: await decideApproval({
            databaseUrl: canary.databaseUrl, decision: command.decision, requestId: command.requestId, reason: command.reason, argumentsHash: command.argumentsHash,
            auth, logger, openUrl: deps.openUrl ?? printLoginUrl(io, auth.redirectPort), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          }),
        });
        return 0;
      }
      case 'run':
        return await run(canary, env, logger, io);
    }
  } catch (error) {
    const { code, message } = describeError(error);
    io.err(`error: ${code}: ${message}`);
    return 1;
  }
}

async function run(canary: CanaryEnvironment, env: NodeJS.ProcessEnv, logger: ReturnType<typeof createLogger>, io: CanaryIo): Promise<number> {
  if (!canary.production.config.allowNetwork) throw new ProductionConfigError('invalid_production_config', 'a real model and real owners require R4_PROD_ALLOW_NETWORK=true in the canary environment');
  const model = configuredModelProvider(env);
  if (!model) throw new ProductionConfigError('production_config_incomplete', 'no model provider configured (R4_MODEL_*)');
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'host';
  // The canary database only: the production R4_DATABASE_URL is never handed to a canary component.
  const scoped = { ...env, R4_DATABASE_URL: canary.databaseUrl };
  const worker = loadWorkerConfig({ ...scoped, R4_WORKER_ID: env.R4_CANARY_WORKER_ID ?? `sales-canary:${host}:${process.pid}` });
  const scheduler = loadSchedulerConfig({ ...scoped, R4_SCHEDULER_ID: env.R4_CANARY_SCHEDULER_ID ?? `sales-canary-scheduler:${host}:${process.pid}` });
  const runtime = await startCanaryRuntime(canary, {
    modelProvider: model.provider,
    ...realBindings(env, canary, logger),
    worker,
    scheduler,
    captureFile: (canaryId) => env.R4_CANARY_CAPTURE_FILE ?? join(resolve('artifacts'), 'sales-canary', canaryId, 'outbound.jsonl'),
    logger,
  });
  runtime.start();
  io.out(JSON.stringify({ canaryId: runtime.canaryId, profile: 'sales-production@4', workerId: worker.workerId, schedulerId: scheduler.owner, capture: runtime.capture.file, stop: 'SIGINT or SIGTERM' }, null, 2));
  return new Promise<number>((done) => {
    let stopping = false;
    const stop = (code: number) => {
      if (stopping) return;
      stopping = true;
      void runtime.close().finally(() => done(code));
    };
    process.once('SIGINT', () => stop(0));
    process.once('SIGTERM', () => stop(0));
    void runtime.violation.then((code) => {
      io.err(`error: ${code}: the canary stopped because its isolation no longer holds`);
      stop(1);
    });
  });
}
