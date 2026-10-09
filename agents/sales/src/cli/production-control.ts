import { runProductionControl } from '../production/control.js';
import { openApprovalInspection } from './approval-inspection.js';

/**
 * `npm run production:sales:control -- <command>` — production-host
 * administration of the autonomy kill switch and of tasks held because
 * autonomy was disabled (R4-I D-5/D-6), retirement of one task, and
 * (R4-J3D-R) read-only inspection of open approval requests. See
 * `production/control.ts`.
 * Reads the process environment only (never `.env`).
 */
runProductionControl(process.argv.slice(2), process.env, {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}, { openApprovals: openApprovalInspection }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.name : 'unexpected_failure'}\n`);
    process.exitCode = 1;
  },
);
