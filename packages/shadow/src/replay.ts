import { redactPersonalData } from './sanitize.js';
import { WORKLOAD_CASE_SCHEMA_VERSION, parseWorkloadCase, type RawConversation, type WorkloadCase, type WorkloadInvariant } from './workload.js';

/**
 * Replay readiness (R4-H). Turns a real conversation into a WorkloadCase:
 * only the person's messages become inputs (what the agent said then is not
 * replayed — the agent under test answers anew), every input is redacted
 * first, and the case records what was redacted. The subject reference is
 * never carried over: a replay runs as an anonymous / fixture identity.
 *
 * R4-H has no legal/operational source of real conversations; this path is
 * exercised with synthetic "raw" input in tests only.
 */
export function workloadFromReplay(raw: RawConversation, options: { id: string; version: number; title: string; acceptableStops: readonly string[]; invariants?: readonly WorkloadInvariant[]; tags?: readonly string[] }): WorkloadCase {
  const redactions: Record<string, number> = {};
  const events = raw.turns
    .filter((t) => t.from === 'person')
    .map((t) => {
      const sanitized = redactPersonalData(t.text, raw.knownIdentifiers);
      for (const [kind, n] of Object.entries(sanitized.redactions)) redactions[kind] = (redactions[kind] ?? 0) + (n ?? 0);
      return { kind: 'input' as const, text: sanitized.text };
    });
  const ref = redactPersonalData(raw.ref, raw.knownIdentifiers);
  for (const [kind, n] of Object.entries(ref.redactions)) redactions[kind] = (redactions[kind] ?? 0) + (n ?? 0);
  return parseWorkloadCase({
    schemaVersion: WORKLOAD_CASE_SCHEMA_VERSION,
    id: options.id,
    version: options.version,
    title: options.title,
    sourceType: 'replay',
    // The source reference is redacted too: it may carry an operational id or contact data.
    source: { ref: `replay:${ref.text}`.slice(0, 200), derivedFrom: [] },
    initialContext: { subjectRef: null, channelRef: 'shadow-replay', profiles: {} },
    events,
    expectations: { invariants: [...(options.invariants ?? [])], acceptableStops: [...options.acceptableStops], constraints: [] },
    privacy: { classification: 'sanitized_real', sanitized: true, redactions, note: 'imported conversation; person turns redacted before persistence; subject reference dropped' },
    tags: ['replay', ...(options.tags ?? [])],
  });
}
