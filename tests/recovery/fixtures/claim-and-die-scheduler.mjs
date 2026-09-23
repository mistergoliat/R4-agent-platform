// Child process for tests/recovery/temporal-process-crash.test.ts.
// A real scheduler composition (built @r4/scheduler) that CLAIMS one due
// schedule — lease + fencing generation on the temporal clock — reports it on
// stdout and then never fires it, so the parent can SIGKILL the process after
// the claim and before any wake. Test-only.
import { setInterval } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSchedulerPlatform, loadSchedulerConfig } from '@r4/scheduler';

const config = loadSchedulerConfig(process.env);
const platform = await createSchedulerPlatform(config);
for (;;) {
  const schedule = await platform.temporal.claimSchedule(config.owner, config.leaseMs);
  if (schedule) {
    process.stdout.write(`${JSON.stringify({ event: 'child.schedule.claimed', scheduleId: schedule.scheduleId, generation: schedule.generation, kind: schedule.kind })}\n`);
    break;
  }
  await sleep(25);
}
// Dies here (SIGKILL) holding the claim.
setInterval(() => undefined, 1_000);
