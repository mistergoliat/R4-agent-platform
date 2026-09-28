import { runProductionBootstrap } from '../production/bootstrap.js';

/**
 * `npm run production:sales:bootstrap` — registers the Sales AgentDefinition
 * into the migrated production database (R4-I). See `production/bootstrap.ts`.
 * Reads the process environment only (never `.env`).
 */
runProductionBootstrap(process.env, {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.name : 'unexpected_failure'}\n`);
    process.exitCode = 1;
  },
);
