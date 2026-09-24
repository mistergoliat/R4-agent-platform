import { z } from 'zod';

/**
 * Architecture gap register (R4-H). H exists to discover whether R4 needs
 * something A–G did not design — and must not hide it by adding layers in
 * the same run. So every observation is first CLASSIFIED; only evidence
 * that the current abstraction cannot represent or support a needed generic
 * behavior, seen more than once, may be called an architecture gap
 * candidate. Nothing here resolves anything: it is input to the human,
 * post-H Architecture Gap Review.
 *
 * Two sources feed the register:
 *   - `observed`: deterministic extraction from suite results (recurring
 *     finding codes, provider/domain failures, safety violations) — always
 *     classified conservatively, never as an architecture gap;
 *   - `reviewed`: entries written by a person after reading the evidence;
 *     only these may be `architecture_gap_candidate`.
 */
export const GAP_CLASSIFICATIONS = ['bug', 'quality_issue', 'missing_integration', 'performance_issue', 'architecture_gap_candidate', 'operational_gap'] as const;
export const GAP_LAYERS = ['Context', 'Goal', 'Runtime', 'Governance', 'Domain', 'Provider', 'Evaluation', 'Operations', 'Agent'] as const;

export const architectureGapCandidateSchema = z
  .strictObject({
    id: z.string().regex(/^GAP-H-\d{3}$|^OBS-H-[A-Z0-9-]{3,48}$/),
    origin: z.enum(['observed', 'reviewed']),
    classification: z.enum(GAP_CLASSIFICATIONS),
    observation: z.string().min(1).max(600),
    frequency: z.strictObject({ affected: z.int().nonnegative(), total: z.int().positive(), unit: z.enum(['executions', 'workloads', 'model_calls', 'turns']) }),
    affectedWorkloads: z.array(z.string()).max(100),
    suspectedLayer: z.enum(GAP_LAYERS),
    /** Artifact-relative references (evaluation runs, workload results, finding ids). */
    evidenceRefs: z.array(z.string().min(1).max(300)).min(1).max(50),
    whyCurrentArchitectureIsInsufficient: z.string().max(800).nullable(),
    workaround: z.string().max(500).nullable(),
    productionImpact: z.string().max(500),
    /** Would the behavior likely differ with another model? (null = unknown). */
    modelSpecific: z.boolean().nullable(),
    /** Specific to the agent pack that exposed it, or generic to agents on R4? */
    scope: z.enum(['pack_specific', 'generic', 'unknown']),
    blocksNextPhase: z.boolean(),
  })
  .refine((g) => g.classification !== 'architecture_gap_candidate' || g.origin === 'reviewed', { message: 'only a human-reviewed entry may be an architecture gap candidate', path: ['classification'] })
  .refine((g) => g.classification !== 'architecture_gap_candidate' || g.frequency.affected >= 2, { message: 'a single failure is not an architecture gap (needs repeated evidence)', path: ['frequency'] })
  .refine((g) => g.classification !== 'architecture_gap_candidate' || (g.whyCurrentArchitectureIsInsufficient ?? '').length >= 20, { message: 'an architecture gap candidate must say why the current abstraction is insufficient', path: ['whyCurrentArchitectureIsInsufficient'] });
export type ArchitectureGapCandidate = z.infer<typeof architectureGapCandidateSchema>;
export type ArchitectureGapCandidateInput = z.input<typeof architectureGapCandidateSchema>;

export function parseGapCandidate(value: unknown): ArchitectureGapCandidate {
  const parsed = architectureGapCandidateSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid ArchitectureGapCandidate: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
