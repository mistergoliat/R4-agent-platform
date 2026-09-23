import type { JsonValue, Observation } from '@r4/contracts';
import type { FindingDraft, SubjectRef } from '../finding.js';
import type { EvaluationContext, Evaluator, EvaluationFragment } from '../evaluator.js';
import { count, rate } from '../metrics.js';
import type { Rubric } from '../rubric.js';
import { callJudge, judgeClaimsSchema, judgeVerdictSchema, type ClaimType, type ExtractedClaim } from '../semantic.js';
import type { EvaluationSubject } from '../subject.js';
import { stableId, type EvaluatorRef } from '../versioning.js';

/**
 * A semantic evaluator that asks a judge one versioned rubric about the
 * privacy projection of a trajectory and turns a valid verdict into
 * findings. It never decides by itself: no answer, a malformed answer, an
 * answer citing things that do not exist, or a self-contradicting answer all
 * make it inconclusive (the agent under test is not failed for it).
 */
export class RubricEvaluator implements Evaluator {
  readonly descriptor;
  readonly #rubric: Rubric;
  readonly #assessesObjective: boolean;

  constructor(options: { ref: EvaluatorRef; rubric: Rubric; description: string; assessesObjective?: boolean }) {
    if (options.rubric.output !== 'verdict') throw new Error(`rubric ${options.rubric.id} is not a verdict rubric`);
    this.#rubric = options.rubric;
    this.#assessesObjective = options.assessesObjective ?? false;
    this.descriptor = { ref: options.ref, kind: 'semantic' as const, description: options.description, emits: [...options.rubric.allowedCodes], rubric: options.rubric };
  }

  async evaluate(subject: Readonly<EvaluationSubject>, context: EvaluationContext): Promise<EvaluationFragment> {
    const inconclusive = (reason: string): EvaluationFragment => ({ findings: [], status: 'inconclusive', reason, ...(this.#assessesObjective ? { outcome: { objective: 'inconclusive' as const } } : {}) });
    if (!context.judge) return inconclusive('no_judge');
    const result = await callJudge(context.judge, this.#rubric, context.view, judgeVerdictSchema, { timeoutMs: context.timeoutMs, signal: context.signal });
    if (!result.ok) return inconclusive(result.reason);
    const verdict = result.value;
    if (verdict.verdict === 'inconclusive') return inconclusive('judge_declared_inconclusive');
    if ((verdict.verdict === 'no_issues') !== (verdict.findings.length === 0)) return inconclusive('judge_inconsistent_verdict');
    if (this.#assessesObjective && verdict.objective === undefined) return inconclusive('judge_missing_objective_assessment');
    const unknown = verdict.findings.flatMap((f) => [f.subjectRef, ...f.evidenceRefs]).filter((r) => !refExists(subject, r));
    if (unknown.length > 0) return inconclusive('judge_unknown_reference');
    const findings: FindingDraft[] = verdict.findings.map((f) => ({
      code: f.code,
      subjectRef: f.subjectRef,
      description: `${this.#rubric.title}: ${f.code.replace(/_/g, ' ')}`,
      evidenceRefs: f.evidenceRefs,
      confidence: f.confidence,
      rationale: f.rationale,
      ...(f.severity ? { severity: f.severity } : {}),
    }));
    return { findings, status: 'completed', ...(this.#assessesObjective && verdict.objective ? { outcome: { objective: verdict.objective } } : {}) };
  }
}

/** Whether a reference names something that exists in the subject. */
export function refExists(subject: Readonly<EvaluationSubject>, ref: { kind: string; id: string }): boolean {
  switch (ref.kind) {
    case 'task':
      return ref.id === subject.task.taskId;
    case 'run':
      return subject.runs.some((r) => r.runId === ref.id);
    case 'step':
      return subject.runs.some((r) => r.steps.some((s) => s.stepId === ref.id));
    case 'response':
      return subject.responses.some((r) => r.responseId === ref.id);
    case 'turn':
      return subject.turns.some((t) => String(t.index) === ref.id);
    case 'observation':
      return subject.observations.some((o) => o.observationId === ref.id);
    case 'proposal':
      return subject.actions.proposals.some((p) => p.proposalId === ref.id);
    case 'receipt':
      return subject.actions.receipts.some((r) => r.receiptId === ref.id);
    case 'goal':
      return subject.goals.some((g) => g.goalId === ref.id);
    case 'domain':
      return true;
    default:
      return false;
  }
}

// --- Grounding -------------------------------------------------------------------

/**
 * How a claim relates to the evidence its response could see:
 *
 *   GROUNDED_FACT            every entity and the stated fact are in that evidence
 *   DERIVED_RECOMMENDATION   an opinion or advice built on grounded entities
 *                            ("more versatile", "suits you") — never a hallucination by itself
 *   UNSUPPORTED_CLAIM        the entities exist in evidence, the stated fact does not
 *   UNSUPPORTED_RELATIONSHIP both sides are grounded, the relation between them is not observed
 *   NONEXISTENT_ENTITY       the response presents something no available evidence shows to exist
 *
 * General knowledge of the judge does not ground anything: an entity that
 * exists in the owner's system but was not observed before the response is
 * not grounded for that response.
 */
export const GROUNDING_CLASSES = ['GROUNDED_FACT', 'DERIVED_RECOMMENDATION', 'UNSUPPORTED_CLAIM', 'UNSUPPORTED_RELATIONSHIP', 'NONEXISTENT_ENTITY'] as const;
export type GroundingClass = (typeof GROUNDING_CLASSES)[number];

export interface ClaimVerification {
  readonly entities: readonly { readonly name: string; readonly grounded: boolean; readonly ref: string | null }[];
  /** Whether the stated fact / relation itself is in the evidence. */
  readonly supported: boolean;
  /** Observation ids that ground the claim (or its entities). */
  readonly evidenceRefs: readonly string[];
}

/** Pack-supplied: checks one claim against the observations available to its response. */
export interface ClaimVerifier {
  verify(claim: ExtractedClaim, evidence: readonly Observation[]): ClaimVerification;
}

export interface ClaimExtractor {
  readonly ref: EvaluatorRef;
  readonly kind: 'deterministic' | 'semantic';
  readonly rubric?: Rubric;
  extract(subject: Readonly<EvaluationSubject>, context: EvaluationContext): Promise<{ ok: true; claims: readonly ExtractedClaim[] } | { ok: false; reason: string }>;
}

const RELATION_TYPES: readonly ClaimType[] = ['relationship', 'compatibility'];

export function classifyClaim(claim: Pick<ExtractedClaim, 'type'>, verification: ClaimVerification): GroundingClass {
  if (verification.entities.some((e) => !e.grounded)) return 'NONEXISTENT_ENTITY';
  if (claim.type === 'recommendation') return 'DERIVED_RECOMMENDATION';
  if (verification.supported) return 'GROUNDED_FACT';
  return RELATION_TYPES.includes(claim.type) ? 'UNSUPPORTED_RELATIONSHIP' : 'UNSUPPORTED_CLAIM';
}

export interface ClassifiedClaim {
  readonly claimId: string;
  readonly responseId: string;
  readonly turnIndex: number | null;
  readonly type: ClaimType;
  readonly text: string;
  readonly entities: readonly { name: string; kind: string; ref: string | null; grounded: boolean }[];
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly supportingEvidenceRefs: readonly string[];
  readonly classification: GroundingClass;
}

/** Judge-based extraction of claims from every response (rubric output `claims`). */
export class JudgeClaimExtractor implements ClaimExtractor {
  readonly kind = 'semantic' as const;
  readonly ref: EvaluatorRef;
  readonly rubric: Rubric;

  constructor(options: { ref: EvaluatorRef; rubric: Rubric }) {
    if (options.rubric.output !== 'claims') throw new Error(`rubric ${options.rubric.id} is not a claims rubric`);
    this.ref = options.ref;
    this.rubric = options.rubric;
  }

  async extract(_subject: Readonly<EvaluationSubject>, context: EvaluationContext) {
    if (!context.judge) return { ok: false as const, reason: 'no_judge' };
    const result = await callJudge(context.judge, this.rubric, context.view, judgeClaimsSchema, { timeoutMs: context.timeoutMs, signal: context.signal });
    return result.ok ? { ok: true as const, claims: result.value.claims } : { ok: false as const, reason: result.reason };
  }
}

/**
 * Grounding: claims (from a judge, or from a deterministic extractor) are
 * verified deterministically against the evidence each response could see.
 * The model may say WHAT was claimed; only the platform's evidence says
 * whether it was grounded.
 */
export class GroundingEvaluator implements Evaluator {
  readonly descriptor;
  readonly #extractor: ClaimExtractor;
  readonly #verifier: ClaimVerifier;
  readonly #nonexistentCode: string;

  constructor(options: { ref: EvaluatorRef; extractor: ClaimExtractor; verifier: ClaimVerifier; nonexistentEntityCode?: string }) {
    this.#extractor = options.extractor;
    this.#verifier = options.verifier;
    this.#nonexistentCode = options.nonexistentEntityCode ?? 'nonexistent_entity_claim';
    this.descriptor = {
      ref: options.ref,
      kind: options.extractor.kind,
      description: `Claim grounding against evidence available per response (extractor ${options.extractor.ref.id}@${options.extractor.ref.version}).`,
      emits: ['unsupported_claim', 'unsupported_relationship', this.#nonexistentCode],
      ...(options.extractor.rubric ? { rubric: options.extractor.rubric } : {}),
    };
  }

  async evaluate(subject: Readonly<EvaluationSubject>, context: EvaluationContext): Promise<EvaluationFragment> {
    const extraction = await this.#extractor.extract(subject, context);
    if (!extraction.ok) return { findings: [], status: 'inconclusive', reason: extraction.reason };
    const responses = new Map(subject.responses.map((r) => [r.responseId, r]));
    if (extraction.claims.some((c) => !responses.has(c.responseId))) return { findings: [], status: 'inconclusive', reason: 'claim_for_unknown_response' };
    const observations = new Map(subject.observations.map((o) => [o.observationId, o]));
    const claims: ClassifiedClaim[] = extraction.claims.map((c) => {
      const response = responses.get(c.responseId)!;
      const evidence = response.evidenceInContext.map((id) => observations.get(id)).filter((o): o is Observation => o !== undefined);
      const verification = this.#verifier.verify(c, evidence);
      return {
        claimId: stableId('clm', { responseId: c.responseId, type: c.type, text: c.text }),
        responseId: c.responseId,
        turnIndex: response.turnIndex,
        type: c.type,
        text: c.text,
        entities: c.entities.map((e, i) => ({ name: e.name, kind: e.kind, ref: verification.entities[i]?.ref ?? e.ref, grounded: verification.entities[i]?.grounded ?? false })),
        attributes: c.attributes,
        supportingEvidenceRefs: [...verification.evidenceRefs],
        classification: classifyClaim(c, verification),
      };
    });
    const semantic = this.#extractor.kind === 'semantic';
    const findings: FindingDraft[] = claims.flatMap((c) => {
      const code = { UNSUPPORTED_CLAIM: 'unsupported_claim', UNSUPPORTED_RELATIONSHIP: 'unsupported_relationship', NONEXISTENT_ENTITY: this.#nonexistentCode }[c.classification as string];
      if (!code) return [];
      const subjectRef: SubjectRef = { kind: 'response', id: c.responseId };
      return [{
        code,
        subjectRef,
        description: `${c.classification.toLowerCase().replace(/_/g, ' ')}: "${c.text.slice(0, 160)}"`,
        evidenceRefs: [{ kind: 'response' as const, id: c.responseId }, { kind: 'claim' as const, id: c.claimId }, ...c.supportingEvidenceRefs.map((id) => ({ kind: 'observation' as const, id }))],
        details: { claimType: c.type, ungroundedEntities: c.entities.filter((e) => !e.grounded).map((e) => e.name) },
        ...(semantic ? { confidence: 'medium' as const, rationale: 'claim extracted by the judge; grounding verified against the evidence available to the response' } : {}),
      }];
    });
    const by = (k: GroundingClass) => claims.filter((c) => c.classification === k).length;
    const factual = claims.length - by('DERIVED_RECOMMENDATION');
    return {
      findings,
      status: 'completed',
      metrics: {
        claims: count(claims.length),
        groundedFacts: count(by('GROUNDED_FACT')),
        derivedRecommendations: count(by('DERIVED_RECOMMENDATION')),
        unsupportedClaims: count(by('UNSUPPORTED_CLAIM')),
        unsupportedRelationships: count(by('UNSUPPORTED_RELATIONSHIP')),
        nonexistentEntityClaims: count(by('NONEXISTENT_ENTITY')),
        groundedness: rate(by('GROUNDED_FACT'), factual, 'ratio', 'grounded facts / factual claims (recommendations excluded)'),
      },
      data: { claims: claims as unknown as JsonValue },
    };
  }
}
