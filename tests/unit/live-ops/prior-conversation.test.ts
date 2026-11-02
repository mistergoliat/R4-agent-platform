import { describe, expect, it } from 'vitest';
import type { ContextSourceRequest } from '@r4/context-compiler';
import { PriorConversationContextSource, type ThreadEntry } from '@r4/live-ops';

/** R4-J4-R7-4 — the earlier tasks of a conversation as context of the current one (pure mapping, fake reader). */

const CURRENT = '01a19ddb-0000-7000-8000-000000000003';
const B = '01a19ddb-0000-7000-8000-000000000002';
const A = '01a19ddb-0000-7000-8000-000000000001';

const turn = (at: string, id: string, kind: ThreadEntry['kind'], text: string | null, status: string | null = null): ThreadEntry => ({
  cursor: `${at}|${id}`, at, kind, text, refs: {}, delivery: status === null ? null : { outboundId: id, status: status as never, holdReason: null, cancelReason: null, providerMessageId: null },
});

const threads: Record<string, ThreadEntry[]> = {
  [A]: [
    turn('2026-11-01T10:00:00.000Z', '01a19ddb-0000-7000-8000-00000000a001', 'contact', 'Busco un banco regulable'),
    turn('2026-11-01T10:00:05.000Z', '01a19ddb-0000-7000-8000-00000000a002', 'agent', 'Tenemos el banco Atlas a $89.990.', 'read'),
    turn('2026-11-01T10:00:06.000Z', '01a19ddb-0000-7000-8000-00000000a003', 'event', null),
  ],
  [B]: [
    turn('2026-11-01T12:00:00.000Z', '01a19ddb-0000-7000-8000-00000000b001', 'contact', 'Hola de nuevo'),
    turn('2026-11-01T12:00:05.000Z', '01a19ddb-0000-7000-8000-00000000b002', 'agent', 'Hola, ¿en qué te ayudo?', 'cancelled'),
    turn('2026-11-01T12:00:09.000Z', '01a19ddb-0000-7000-8000-00000000b003', 'operator', 'Te escribo yo, soy Ana.', 'delivered'),
  ],
};

function source(earlier: string[], options: { maxTurns?: number; maxTasks?: number } = {}) {
  const asked: number[] = [];
  const reader = {
    earlierConversationTasks: (taskId: string, limit: number) => (expect(taskId).toBe(CURRENT), asked.push(limit), Promise.resolve(earlier.slice(0, limit))),
    thread: (taskId: string) => Promise.resolve(threads[taskId] ?? []),
  };
  return { s: new PriorConversationContextSource(reader, options), asked };
}

const request = { execution: { task: { taskId: CURRENT } } } as unknown as ContextSourceRequest;

describe('PriorConversationContextSource', () => {
  it('without an earlier task of the conversation, contributes nothing (nothing is invented)', async () => {
    expect(await source([]).s.load(request)).toEqual([]);
  });

  it('projects what was said in the earlier tasks, oldest first, as CONVERSATIONAL turns of the current task', async () => {
    const items = await source([B, A]).s.load(request);
    const turns = items.filter((i) => i.kind === 'conversation_turn');
    expect(turns.map((i) => (i.content as { text: string }).text)).toEqual(['Busco un banco regulable', 'Tenemos el banco Atlas a $89.990.', 'Hola de nuevo', 'Hola, ¿en qué te ayudo?', 'Te escribo yo, soy Ana.']);
    for (const t of turns) {
      expect(t.authority).toBe('CONVERSATIONAL');
      expect(t.taskId).toBe(CURRENT);
      expect(t.itemId).toMatch(/^prior_turn:/);
      expect((t.content as { earlierTask: boolean }).earlierTask).toBe(true);
    }
    // Platform events of the thread are not turns; only conversation turns and one framing episode enter.
    expect(items.map((i) => i.kind).sort()).toEqual(['conversation_turn', 'conversation_turn', 'conversation_turn', 'conversation_turn', 'conversation_turn', 'episode']);
  });

  it('says honestly what the contact did and did not receive', async () => {
    const turns = (await source([B, A]).s.load(request)).filter((i) => i.kind === 'conversation_turn').map((i) => i.content as { actor: { role: string }; delivery?: string });
    expect(turns.map((t) => [t.actor.role, t.delivery])).toEqual([
      ['participant', undefined],
      ['agent', 'the contact received it'],
      ['participant', undefined],
      ['agent', 'it was NOT sent'],
      ['operator', 'the contact received it'],
    ]);
  });

  it('frames the turns with one required OBSERVED episode', async () => {
    const episode = (await source([B, A]).s.load(request)).find((i) => i.kind === 'episode')!;
    expect(episode).toMatchObject({ itemId: `prior_conversation:${CURRENT}`, authority: 'OBSERVED', required: true, taskId: CURRENT });
    expect(episode.content).toMatchObject({ earlierTasks: 2, turnsShown: 5, earlierTurnsOmitted: false });
  });

  it('keeps the newest maxTurns, stops reading older tasks once it has them, and says turns were omitted', async () => {
    const { s, asked } = source([B, A], { maxTurns: 2, maxTasks: 5 });
    const items = await s.load(request);
    expect(asked).toEqual([5]);
    expect(items.filter((i) => i.kind === 'conversation_turn').map((i) => (i.content as { text: string }).text)).toEqual(['Hola, ¿en qué te ayudo?', 'Te escribo yo, soy Ana.']);
    expect(items.find((i) => i.kind === 'episode')!.content).toMatchObject({ earlierTasks: 1, turnsShown: 2, earlierTurnsOmitted: true });
  });

  it('is deterministic in the durable records', async () => {
    expect(await source([B, A]).s.load(request)).toEqual(await source([B, A]).s.load(request));
  });
});
