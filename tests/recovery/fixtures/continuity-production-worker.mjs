// Child process for tests/recovery/cross-task-continuity-process.test.ts (R4-J4-R7-4).
// The real production worker composition (built @r4/worker + the Sales production composition) with a scripted
// stand-in model: call N answers CHILD_STEPS[N] and first reports on stdout which earlier-conversation items its
// context carried (`prior_turn:` / `prior_conversation:`), so the parent can compare what two processes saw.
// Past the script, a call never answers. Test-only.
import { setInterval } from 'node:timers';
import { FakeModelProvider } from '@r4/model-gateway';
import { loadProductionConfig } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { PostgresProductionStore, createPool } from '@r4/persistence-postgres';
import { createWorkerPlatform, loadWorkerConfig } from '@r4/worker';
import { composeSalesProductionWorker } from '@r4-sales/agent/production';

const env = process.env;
const steps = JSON.parse(env.CHILD_STEPS ?? '[]');
const production = loadProductionConfig(env);
const logger = createLogger({ service: 'child-worker', level: 'silent' });
const pool = createPool({ connectionString: env.R4_DATABASE_URL, logger, applicationName: 'child-worker', max: 2 });
const model = new FakeModelProvider((request, index) => {
  const items = Object.values(request.context?.sections ?? {}).flat();
  const prior = items
    .filter((i) => /^prior_(turn|conversation):/.test(i.itemId))
    .map((i) => ({ itemId: i.itemId, kind: i.kind, authority: i.authority, content: i.content }));
  process.stdout.write(`${JSON.stringify({ event: 'child.model.call', pid: process.pid, index, prior })}\n`);
  return index < steps.length ? steps[index] : new Promise(() => undefined);
});
const composition = composeSalesProductionWorker({ pool, store: new PostgresProductionStore(pool), production, modelProvider: model, logger });
const platform = await createWorkerPlatform(loadWorkerConfig(env), composition.bindings, { logger });
platform.worker.start();
process.stdout.write(`${JSON.stringify({ event: 'child.started', pid: process.pid })}\n`);
setInterval(() => undefined, 1_000);
