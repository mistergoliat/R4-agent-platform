import { z } from 'zod';
import {
  agentIdSchema,
  correlationIdSchema,
  jsonValueSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Context contracts (R4-C2). What a model sees in one decision is a typed,
 * versioned structure of ContextItems — never one giant prompt string — and
 * every item says what it is, where it came from, how much authority it has
 * and whether it is still current.
 *
 * The central rule: structured authoritative state ≠ observation ≠
 * conversation ≠ derived memory ≠ agent scratch state. Each item carries its
 * authority explicitly, and the contracts below make the dangerous
 * combinations unrepresentable (a summary can never be AUTHORITATIVE, a SECRET
 * can never be part of a compiled context).
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * AUTHORITATIVE  current state read from its owner (task, goal, platform records, domain state)
 * OBSERVED       evidence obtained through a capability or recorded by the platform
 * CONVERSATIONAL something said in an interaction
 * DERIVED        a summary, extraction or interpretation produced from other items
 * COGNITIVE      the agent's own working state
 *
 * Deliberately not a ranking: authority is a semantic class. Only an
 * AUTHORITATIVE item can stand for current truth, and nothing else can
 * replace it.
 */
export const CONTEXT_AUTHORITIES = ['AUTHORITATIVE', 'OBSERVED', 'CONVERSATIONAL', 'DERIVED', 'COGNITIVE'] as const;
export const contextAuthoritySchema = z.enum(CONTEXT_AUTHORITIES);
export type ContextAuthority = z.infer<typeof contextAuthoritySchema>;

/**
 * Freshness of an item as a statement about the present, classified
 * deterministically by the compiler (never by a model) against an injected clock.
 */
export const CONTEXT_FRESHNESS = ['fresh', 'stale', 'expired', 'unknown'] as const;
export const contextFreshnessSchema = z.enum(CONTEXT_FRESHNESS);
export type ContextFreshness = z.infer<typeof contextFreshnessSchema>;

/**
 * NORMAL and SENSITIVE items may reach a model; SECRET items never do and are
 * never persisted inside a compiled context or snapshot.
 */
export const CONTEXT_SENSITIVITIES = ['NORMAL', 'SENSITIVE', 'SECRET'] as const;
export const contextSensitivitySchema = z.enum(CONTEXT_SENSITIVITIES);
export type ContextSensitivity = z.infer<typeof contextSensitivitySchema>;

/**
 * How an item relates to time:
 * - live           the owner's current record, read during this compilation
 * - point_in_time  true (or said, or derived) as of `observedAt`; may age
 */
export const CONTEXT_TEMPORALITIES = ['live', 'point_in_time'] as const;
export const contextTemporalitySchema = z.enum(CONTEXT_TEMPORALITIES);
export type ContextTemporality = z.infer<typeof contextTemporalitySchema>;

/** Generic kinds. Domain state enters as `state`; the Core names no domain concept. */
export const CONTEXT_ITEM_KINDS = [
  'agent_definition',
  'task',
  'execution_constraints',
  'goal',
  'capability',
  'state',
  'observation',
  'conversation_turn',
  'working_note',
  'episode',
  'derived_summary',
] as const;
export const contextItemKindSchema = z.enum(CONTEXT_ITEM_KINDS);
export type ContextItemKind = z.infer<typeof contextItemKindSchema>;

/**
 * The authorities each kind may carry. This is what makes "a summary becomes
 * truth" unrepresentable: `derived_summary` is DERIVED only, memory kinds are
 * never AUTHORITATIVE, and `state` is AUTHORITATIVE only (it must come from
 * the state's owner). A goal is AUTHORITATIVE when the requester set it and
 * COGNITIVE when the agent formed it.
 */
export const AUTHORITIES_BY_KIND: Readonly<Record<ContextItemKind, readonly ContextAuthority[]>> = Object.freeze({
  agent_definition: ['AUTHORITATIVE'],
  task: ['AUTHORITATIVE'],
  execution_constraints: ['AUTHORITATIVE'],
  goal: ['AUTHORITATIVE', 'COGNITIVE'],
  capability: ['AUTHORITATIVE'],
  state: ['AUTHORITATIVE'],
  observation: ['OBSERVED'],
  conversation_turn: ['CONVERSATIONAL'],
  working_note: ['COGNITIVE'],
  episode: ['OBSERVED'],
  derived_summary: ['DERIVED'],
});

/**
 * Authorities whose expired items remain useful as historical evidence
 * ("why did the agent decide X then?") while no longer being current truth.
 */
export const EVIDENCE_AUTHORITIES: readonly ContextAuthority[] = ['AUTHORITATIVE', 'OBSERVED'];

// ---------------------------------------------------------------------------
// ContextItem
// ---------------------------------------------------------------------------

/** `<namespace>:<local ref>`, deterministic (derived from the underlying record), e.g. `observation:<uuid>`. */
export const contextItemIdSchema = z.string().max(256).regex(/^[a-z][a-z0-9_]*:[A-Za-z0-9._:-]{1,200}$/, 'must be "<namespace>:<ref>"');

/** Namespaced source identifier, e.g. `platform.memory`. */
export const contextSourceIdSchema = z.string().max(128).regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, 'must be a dotted, namespaced lowercase name');

/**
 * A fact an item asserts, in a comparable form (`subject` = stable key such as
 * `record:42.status`). Used ONLY to detect disagreement between items
 * deterministically; an assertion is exactly as authoritative as its item.
 */
export const contextAssertionSchema = z.strictObject({
  subject: z.string().max(256).regex(/^[a-z][a-z0-9_]*(?:[.:][A-Za-z0-9_-]+)*$/, 'must be a stable, namespaced key'),
  value: jsonValueSchema,
});
export type ContextAssertion = z.infer<typeof contextAssertionSchema>;

export const contextProvenanceSchema = z.strictObject({
  /** Kind of durable record the item was read from (e.g. `observation`, `memory_entry`, `agent_task`). */
  recordType: z.string().max(64).regex(/^[a-z][a-z0-9_]*$/),
  recordId: z.string().min(1).max(256),
  /** Version of that record when it was read, when the record is versioned. */
  recordVersion: z.string().max(128).nullable().default(null),
  /** The items this one was derived from (summaries). Never empty for a derived item. */
  derivedFrom: z.array(contextItemIdSchema).max(10_000).default([]),
  /** Who produced the content, when not the record owner itself (capability, compactor, recording principal). */
  producedBy: z.string().max(256).nullable().default(null),
});
export type ContextProvenance = z.output<typeof contextProvenanceSchema>;

const MAX_ITEM_CONTENT_BYTES = 256 * 1024;

const itemShape = {
  itemId: contextItemIdSchema,
  kind: contextItemKindSchema,
  authority: contextAuthoritySchema,
  temporality: contextTemporalitySchema,
  content: jsonValueSchema.refine((value) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= MAX_ITEM_CONTENT_BYTES, {
    message: `content must serialize to at most ${MAX_ITEM_CONTENT_BYTES} bytes`,
  }),
  assertions: z.array(contextAssertionSchema).max(100).default([]),
  provenance: contextProvenanceSchema,
  /** When the underlying record was created. Orders items of the same section. */
  createdAt: timestampSchema,
  /** When the content was known to be true (point-in-time items). */
  observedAt: timestampSchema.nullable().default(null),
  /** After this instant (inclusive) the item is no longer current. */
  validUntil: timestampSchema.nullable().default(null),
  sensitivity: contextSensitivitySchema.default('NORMAL'),
  /** Task scope; null = not task-scoped (agent definition, capabilities). Another task's item is never relevant. */
  taskId: uuidSchema.nullable().default(null),
  /** The source requires this item: it is never dropped for budget. */
  required: z.boolean().default(false),
  /** Older items of the SAME source that this one replaces (append + supersede, never overwrite). */
  supersedes: z.array(contextItemIdSchema).max(100).default([]),
};

function checkItem(item: { itemId: string; kind: ContextItemKind; authority: ContextAuthority; temporality: ContextTemporality; observedAt: string | null; supersedes: readonly string[]; provenance: ContextProvenance }, ctx: z.RefinementCtx): void {
  if (!AUTHORITIES_BY_KIND[item.kind].includes(item.authority)) {
    ctx.addIssue({ code: 'custom', path: ['authority'], message: `a ${item.kind} item cannot be ${item.authority} (allowed: ${AUTHORITIES_BY_KIND[item.kind].join(', ')})` });
  }
  if (item.temporality === 'point_in_time' && item.observedAt === null) {
    ctx.addIssue({ code: 'custom', path: ['observedAt'], message: 'a point_in_time item must say when it was observed' });
  }
  if (item.supersedes.includes(item.itemId)) {
    ctx.addIssue({ code: 'custom', path: ['supersedes'], message: 'an item cannot supersede itself' });
  }
  if (item.kind === 'derived_summary' && (item.provenance.derivedFrom.length === 0 || item.provenance.producedBy === null)) {
    ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'a derived item must record what it was derived from and what produced it' });
  }
}

/** What a ContextSource returns. The compiler stamps the source id, so a source cannot speak for another. */
export const contextContributionSchema = z.strictObject(itemShape).superRefine(checkItem);
export type ContextContributionInput = z.input<typeof contextContributionSchema>;
export type ContextContribution = z.output<typeof contextContributionSchema>;

export const contextItemSchema = z.strictObject({ ...itemShape, sourceId: contextSourceIdSchema }).superRefine(checkItem);
export type ContextItem = z.output<typeof contextItemSchema>;

// ---------------------------------------------------------------------------
// CompiledContext — the canonical model input
// ---------------------------------------------------------------------------

export const CONTEXT_SECTIONS = [
  'agent',
  'task',
  'goals',
  'capabilities',
  'authoritativeState',
  'observations',
  'conversation',
  'workingMemory',
  'episodicMemory',
  'derivedMemory',
  /** Expired AUTHORITATIVE/OBSERVED items kept as evidence of the past — never current truth. */
  'history',
] as const;
export const contextSectionSchema = z.enum(CONTEXT_SECTIONS);
export type ContextSection = z.infer<typeof contextSectionSchema>;

/** The (current) section of each kind. Expired evidence goes to `history` instead. */
export const SECTION_BY_KIND: Readonly<Record<ContextItemKind, Exclude<ContextSection, 'history'>>> = Object.freeze({
  agent_definition: 'agent',
  task: 'task',
  execution_constraints: 'task',
  goal: 'goals',
  capability: 'capabilities',
  state: 'authoritativeState',
  observation: 'observations',
  conversation_turn: 'conversation',
  working_note: 'workingMemory',
  episode: 'episodicMemory',
  derived_summary: 'derivedMemory',
});

/**
 * Why an evaluated item did not enter the context.
 * `compacted` = represented by a derived summary (the raw item stays durable).
 */
export const CONTEXT_EXCLUSION_REASONS = [
  'expired',
  'superseded',
  'budget',
  'policy',
  'sensitivity',
  'duplicate',
  'not_relevant_to_scope',
  'compacted',
] as const;
export const contextExclusionReasonSchema = z.enum(CONTEXT_EXCLUSION_REASONS);
export type ContextExclusionReason = z.infer<typeof contextExclusionReasonSchema>;

/** An item as the model sees it. SECRET is not representable. */
export const compiledContextItemSchema = z.strictObject({
  itemId: contextItemIdSchema,
  sourceId: contextSourceIdSchema,
  kind: contextItemKindSchema,
  authority: contextAuthoritySchema,
  freshness: contextFreshnessSchema,
  sensitivity: z.enum(['NORMAL', 'SENSITIVE']),
  content: jsonValueSchema,
  assertions: z.array(contextAssertionSchema),
  createdAt: timestampSchema,
  observedAt: timestampSchema.nullable(),
  validUntil: timestampSchema.nullable(),
  provenance: z.strictObject({
    recordType: z.string(),
    recordId: z.string(),
    recordVersion: z.string().nullable(),
    producedBy: z.string().nullable(),
    /** Size of the derivation (the full list stays in durable storage). */
    derivedFromCount: nonNegativeIntSchema,
  }),
});
export type CompiledContextItem = z.infer<typeof compiledContextItemSchema>;

/**
 * Two or more included items assert different values for one subject. The
 * compiler never merges them and never lets the latest text win: it exposes
 * every position. `authoritativeItemId` is the single current AUTHORITATIVE
 * position when there is one — the only candidate for current truth; the
 * others remain evidence (e.g. a signal that the owner's state may need an
 * update through a governed capability). Null = unresolved.
 */
export const contextConflictSchema = z.strictObject({
  subject: contextAssertionSchema.shape.subject,
  positions: z
    .array(z.strictObject({ itemId: contextItemIdSchema, authority: contextAuthoritySchema, value: jsonValueSchema }))
    .min(2),
  authoritativeItemId: contextItemIdSchema.nullable(),
});
export type ContextConflict = z.infer<typeof contextConflictSchema>;

/**
 * R4's own context budget policy (ADR-015). Budgeting is a mechanism; how much
 * to budget is an empirical decision, so the early-stage default is
 * `unbounded`: R4 imposes no artificial token limit of its own (it does NOT
 * mean infinite context — a model's physical envelope will be applied
 * separately, as min(envelope, R4 budget)). `fixed` caps the compiled context
 * at `maxEstimatedTokens` (sizer estimate) and enables budget-driven
 * selection and compaction.
 */
export const contextBudgetPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('unbounded') }),
  z.strictObject({ mode: z.literal('fixed'), maxEstimatedTokens: positiveIntSchema }),
]);
export type ContextBudgetPolicy = z.infer<typeof contextBudgetPolicySchema>;
export const UNBOUNDED_CONTEXT_BUDGET: ContextBudgetPolicy = Object.freeze({ mode: 'unbounded' });

/** The effective budget after an optional ceiling (e.g. the agent's own): it can only tighten. */
export function tightenContextBudget(policy: ContextBudgetPolicy, ceiling: number | undefined): ContextBudgetPolicy {
  if (ceiling === undefined) return policy;
  return { mode: 'fixed', maxEstimatedTokens: policy.mode === 'fixed' ? Math.min(policy.maxEstimatedTokens, ceiling) : ceiling };
}

const sectionArray = z.array(compiledContextItemSchema);

export const COMPILED_CONTEXT_SCHEMA_VERSION = 1;

export const compiledContextSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPILED_CONTEXT_SCHEMA_VERSION),
    compilerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Fingerprint of the effective compilation policy. */
    policyVersion: z.string().regex(/^[0-9a-f]{64}$/),
    scope: z.strictObject({
      taskId: uuidSchema,
      runId: uuidSchema,
      agentId: agentIdSchema,
      agentVersion: positiveIntSchema,
      iteration: positiveIntSchema,
    }),
    /** Instant freshness was judged at. Temporal metadata: excluded from the content hash. */
    asOf: timestampSchema,
    sections: z.strictObject({
      agent: sectionArray,
      task: sectionArray,
      goals: sectionArray,
      capabilities: sectionArray,
      authoritativeState: sectionArray,
      observations: sectionArray,
      conversation: sectionArray,
      workingMemory: sectionArray,
      episodicMemory: sectionArray,
      derivedMemory: sectionArray,
      history: sectionArray,
    }),
    conflicts: z.array(contextConflictSchema),
    /** How many evaluated items were left out, by reason (details live in the snapshot). */
    omissions: z.partialRecord(contextExclusionReasonSchema, positiveIntSchema),
    budget: z.strictObject({
      /** The effective budget this context was compiled under. */
      policy: contextBudgetPolicySchema,
      estimatedTokens: nonNegativeIntSchema,
      sizer: z.string().min(1).max(64),
    }),
  })
  .superRefine((context, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const seen = new Set<string>();
    for (const section of CONTEXT_SECTIONS) {
      context.sections[section].forEach((item, index) => {
        const path = ['sections', section, index];
        if (seen.has(item.itemId)) issue(path, `item ${item.itemId} appears more than once`);
        seen.add(item.itemId);
        if (!AUTHORITIES_BY_KIND[item.kind].includes(item.authority)) issue(path, `a ${item.kind} item cannot be ${item.authority}`);
        if (section === 'history') {
          if (item.freshness !== 'expired' || !EVIDENCE_AUTHORITIES.includes(item.authority)) {
            issue(path, 'history holds only expired AUTHORITATIVE/OBSERVED evidence');
          }
        } else {
          if (SECTION_BY_KIND[item.kind] !== section) issue(path, `a ${item.kind} item belongs in ${SECTION_BY_KIND[item.kind]}`);
          if (item.freshness === 'expired') issue(path, 'an expired item can never be presented as current');
        }
      });
    }
    for (const [index, conflict] of context.conflicts.entries()) {
      for (const position of conflict.positions) {
        if (!seen.has(position.itemId)) issue(['conflicts', index], `conflict references ${position.itemId}, which is not in the context`);
      }
      const prevailing = conflict.positions.find((p) => p.itemId === conflict.authoritativeItemId);
      if (conflict.authoritativeItemId !== null && prevailing?.authority !== 'AUTHORITATIVE') {
        issue(['conflicts', index, 'authoritativeItemId'], 'only an AUTHORITATIVE position can prevail');
      }
    }
    const { policy, estimatedTokens } = context.budget;
    if (policy.mode === 'fixed' && estimatedTokens > policy.maxEstimatedTokens) {
      issue(['budget'], 'estimated tokens exceed the budget');
    }
  });
export type CompiledContext = z.infer<typeof compiledContextSchema>;

// ---------------------------------------------------------------------------
// ContextSnapshot — the durable, immutable record of one model input
// ---------------------------------------------------------------------------

/** One evaluated item and what the compiler did with it. Never carries content. */
export const contextItemDecisionSchema = z
  .strictObject({
    itemId: contextItemIdSchema,
    sourceId: contextSourceIdSchema,
    kind: contextItemKindSchema,
    authority: contextAuthoritySchema,
    freshness: contextFreshnessSchema,
    sensitivity: contextSensitivitySchema,
    decision: z.enum(['included', 'excluded']),
    section: contextSectionSchema.nullable(),
    reason: contextExclusionReasonSchema.nullable(),
    /** For duplicate / superseded / compacted: the item that represents this one. */
    representedBy: contextItemIdSchema.nullable(),
    estimatedTokens: nonNegativeIntSchema,
  })
  .refine((d) => (d.decision === 'included') === (d.section !== null) && (d.decision === 'included') === (d.reason === null), {
    message: 'included items have a section and no reason; excluded items the reverse',
  });
export type ContextItemDecision = z.infer<typeof contextItemDecisionSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Persisted BEFORE the model call it feeds, immutable afterwards. `attempt`
 * numbers the snapshots of one (run, iteration): a recovered iteration reuses
 * its snapshot unless its inputs or its effective policy changed, in which
 * case a new attempt supersedes the previous one (see ADR-012).
 */
export const contextSnapshotSchema = z
  .strictObject({
  snapshotId: uuidSchema,
  runId: uuidSchema,
  taskId: uuidSchema,
  iteration: positiveIntSchema,
  attempt: positiveIntSchema,
  agentId: agentIdSchema,
  agentVersion: positiveIntSchema,
  compilerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  policyVersion: sha256Schema,
  compiledContext: compiledContextSchema,
  /** Hash of the compiled context without temporal metadata (`asOf`). */
  contentHash: sha256Schema,
  /**
   * Hash of the evaluated inputs (items + freshness) and of the effective
   * policy (incl. budget): equal fingerprint = equivalent compilation → reuse.
   */
  inputFingerprint: sha256Schema,
  estimatedTokens: nonNegativeIntSchema,
  /** The effective budget (after the agent's ceiling). */
  budget: contextBudgetPolicySchema,
  /** Every evaluated item, compacted ones included: the source of context accounting. */
  decisions: z.array(contextItemDecisionSchema),
  supersedesSnapshotId: uuidSchema.nullable(),
  correlationId: correlationIdSchema,
  createdAt: timestampSchema,
})
  .refine((s) => s.budget.mode === 'unbounded' || s.estimatedTokens <= s.budget.maxEstimatedTokens, {
    message: 'estimated tokens exceed the budget',
    path: ['estimatedTokens'],
  });
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

// ---------------------------------------------------------------------------
// ContextComposition — context accounting (ADR-015)
// ---------------------------------------------------------------------------

const tallySchema = z.strictObject({ count: nonNegativeIntSchema, estimatedTokens: nonNegativeIntSchema });
const inclusionTallySchema = z.strictObject({ included: tallySchema, excluded: tallySchema });

/**
 * How much of what a context was made of. NOT persisted: it is a
 * deterministic projection of a snapshot's item decisions
 * (`context_snapshot_items`) plus its estimated size and budget, so it can be
 * recomputed — and re-aggregated in SQL — from durable data at any time.
 *
 * Identities (exact, in sizer units):
 *   rawEstimatedTokens      = includedEstimatedTokens + excludedEstimatedTokens
 *   compiledEstimatedTokens = includedEstimatedTokens + overheadEstimatedTokens
 * where overhead = document frame + conflicts. SECRET items are counted but
 * never sized (0 tokens): not even their length is recorded.
 */
export const contextCompositionSchema = z.strictObject({
  budget: contextBudgetPolicySchema,
  rawEstimatedTokens: nonNegativeIntSchema,
  compiledEstimatedTokens: nonNegativeIntSchema,
  includedEstimatedTokens: nonNegativeIntSchema,
  excludedEstimatedTokens: nonNegativeIntSchema,
  overheadEstimatedTokens: nonNegativeIntSchema,
  includedCount: nonNegativeIntSchema,
  excludedCount: nonNegativeIntSchema,
  compactedCount: nonNegativeIntSchema,
  byKind: z.partialRecord(contextItemKindSchema, inclusionTallySchema),
  byAuthority: z.partialRecord(contextAuthoritySchema, inclusionTallySchema),
  bySource: z.record(contextSourceIdSchema, inclusionTallySchema),
  /** Included items by section: `history` is expired evidence. */
  bySection: z.partialRecord(contextSectionSchema, tallySchema),
  byExclusionReason: z.partialRecord(contextExclusionReasonSchema, tallySchema),
  /** Null when nothing was compacted. ratio = output / input. */
  compaction: z
    .strictObject({
      summaryCount: positiveIntSchema,
      compactedItemCount: positiveIntSchema,
      inputEstimatedTokens: nonNegativeIntSchema,
      outputEstimatedTokens: nonNegativeIntSchema,
      ratio: z.number().nonnegative(),
    })
    .nullable(),
});
export type ContextComposition = z.infer<typeof contextCompositionSchema>;
