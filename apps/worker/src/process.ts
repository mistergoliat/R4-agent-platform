import type { WorkerConfig } from './config.js';
import { createWorkerPlatform, type WorkerBindings, type WorkerOverrides, type WorkerPlatform } from './platform.js';

/**
 * Runs a worker as an OS process: boots, starts polling, and on SIGINT/SIGTERM
 * stops gracefully (releasing its lease) before exiting. A deployment's entry
 * point is `runWorkerProcess(loadWorkerConfig(process.env), bindings)` with its
 * own model provider adapter and capabilities; C1 ships neither, so there is
 * no production `main` yet (see docs/roadmap).
 */
export async function runWorkerProcess(config: WorkerConfig, bindings: WorkerBindings, overrides: WorkerOverrides = {}): Promise<WorkerPlatform> {
  const platform = await createWorkerPlatform(config, bindings, overrides);
  platform.worker.start();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    platform.logger.info({ event: 'service.stopping', signal, workerId: config.workerId }, 'shutting down');
    platform.close().then(
      () => process.exit(0),
      (error: unknown) => {
        platform.logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return platform;
}
