import { runCanary } from './canary/command.js';

/**
 * `npm run sales:canary -- <command>` — the isolated Sales canary
 * (R4-J3D-R). See `cli/canary/command.ts`.
 * Reads the process environment only (never `.env`).
 */
runCanary(process.argv.slice(2), process.env, {
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
