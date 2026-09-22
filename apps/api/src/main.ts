import { createLogger } from '@r4/observability';
import { loadConfig } from './config.js';
import { loadLocalEnvFile } from './env.js';
import { createPlatform } from './platform.js';

async function main(): Promise<void> {
  loadLocalEnvFile();
  const config = loadConfig(process.env);
  const logger = createLogger({ service: 'r4-api', level: config.logLevel });
  const platform = await createPlatform(config, { logger });
  await platform.app.listen({ host: config.host, port: config.port });
  logger.info({ event: 'service.started', host: config.host, port: config.port }, 'r4-api listening');

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'service.stopping', signal }, 'shutting down');
    platform.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Boot failures are reported once, structured, then the process exits non-zero.
  console.error(JSON.stringify({ level: 'fatal', event: 'service.boot_failed', message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
