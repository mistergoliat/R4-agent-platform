// Child process for tests/recovery/live-ops-process-crash.test.ts.
// The real channel gateway composition (built @r4/channel-gateway + the Sales
// canary bindings) with its delivery dispatcher running. The parent's fake
// provider holds the send request open; the parent SIGKILLs this process
// while the provider call is in flight. Test-only.
import { setInterval } from 'node:timers';
import { createGatewayPlatform } from '@r4/channel-gateway';
import { loadProductionConfig } from '@r4/live-ops';
import { createLogger } from '@r4/observability';
import { createPool } from '@r4/persistence-postgres';
import { composeSalesGateway } from '@r4-sales/agent/production';

const env = process.env;
const production = loadProductionConfig(env);
const logger = createLogger({ service: 'child-gateway', level: 'silent' });
const pool = createPool({ connectionString: env.R4_DATABASE_URL, logger, applicationName: 'child-gateway', max: 2 });
const { bindings } = composeSalesGateway({ pool, production, env });
const gateway = await createGatewayPlatform(
  { databaseUrl: env.R4_DATABASE_URL, host: '127.0.0.1', port: 0, logLevel: 'silent', dbPoolMax: 2, gatewayId: 'gateway-child', dispatch: true, resumeAfterMs: 60_000 },
  bindings,
  { logger },
);
gateway.start();
process.stdout.write(`${JSON.stringify({ event: 'child.started' })}\n`);
setInterval(() => undefined, 1_000);
