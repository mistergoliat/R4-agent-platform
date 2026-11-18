import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRequest } from '@r4/model-gateway';
import { LiveOpsTestbed, complete, say, type QueuedStep } from '../support/live-ops.js';

/**
 * A reply the contact never received is never shown to the agent as said. Live case: two contact messages seconds
 * apart; the reply to the first was created and then cancelled before sending (superseded by the newer input), yet
 * the next context showed it as an agent turn. Real production composition over PostgreSQL; the scripted model only
 * records what it was shown.
 */
const CUSTOMER = '56955556666';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

function shownBy(step: QueuedStep): { step: QueuedStep; seen: () => Record<string, unknown>[] } {
  let context: unknown;
  return {
    step: (request: ModelRequest) => ((context = request.context), typeof step === 'function' ? step(request) : step),
    seen: () => Object.values((context as { sections: Record<string, unknown[]> }).sections).flat() as Record<string, unknown>[],
  };
}
const agentTurns = (items: Record<string, unknown>[]) =>
  items.filter((i) => i.kind === 'conversation_turn' && (i.content as { actor: { role: string } }).actor.role === 'agent').map((i) => (i.content as { text: string }).text);
const deliveryEpisodes = (items: Record<string, unknown>[]) => items.filter((i) => String(i.itemId).startsWith('delivery:')).map((i) => i.content as { status: string; meaning: string; reason: string | null });

describe('a cancelled reply is not in the agent context as said', { timeout: 90_000 }, () => {
  it('superseded by a newer message: left out while pending (it can only be cancelled) and once cancelled; the delivery episode says it was not sent', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true }));
    b.next(say('Borrador: el banco Atlas cuesta $89.990.'));
    await b.customer(CUSTOMER, 'wamid.s1', 'Hola, busco un banco');
    await b.runAgent();
    // The reply is materialized (pending) when the second message arrives, before any dispatch.
    await b.store.materializeResponses({ limit: 10 });
    const whilePending = shownBy(say('Te cuento de ambos bancos.'));
    b.next(whilePending.step);
    await b.customer(CUSTOMER, 'wamid.s2', 'Mejor uno plegable');
    await b.runAgent();
    expect(agentTurns(whilePending.seen())).toEqual([]);
    expect(deliveryEpisodes(whilePending.seen())).toEqual([expect.objectContaining({ status: 'pending', meaning: expect.stringMatching(/^it will NOT be sent/) })]);
    await b.deliver();
    expect(await b.rows('select status, cancel_reason from outbound_messages order by created_at')).toEqual([
      { status: 'cancelled', cancel_reason: 'superseded_by_newer_input' },
      { status: 'accepted', cancel_reason: null },
    ]);
    expect(b.provider.sends.map((s) => s.text)).toEqual(['Te cuento de ambos bancos.']);

    const afterCancel = shownBy(say('Perfecto.'));
    b.next(afterCancel.step);
    await b.customer(CUSTOMER, 'wamid.s3', 'Gracias');
    await b.runAgent();
    expect(agentTurns(afterCancel.seen())).toEqual(['Te cuento de ambos bancos.']);
    expect(JSON.stringify(afterCancel.seen())).not.toContain('Borrador');
    // The note that a draft was not sent stays (without its text), as the delivery owner recorded it.
    expect(deliveryEpisodes(afterCancel.seen())).toContainEqual(expect.objectContaining({ status: 'cancelled', reason: 'superseded_by_newer_input' }));

    // A later task of the conversation does not see it among the earlier turns either.
    await b.deliver();
    b.next(complete(), complete());
    await b.customer(CUSTOMER, 'wamid.s4', 'Chao');
    await b.runAgent();
    const nextTask = shownBy(say('Hola de nuevo.'));
    b.next(nextTask.step);
    await b.customer(CUSTOMER, 'wamid.s5', 'Hola otra vez');
    await b.runAgent();
    const prior = nextTask.seen().filter((i) => String(i.itemId).startsWith('prior_turn:')).map((i) => (i.content as { text: string }).text);
    expect(prior).toContain('Te cuento de ambos bancos.');
    expect(prior).toContain('Mejor uno plegable');
    expect(prior.join('\n')).not.toContain('Borrador');
    // The operator thread still shows every message with its delivery state.
    const thread = await b.store.thread((await b.rows<{ task_id: string }>('select task_id from agent_tasks order by created_at limit 1'))[0]!.task_id);
    expect(thread.find((e) => e.text?.startsWith('Borrador'))?.delivery).toMatchObject({ status: 'cancelled', cancelReason: 'superseded_by_newer_input' });
  });

  it('the production race: the second message arrives during the first reply\'s model call, and run 2 compiles before the reply is materialized', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true }));
    // Run 1's model call: the contact writes again while the model drafts the reply.
    b.next(async () => {
      await b.customer(CUSTOMER, 'wamid.p2', 'Mejor uno plegable');
      return say('Borrador: el banco Atlas cuesta $89.990.');
    });
    const run2 = shownBy(say('Te cuento de ambos bancos.'));
    b.next(run2.step);
    await b.customer(CUSTOMER, 'wamid.p1', 'Hola, busco un banco');
    // No delivery tick between the runs: run 2 is claimed at once, before the gateway materializes the first reply.
    await b.runAgent();
    expect(await b.rows<{ n: number }>('select count(*)::int as n from agent_runs')).toEqual([{ n: 2 }]);
    expect(await b.rows('select 1 from outbound_messages')).toEqual([]);
    expect(agentTurns(run2.seen())).toEqual([]);
    expect(JSON.stringify(run2.seen())).not.toContain('Borrador');
    // Materialized afterwards, it is cancelled as superseded and never sent; the second reply is.
    await b.deliver();
    await b.deliver();
    expect(await b.rows('select status, cancel_reason from outbound_messages order by created_at')).toEqual([
      { status: 'cancelled', cancel_reason: 'superseded_by_newer_input' },
      { status: 'accepted', cancel_reason: null },
    ]);
    expect(b.provider.sends.map((s) => s.text)).toEqual(['Te cuento de ambos bancos.']);
  });

  it('a delivered reply stays said', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true }));
    b.next(say('Tenemos el banco Atlas.'));
    await b.customer(CUSTOMER, 'wamid.d1', 'Busco un banco');
    await b.runAgent();
    await b.deliver();
    const shown = shownBy(say('Sí, el Atlas.'));
    b.next(shown.step);
    await b.customer(CUSTOMER, 'wamid.d2', '¿Cuál era?');
    await b.runAgent();
    expect(agentTurns(shown.seen())).toEqual(['Tenemos el banco Atlas.']);
  });
});
