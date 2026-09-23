import type { JsonValue } from '@r4/contracts';
import type { EvaluationSubject } from './subject.js';

/**
 * Privacy boundary of Quality (R4-G). A judge never receives the subject as
 * is: it receives a projection with what evaluating the trajectory needs —
 * turns, responses, the observations each response could see, goals, the
 * outcome of governed actions and an optional pack view of domain state —
 * with personal fields redacted and nothing operational (principals,
 * correlation ids, leases, trusted contexts, model configuration).
 *
 * Artifacts pass a second check before they are written: no configured
 * secret, no credential header, no reasoning text.
 */
export interface PrivacyPolicy {
  /** Payload keys whose values are replaced before a judge sees them (personal data). Case-insensitive. */
  readonly redactKeys: readonly string[];
  /** Capabilities whose observations are never shown to a judge. */
  readonly excludeCapabilities?: readonly string[];
  /** Pack-defined judge view of its domain projections (default: none). */
  readonly domainView?: (domain: EvaluationSubject['domain']) => JsonValue;
}

export const REDACTED = '[redacted]';

export interface SemanticView {
  readonly subjectId: string;
  readonly objective: { readonly root: string | null; readonly goals: readonly { goalId: string; description: string; status: string; isRoot: boolean; isCurrent: boolean }[] };
  readonly turns: readonly { index: number; kind: string; text: string }[];
  readonly responses: readonly { responseId: string; turnIndex: number | null; text: string; evidenceInContext: readonly string[] }[];
  readonly observations: Readonly<Record<string, { capabilityId: string; outcome: string; observedAt: string; validUntil: string | null; payload: JsonValue }>>;
  readonly actions: readonly { proposalId: string; capabilityId: string; turnIndex: number | null; arguments: JsonValue; policy: string | null; receipt: string | null }[];
  readonly domain: JsonValue;
  /** Codes deterministic evaluators already established (a judge must not re-judge them). */
  readonly establishedFindings: readonly { code: string; subject: string }[];
}

export function projectSemanticView(subject: EvaluationSubject, policy: PrivacyPolicy, established: readonly { code: string; subjectRef: { kind: string; id: string } }[] = []): SemanticView {
  const excluded = new Set(policy.excludeCapabilities ?? []);
  const keys = new Set(policy.redactKeys.map((k) => k.toLowerCase()));
  const clean = (v: unknown): JsonValue => redactValue(v, keys);
  const turnOfRun = new Map(subject.runs.map((r) => [r.runId, r.turnIndex]));
  const observations: Record<string, SemanticView['observations'][string]> = {};
  for (const o of subject.observations) {
    if (excluded.has(o.source.capabilityId)) continue;
    observations[o.observationId] = { capabilityId: o.source.capabilityId, outcome: o.outcome, observedAt: o.observedAt, validUntil: o.validUntil, payload: clean(o.payload ?? (o.error ? { error: o.error.code } : null)) };
  }
  return {
    subjectId: subject.subjectId,
    objective: {
      root: subject.goals.find((g) => g.goalId === subject.task.rootGoalId)?.description ?? null,
      goals: subject.goals.map((g) => ({ goalId: g.goalId, description: g.description, status: g.status, isRoot: g.goalId === subject.task.rootGoalId, isCurrent: g.goalId === subject.task.currentGoalId })),
    },
    turns: subject.turns.map((t) => ({ index: t.index, kind: t.kind, text: t.text })),
    responses: subject.responses.map((r) => ({ responseId: r.responseId, turnIndex: r.turnIndex, text: r.text, evidenceInContext: r.evidenceInContext.filter((id) => id in observations) })),
    observations,
    actions: subject.actions.proposals.map((p) => ({
      proposalId: p.proposalId,
      capabilityId: p.capabilityId,
      turnIndex: turnOfRun.get(p.runId) ?? null,
      arguments: clean(p.arguments),
      policy: [...subject.actions.policyDecisions].reverse().find((d) => d.proposalId === p.proposalId)?.outcome ?? null,
      receipt: subject.actions.receipts.find((r) => r.proposalId === p.proposalId)?.status ?? null,
    })),
    domain: policy.domainView ? clean(policy.domainView(subject.domain)) : null,
    establishedFindings: established.map((f) => ({ code: f.code, subject: `${f.subjectRef.kind}:${f.subjectRef.id}` })),
  };
}

/** Keys that would carry model reasoning if anything ever tried to keep it. */
const REASONING_KEY = /^(reasoning|reasoning_?content|reasoning_?text|chain_?of_?thought|thoughts?|thinking_?content|scratchpad)$/i;

function redactValue(value: unknown, keys: ReadonlySet<string>): JsonValue {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, keys));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (REASONING_KEY.test(k)) continue;
      out[k] = keys.has(k.toLowerCase()) ? REDACTED : redactValue(v, keys);
    }
    return out;
  }
  if (typeof value === 'string') return redactCredentials(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return null;
}

/** Credential-shaped substrings (bearer tokens, common key prefixes). */
export function redactCredentials(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`).replace(/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED);
}

/**
 * Final gate before anything leaves as an artifact. Throws — never silently
 * rewrites — when the text carries a configured secret, a credential header,
 * the name of the model credential variable, or a reasoning field.
 */
export function assertArtifactSafe(text: string, secrets: readonly string[] = []): void {
  for (const secret of secrets) {
    if (secret.length >= 4 && text.includes(secret)) throw new Error('artifact contains a configured secret');
  }
  const problems: [RegExp, string][] = [
    [/"authorization"\s*:/i, 'an authorization header'],
    [/\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/i, 'a bearer token'],
    [/\bR4_MODEL_API_KEY\b/, 'the model credential variable'],
    [/"(x-api-key|api[_-]?key)"\s*:\s*"/i, 'an API key field'],
    [/"(reasoning|reasoning_?content|reasoning_?text|chain_?of_?thought|thoughts?|thinking_?content|scratchpad)"\s*:\s*"/i, 'reasoning text'],
  ];
  for (const [pattern, what] of problems) if (pattern.test(text)) throw new Error(`artifact contains ${what}`);
}
