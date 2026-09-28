// Child process for tests/recovery/worker-presence-process.test.ts.
// The real production worker entry path (built @r4/worker `runWorkerProcess`
// + the Sales production composition) with a scripted stand-in model that is
// never called: with no work it only polls, so its sole durable trace is its
// worker presence. The parent SIGKILLs it — no shutdown code runs. Test-only.
import { FakeModelProvider } from '@r4/model-gateway';
import { loadProductionConfig } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { PostgresProductionStore, createPool } from '@r4/persistence-postgres';
import { loadWorkerConfig, runWorkerProcess } from '@r4/worker';
import { composeSalesProductionWorker } from '@r4-sales/agent/production';

const env = process.env;
const production = loadProductionConfig(env);
const logger = createLogger({ service: 'child-worker', level: 'silent' });
const pool = createPool({ connectionString: env.R4_DATABASE_URL, logger, applicationName: 'child-worker-bindings', max: 2 });
const model = new FakeModelProvider(() => ({ type: 'provider_error', message: 'the idle worker must never call the model' }));
const composition = composeSalesProductionWorker({ pool, store: new PostgresProductionStore(pool), production, modelProvider: model, logger });
await runWorkerProcess(loadWorkerConfig(env), composition.bindings, { logger });
process.stdout.write(`${JSON.stringify({ event: 'child.started' })}\n`);
