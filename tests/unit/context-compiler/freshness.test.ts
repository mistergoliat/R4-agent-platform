import { describe, expect, it } from 'vitest';
import { classifyFreshness } from '@r4/context-compiler';
import { FixtureMemory, HOUR, MINUTE, T0, at, compiler, observation, request } from '../../fixtures/context/builders.js';

const now = (ms: number) => new Date(Date.parse(T0) + ms);
const point = (observedAt: string, validUntil: string | null = null) => ({ temporality: 'point_in_time' as const, observedAt, validUntil });
const live = (validUntil: string | null = null) => ({ temporality: 'live' as const, observedAt: null, validUntil });

describe('freshness classification (deterministic, injected clock)', () => {
  it('fresh: live records and bounded point-in-time items before their bounds', () => {
    expect(classifyFreshness(live(), now(10 * HOUR), undefined)).toBe('fresh');
    expect(classifyFreshness(point(T0, at(HOUR)), now(30 * MINUTE), undefined)).toBe('fresh');
    expect(classifyFreshness(point(T0), now(30 * MINUTE), HOUR)).toBe('fresh');
  });

  it('stale: aged past the policy threshold but not expired', () => {
    expect(classifyFreshness(point(T0, at(10 * HOUR)), now(2 * HOUR), HOUR)).toBe('stale');
    expect(classifyFreshness(point(T0), now(2 * HOUR), HOUR)).toBe('stale');
  });

  it('expired: at or after validUntil — for live and point-in-time items alike', () => {
    expect(classifyFreshness(point(T0, at(HOUR)), now(2 * HOUR), undefined)).toBe('expired');
    expect(classifyFreshness(live(at(HOUR)), now(2 * HOUR), undefined)).toBe('expired');
    // Expiry wins over staleness.
    expect(classifyFreshness(point(T0, at(HOUR)), now(2 * HOUR), MINUTE)).toBe('expired');
  });

  it('unknown: a point-in-time item with no bound at all', () => {
    expect(classifyFreshness(point(T0), now(1_000 * HOUR), undefined)).toBe('unknown');
  });

  it('boundaries: validUntil is exclusive, the stale threshold inclusive', () => {
    expect(classifyFreshness(point(T0, at(HOUR)), now(HOUR - 1), undefined)).toBe('fresh');
    expect(classifyFreshness(point(T0, at(HOUR)), now(HOUR), undefined)).toBe('expired');
    expect(classifyFreshness(point(T0), now(HOUR - 1), HOUR)).toBe('fresh');
    expect(classifyFreshness(point(T0), now(HOUR), HOUR)).toBe('stale');
  });

  it('is applied by the compiler per kind, from the policy', async () => {
    const memory = new FixtureMemory();
    memory.turn(at(0), 'said long ago');
    const observations = [
      observation(1, at(HOUR), { validUntil: at(3 * HOUR) }), // fresh: 1h old, threshold 90 min
      observation(2, at(0), { validUntil: null }), // stale by policy
      observation(3, at(0), { validUntil: at(HOUR) }), // expired → history
    ];
    const outcome = await compiler({ memory, policy: { staleAfterMs: { observation: 90 * MINUTE } } }).compile(request({ now: at(2 * HOUR), observations }));
    if (outcome.kind !== 'compiled') throw new Error('not compiled');
    const freshness = (itemId: string) => outcome.decisions.find((d) => d.itemId === itemId)?.freshness;
    expect(freshness('observation:0190e7a2-0000-7000-8000-000000000001')).toBe('fresh');
    expect(freshness('observation:0190e7a2-0000-7000-8000-000000000002')).toBe('stale');
    expect(freshness('observation:0190e7a2-0000-7000-8000-000000000003')).toBe('expired');
    // What someone said has no bound: unknown, not "fresh".
    expect(freshness(`memory:${memory.entries[0]!.entryId}`)).toBe('unknown');
    // Live platform records are fresh.
    expect(outcome.compiled.sections.goals[0]!.freshness).toBe('fresh');
  });
});
