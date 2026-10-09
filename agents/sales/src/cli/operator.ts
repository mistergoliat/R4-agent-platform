import { runOperator } from './operator-command.js';

/**
 * `npm run production:sales:operator -- <command>` — OIDC-authenticated
 * operator approvals (R4-J3D-S). See `cli/operator-command.ts`.
 * Reads the process environment only (never `.env`).
 */
runOperator(process.argv.slice(2), process.env, {
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
