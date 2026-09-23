import { z } from 'zod';
import { evidenceRefSchema, subjectRefSchema } from './finding.js';
import type { ModelProfile } from './model-profile.js';
import type { SemanticView } from './privacy.js';
import { rubricHash, type Rubric } from './rubric.js';
import { confidenceSchema, findingCodeSchema, severitySchema } from './taxonomy.js';

/**
 * Semantic evaluation boundary (R4-G). A judge is any model — the same one
 * under test or another, hosted or local — reached through the existing
 * ModelProvider SPI by an adapter outside this package. Quality only defines
 * what it sends (a versioned rubric and a privacy projection) and what it
 * accepts back (a strict, structured verdict). Judges are untrusted exactly
 * like agents: an answer that does not validate, or that does not arrive in
 * time, makes the evaluator INCONCLUSIVE — it never turns the agent under
 * test into a failure, and nothing is invented to fill the gap.
 */
export interface JudgeRequest {
  readonly rubric: Rubric & { readonly hash: string };
  readonly view: SemanticView;
  /** JSON Schema of the expected answer (for providers that support structured output). */
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export interface SemanticJudge {
  /** The judge's model profile (recorded as the evaluator model of the run). */
  readonly profile: ModelProfile;
  judge(request: JudgeRequest, signal: AbortSignal): Promise<unknown>;
}

const rationaleSchema = z.string().trim().min(1).max(280);

/** A verdict: findings only, each with its evidence and a short evaluative rationale. No reasoning field exists. */
export const judgeVerdictSchema = z.strictObject({
  verdict: z.enum(['no_issues', 'issues_found', 'inconclusive']),
  /** Objective-continuity rubrics only. */
  objective: z.enum(['preserved', 'drifted']).optional(),
  findings: z
    .array(
      z.strictObject({
        code: findingCodeSchema,
        severity: severitySchema.optional(),
        subjectRef: subjectRefSchema,
        evidenceRefs: z.array(evidenceRefSchema).max(20).default([]),
        confidence: confidenceSchema,
        rationale: rationaleSchema,
      }),
    )
    .max(50),
});
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

export const CLAIM_TYPES = ['entity_fact', 'numeric_fact', 'availability', 'price', 'stock', 'specification', 'relationship', 'compatibility', 'recommendation'] as const;
export const claimTypeSchema = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof claimTypeSchema>;

export const claimEntitySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  /** Pack vocabulary for the entity (e.g. an item, a category); free text for the framework. */
  kind: z.string().trim().min(1).max(40),
  /** Identifier in the owner's id space, when the response or evidence gives one. */
  ref: z.string().trim().min(1).max(120).nullable().default(null),
});

/** Claims as a judge (or a deterministic extractor) reports them, before verification. */
export const extractedClaimSchema = z.strictObject({
  responseId: z.string().min(1),
  type: claimTypeSchema,
  /** The span, or a normalized proposition (bounded). */
  text: z.string().trim().min(1).max(300),
  entities: z.array(claimEntitySchema).max(8),
  attributes: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), z.union([z.string().max(120), z.number(), z.boolean()])).default({}),
});
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;

export const judgeClaimsSchema = z.strictObject({ claims: z.array(extractedClaimSchema).max(200) });

export type JudgeCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'judge_timeout' | 'judge_invalid_output' | 'judge_error' | 'judge_disallowed_code'; readonly detail: string };

/**
 * One judge call with the platform's guarantees: a hard deadline, strict
 * validation, and an allow-list of codes from the rubric. Every failure is a
 * value (inconclusive), never an exception and never a finding.
 */
export async function callJudge<T>(judge: SemanticJudge, rubric: Rubric, view: SemanticView, schema: z.ZodType<T>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<JudgeCallResult<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, options.timeoutMs);
  });
  try {
    const request: JudgeRequest = { rubric: { ...rubric, hash: rubricHash(rubric) }, view, outputSchema: z.toJSONSchema(schema) };
    const answer = await Promise.race([judge.judge(request, controller.signal).then((value) => ({ value })), timeout]);
    if (answer === 'timeout') return { ok: false, reason: 'judge_timeout', detail: `no verdict within ${options.timeoutMs}ms` };
    const parsed = schema.safeParse(answer.value);
    if (!parsed.success) return { ok: false, reason: 'judge_invalid_output', detail: z.prettifyError(parsed.error).slice(0, 500) };
    const codes = codesOf(parsed.data);
    const disallowed = codes.filter((c) => !rubric.allowedCodes.includes(c));
    if (disallowed.length > 0) return { ok: false, reason: 'judge_disallowed_code', detail: `codes outside rubric ${rubric.id}@${rubric.version}: ${[...new Set(disallowed)].join(', ')}` };
    return { ok: true, value: parsed.data };
  } catch (error) {
    return { ok: false, reason: 'judge_error', detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

function codesOf(value: unknown): string[] {
  const findings = (value as { findings?: unknown }).findings;
  return Array.isArray(findings) ? findings.map((f) => String((f as { code?: unknown }).code)) : [];
}

/**
 * Deterministic stand-in judge for offline CI and fixtures. Each script entry
 * answers a rubric: a value (returned as the judge's raw answer, valid or
 * not), `{ timeout: true }` (never answers) or `{ throws: message }`.
 */
export type ScriptedAnswer = { readonly answer: unknown } | { readonly timeout: true } | { readonly throws: string };

export class ScriptedJudge implements SemanticJudge {
  readonly profile: ModelProfile;
  readonly requests: JudgeRequest[] = [];
  readonly #script: (request: JudgeRequest) => ScriptedAnswer;

  constructor(script: Readonly<Record<string, ScriptedAnswer | ((request: JudgeRequest) => ScriptedAnswer)>>, profile?: Partial<ModelProfile>) {
    this.#script = (request) => {
      const entry = script[`${request.rubric.id}@${request.rubric.version}`] ?? script[request.rubric.id];
      if (entry === undefined) return { answer: { verdict: 'inconclusive', findings: [] } };
      return typeof entry === 'function' ? entry(request) : entry;
    };
    this.profile = { role: 'evaluator', provider: 'scripted', profile: 'offline', host: null, model: 'scripted-judge', maxOutputTokens: null, contextWindowTokens: null, temperature: null, responseFormat: 'json', extras: {}, ...profile };
  }

  judge(request: JudgeRequest, signal: AbortSignal): Promise<unknown> {
    this.requests.push(request);
    const entry = this.#script(request);
    if ('timeout' in entry) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    if ('throws' in entry) return Promise.reject(new Error(entry.throws));
    return Promise.resolve(structuredClone(entry.answer));
  }
}
