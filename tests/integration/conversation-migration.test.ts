import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { AutonomyControls, ProductionAdministration, profileFingerprint, profileLabel } from '@r4/live-ops';
import { salesAgentOf, salesProductionProfile } from '@r4-sales/agent/production';
import { LiveOpsTestbed, keyOf, say } from '../support/live-ops.js';

/**
 * Profile migration: a conversation keeps the profile it opened with (ADR-045). When that version's worker no longer
 * runs (the web chat after each new version), the conversation waits forever. Migrating moves it — binding profile and
 * task agent version together — onto the current profile, with its whole history, and the current worker answers.
 */
const OWNER = '56911113333';
const LANE = 'sales-production@13';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const admin = (b: LiveOpsTestbed) => new ProductionAdministration({ store: b.store, temporal: b.api.temporal, controls: new AutonomyControls({ store: b.store, logger: createSilentLogger() }), correlationId: 'test:migration' });
const target = () => {
  const p = salesProductionProfile('sales-production@1')!;
  const a = salesAgentOf(p);
  return { profile: profileLabel(p), profileFingerprint: profileFingerprint(p), agentId: a.agentId, agentVersion: a.version };
};
const state = async (b: LiveOpsTestbed) => (await b.rows<{ profile: string; status: string; agent_version: number; task_id: string }>(
  `select b.profile, b.status, t.agent_version, t.task_id from channel_conversation_bindings b join agent_tasks t on t.task_id = b.task_id where b.conversation_key = $1 order by b.created_at desc limit 1`, [keyOf(OWNER)]))[0]!;

describe('conversation migration onto the current profile', () => {
  it('an orphaned conversation (its version has no worker) moves with its task and history, and the current worker answers the waiting message', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], autonomy: true }));
    await b.customer(OWNER, 'wamid.m1', 'Hola');
    // The lane is retired and its worker no longer runs: the conversation keeps v13 and its next message waits.
    await b.redeployGateway({ allowlist: [OWNER] });
    await b.customer(OWNER, 'wamid.m2', '¿Sigues ahí?');
    const before = await state(b);
    expect(before).toMatchObject({ profile: LANE, status: 'open', agent_version: 13 });
    expect(await b.runAgent()).not.toContain('executed');

    // Preview changes nothing.
    const preview = await admin(b).migrateConversations({ channel: 'whatsapp', to: target(), reason: 'web version changed', preview: true });
    expect(preview).toMatchObject({ migrated: 1, skipped: 0, conversations: [{ outcome: 'would_migrate', fromProfile: LANE, fromAgentVersion: 13 }] });
    expect((await state(b)).agent_version).toBe(13);

    const done = await admin(b).migrateConversations({ channel: 'whatsapp', to: target(), reason: 'web version changed', preview: false });
    expect(done.conversations).toEqual([expect.objectContaining({ outcome: 'migrated', taskId: before.task_id, fromAgentVersion: 13 })]);
    expect(await state(b)).toMatchObject({ profile: 'sales-production@1', status: 'open', agent_version: target().agentVersion, task_id: before.task_id });
    expect(await b.rows(`select data->>'fromProfile' as f, data->>'toProfile' as t from temporal_events where task_id = $1 and event_type = 'task.agent_migrated'`, [before.task_id])).toEqual([{ f: LANE, t: 'sales-production@1' }]);

    // The current worker claims the same task and answers the waiting message, seeing both messages (history kept).
    let seen = '';
    b.next((request) => ((seen = JSON.stringify(request)), say('Sí, aquí estoy.')));
    await b.runAgent();
    expect(seen).toContain('¿Sigues ahí?');
    expect(seen).toContain('Hola');
    await b.deliver();
    expect((await b.store.outboundForTask(before.task_id)).length).toBeGreaterThan(0);

    // Again: nothing left to move.
    expect((await admin(b).migrateConversations({ channel: 'whatsapp', to: target(), reason: 'again', preview: false })).migrated).toBe(0);
  });

  it('skips what has something in flight or already ended, and refuses a migration without a reason', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], autonomy: true }));
    await b.customer(OWNER, 'wamid.m3', 'Hola');
    await b.redeployGateway({ allowlist: [OWNER] });
    const { task_id: taskId } = await state(b);
    // A run holding its lease right now.
    await b.pool.query(`update agent_tasks set lease_owner = 'w', lease_generation = lease_generation + 1, lease_acquired_at = clock_timestamp(), last_heartbeat_at = clock_timestamp(), lease_expires_at = clock_timestamp() + interval '1 minute' where task_id = $1`, [taskId]);
    expect((await admin(b).migrateConversations({ channel: 'whatsapp', to: target(), reason: 'r', preview: false })).conversations).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'run_in_flight' })]);
    await b.pool.query(`update agent_tasks set lease_owner = null, lease_acquired_at = null, last_heartbeat_at = null, lease_expires_at = null where task_id = $1`, [taskId]);
    await b.api.temporal.cancelTaskByPlatform(taskId, { note: 'ended', actorRef: 'test', correlationId: 'test' });
    expect((await admin(b).migrateConversations({ channel: 'whatsapp', to: target(), reason: 'r', preview: false })).conversations).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'task_ended' })]);
    await expect(admin(b).migrateConversations({ channel: 'whatsapp', to: target(), reason: '  ', preview: false })).rejects.toThrow();
  });
});
