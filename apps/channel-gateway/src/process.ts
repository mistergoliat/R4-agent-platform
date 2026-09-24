import type { GatewayConfig } from './config.js';
import { createGatewayPlatform, type GatewayBindings, type GatewayOverrides, type GatewayPlatform } from './platform.js';

/**
 * Runs the channel gateway as an OS process: boots (fail closed), listens,
 * starts dispatching; on SIGINT/SIGTERM stops claiming, lets the submission
 * in flight finish and exits. A deployment's entry point calls this with the
 * pack's production bindings (channel adapters, profile, task factory).
 */
export async function runGatewayProcess(config: GatewayConfig, bindings: GatewayBindings, overrides: GatewayOverrides = {}): Promise<GatewayPlatform> {
  const platform = await createGatewayPlatform(config, bindings, overrides);
  await platform.app.listen({ host: config.host, port: config.port });
  platform.start();
  platform.logger.info({ event: 'service.started', host: config.host, port: config.port, dispatch: config.dispatch }, 'r4-channel-gateway listening');
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    platform.logger.info({ event: 'service.stopping', signal }, 'shutting down');
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
