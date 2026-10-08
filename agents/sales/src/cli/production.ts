import { join, resolve } from 'node:path';
import { runGatewayProcess, loadGatewayConfig } from '@r4/channel-gateway';
import { stableJson } from '@r4/evaluation';
import { gitState, secretsFromEnv, writeArtifacts } from '@r4/evaluator';
import { createLogger } from '@r4/observability';
import { PostgresProductionStore, createPool } from '@r4/persistence-postgres';
import {
  assertProductionComposition,
  conversationKey,
  declaredExecutionMode,
  loadProductionConfig,
  productionConfigFingerprint,
  profileFingerprint,
  profileLabel,
  rolloutEligibility,
  rolloutFingerprint,
} from '@r4/live-ops';
import { loadWorkerConfig, runWorkerProcess } from '@r4/worker';
import { HttpCatalogAdapter, describeCatalogHttpConfig, loadCatalogHttpConfig, type CatalogFetch } from '@r4-adapters/catalog-http';
import { ProductionShippingAdapter, loadShippingHttpConfig, type ShippingFetch } from '@r4-adapters/shipping-http';
import { QuoteV2HttpClient, describeQuoteHttpConfig, loadQuoteHttpConfig, quoteModeOf, type QuoteFetch } from '@r4-adapters/quote-http';
import { describeWhatsAppConfig, loadWhatsAppCloudConfig } from '@r4-adapters/whatsapp-cloud';
import { adminDatabaseUrl } from '../harness/database.js';
import { configuredModelProvider } from '../model.js';
import { composeSalesGateway, composeSalesProductionWorker, selectedSalesProductionProfile } from '../production/composition.js';
import { salesProductionAgentVersion } from '../production/profile-v4.js';
import { salesShippingPlan } from '../production/shipping-plan.js';
import { SALES_DOMAINS, SALES_PRODUCTION_PROFILE } from '../production/profile.js';
import { SALES_PRODUCTION_PROCESSES, schedulerConfigurationStatus } from '../production/topology.js';
import { flag, loadLocalEnv, option, print } from './common.js';
import { VALIDATION_SCENARIOS, VALIDATION_SECRETS, validationIdentity, type ScenarioResult } from './production-validation.js';

/**
 * `npm run production:sales:*` — R4-I governed production of the Sales canary.
 *
 *   --plan            (production:sales:plan) print what production WOULD run —
 *                     mode, model profile, channel, redacted recipient identity,
 *                     rollout eligibility, kill switch, domain bindings,
 *                     capabilities, writes requiring approval — and exit. Sends
 *                     nothing, writes nothing. Requires the production declaration.
 *   --validate        (production:sales:validate) OFFLINE production validation:
 *                     real composition, disposable database, scripted model,
 *                     local fake provider. Writes artifacts/production-validation/<id>/.
 *   --smoke           (production:sales:smoke) REAL canary smoke. Refuses unless
 *                     production is declared, R4_PROD_ALLOW_NETWORK=true, the
 *                     WhatsApp canary secrets and R4_MODEL_* exist, the rollout is
 *                     allowlist-only (0 %), R4_PROD_SMOKE_RECIPIENT is allowlisted and
 *                     the kill switch was ALREADY released by an operator. Waits for
 *                     one real inbound from that identity, then for provider
 *                     acceptance (and a status callback if it arrives).
 *   --gateway         run the channel gateway process (deployment entry point)
 *   --worker          run the production worker process (deployment entry point)
 *   --identity-key W  print the conversation key (keyed hash) of wa_id W for the allowlist
 *
 * The third production process, the scheduler, is the generic one
 * (`npm run start:scheduler`, apps/scheduler): see SALES_PRODUCTION_PROCESSES.
 * `--plan` reports whether its configuration is usable and which schedules
 * are already due (it would fire them as soon as it starts).
 *
 * Never enables autonomy, never widens the rollout: those are operator acts.
 */
async function main(): Promise<void> {
  loadLocalEnv();
  if (flag('validate')) return validate();
  const mode = declaredExecutionMode(process.env);
  if (flag('identity-key')) {
    const waId = option('identity-key');
    const phone = process.env.R4_WHATSAPP_PHONE_NUMBER_ID;
    const key = process.env.R4_PROD_IDENTITY_HASH_KEY;
    if (!waId || !phone || !key) throw new Error('usage: --identity-key <wa_id> with R4_WHATSAPP_PHONE_NUMBER_ID and R4_PROD_IDENTITY_HASH_KEY set');
    print(conversationKey(key, 'whatsapp', phone, waId));
    return;
  }
  if (mode !== 'production') {
    print(`refusing: ${'R4_EXECUTION_MODE'} is "${mode}". Production commands require the explicit production declaration (see docs/adr/ADR-029).`);
    process.exitCode = 1;
    return;
  }
  const production = loadProductionConfig(process.env);
  if (flag('plan')) return plan(production);
  if (flag('gateway')) return gateway(production);
  if (flag('worker')) return worker(production);
  if (flag('smoke')) return smoke(production);
  print('usage: --plan | --validate | --smoke | --gateway | --worker | --identity-key <wa_id>');
}

const nodeFetch: CatalogFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
};

/** The catalog-service binding when the selected profile makes Catalog REAL (v2); undefined under v1. Nothing is called here. */
function productionCatalog(production: ReturnType<typeof loadProductionConfig>, logger?: ReturnType<typeof createLogger>): HttpCatalogAdapter | undefined {
  if (selectedSalesProductionProfile(production.config).domains[SALES_DOMAINS.catalog]?.status !== 'REAL') return undefined;
  const config = loadCatalogHttpConfig(process.env, { allowNetwork: production.config.allowNetwork });
  return new HttpCatalogAdapter({ config, fetch: nodeFetch, ...(logger ? { onCall: (event) => logger.info({ event: 'catalog.call', ...event }, 'catalog call') } : {}) });
}

const shippingFetch: ShippingFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
};

/**
 * The pc-carrier binding when the selected profile makes Shipping REAL (v3); undefined under v1/v2.
 * Fails closed on an incomplete R4_SHIPPING_* configuration. Nothing is called here.
 */
function productionShipping(production: ReturnType<typeof loadProductionConfig>, logger?: ReturnType<typeof createLogger>): ProductionShippingAdapter | undefined {
  if (selectedSalesProductionProfile(production.config).domains[SALES_DOMAINS.shipping]?.status !== 'REAL') return undefined;
  const config = loadShippingHttpConfig(process.env, { allowNetwork: production.config.allowNetwork });
  return new ProductionShippingAdapter({ config, fetch: shippingFetch, ...(logger ? { onEvent: (event) => logger.info({ event: `shipping.${event.kind}`, ...event }, 'shipping call') } : {}) });
}

const quoteFetch: QuoteFetch = (url, init) => fetch(url, init);

/**
 * The Quote V2 binding when the selected profile makes Quote REAL (v4); undefined under v1–v3.
 * Fails closed on an incomplete R4_QUOTE_* configuration. Nothing is called here; the token is never logged.
 */
function productionQuotes(production: ReturnType<typeof loadProductionConfig>, logger?: ReturnType<typeof createLogger>): QuoteV2HttpClient | undefined {
  if (selectedSalesProductionProfile(production.config).domains[SALES_DOMAINS.quote]?.status !== 'REAL') return undefined;
  const config = loadQuoteHttpConfig(process.env, { allowNetwork: production.config.allowNetwork });
  return new QuoteV2HttpClient({ config, fetch: quoteFetch, ...(logger ? { onCall: (event) => logger.info({ event: 'quote.call', ...event }, 'quote call') } : {}) });
}

function composition() {
  const noStore = { readControls: () => Promise.reject(new Error('plan only')) } as never;
  const production = loadProductionConfig(process.env);
  const catalog = productionCatalog(production);
  const shipping = productionShipping(production);
  const quotes = productionQuotes(production);
  return composeSalesProductionWorker({ pool: { query: () => Promise.reject(new Error('plan only')) } as never, store: noStore, production, modelProvider: { providerId: 'plan', invoke: () => Promise.reject(new Error('plan only')) }, logger: createLogger({ service: 'plan', level: 'silent' }), ...(catalog ? { catalog } : {}), ...(shipping ? { shipping } : {}), ...(quotes ? { quotes } : {}) });
}

async function plan(production: ReturnType<typeof loadProductionConfig>): Promise<void> {
  const whatsapp = (() => {
    try {
      return describeWhatsAppConfig(loadWhatsAppCloudConfig(process.env, { allowNetwork: production.config.allowNetwork }));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })();
  // A well-formed configuration proves neither authentication nor connectivity (nothing is probed here).
  const catalog = (() => {
    const gate = selectedSalesProductionProfile(production.config).domains[SALES_DOMAINS.catalog]?.status === 'REAL' ? 'REAL: catalog-service v2 over HTTP (read-only)' : 'UNAVAILABLE in this profile';
    try {
      return { binding: gate, ...describeCatalogHttpConfig(loadCatalogHttpConfig(process.env, { allowNetwork: production.config.allowNetwork })) };
    } catch (error) {
      return { binding: gate, configuration: `not usable: ${error instanceof Error ? error.message : String(error)}` };
    }
  })();
  // Shipping is composed only when the profile makes it REAL (sales-production@3); nothing is probed here.
  const shipping = salesShippingPlan(selectedSalesProductionProfile(production.config), process.env, { allowNetwork: production.config.allowNetwork });
  // Quote is composed only when the profile makes it REAL (sales-production@4); nothing is probed here.
  const quote = (() => {
    const gate = selectedSalesProductionProfile(production.config).domains[SALES_DOMAINS.quote]?.status === 'REAL' ? 'REAL: Quote Service V2 over HTTP (quote.create@2, approval required)' : 'UNAVAILABLE in this profile (not composed)';
    try {
      if (quoteModeOf(process.env) !== 'real') return { binding: gate, configuration: 'not configured (R4_QUOTE_MODE unset)' };
      return { profile: gate, ...describeQuoteHttpConfig(loadQuoteHttpConfig(process.env, { allowNetwork: production.config.allowNetwork })) };
    } catch (error) {
      return { binding: gate, configuration: `not usable: ${error instanceof Error ? error.message : String(error)}` };
    }
  })();
  const model = configuredModelProvider(process.env);
  const recipient = process.env.R4_PROD_SMOKE_RECIPIENT;
  const recipientKey = recipient && process.env.R4_WHATSAPP_PHONE_NUMBER_ID ? conversationKey(production.secrets.identityHashKey, 'whatsapp', process.env.R4_WHATSAPP_PHONE_NUMBER_ID, recipient) : null;
  let killSwitch: unknown = 'unknown (R4_DATABASE_URL not set)';
  let dueSchedules: unknown = 'unknown (R4_DATABASE_URL not set)';
  if (process.env.R4_DATABASE_URL) {
    const pool = createPool({ connectionString: process.env.R4_DATABASE_URL, logger: createLogger({ service: 'plan', level: 'silent' }), applicationName: 'production-plan', max: 1 });
    try {
      killSwitch = (await new PostgresProductionStore(pool).readControls()).state;
    } catch (error) {
      killSwitch = `unreadable (${error instanceof Error ? error.message : String(error)}) — treated as DISABLED`;
    }
    try {
      // Read-only: what a scheduler starting now would claim at once (the claim predicate of claimDueSchedule).
      const due = await pool.query<{ schedule_id: string; task_id: string; kind: string; status: string; due_at: Date }>(
        `select schedule_id, task_id, kind, status, due_at from schedules
          where due_at <= r4_now() and (status = 'pending' or (status = 'claimed' and lease_expires_at <= r4_now()))
          order by due_at, schedule_id`,
      );
      dueSchedules = due.rows.map((r) => ({ scheduleId: r.schedule_id, taskId: r.task_id, kind: r.kind, status: r.status, dueAt: r.due_at.toISOString() }));
    } catch (error) {
      dueSchedules = `unreadable (${error instanceof Error ? error.message : String(error)})`;
    } finally {
      await pool.end();
    }
  }
  const report = composition().report;
  print(stableJson({
    executionMode: production.config.mode,
    networkAllowed: production.config.allowNetwork,
    profile: report.profile,
    profileFingerprint: report.profileFingerprint,
    agentDefinition: `sales@${salesProductionAgentVersion(selectedSalesProductionProfile(production.config))}`,
    productionConfigFingerprint: productionConfigFingerprint(production.config),
    model: model ? { provider: 'openai_compatible', ...model.description } : 'not configured (R4_MODEL_*)',
    channel: whatsapp,
    catalog,
    shipping,
    quote,
    recipient: recipientKey ? { conversationKey: `${recipientKey.slice(0, 12)}…`, eligibility: rolloutEligibility(production.config.rollout, recipientKey) } : 'R4_PROD_SMOKE_RECIPIENT not set',
    rollout: { percent: production.config.rollout.percent, allowlisted: production.config.rollout.allowlist.length, denylisted: production.config.rollout.denylist.length, fingerprint: rolloutFingerprint(production.config.rollout) },
    killSwitch,
    processes: SALES_PRODUCTION_PROCESSES.map((p) => ({ name: p.name, command: `npm run ${p.script}`, owns: p.owns })),
    scheduler: { configuration: schedulerConfigurationStatus(process.env), dueSchedules },
    domainBindings: report.domains,
    capabilities: report.capabilities,
    writes: report.writes,
    sends: 'nothing (plan only)',
  }));
}

async function gateway(production: ReturnType<typeof loadProductionConfig>): Promise<void> {
  const config = loadGatewayConfig(process.env);
  const logger = createLogger({ service: 'r4-channel-gateway', level: config.logLevel });
  const pool = createPool({ connectionString: config.databaseUrl, logger, applicationName: 'r4-gateway-bindings', max: 2 });
  const { bindings } = composeSalesGateway({ pool, production, env: process.env });
  await runGatewayProcess(config, bindings, { logger });
}

async function worker(production: ReturnType<typeof loadProductionConfig>): Promise<void> {
  const model = configuredModelProvider(process.env);
  if (!model) throw new Error('refusing: no model provider configured (R4_MODEL_*)');
  if (!production.config.allowNetwork) throw new Error('refusing: a real model call requires R4_PROD_ALLOW_NETWORK=true');
  const config = loadWorkerConfig(process.env);
  const logger = createLogger({ service: 'r4-worker', level: config.logLevel });
  const pool = createPool({ connectionString: config.databaseUrl, logger, applicationName: 'r4-worker-bindings', max: 2 });
  const catalog = productionCatalog(production, logger);
  const shipping = productionShipping(production, logger);
  const quotes = productionQuotes(production, logger);
  const composed = composeSalesProductionWorker({ pool, store: new PostgresProductionStore(pool), production, modelProvider: model.provider, logger, ...(catalog ? { catalog } : {}), ...(shipping ? { shipping } : {}), ...(quotes ? { quotes } : {}) });
  logger.info({ event: 'service.composed', profile: composed.report.profile, profileFingerprint: composed.report.profileFingerprint }, 'production worker composed');
  await runWorkerProcess(config, composed.bindings, { logger });
}

async function validate(): Promise<void> {
  const git = gitState();
  const id = `pval_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const results: ScenarioResult[] = [];
  for (const scenario of VALIDATION_SCENARIOS) {
    const result = await scenario.run(adminDatabaseUrl(process.env));
    results.push(result);
    print(`${result.checks.every((c) => c.passed) ? 'PASS' : 'FAIL'} ${result.id} — ${result.title}`);
    for (const c of result.checks) print(`   ${c.passed ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
  }
  const passed = results.every((r) => r.checks.every((c) => c.passed));
  const report = assertProductionComposition(SALES_PRODUCTION_PROFILE, [{ domain: 'sales-workspace', bindingKind: 'internal' }], ['sales.workspace.update']);
  const effects = results.map((r) => ({
    scenario: r.id,
    inboundEvents: r.metrics.inbound_received, duplicates: r.metrics.inbound_duplicate,
    outboundAttempts: r.metrics.outbound_dispatch_attempted, outboundAccepted: r.metrics.outbound_accepted, confirmedDeliveries: r.metrics.outbound_delivered,
    unknownOutcomes: r.metrics.outbound_unknown, domainReads: 0, domainWrites: r.metrics.writes_by_capability, approvals: r.metrics.approvals, humanInterventions: r.metrics.human_handoffs,
    realProviderSubmissions: 0, realCustomerMessages: 0,
  }));
  const files = {
    'manifest.json': stableJson({ validationId: id, kind: 'offline-production-validation', gitSha: git.sha, gitDirty: git.dirty, ...validationIdentity(), channelBinding: 'local fake WhatsApp Cloud API (loopback)', model: 'scripted stand-in (FakeModelProvider)', network: false, realCustomerTraffic: false, passed }),
    'bindings.json': stableJson({ domains: report.domains, capabilities: report.capabilities, writes: report.writes, channel: SALES_PRODUCTION_PROFILE.channel }),
    'results.json': stableJson(results.map((r) => ({ id: r.id, title: r.title, checks: r.checks }))),
    'effects.json': stableJson(effects),
    'metrics.json': stableJson(results.map((r) => ({ scenario: r.id, metrics: r.metrics }))),
    'evaluation-summary.json': stableJson(results.map((r) => ({ scenario: r.id, evaluation: r.evaluation }))),
    'report.md': [`# Production validation ${id}`, '', `Offline (no network, no credentials, no real person). Git ${git.sha}${git.dirty ? ' (dirty)' : ''}. Profile ${profileLabel(SALES_PRODUCTION_PROFILE)} (${profileFingerprint(SALES_PRODUCTION_PROFILE).slice(0, 12)}).`, '', ...results.flatMap((r) => [`## ${r.id} — ${r.title}`, '', ...r.checks.map((c) => `- ${c.passed ? 'PASS' : 'FAIL'} \`${c.id}\` — ${c.detail}`), '']), `Result: **${passed ? 'PASSED' : 'FAILED'}**`, ''].join('\n'),
  };
  const dir = writeArtifacts(join(resolve('artifacts'), 'production-validation', id), files, { secrets: [...Object.values(VALIDATION_SECRETS), ...secretsFromEnv(process.env, ['R4_MODEL_API_KEY', 'R4_WHATSAPP_APP_SECRET', 'R4_WHATSAPP_ACCESS_TOKEN', 'R4_WHATSAPP_VERIFY_TOKEN', 'R4_PROD_IDENTITY_HASH_KEY', 'R4_CATALOG_API_KEY'])] });
  print(`\n${passed ? 'PASSED' : 'FAILED'} — artifacts: ${dir}`);
  if (!passed) process.exitCode = 1;
}

async function smoke(production: ReturnType<typeof loadProductionConfig>): Promise<void> {
  const problems: string[] = [];
  if (!production.config.allowNetwork) problems.push('R4_PROD_ALLOW_NETWORK is not "true"');
  if (production.config.rollout.percent !== 0) problems.push('the smoke only runs with an allowlist-only rollout (R4_PROD_ROLLOUT_PERCENT=0)');
  const recipient = process.env.R4_PROD_SMOKE_RECIPIENT;
  const phone = process.env.R4_WHATSAPP_PHONE_NUMBER_ID;
  if (!recipient || !phone) problems.push('R4_PROD_SMOKE_RECIPIENT (an internal/test identity) and R4_WHATSAPP_PHONE_NUMBER_ID are required');
  else if (!production.config.rollout.allowlist.includes(conversationKey(production.secrets.identityHashKey, 'whatsapp', phone, recipient))) problems.push('R4_PROD_SMOKE_RECIPIENT is not in R4_PROD_ROLLOUT_ALLOWLIST');
  if (!configuredModelProvider(process.env)) problems.push('no real model configured (R4_MODEL_*)');
  if (!process.env.R4_DATABASE_URL) problems.push('R4_DATABASE_URL is required (a migrated production/staging database)');
  try {
    loadWhatsAppCloudConfig(process.env, { allowNetwork: production.config.allowNetwork });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0) {
    print(`real-channel smoke NOT executed (external configuration pending):\n- ${problems.join('\n- ')}`);
    process.exitCode = 2;
    return;
  }
  const pool = createPool({ connectionString: process.env.R4_DATABASE_URL!, logger: createLogger({ service: 'smoke', level: 'silent' }), applicationName: 'production-smoke', max: 2 });
  try {
    const store = new PostgresProductionStore(pool);
    if (!(await store.readControls()).state.globalEnabled) {
      print('real-channel smoke NOT executed: autonomy is disabled (kill switch engaged). An operator must release it explicitly first (POST /v1/production/controls); this command never does.');
      process.exitCode = 2;
      return;
    }
    print('smoke: run the gateway (--gateway, publicly reachable webhook URL) and the worker (--worker) with this same configuration, then send one message from the allowlisted identity.');
    const key = conversationKey(production.secrets.identityHashKey, 'whatsapp', phone!, recipient!);
    const deadline = Date.now() + Number(process.env.R4_PROD_SMOKE_WAIT_MS ?? 300_000);
    for (;;) {
      const binding = await store.findOpenBinding('whatsapp', key);
      const outbound = binding?.taskId ? await store.outboundForTask(binding.taskId) : [];
      const accepted = outbound.find((o) => o.providerMessageId !== null);
      if (accepted && (accepted.status === 'delivered' || accepted.status === 'read' || Date.now() > deadline)) {
        const git = gitState();
        const id = `psmoke_${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const files = {
          'manifest.json': stableJson({ smokeId: id, kind: 'real-channel-smoke', gitSha: git.sha, gitDirty: git.dirty, profile: profileLabel(selectedSalesProductionProfile(production.config)), conversationKey: `${key.slice(0, 12)}…`, rolloutFingerprint: rolloutFingerprint(production.config.rollout) }),
          'outbound.json': stableJson(outbound.map((o) => ({ outboundId: o.outboundId, status: o.status, attempts: o.attempts, providerMessageIdKnown: o.providerMessageId !== null, acceptedAt: o.acceptedAt, deliveredAt: o.deliveredAt, readAt: o.readAt }))),
          'metrics.json': stableJson(await store.metrics()),
        };
        print(`smoke result: provider accepted; final status ${accepted.status} — ${writeArtifacts(join(resolve('artifacts'), 'production-validation', id), files, { secrets: secretsFromEnv(process.env, ['R4_MODEL_API_KEY', 'R4_WHATSAPP_APP_SECRET', 'R4_WHATSAPP_ACCESS_TOKEN', 'R4_WHATSAPP_VERIFY_TOKEN', 'R4_PROD_IDENTITY_HASH_KEY', 'R4_CATALOG_API_KEY']) })}`);
        return;
      }
      if (Date.now() > deadline) {
        print('smoke timed out: no provider-accepted response for the allowlisted identity');
        process.exitCode = 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
