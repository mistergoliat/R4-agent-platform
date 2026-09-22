import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { observationSchema, systemClock, uuidV7Generator, type TrustedExecutionContext } from '@r4/contracts';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { DefaultModelGateway, FakeModelProvider, parseStructuredOutput } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresObservationStore } from '@r4/persistence-postgres';
import type { Platform } from '@r4/api';
import { z } from 'zod';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { GET_TEST_FACT_ID, getTestFactCapability } from '../fixtures/capabilities/get-test-fact.js';

let db: TestDatabase;
let platform: Platform;
let observations: PostgresObservationStore;
let invoker: CapabilityInvoker;
let registry: CapabilityRegistry;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
  observations = new PostgresObservationStore(platform.pool);
  registry = new CapabilityRegistry();
  registry.register(getTestFactCapability());
  invoker = new CapabilityInvoker({ registry, observations, ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger() });
});

afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

async function runningContext(): Promise<TrustedExecutionContext> {
  const actor = { kind: 'service', ref: 'it' } as const;
  const { task } = (await platform.tasks.createTask({ request: validTaskBody({ taskType: 'probe.fact_lookup' }), requestedBy: actor, correlationId: 'cap-it' })).view;
  const { run } = await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'cap-it' });
  const agent = await platform.agents.get(task.agentId, task.agentVersion);
  // The trusted context is built by the platform from durable state — not by a model.
  return { taskId: task.taskId, runId: run.runId, agentId: agent.agentId, agentVersion: agent.version, correlationId: 'cap-it', grantedScopes: agent.capabilityScopes };
}

describe('capability invocation → durable observation', () => {
  it('discovers the test capability from the agent’s granted scopes', async () => {
    const agent = await platform.agents.get('platform-probe');
    expect(registry.discover(agent.capabilityScopes).map((d) => d.capabilityId)).toEqual([GET_TEST_FACT_ID]);
  });

  it('persists a successful observation linked to task, run and agent', async () => {
    const context = await runningContext();
    const observation = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'platform.phase' } }, context);
    expect(observation).toMatchObject({ outcome: 'succeeded', payload: { factKey: 'platform.phase', found: true, value: 'R4-B' } });

    const stored = await observations.listByTask(context.taskId);
    expect(stored).toHaveLength(1);
    expect(observationSchema.safeParse(stored[0]).success).toBe(true);
    expect(stored[0]).toEqual(observation);
  });

  it('persists rejected invocations as evidence too', async () => {
    const context = await runningContext();
    await invoker.invoke({ capabilityId: 'platform_test.unknown', arguments: {} }, context);
    await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 7 } }, context);
    const stored = await observations.listByTask(context.taskId);
    expect(stored.map((o) => [o.outcome, o.error?.code])).toEqual([
      ['rejected', 'capability_not_found'],
      ['rejected', 'invalid_arguments'],
    ]);
  });

  it('records exactly once per invocation id, even when replayed', async () => {
    const context = await runningContext();
    const invocationId = uuidV7Generator().next();
    const a = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context, { invocationId });
    const b = await invoker.invoke({ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }, context, { invocationId });
    expect(b.observationId).toBe(a.observationId);
    expect(await observations.listByTask(context.taskId)).toHaveLength(1);
  });

  it('end to end offline: fake model proposes a read, platform validates it, capability observation is durable', async () => {
    const context = await runningContext();
    const provider = new FakeModelProvider([{ type: 'structured', data: { capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'platform.name' } } }]);
    const gateway = new DefaultModelGateway({ provider, logger: createSilentLogger() });
    const agent = await platform.agents.get(context.agentId, context.agentVersion);

    const result = await gateway.generate({
      correlation: { correlationId: context.correlationId, taskId: context.taskId, runId: context.runId, agentId: context.agentId },
      requirements: agent.modelRequirements,
      messages: [{ role: 'user', content: 'What is the platform name?' }],
      tools: registry.discover(context.grantedScopes).map((d) => ({ name: d.capabilityId, description: d.description, inputSchema: d.inputSchema })),
      outputContract: { kind: 'json', name: 'read_proposal', schema: {} },
      limits: { timeoutMs: 1_000 },
    });
    if (!result.ok) throw new Error(result.error.message);

    const proposal = parseStructuredOutput(result.response, z.strictObject({ capabilityId: z.string(), arguments: z.unknown() }));
    if (!proposal.ok) throw new Error(proposal.error.message);
    const observation = await invoker.invoke(proposal.data, context);

    expect(observation).toMatchObject({ outcome: 'succeeded', payload: { value: 'R4' } });
    expect(provider.requests[0]!.tools!.map((t) => t.name)).toEqual([GET_TEST_FACT_ID]);
    // The model output never touched persistence: only the invoker wrote the observation.
    expect(await observations.listByTask(context.taskId)).toEqual([observation]);
  });
});
