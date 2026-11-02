import { describe, expect, it } from 'vitest';
import type { ContextSourceRequest } from '@r4/context-compiler';
import { PriorConversationContextSource, type ThreadEntry } from '@r4/live-ops';

/** R4-J4-R7-4 — the earlier tasks of a conversation as context of the current one (pure mapping, fake reader). */

const CURRENT = '01a19ddb-0000-7000-8000-000000000003';
const NOW = new Date('2026-11-02T12:00:00.000Z');

const turn = (at: string, id: string, kind: ThreadEntry['kind'], text: string, status: string | null = null): ThreadEntry => ({
  cursor: `${at}|${id}`, at, kind, text, refs: {}, delivery: status === null ? null : { outboundId: id, status: status as never, holdReason: null, cancelReason: null, providerMessageId: null },
});

/** What the store holds for the conversation, oldest first (two earlier tasks). */
const SAID = [
  turn('2026-11-01T10:00:00.000Z', '01a19ddb-0000-7000-8000-00000000a001', 'contact', 'Busco un banco regulable'),
  turn('2026-11-01T10:00:05.000Z', '01a19ddb-0000-7000-8000-00000000a002', 'agent', 'Tenemos el banco Atlas a $89.990.', 'read'),
  turn('2026-11-01T12:00:00.000Z', '01a19ddb-0000-7000-8000-00000000b001', 'contact', 'Hola de nuevo'),
  turn('2026-11-01T12:00:05.000Z', '01a19ddb-0000-7000-8000-00000000b002', 'agent', 'Hola, ¿en qué te ayudo?', 'cancelled'),
  turn('2026-11-01T12:00:09.000Z', '01a19ddb-0000-7000-8000-00000000b003', 'operator', 'Te escribo yo, soy Ana.', 'delivered'),
];

/** A fake with the store's contract: turns at or after `since`, the newest `limit`, oldest first. */
function source(said: ThreadEntry[], earlierTasks: number, options: { maxTurns?: number; maxTasks?: number; windowDays?: number } = {}) {
  const asked: { since: string; limit: number; maxTasks: number }[] = [];
  const reader = {
    earlierConversationTurns: (taskId: string, o: { since: string; limit: number; maxTasks: number }) => {
      expect(taskId).toBe(CURRENT);
      asked.push(o);
      return Promise.resolve({ turns: said.filter((t) => t.at >= o.since).slice(-o.limit), earlierTasks });
    },
  };
  return { s: new PriorConversationContextSource(reader, options), asked };
}

const request = { now: NOW, execution: { task: { taskId: CURRENT } } } as unknown as ContextSourceRequest;
const texts = (items: readonly { kind: string; content: unknown }[]) => items.filter((i) => i.kind === 'conversation_turn').map((i) => (i.content as { text: string }).text);

describe('PriorConversationContextSource', () => {
  it('without an earlier turn, contributes nothing (nothing is invented)', async () => {
    expect(await source([], 0).s.load(request)).toEqual([]);
  });

  it('projects what was said in the earlier tasks, oldest first, as CONVERSATIONAL turns of the current task', async () => {
    const items = await source(SAID, 2).s.load(request);
    expect(texts(items)).toEqual(['Busco un banco regulable', 'Tenemos el banco Atlas a $89.990.', 'Hola de nuevo', 'Hola, ¿en qué te ayudo?', 'Te escribo yo, soy Ana.']);
    for (const t of items.filter((i) => i.kind === 'conversation_turn')) {
      expect(t.authority).toBe('CONVERSATIONAL');
      expect(t.taskId).toBe(CURRENT);
      expect(t.itemId).toMatch(/^prior_turn:/);
      expect((t.content as { earlierTask: boolean }).earlierTask).toBe(true);
    }
    expect(items.map((i) => i.kind).sort()).toEqual(['conversation_turn', 'conversation_turn', 'conversation_turn', 'conversation_turn', 'conversation_turn', 'episode']);
  });

  it('says honestly what the contact did and did not receive', async () => {
    const turns = (await source(SAID, 2).s.load(request)).filter((i) => i.kind === 'conversation_turn').map((i) => i.content as { actor: { role: string }; delivery?: string });
    expect(turns.map((t) => [t.actor.role, t.delivery])).toEqual([
      ['participant', undefined],
      ['agent', 'the contact received it'],
      ['participant', undefined],
      ['agent', 'it was NOT sent'],
      ['operator', 'the contact received it'],
    ]);
  });

  it('frames the turns with one required OBSERVED episode', async () => {
    const episode = (await source(SAID, 2).s.load(request)).find((i) => i.kind === 'episode')!;
    expect(episode).toMatchObject({ itemId: `prior_conversation:${CURRENT}`, authority: 'OBSERVED', required: true, taskId: CURRENT });
    expect(episode.content).toMatchObject({ earlierTasks: 2, turnsShown: 5, earlierTurnsOmitted: false });
  });

  it('asks the store once for one more than maxTurns, keeps the newest maxTurns and says turns were omitted', async () => {
    const { s, asked } = source(SAID, 2, { maxTurns: 2, maxTasks: 5 });
    const items = await s.load(request);
    expect(asked).toEqual([{ since: '2026-10-03T12:00:00.000Z', limit: 3, maxTasks: 5 }]);
    expect(texts(items)).toEqual(['Hola, ¿en qué te ayudo?', 'Te escribo yo, soy Ana.']);
    expect(items.find((i) => i.kind === 'episode')!.content).toMatchObject({ turnsShown: 2, earlierTurnsOmitted: true });
  });

  it('R-2: the window is 30 days by default, configurable, measured from the compilation clock', async () => {
    const byDefault = source(SAID, 2);
    await byDefault.s.load(request);
    expect(byDefault.asked[0]!.since).toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
    // A one-day window leaves out the turns of 2026-11-01 before 12:00.
    const oneDay = source(SAID, 2, { windowDays: 1 });
    expect(texts(await oneDay.s.load(request))).toEqual(['Hola de nuevo', 'Hola, ¿en qué te ayudo?', 'Te escribo yo, soy Ana.']);
    expect(oneDay.asked[0]!.since).toBe('2026-11-01T12:00:00.000Z');
  });

  it('is deterministic in the durable records and the clock', async () => {
    expect(await source(SAID, 2).s.load(request)).toEqual(await source(SAID, 2).s.load(request));
  });
});
