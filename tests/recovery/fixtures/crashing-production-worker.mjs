// Child process for tests/recovery/live-ops-process-crash.test.ts.
// The real production worker composition (built @r4/worker + the Sales
// production composition) with a scripted stand-in model: the first call
// responds (an accepted `respond` step becomes durable), the second call
// announces itself on stdout and never returns — the parent SIGKILLs the
// process there, after the response was accepted and before anything was
// delivered. Test-only.
import { setInterval } from 'node:timers';
import { FakeModelProvider } from '@r4/model-gateway';
import { loadProductionConfig } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { PostgresProductionStore, createPool } from '@r4/persistence-postgres';
import { createWorkerPlatform, loadWorkerConfig } from '@r4/worker';
import { composeSalesProductionWorker } from '@r4-sales/agent/production';

const env = process.env;
const production = loadProductionConfig(env);
const logger = createLogger({ service: 'child-worker', level: 'silent' });
const pool = createPool({ connectionString: env.R4_DATABASE_URL, logger, applicationName: 'child-worker', max: 2 });
const model = new FakeModelProvider((_request, index) => {
  if (index === 0) return { type: 'structured', data: { type: 'respond', content: env.CHILD_RESPONSE } };
  process.stdout.write(`${JSON.stringify({ event: 'child.model.second_call' })}\n`);
  return new Promise(() => undefined);
});
const composition = composeSalesProductionWorker({ pool, store: new PostgresProductionStore(pool), production, modelProvider: model, logger });
const platform = await createWorkerPlatform(loadWorkerConfig(env), composition.bindings, { logger });
platform.worker.start();
process.stdout.write(`${JSON.stringify({ event: 'child.started' })}\n`);
setInterval(() => undefined, 1_000);
