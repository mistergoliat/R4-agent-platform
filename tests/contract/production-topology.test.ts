import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SALES_PRODUCTION_PROCESSES, schedulerConfigurationStatus } from '@r4-sales/agent/production';

/**
 * R4-J1E-R2.1 — production composition correction. A Sales production
 * deployment runs THREE independent processes: channel gateway, worker and
 * scheduler. The scheduler is not optional: it is the only consumer of
 * durable schedules, and the agent protocol admits WAIT_UNTIL (plus human
 * request expiries, retry release and reconciliation dispatch), which only a
 * schedule firing resolves. These checks fail if the production topology,
 * its entry points or its runbook drop it.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const text = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const scripts = (JSON.parse(text('package.json')) as { scripts: Record<string, string> }).scripts;

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}
const runtimeSources = ['packages', 'apps', 'agents', 'adapters'].flatMap(sources).map((p) => relative(ROOT, join(ROOT, p)).replace(/\\/g, '/'));

describe('R4-J1E-R2.1 production topology: gateway + worker + scheduler', () => {
  it('declares exactly the three production processes, each started by an existing root script', () => {
    expect(SALES_PRODUCTION_PROCESSES.map((p) => p.name)).toEqual(['r4-channel-gateway', 'r4-sales-worker', 'r4-scheduler']);
    for (const p of SALES_PRODUCTION_PROCESSES) expect(scripts[p.script], `script ${p.script} of ${p.name}`).toBeDefined();
    const byName = Object.fromEntries(SALES_PRODUCTION_PROCESSES.map((p) => [p.name, scripts[p.script]]));
    expect(byName['r4-channel-gateway']).toBe('node agents/sales/dist/cli/production.js --gateway');
    expect(byName['r4-sales-worker']).toBe('node agents/sales/dist/cli/production.js --worker');
    // The scheduler is the generic, existing entry point — no second, Sales-specific one.
    expect(byName['r4-scheduler']).toBe('node apps/scheduler/dist/main.js');
    const main = text('apps/scheduler/src/main.ts');
    expect(main).toMatch(/createSchedulerPlatform\(/);
    expect(main).toMatch(/platform\.scheduler\.start\(\)/);
  });

  it('the scheduler is required: it is the only consumer of durable schedules, and agent waits create them', () => {
    const consumers = runtimeSources.filter((p) => /\.claimSchedule\(/.test(text(p)));
    expect(consumers).toEqual(['apps/scheduler/src/scheduler.ts']);
    // A WAIT_UNTIL the agent decides persists a wake schedule, which only a scheduler fires.
    expect(text('packages/contracts/src/temporal.ts')).toMatch(/'WAIT_UNTIL'/);
    expect(text('packages/task-runtime/src/temporal-runtime.ts')).toMatch(/if \(dueAt\) await this\.scheduleWithin\(uow, task, 'wake'/);
    // ... and the worker can never wake a waiting task itself: it claims only pending/running tasks.
    expect(text('packages/persistence-postgres/src/execution-store.ts')).toMatch(/where status in \('pending', 'running'\)/);
  });

  it('the scheduler stays an independent process: neither the gateway nor the worker embeds one', () => {
    const embedding = runtimeSources.filter(
      (p) => (p.startsWith('apps/worker/') || p.startsWith('apps/channel-gateway/') || p.startsWith('agents/sales/src/production/') || p === 'agents/sales/src/cli/production.ts') && /createSchedulerPlatform\(|new Scheduler\(|scheduler\.start\(\)/.test(text(p)),
    );
    expect(embedding).toEqual([]);
    for (const dir of ['apps/worker/src', 'apps/channel-gateway/src']) {
      for (const p of runtimeSources.filter((s) => s.startsWith(dir))) expect(text(p), p).not.toMatch(/@r4\/scheduler/);
    }
  });

  it('the production plan reports the processes and whether the scheduler can start', () => {
    const cli = text('agents/sales/src/cli/production.ts');
    expect(cli).toMatch(/processes: SALES_PRODUCTION_PROCESSES/);
    expect(cli).toMatch(/schedulerConfigurationStatus\(process\.env\)/);
  });

  it('the scheduler configuration has no silent default for the reconciliation policy', () => {
    const missing = schedulerConfigurationStatus({ R4_DATABASE_URL: 'postgres://r4:secret@db.example:5432/r4' });
    expect(missing.usable).toBe(false);
    if (missing.usable) return;
    for (const name of ['R4_RECONCILIATION_MAX_ATTEMPTS', 'R4_RECONCILIATION_INITIAL_BACKOFF_MS', 'R4_RECONCILIATION_MAX_BACKOFF_MS', 'R4_RECONCILIATION_DEADLINE_MS']) expect(missing.reason).toContain(name);
    expect(missing.reason).not.toContain('secret');
    const ready = schedulerConfigurationStatus({
      R4_DATABASE_URL: 'postgres://r4:secret@db.example:5432/r4', R4_SCHEDULER_ID: 'r4-scheduler-1',
      R4_RECONCILIATION_MAX_ATTEMPTS: '5', R4_RECONCILIATION_INITIAL_BACKOFF_MS: '1000', R4_RECONCILIATION_MAX_BACKOFF_MS: '60000', R4_RECONCILIATION_DEADLINE_MS: '86400000',
    });
    expect(ready).toMatchObject({ usable: true, owner: 'r4-scheduler-1', reconciliationPolicy: { maxAttempts: 5, initialBackoffMs: 1000, maxBackoffMs: 60000, deadlineMs: 86400000 } });
  });

  it('the production runbook, ADR-029 §16 and the README deployment order name all three processes', () => {
    for (const doc of ['docs/architecture/R4-J1E-R2.1_PRODUCTION_COMPOSITION.md', 'docs/adr/ADR-029-governed-production-channel-delivery-rollout.md', 'README.md']) {
      const body = text(doc);
      for (const p of SALES_PRODUCTION_PROCESSES) expect(body, `${doc} names ${p.script}`).toContain(`npm run ${p.script}`);
    }
    // The pre-deploy operator gate uses the existing production control, with its real syntax.
    expect(text('docs/architecture/R4-J1E-R2.1_PRODUCTION_COMPOSITION.md')).toContain('npm run production:sales:control -- tasks cancel --task 01a0f85e-80e7-7bda-aa19-73193021d287 --reason');
  });
});
