import { fileURLToPath } from 'node:url';
import type { Platform } from '@r4/api';
import { CapabilityRegistry } from '@r4/capability-runtime';
import type { JsonObject, Principal } from '@r4/contracts';
import { PostgresActionLedgerStore, type Pool } from '@r4/persistence-postgres';
import { getTestFactCapability } from '../fixtures/capabilities/get-test-fact.js';
import { testLedgerCapability, type TestLedgerCapabilityOptions } from '../fixtures/capabilities/test-ledger.js';
import { startTestPlatform } from './platform.js';

/** Test-only agent definitions for governed execution (the repo's platform-probe has no write scopes). */
export const ACTION_AGENTS_DIR = fileURLToPath(new URL('../fixtures/agents', import.meta.url));
export const ACTION_AGENT = 'action-probe';

export function startActionPlatform(databaseUrl: string): Promise<Platform> {
  return startTestPlatform(databaseUrl, { agentDefinitionsDir: ACTION_AGENTS_DIR });
}

/** Registry with the READ test fact plus the ledger write capability (and any extra variants). */
export function actionCapabilities(pool: Pool, ledger: TestLedgerCapabilityOptions = {}, extra: TestLedgerCapabilityOptions[] = []): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(getTestFactCapability());
  registry.registerWrite(testLedgerCapability(pool, ledger));
  for (const variant of extra) registry.registerWrite(testLedgerCapability(pool, variant));
  return registry;
}

export async function createActionTask(
  platform: Platform,
  options: { correlationId?: string; input?: JsonObject; budget?: Record<string, number>; requestedBy?: Principal } = {},
): Promise<string> {
  const { view } = await platform.tasks.createTask({
    request: {
      taskType: 'probe.record_update',
      agentId: ACTION_AGENT,
      goal: { description: 'Set the test record and confirm it from a receipt' },
      input: options.input ?? { recordKey: 'alpha', value: 'one' },
      ...(options.budget ? { budget: options.budget } : {}),
    },
    requestedBy: options.requestedBy ?? { kind: 'service', ref: 'governed-execution-test' },
    correlationId: options.correlationId ?? 'governed-it',
  });
  return view.task.taskId;
}

export function ledgerOf(pool: Pool, taskId: string) {
  return new PostgresActionLedgerStore(pool).forTask(taskId);
}

/** A write-enabled execution policy for tests (writes are opt-in). */
export const WRITES = { maxWriteActions: 5 } as const;
