import type { ContextFreshness, ContextItem } from '@r4/contracts';

/**
 * Deterministic freshness of an item as a statement about the present, judged
 * at `now` (an injected clock reading — never a model):
 *
 *   1. validUntil known and now ≥ validUntil                → expired  (validUntil is exclusive)
 *   2. live item                                            → fresh    (the owner's record, read now)
 *   3. point-in-time, staleAfterMs set, now ≥ observedAt+ms → stale
 *   4. point-in-time with a known bound (validUntil or ms)  → fresh
 *   5. point-in-time with no bound at all                   → unknown  (e.g. what someone said)
 *
 * `stale` means aging but still usable; `unknown` means nothing says whether
 * it still holds; only `expired` removes an item from the current context.
 */
export function classifyFreshness(
  item: Pick<ContextItem, 'temporality' | 'observedAt' | 'validUntil'>,
  now: Date,
  staleAfterMs: number | undefined,
): ContextFreshness {
  const at = now.getTime();
  if (item.validUntil !== null && at >= Date.parse(item.validUntil)) return 'expired';
  if (item.temporality === 'live') return 'fresh';
  const observedAt = item.observedAt === null ? null : Date.parse(item.observedAt);
  if (staleAfterMs !== undefined && observedAt !== null) {
    return at >= observedAt + staleAfterMs ? 'stale' : 'fresh';
  }
  return item.validUntil !== null ? 'fresh' : 'unknown';
}
