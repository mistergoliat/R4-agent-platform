import { z } from 'zod';
import {
  contextAssertionSchema,
  contextItemIdSchema,
  type ContextAuthority,
  type ContextItemKind,
} from './context.js';
import {
  correlationIdSchema,
  principalSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';
import { reasonCodeSchema } from './run.js';

/**
 * Memory (R4-C2): durable, task-scoped records that help an agent continue —
 * never business truth. Four types, each with a fixed context kind and a fixed
 * authority, none of them AUTHORITATIVE:
 *
 *   WORKING          operational notes of the agent (hypothesis, note, open question) → COGNITIVE
 *   CONVERSATIONAL   something said in an interaction                                  → CONVERSATIONAL
 *   EPISODIC         something that happened (a failure, a correction, a resumption)    → OBSERVED
 *   DERIVED_SUMMARY  a summary of other items, with its derivation                      → DERIVED
 *
 * Entries are append-only. Lifecycle is expressed without destroying
 * provenance: a newer entry supersedes an older one (same task, same type),
 * or an entry is expired (validUntil at creation, or expiredAt set once).
 * No reasoning traces: working notes are short, explicit, auditable text.
 *
 * Long-term (beyond one task), organization-wide and semantic/vector memory
 * are deliberately not modelled in R4-C2.
 */
export const MEMORY_TYPES = ['WORKING', 'CONVERSATIONAL', 'EPISODIC', 'DERIVED_SUMMARY'] as const;
export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const MEMORY_ITEM_KIND: Readonly<Record<MemoryType, ContextItemKind>> = Object.freeze({
  WORKING: 'working_note',
  CONVERSATIONAL: 'conversation_turn',
  EPISODIC: 'episode',
  DERIVED_SUMMARY: 'derived_summary',
});

export const MEMORY_AUTHORITY: Readonly<Record<MemoryType, ContextAuthority>> = Object.freeze({
  WORKING: 'COGNITIVE',
  CONVERSATIONAL: 'CONVERSATIONAL',
  EPISODIC: 'OBSERVED',
  DERIVED_SUMMARY: 'DERIVED',
});

/** Memory has no encryption: secrets do not belong in it. */
export const memorySensitivitySchema = z.enum(['NORMAL', 'SENSITIVE']);

const baseShape = {
  entryId: uuidSchema,
  taskId: uuidSchema,
  /** When it happened / was said / was noted. */
  occurredAt: timestampSchema,
  /** When the platform persisted it. */
  recordedAt: timestampSchema,
  validUntil: timestampSchema.nullable().default(null),
  /** Explicit expiry, set at most once after creation. */
  expiredAt: timestampSchema.nullable().default(null),
  /** The older entry (same task and type) this one replaces. */
  supersedesEntryId: uuidSchema.nullable().default(null),
  sensitivity: memorySensitivitySchema.default('NORMAL'),
  /** Who recorded it (platform-resolved, never model-claimed). */
  recordedBy: principalSchema,
  correlationId: correlationIdSchema,
};

export const workingMemoryContentSchema = z.strictObject({
  category: z.enum(['hypothesis', 'note', 'open_question']),
  text: z.string().trim().min(1).max(2000),
});

export const conversationalMemoryContentSchema = z.strictObject({
  actor: z.strictObject({
    role: z.enum(['requester', 'agent', 'participant', 'operator']),
    ref: z.string().min(1).max(256),
  }),
  text: z.string().min(1).max(8000),
  /** Opaque reference to the interaction (thread, session) — no channel is assumed. */
  interactionRef: z.string().min(1).max(256),
  /** Structured claims made in the turn (what was SAID, not what is true). */
  assertions: z.array(contextAssertionSchema).max(50).default([]),
});

export const episodicMemoryContentSchema = z.strictObject({
  event: reasonCodeSchema,
  text: z.string().trim().min(1).max(2000),
  /** Ids of related records (observations, steps, entries). */
  refs: z.array(z.string().min(1).max(256)).max(50).default([]),
});

export const summaryDerivationSchema = z.strictObject({
  /** sha256 over compactor identity + source items: same range, same key. */
  derivationKey: z.string().regex(/^[0-9a-f]{64}$/),
  compactorId: z.string().min(1).max(64),
  compactorVersion: z.string().min(1).max(32),
  /** Every item the summary covers, in order. The items themselves stay durable. */
  sourceItemIds: z.array(contextItemIdSchema).min(1).max(10_000),
  fromObservedAt: timestampSchema,
  toObservedAt: timestampSchema,
});
export type SummaryDerivation = z.infer<typeof summaryDerivationSchema>;

export const derivedSummaryContentSchema = z.strictObject({
  text: z.string().min(1).max(16_000),
  /** Claims carried over from the sources — DERIVED, so never truth. */
  assertions: z.array(contextAssertionSchema).max(100).default([]),
  derivation: summaryDerivationSchema,
});
export type DerivedSummaryContent = z.output<typeof derivedSummaryContentSchema>;

export const memoryEntrySchema = z
  .discriminatedUnion('memoryType', [
    z.strictObject({ ...baseShape, memoryType: z.literal('WORKING'), content: workingMemoryContentSchema }),
    z.strictObject({ ...baseShape, memoryType: z.literal('CONVERSATIONAL'), content: conversationalMemoryContentSchema }),
    z.strictObject({ ...baseShape, memoryType: z.literal('EPISODIC'), content: episodicMemoryContentSchema }),
    z.strictObject({ ...baseShape, memoryType: z.literal('DERIVED_SUMMARY'), content: derivedSummaryContentSchema }),
  ])
  .superRefine((entry, ctx) => {
    if (entry.supersedesEntryId === entry.entryId) {
      ctx.addIssue({ code: 'custom', path: ['supersedesEntryId'], message: 'an entry cannot supersede itself' });
    }
    if (entry.memoryType === 'DERIVED_SUMMARY' && Date.parse(entry.content.derivation.fromObservedAt) > Date.parse(entry.content.derivation.toObservedAt)) {
      ctx.addIssue({ code: 'custom', path: ['content', 'derivation'], message: 'derivation range is inverted' });
    }
  });
export type MemoryEntryInput = z.input<typeof memoryEntrySchema>;
export type MemoryEntry = z.output<typeof memoryEntrySchema>;
