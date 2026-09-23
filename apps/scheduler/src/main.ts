import { existsSync } from 'node:fs';
import { loadSchedulerConfig } from './config.js';
import { createSchedulerPlatform } from './platform.js';

/** Scheduler process entry point: `npm run start:scheduler` (after `npm run build`). */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadSchedulerConfig(process.env);
  const platform = await createSchedulerPlatform(config);
  platform.scheduler.start();
  platform.logger.info({ event: 'service.started', schedulerId: config.owner, leaseMs: config.leaseMs, pollMs: config.pollMs }, 'r4-scheduler started');

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    platform.logger.info({ event: 'service.stopping', signal, schedulerId: config.owner }, 'shutting down');
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
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', event: 'service.boot_failed', message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
