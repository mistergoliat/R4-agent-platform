import { z } from 'zod';
import type { JsonValue } from '@r4/contracts';
import { confidenceSchema, findingCategorySchema, findingCodeSchema, severitySchema, type Confidence, type FindingTaxonomy, type Severity } from './taxonomy.js';
import { evaluatorRefSchema, rubricRefSchema, stableId, type EvaluatorRef, type RubricRef } from './versioning.js';

/** What a finding is about. */
export const SUBJECT_REF_KINDS = ['task', 'run', 'step', 'turn', 'response', 'claim', 'proposal', 'execution', 'receipt', 'goal', 'observation', 'domain', 'model_call'] as const;
export const subjectRefSchema = z.strictObject({ kind: z.enum(SUBJECT_REF_KINDS), id: z.string().min(1).max(256) });
export type SubjectRef = z.infer<typeof subjectRefSchema>;

/** Durable records a finding rests on (ids only; never copies of content). */
export const EVIDENCE_REF_KINDS = ['observation', 'receipt', 'proposal', 'policy_decision', 'execution', 'step', 'response', 'turn', 'goal', 'goal_transition', 'snapshot', 'domain', 'claim', 'model_call', 'run'] as const;
export const evidenceRefSchema = z.strictObject({ kind: z.enum(EVIDENCE_REF_KINDS), id: z.string().min(1).max(256) });
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

const MAX_DETAILS_BYTES = 4 * 1024;

/** Small structured facts about a finding (counts, codes, ids). Never prose reasoning. */
export const findingDetailsSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.json())
  .refine((d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= MAX_DETAILS_BYTES, { message: `details must serialize to at most ${MAX_DETAILS_BYTES} bytes` });

/**
 * Finding: one structured statement that something in a trajectory is wrong
 * (or noteworthy), with the evidence it rests on. It never carries the
 * evaluator's reasoning: `description` states what was found, and a semantic
 * finding may add a short evaluative `rationale` (bounded), nothing more.
 *
 * `source` separates what R4 can prove (`deterministic`) from what a judge
 * believes (`semantic`, always with a confidence and a versioned rubric).
 */
export const findingSchema = z
  .strictObject({
    findingId: z.string().regex(/^fnd_[0-9a-f]{24}$/),
    category: findingCategorySchema,
    code: findingCodeSchema,
    severity: severitySchema,
    source: z.enum(['deterministic', 'semantic']),
    subjectRef: subjectRefSchema,
    description: z.string().trim().min(1).max(500),
    rationale: z.string().trim().min(1).max(280).nullable(),
    evidenceRefs: z.array(evidenceRefSchema).max(50),
    confidence: confidenceSchema.nullable(),
    evaluator: evaluatorRefSchema,
    rubric: rubricRefSchema.nullable(),
    details: findingDetailsSchema.nullable(),
    /** Other evaluators that reported the same finding (dedupe keeps one). */
    alsoReportedBy: z.array(evaluatorRefSchema).max(20),
  })
  .refine((f) => (f.source === 'semantic') === (f.confidence !== null), { message: 'confidence is present exactly for semantic findings', path: ['confidence'] })
  .refine((f) => (f.source === 'semantic') === (f.rubric !== null), { message: 'a semantic finding names its rubric; a deterministic one has none', path: ['rubric'] })
  .refine((f) => f.source === 'semantic' || f.rationale === null, { message: 'only semantic findings carry a rationale', path: ['rationale'] });
export type Finding = z.infer<typeof findingSchema>;

/** What an evaluator emits. The category always comes from the taxonomy, never from the evaluator. */
export interface FindingDraft {
  readonly code: string;
  readonly subjectRef: SubjectRef;
  readonly description: string;
  readonly severity?: Severity;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly details?: Readonly<Record<string, JsonValue>>;
  /** Semantic findings only. */
  readonly confidence?: Confidence;
  readonly rationale?: string;
}

export function finalizeFinding(draft: FindingDraft, context: { taxonomy: FindingTaxonomy; evaluator: EvaluatorRef; source: 'deterministic' | 'semantic'; rubric: RubricRef | null }): Finding {
  const spec = context.taxonomy.require(draft.code);
  const evidenceRefs = sortRefs(draft.evidenceRefs ?? []);
  return findingSchema.parse({
    findingId: stableId('fnd', { evaluator: context.evaluator, code: draft.code, subjectRef: draft.subjectRef, evidenceRefs }),
    category: spec.category,
    code: draft.code,
    severity: draft.severity ?? spec.defaultSeverity,
    source: context.source,
    subjectRef: draft.subjectRef,
    description: draft.description,
    rationale: context.source === 'semantic' ? (draft.rationale ?? null) : null,
    evidenceRefs,
    confidence: context.source === 'semantic' ? (draft.confidence ?? 'low') : null,
    evaluator: context.evaluator,
    rubric: context.rubric,
    details: draft.details ?? null,
    alsoReportedBy: [],
  });
}

/**
 * The identity of "the same problem" across evaluators: code + subject +
 * evidence. Deliberately simple (no clustering): two evaluators that report
 * the same code about the same thing on the same evidence produce one finding.
 */
export function dedupeKey(f: Pick<Finding, 'code' | 'subjectRef' | 'evidenceRefs'>): string {
  return `${f.code}|${f.subjectRef.kind}:${f.subjectRef.id}|${sortRefs(f.evidenceRefs).map((r) => `${r.kind}:${r.id}`).join(',')}`;
}

export interface SuppressedFinding {
  readonly finding: Finding;
  readonly reason: 'duplicate' | 'deterministic_authority';
  readonly keptFindingId: string | null;
}

/**
 * Merges findings, deterministic first. A later duplicate is folded into the
 * first (`alsoReportedBy`). A semantic finding about a code some deterministic
 * evaluator is authoritative for is dropped: a judge never overrides what R4
 * can prove (e.g. whether a receipt exists).
 */
export function mergeFindings(findings: readonly Finding[], deterministicAuthority: ReadonlySet<string>): { findings: Finding[]; suppressed: SuppressedFinding[] } {
  const ordered = [...findings].sort((a, b) => (a.source === b.source ? 0 : a.source === 'deterministic' ? -1 : 1));
  const kept = new Map<string, Finding>();
  const suppressed: SuppressedFinding[] = [];
  for (const f of ordered) {
    if (f.source === 'semantic' && deterministicAuthority.has(f.code)) {
      suppressed.push({ finding: f, reason: 'deterministic_authority', keptFindingId: null });
      continue;
    }
    // Same code about the same subject already proven deterministically: the judge only confirms it.
    const key = f.source === 'semantic' ? (findDeterministic(kept, f) ?? dedupeKey(f)) : dedupeKey(f);
    const existing = kept.get(key);
    if (existing) {
      kept.set(key, { ...existing, alsoReportedBy: [...existing.alsoReportedBy, f.evaluator] });
      suppressed.push({ finding: f, reason: 'duplicate', keptFindingId: existing.findingId });
    } else kept.set(key, f);
  }
  return { findings: [...kept.values()].sort(compareFindings), suppressed };
}

function findDeterministic(kept: ReadonlyMap<string, Finding>, f: Finding): string | undefined {
  for (const [key, k] of kept) if (k.source === 'deterministic' && k.code === f.code && k.subjectRef.kind === f.subjectRef.kind && k.subjectRef.id === f.subjectRef.id) return key;
  return undefined;
}

function sortRefs<T extends { kind: string; id: string }>(refs: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...refs]
    .filter((r) => (seen.has(`${r.kind}:${r.id}`) ? false : (seen.add(`${r.kind}:${r.id}`), true)))
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1));
}

/** Stable order for serialization: category, code, subject, id. */
export function compareFindings(a: Finding, b: Finding): number {
  const ka = `${a.category}|${a.code}|${a.subjectRef.kind}:${a.subjectRef.id}|${a.findingId}`;
  const kb = `${b.category}|${b.code}|${b.subjectRef.kind}:${b.subjectRef.id}|${b.findingId}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
