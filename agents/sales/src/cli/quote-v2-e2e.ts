import { randomBytes, randomUUID } from 'node:crypto';
import { FixtureCatalog, FixtureShipping } from '@r4-adapters/domains';
import { QuoteV2HttpClient, describeQuoteHttpConfig, loadQuoteHttpConfig, type QuoteCallTelemetry } from '@r4-adapters/quote-http';
import type { WriteHandlerContext } from '@r4/capability-runtime';
import { createLogger } from '@r4/observability';
import { createPool } from '@r4/persistence-postgres';
import { quoteCreateV2Capability, quoteCreateV2Input } from '../capabilities/quote-v2.js';
import { migrateSales } from '../migrate.js';
import { workspaceUpdateInputSchema } from '../workspace/model.js';
import { PostgresSalesStore } from '../workspace/store.js';
import { loadLocalEnv, print } from './common.js';

/**
 * R4-J3B controlled synthetic Sales → Quote V2 run (isolated runner).
 *
 * The REAL Quote V2 adapter (R4_QUOTE_*) against the deployed owner, the
 * real quote.create@2 capability, a THROWAWAY PostgreSQL database for the
 * `sales` schema (R4_QUOTE_E2E_DATABASE_URL — refused if it holds an R4
 * platform schema), and synthetic commercial evidence (the fixture Catalog
 * and Shipping owners: synthetic products, synthetic customer). No worker,
 * no model, no channel, no email, no rollout change.
 *
 * Steps: readiness (unauthenticated) → authenticated lookup of an unused key
 * (expects not_found: proves auth + quotes:read) → execute (issue) → replay
 * the same key (must return the same quote) → reconcile by key → verify the
 * document hash. Prints a JSON evidence report; never prints the token.
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const databaseUrl = process.env.R4_QUOTE_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error('refusing: R4_QUOTE_E2E_DATABASE_URL (a throwaway database) is required');
  const config = loadQuoteHttpConfig(process.env, { allowNetwork: process.env.R4_PROD_ALLOW_NETWORK === 'true' });
  const calls: QuoteCallTelemetry[] = [];
  const quotes = new QuoteV2HttpClient({ config, fetch: (url, init) => fetch(url, init), onCall: (e) => calls.push(e) });
  const pool = createPool({ connectionString: databaseUrl, logger: createLogger({ service: 'quote-v2-e2e', level: 'silent' }), applicationName: 'quote-v2-e2e', max: 2 });
  const evidence: Record<string, unknown> = { quote: describeQuoteHttpConfig(config) };
  try {
    const platform = await pool.query<{ present: boolean }>("select to_regclass('public.agent_tasks') is not null as present");
    if (platform.rows[0]?.present) throw new Error('refusing: R4_QUOTE_E2E_DATABASE_URL holds an R4 platform schema; use a throwaway database');
    evidence.salesMigrations = (await migrateSales(pool)).applied;
    const ready = await fetch(`${config.baseUrl}/health/ready`, { signal: AbortSignal.timeout(config.timeoutMs) });
    evidence.readiness = { httpStatus: ready.status, body: await ready.json().catch(() => null) };
    if (ready.status !== 200) throw new Error(`owner not ready (HTTP ${ready.status})`);
    evidence.authenticatedLookupOfUnusedKey = await quotes.lookupIdempotency(`r4x_${randomBytes(16).toString('hex')}`);

    const now = () => new Date();
    const store = new PostgresSalesStore(pool);
    const catalog = new FixtureCatalog({ now });
    const shipping = new FixtureShipping({ now });
    const capability = quoteCreateV2Capability({ store, quotes, catalog, shipping, now });
    const taskId = randomUUID();
    await store.applyCommand({ taskId, executionKey: `r4x_${randomBytes(16).toString('hex')}`, input: workspaceUpdateInputSchema.parse({ operations: [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }, { op: 'add_item', productId: 'BAR-EZ', quantity: 2 }, { op: 'set_delivery_destination', commune: 'Ñuñoa' }] }), unknownProducts: [], now: now().toISOString() });
    // The approved synthetic snapshot (fixture prices; hand-checked totals with the owner arithmetic).
    const input = quoteCreateV2Input.parse({
      workspaceVersion: 1,
      customer: { kind: 'guest', displayName: 'R4 J3B Synthetic Guest', email: 'r4-j3b-synthetic@example.invalid' },
      lines: [
        { itemKey: 'BAR-OLY20', quantity: 1, unitPrice: { amount: 129_990, taxBasis: 'included', taxRate: '0.19' } },
        { itemKey: 'BAR-EZ', quantity: 2, unitPrice: { amount: 39_990, taxBasis: 'included', taxRate: '0.19' } },
      ],
      shipping: { destinationCommune: 'Ñuñoa', carrierName: 'Fixture Courier', serviceType: 'NORMAL', amount: { amount: 12_674, taxBasis: 'excluded', taxRate: '0.19' } },
      expectedTotals: { net: 189_119, tax: 35_933, gross: 225_052 },
      currency: 'CLP',
    });
    const executionKey = `r4x_${randomBytes(16).toString('hex')}`;
    const context = (attempt: number): WriteHandlerContext => ({ executionKey, attempt, signal: AbortSignal.timeout(120_000), execution: { taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 4, correlationId: `r4-j3b-e2e-${taskId.slice(0, 8)}`, grantedScopes: ['quote.create'], actor: { kind: 'service', ref: 'quote-v2-e2e' }, identityAssurance: 'provisional' } });
    const first = await capability.execute(input, context(1));
    const replay = await capability.execute(input, context(2));
    const reconciled = await capability.reconcile!(context(3));
    const ids = [first, replay, reconciled].map((o) => (o.status === 'applied' ? o.result.quoteId : null));
    evidence.issue = first;
    evidence.replay = { status: replay.status, replayed: replay.status === 'applied' ? replay.replayed : null, sameQuote: ids[1] === ids[0] };
    evidence.reconcile = { status: reconciled.status, sameQuote: ids[2] === ids[0] };
    evidence.frozenRequestSha256 = (await store.quoteV2Request(executionKey))?.requestSha256 ?? null;
    evidence.salesIssuedRecord = await store.quoteV2Issued(taskId);
    evidence.ownerCalls = calls.map(({ operation, outcome, httpStatus, durationMs, replayed, errorCode }) => ({ operation, outcome, httpStatus, durationMs, replayed, errorCode }));
    const pass = first.status === 'applied' && first.result.document.verification === 'verified' && replay.status === 'applied' && replay.replayed === true && ids.every((id) => id !== null && id === ids[0]);
    evidence.verdict = pass ? 'PASS' : 'FAIL';
    print(JSON.stringify(evidence, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  print(JSON.stringify({ verdict: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
