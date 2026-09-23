import { z } from 'zod';
import {
  COMPILED_CONTEXT_SCHEMA_VERSION,
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_SECTIONS,
  EVIDENCE_AUTHORITIES,
  PlatformError,
  SECTION_BY_KIND,
  canonicalJson,
  compiledContextSchema,
  tightenContextBudget,
  contextContributionSchema,
  contextSourceIdSchema,
  fingerprint,
  type CompiledContext,
  type CompiledContextItem,
  type ContextBudgetPolicy,
  type ContextComposition,
  type ContextConflict,
  type ContextExclusionReason,
  type ContextFreshness,
  type ContextItem,
  type ContextItemDecision,
  type ContextItemKind,
  type ContextSection,
} from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { ContextCompactor } from './compactor.js';
import { contextComposition } from './composition.js';
import { classifyFreshness } from './freshness.js';
import {
  CONTEXT_COMPILER_VERSION,
  contextCompilationPolicySchema,
  policyVersionOf,
  type ContextCompilationPolicy,
  type ContextCompilationPolicyInput,
} from './policy.js';
import { Utf8BytesSizer, type ContextSizer } from './sizer.js';
import type { ContextSource, ContextSourceRequest } from './source.js';
import { MEMORY_SOURCE_ID, derivationKeyOf, derivedSummaryContribution, summaryItemId, type NewDerivedSummary } from './summary.js';

export interface ContextCompilerOptions {
  readonly sources: readonly ContextSource[];
  readonly policy: ContextCompilationPolicyInput;
  readonly sizer?: ContextSizer;
  /** Used only under a `fixed` budget. Without one, conversation that does not fit is dropped oldest-first (reason `budget`). */
  readonly compactor?: ContextCompactor | null;
  readonly logger: StructuredLogger;
}

export interface ContextCompileRequest extends ContextSourceRequest {
  /**
   * An optional ceiling that tightens (never widens) the policy budget, e.g. the
   * agent definition's `contextPolicy.maxContextTokens`: unbounded + N → fixed(N),
   * fixed(M) + N → fixed(min(M, N)).
   */
  readonly budgetCeilingTokens?: number;
}

export interface CompiledResult {
  readonly kind: 'compiled';
  readonly compiled: CompiledContext;
  readonly contentHash: string;
  readonly inputFingerprint: string;
  readonly estimatedTokens: number;
  /** The effective budget (policy budget tightened by the request ceiling). */
  readonly budget: ContextBudgetPolicy;
  readonly compilerVersion: string;
  readonly policyVersion: string;
  /** Every evaluated item, compacted ones included. */
  readonly decisions: readonly ContextItemDecision[];
  /** Context accounting, derived from `decisions` (identical to `snapshotComposition` of the stored snapshot). */
  readonly composition: ContextComposition;
  /** Summaries produced by this compilation: persist them atomically with the snapshot. */
  readonly newSummaries: readonly NewDerivedSummary[];
}

/** The items the policy requires do not fit a `fixed` budget: no context can be built. Never happens when unbounded. */
export interface BudgetExhaustedResult {
  readonly kind: 'budget_exhausted';
  readonly requiredTokens: number;
  readonly maxEstimatedTokens: number;
  readonly decisions: readonly ContextItemDecision[];
}

export type CompileOutcome = CompiledResult | BudgetExhaustedResult;

interface Candidate {
  readonly item: ContextItem;
  readonly position: number;
  /** observedAt ?? createdAt, in ms: the item's place in time. */
  readonly time: number;
  freshness: ContextFreshness;
  /** Expired evidence kept only as history. */
  historical: boolean;
  required: boolean;
  tokens: number;
  state: 'pending' | 'included' | 'excluded';
  reason: ContextExclusionReason | null;
  representedBy: string | null;
  section: ContextSection | null;
  includeOrder: number;
  /** Set when this compilation produced the summary. */
  newSummary: NewDerivedSummary | null;
  /** For a summary chosen by compaction: the raw items it represents. */
  covers: Candidate[];
}

/**
 * Context Compiler (R4-C2): builds, for one agent decision, a context that is
 *
 *   minimal      — required items, then policy-ordered kinds, within a token budget
 *   structured   — typed sections of items, never a single prompt string
 *   explicit     — every item carries authority, freshness and provenance
 *   reproducible — same durable state + compiler version + policy + budget
 *                  → same items, same order, same content hash
 *   explainable  — every evaluated item has a recorded decision and reason
 *
 * It never merges disagreeing items (conflicts are exposed, and only a current
 * AUTHORITATIVE item can prevail), never lets a derived item replace an
 * authoritative one, never admits SECRET items, and never uses a model to
 * decide what to include. It does not know storage, providers, transports or
 * domains: data arrives through ContextSources; compaction through the
 * ContextCompactor seam; size through the ContextSizer port.
 *
 * It does not decide what the agent does next, and it writes nothing: summaries
 * it produces are returned for the execution layer to persist.
 */
export class ContextCompiler {
  readonly #sources: readonly ContextSource[];
  readonly #policy: ContextCompilationPolicy;
  readonly #policyVersion: string;
  readonly #sizer: ContextSizer;
  readonly #compactor: ContextCompactor | null;
  readonly #logger: StructuredLogger;

  constructor(options: ContextCompilerOptions) {
    const ids = new Set<string>();
    for (const source of options.sources) {
      if (!contextSourceIdSchema.safeParse(source.id).success) {
        throw new PlatformError('validation', 'invalid_context_source', `context source id "${source.id}" is not a dotted, namespaced name`);
      }
      if (ids.has(source.id)) throw new PlatformError('validation', 'invalid_context_source', `context source "${source.id}" is registered twice`);
      ids.add(source.id);
    }
    const policy = contextCompilationPolicySchema.safeParse(options.policy);
    if (!policy.success) throw new PlatformError('validation', 'invalid_context_policy', z.prettifyError(policy.error));
    this.#sources = [...options.sources];
    this.#policy = policy.data;
    this.#policyVersion = policyVersionOf(policy.data);
    this.#sizer = options.sizer ?? new Utf8BytesSizer();
    this.#compactor = options.compactor ?? null;
    this.#logger = options.logger;
  }

  get policy(): ContextCompilationPolicy {
    return this.#policy;
  }

  get policyVersion(): string {
    return this.#policyVersion;
  }

  async compile(request: ContextCompileRequest): Promise<CompileOutcome> {
    const { scope } = request;
    const telemetry = { taskId: scope.taskId, runId: scope.runId, agentId: scope.agentId, iteration: scope.iteration };
    const budget = tightenContextBudget(this.#policy.budget, request.budgetCeilingTokens);
    // Unbounded: no artificial limit, so every budget comparison below passes.
    const max = budget.mode === 'fixed' ? budget.maxEstimatedTokens : Number.POSITIVE_INFINITY;
    emitTelemetry(this.#logger, 'context.compile.started', {
      ...telemetry,
      sourceCount: this.#sources.length,
      compilerVersion: CONTEXT_COMPILER_VERSION,
      policyVersion: this.#policyVersion,
      budgetMode: budget.mode,
      maxEstimatedTokens: budget.mode === 'fixed' ? budget.maxEstimatedTokens : null,
    });

    const candidates = (await this.#load(request, telemetry)).map((item, position) => candidate(item, position));
    this.#screen(candidates, request);
    // Every evaluated item is sized (as it would be compiled), so accounting can
    // show what was left out, not only what went in. SECRET items stay unsized.
    for (const c of candidates) if (c.item.sensitivity !== 'SECRET') c.tokens = this.#tokensOf(c);

    const frame = this.#frameTokens(request, budget);
    const required = candidates.filter((c) => c.state === 'pending' && c.required);
    const requiredTokens = frame + sum(required);
    if (requiredTokens > max) {
      return this.#exhausted(candidates, requiredTokens, max, required.length, telemetry);
    }

    const selection = { used: frame, order: 0 };
    const include = (c: Candidate) => {
      c.state = 'included';
      c.section = c.historical ? 'history' : SECTION_BY_KIND[c.item.kind];
      c.includeOrder = selection.order++;
      selection.used += c.tokens;
    };
    for (const c of required) include(c);

    // Non-required items, kind by kind in policy order; expired evidence last.
    for (const kind of this.#policy.selectionOrder) {
      const pool = candidates.filter((c) => c.state === 'pending' && !c.historical && c.item.kind === kind);
      if (kind === 'conversation_turn') {
        await this.#selectConversation(pool, candidates, request, budget, max, selection, include, telemetry);
      } else if (kind === 'derived_summary') {
        this.#dropRedundantSummaries(pool, candidates);
        this.#greedy(pool.filter((c) => c.state === 'pending'), kind, max, selection, include);
      } else {
        this.#greedy(pool, kind, max, selection, include);
      }
    }
    const history = candidates.filter((c) => c.state === 'pending' && c.historical);
    this.#greedy(history, null, max, selection, include);
    for (const c of candidates) if (c.state === 'pending') excludeCandidate(c, 'policy');

    // Conflicts are part of the context and of its budget: shed the last-selected
    // optional items until everything fits.
    let conflicts = detectConflicts(candidates);
    let conflictTokens = conflicts.length > 0 ? this.#sizer.estimate(conflicts) : 0;
    while (selection.used + conflictTokens > max) {
      const victim = candidates.filter((c) => c.state === 'included' && !c.required).sort((a, b) => b.includeOrder - a.includeOrder)[0];
      if (!victim) return this.#exhausted(candidates, selection.used + conflictTokens, max, required.length, telemetry);
      excludeCandidate(victim, 'budget');
      selection.used -= victim.tokens;
      for (const covered of victim.covers) excludeCandidate(covered, 'budget');
      conflicts = detectConflicts(candidates);
      conflictTokens = conflicts.length > 0 ? this.#sizer.estimate(conflicts) : 0;
    }
    const estimatedTokens = selection.used + conflictTokens;

    const compiled = this.#assemble(request, candidates, conflicts, budget, estimatedTokens);
    const contentHash = contentHashOf(compiled);
    // What was evaluated (items and their freshness) under which effective
    // policy and budget — independent of the compiler version. Equal
    // fingerprints mean an equivalent compilation (ADR-012, ADR-015).
    const inputFingerprint = fingerprint({
      policyVersion: this.#policyVersion,
      budget,
      items: candidates
        .filter((c) => c.item.sensitivity !== 'SECRET')
        .sort((a, b) => compare(a.item.itemId, b.item.itemId) || compare(a.item.sourceId, b.item.sourceId))
        .map((c) => ({ freshness: c.freshness, item: c.item })),
    });
    const decisions = decisionsOf(candidates);
    this.#report(candidates, conflicts, telemetry);
    return {
      kind: 'compiled',
      compiled,
      contentHash,
      inputFingerprint,
      estimatedTokens,
      budget,
      compilerVersion: CONTEXT_COMPILER_VERSION,
      policyVersion: this.#policyVersion,
      decisions,
      composition: contextComposition({ decisions, estimatedTokens, budget }),
      newSummaries: candidates.filter((c) => c.state === 'included' && c.newSummary).map((c) => c.newSummary!),
    };
  }

  /** Loads every source in registration order; validates and stamps each contribution. */
  async #load(request: ContextSourceRequest, telemetry: Record<string, unknown>): Promise<ContextItem[]> {
    const loaded = await Promise.all(this.#sources.map((source) => source.load(request)));
    const items: ContextItem[] = [];
    this.#sources.forEach((source, index) => {
      const contributions = loaded[index]!;
      for (const contribution of contributions) {
        const parsed = contextContributionSchema.safeParse(contribution);
        if (!parsed.success) {
          // Paths and messages only: never echo the contribution's content.
          throw new PlatformError('internal', 'invalid_context_item', `context source ${source.id} produced an invalid item: ${z.prettifyError(parsed.error)}`);
        }
        items.push({ ...parsed.data, sourceId: source.id });
      }
      emitTelemetry(this.#logger, 'context.source.loaded', { ...telemetry, sourceId: source.id, itemCount: contributions.length });
    });
    return items;
  }

  /**
   * Admission rules, in order: sensitivity → duplicates → scope →
   * supersession (within one source) → freshness/expiry → policy.
   */
  #screen(candidates: Candidate[], request: ContextSourceRequest): void {
    const exclude = excludeCandidate;
    const firstById = new Map<string, Candidate>();
    for (const c of candidates) {
      c.freshness = classifyFreshness(c.item, request.now, this.#policy.staleAfterMs[c.item.kind]);
      if (c.item.sensitivity === 'SECRET') {
        exclude(c, 'sensitivity');
        continue;
      }
      const first = firstById.get(c.item.itemId);
      if (first) {
        if (fingerprint(withoutSource(first.item)) !== fingerprint(withoutSource(c.item))) {
          throw new PlatformError('internal', 'context_item_collision', `item ${c.item.itemId} was contributed twice with different content (${first.item.sourceId}, ${c.item.sourceId})`);
        }
        exclude(c, 'duplicate', first.item.itemId);
        continue;
      }
      firstById.set(c.item.itemId, c);
      if (c.item.taskId !== null && c.item.taskId !== request.scope.taskId) exclude(c, 'not_relevant_to_scope');
    }

    // A source may only supersede its own items: a derived item can never
    // retire an authoritative one by pointing at it.
    const eligible = candidates.filter((c) => c.state === 'pending');
    const byId = new Map(eligible.map((c) => [c.item.itemId, c]));
    const superseded = new Map<Candidate, string>();
    for (const c of eligible) {
      for (const target of c.item.supersedes) {
        const old = byId.get(target);
        if (old && old !== c && old.item.sourceId === c.item.sourceId && !superseded.has(old)) superseded.set(old, c.item.itemId);
      }
    }
    for (const [old, by] of superseded) exclude(old, 'superseded', by);

    for (const c of candidates) {
      if (c.state !== 'pending') continue;
      c.required = c.item.required || this.#policy.requiredKinds.includes(c.item.kind);
      if (!c.required && !this.#policy.selectionOrder.includes(c.item.kind)) {
        exclude(c, 'policy');
        continue;
      }
      if (c.freshness === 'expired') {
        // No longer current truth. Evidence may remain as history; anything else is dropped.
        if (EVIDENCE_AUTHORITIES.includes(c.item.authority) && this.#policy.expiredEvidence === 'include') c.historical = true;
        else exclude(c, 'expired');
      }
    }
  }

  /**
   * Conversation: all of it when it fits; otherwise (with a compactor and a
   * `fixed` budget) the oldest whole chunks are replaced by one DERIVED
   * summary — reused when an identical derivation already exists — plus the
   * most recent raw turns, newest first and without gaps. Unbounded mode
   * never compacts: there is no budget pressure to relieve.
   */
  async #selectConversation(
    pool: Candidate[],
    candidates: Candidate[],
    request: ContextSourceRequest,
    budget: ContextBudgetPolicy,
    max: number,
    selection: { used: number },
    include: (c: Candidate) => void,
    telemetry: Record<string, unknown>,
  ): Promise<void> {
    const turns = [...pool].sort(chronological);
    const limits = this.#policy.kindLimits.conversation_turn ?? {};
    // `added` more tokens on top of what is already selected; `count`/`tokens` = this kind's totals.
    const withinKind = (count: number, tokens: number) => (limits.maxTokens === undefined || tokens <= limits.maxTokens) && (limits.maxItems === undefined || count <= limits.maxItems);
    const fits = (added: number, count: number, tokens: number) => selection.used + added <= max && withinKind(count, tokens);
    const total = sum(turns);
    if (fits(total, turns.length, total)) {
      for (const turn of turns) include(turn);
      return;
    }

    let rest = turns;
    const { recentTurns, compaction } = this.#policy.conversation;
    const prefixLength = turns.length > recentTurns ? Math.floor((turns.length - recentTurns) / compaction.chunkTurns) * compaction.chunkTurns : 0;
    if (this.#compactor && compaction.enabled && budget.mode === 'fixed' && prefixLength > 0) {
      const prefix = turns.slice(0, prefixLength);
      const summary = await this.#summaryFor(prefix, candidates, request, this.#compactor);
      const usable = summary !== null && (summary.state === 'included' || (summary.state === 'pending' && selection.used + summary.tokens <= max));
      if (summary && usable) {
        if (!candidates.includes(summary)) candidates.push(summary);
        if (summary.state === 'pending') include(summary);
        summary.covers = prefix;
        for (const turn of prefix) excludeCandidate(turn, 'compacted', summary.item.itemId);
        rest = turns.slice(prefixLength);
        const derivation = (summary.item.content as { derivation: { derivationKey: string } }).derivation;
        emitTelemetry(this.#logger, 'context.compacted', { ...telemetry, derivationKey: derivation.derivationKey, sourceCount: prefix.length, reused: summary.newSummary === null, estimatedTokens: summary.tokens, compactorId: this.#compactor.id });
      }
    }

    // Recent tail, newest first, contiguous: an older turn never enters without the newer ones.
    let count = 0;
    let tokens = 0;
    let full: ContextExclusionReason | null = null;
    for (const turn of [...rest].reverse()) {
      if (full === null && fits(turn.tokens, count + 1, tokens + turn.tokens)) {
        include(turn);
        count += 1;
        tokens += turn.tokens;
      } else {
        // A per-kind cap is selection policy; only the global budget is `budget`.
        full ??= withinKind(count + 1, tokens + turn.tokens) ? 'budget' : 'policy';
        excludeCandidate(turn, full);
      }
    }
  }

  /**
   * The summary of `prefix`: an existing one with the same derivation (loaded
   * from memory), or a new one from the compactor. Null when an identical
   * summary exists but was excluded (e.g. expired): it is not recomputed.
   */
  async #summaryFor(prefix: Candidate[], candidates: Candidate[], request: ContextSourceRequest, compactor: ContextCompactor): Promise<Candidate | null> {
    const items = prefix.map((c) => c.item);
    const key = derivationKeyOf(compactor, items);
    const existing = candidates.find((c) => c.item.itemId === summaryItemId(key) && c.state !== 'excluded');
    if (existing) return existing;
    if (candidates.some((c) => c.item.itemId === summaryItemId(key))) return null;

    const result = await compactor.compact({ items });
    const newSummary: NewDerivedSummary = {
      taskId: request.scope.taskId,
      occurredAt: items.at(-1)!.observedAt ?? items.at(-1)!.createdAt,
      sensitivity: items.some((i) => i.sensitivity === 'SENSITIVE') ? 'SENSITIVE' : 'NORMAL',
      content: {
        text: result.text,
        assertions: [...result.assertions],
        derivation: {
          derivationKey: key,
          compactorId: compactor.id,
          compactorVersion: compactor.version,
          sourceItemIds: items.map((i) => i.itemId),
          fromObservedAt: items[0]!.observedAt ?? items[0]!.createdAt,
          toObservedAt: items.at(-1)!.observedAt ?? items.at(-1)!.createdAt,
        },
      },
    };
    const parsed = contextContributionSchema.safeParse(derivedSummaryContribution(newSummary));
    if (!parsed.success) throw new PlatformError('internal', 'invalid_context_item', `compactor ${compactor.id} produced an invalid summary: ${z.prettifyError(parsed.error)}`);
    // Exactly what the memory source will yield once the summary is persisted.
    const c = candidate({ ...parsed.data, sourceId: MEMORY_SOURCE_ID }, candidates.length);
    c.freshness = classifyFreshness(c.item, request.now, this.#policy.staleAfterMs.derived_summary);
    c.newSummary = newSummary;
    c.tokens = this.#tokensOf(c);
    return c;
  }

  /** A stored summary whose every source item is already in the context (raw or compacted) adds nothing. */
  #dropRedundantSummaries(pool: Candidate[], candidates: Candidate[]): void {
    const represented = new Map<string, string>();
    for (const c of candidates) {
      if (c.state === 'included') represented.set(c.item.itemId, c.item.itemId);
      else if (c.reason === 'compacted' && c.representedBy) represented.set(c.item.itemId, c.representedBy);
    }
    for (const summary of pool) {
      const sources = summary.item.provenance.derivedFrom;
      if (sources.length > 0 && sources.every((id) => represented.has(id))) {
        const by = new Set(sources.map((id) => represented.get(id)));
        excludeCandidate(summary, 'duplicate', by.size === 1 ? [...by][0]! : null);
      }
    }
  }

  /** Newest first; an item that does not fit is skipped and the next (smaller) one tried. Kind caps exclude as `policy`. */
  #greedy(
    pool: Candidate[],
    kind: ContextItemKind | null,
    max: number,
    selection: { used: number },
    include: (c: Candidate) => void,
  ): void {
    const limits = kind === null ? {} : (this.#policy.kindLimits[kind] ?? {});
    let count = 0;
    let tokens = 0;
    for (const c of [...pool].sort(newestFirst)) {
      const withinKind = (limits.maxItems === undefined || count < limits.maxItems) && (limits.maxTokens === undefined || tokens + c.tokens <= limits.maxTokens);
      if (!withinKind) {
        excludeCandidate(c, 'policy');
        continue;
      }
      if (selection.used + c.tokens > max) {
        excludeCandidate(c, 'budget');
        continue;
      }
      include(c);
      count += 1;
      tokens += c.tokens;
    }
  }

  #exhausted(candidates: Candidate[], requiredTokens: number, max: number, requiredItems: number, telemetry: Record<string, unknown>): BudgetExhaustedResult {
    for (const c of candidates) if (c.state !== 'excluded') excludeCandidate(c, 'budget');
    emitTelemetry(this.#logger, 'context.budget.exhausted', { ...telemetry, requiredTokens, maxEstimatedTokens: max, requiredItems });
    return { kind: 'budget_exhausted', requiredTokens, maxEstimatedTokens: max, decisions: decisionsOf(candidates) };
  }

  #assemble(request: ContextSourceRequest, candidates: Candidate[], conflicts: ContextConflict[], budget: ContextBudgetPolicy, estimatedTokens: number): CompiledContext {
    const sections = Object.fromEntries(CONTEXT_SECTIONS.map((s) => [s, [] as CompiledContextItem[]])) as Record<ContextSection, CompiledContextItem[]>;
    for (const c of candidates.filter((x) => x.state === 'included').sort(chronological)) {
      sections[c.section!].push(compiledItem(c));
    }
    const omissions: Partial<Record<ContextExclusionReason, number>> = {};
    for (const c of candidates) if (c.state === 'excluded') omissions[c.reason!] = (omissions[c.reason!] ?? 0) + 1;
    const parsed = compiledContextSchema.safeParse({
      schemaVersion: COMPILED_CONTEXT_SCHEMA_VERSION,
      compilerVersion: CONTEXT_COMPILER_VERSION,
      policyVersion: this.#policyVersion,
      scope: { ...request.scope },
      asOf: request.now.toISOString(),
      sections,
      conflicts,
      omissions: sortedRecord(omissions),
      budget: { policy: budget, estimatedTokens, sizer: this.#sizer.id },
    });
    if (!parsed.success) {
      // A compiler bug, never a model or source input problem: fail loudly.
      throw new PlatformError('internal', 'invalid_compiled_context', z.prettifyError(parsed.error));
    }
    return parsed.data;
  }

  #tokensOf(c: Candidate): number {
    // +1: the separator between items in a section.
    return this.#sizer.estimate(compiledItem(c)) + 1;
  }

  /** Upper bound of everything that is not an item or a conflict. */
  #frameTokens(request: ContextSourceRequest, budget: ContextBudgetPolicy): number {
    return this.#sizer.estimate({
      schemaVersion: COMPILED_CONTEXT_SCHEMA_VERSION,
      compilerVersion: CONTEXT_COMPILER_VERSION,
      policyVersion: this.#policyVersion,
      scope: { ...request.scope },
      asOf: request.now.toISOString(),
      sections: Object.fromEntries(CONTEXT_SECTIONS.map((s) => [s, []])),
      conflicts: [],
      omissions: Object.fromEntries(CONTEXT_EXCLUSION_REASONS.map((r) => [r, 999_999_999])),
      budget: { policy: budget, estimatedTokens: 999_999_999, sizer: this.#sizer.id },
    });
  }

  /** Aggregated telemetry (bounded volume); per-item detail lives in the snapshot. */
  #report(candidates: Candidate[], conflicts: ContextConflict[], telemetry: Record<string, unknown>): void {
    const groups = new Map<string, { event: 'context.item.included' | 'context.item.excluded'; fields: Record<string, unknown>; count: number; estimatedTokens: number }>();
    for (const c of candidates) {
      const included = c.state === 'included';
      const fields = {
        sourceId: c.item.sourceId,
        itemKind: c.item.kind,
        authority: c.item.authority,
        freshness: c.freshness,
        ...(included ? { section: c.section } : { exclusionReason: c.reason }),
      };
      const key = canonicalJson([included, fields]);
      const group = groups.get(key) ?? { event: included ? 'context.item.included' : 'context.item.excluded', fields, count: 0, estimatedTokens: 0 };
      group.count += 1;
      group.estimatedTokens += c.tokens;
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      emitTelemetry(this.#logger, group.event, { ...telemetry, ...group.fields, count: group.count, estimatedTokens: group.estimatedTokens });
    }
    for (const conflict of conflicts) {
      emitTelemetry(this.#logger, 'context.conflict.detected', {
        ...telemetry,
        subject: conflict.subject,
        positions: conflict.positions.length,
        authorities: [...new Set(conflict.positions.map((p) => p.authority))].sort(),
        resolvedByAuthority: conflict.authoritativeItemId !== null,
      });
    }
  }
}

/** Hash of what the model sees, excluding temporal metadata (`asOf`). */
export function contentHashOf(compiled: CompiledContext): string {
  return fingerprint({ ...compiled, asOf: undefined });
}

/**
 * Disagreements among included items, per subject. Values are compared
 * canonically; the single current AUTHORITATIVE value (if exactly one) is
 * named, and every position is kept — nothing is merged or overwritten.
 */
function detectConflicts(candidates: Candidate[]): ContextConflict[] {
  const bySubject = new Map<string, { itemId: string; authority: ContextItem['authority']; value: ContextItem['assertions'][number]['value']; current: boolean }[]>();
  for (const c of candidates.filter((x) => x.state === 'included').sort((a, b) => compare(a.item.itemId, b.item.itemId))) {
    for (const assertion of c.item.assertions) {
      const positions = bySubject.get(assertion.subject) ?? [];
      positions.push({ itemId: c.item.itemId, authority: c.item.authority, value: assertion.value, current: !c.historical });
      bySubject.set(assertion.subject, positions);
    }
  }
  const conflicts: ContextConflict[] = [];
  for (const [subject, positions] of [...bySubject].sort(([a], [b]) => compare(a, b))) {
    if (new Set(positions.map((p) => canonicalJson(p.value))).size < 2) continue;
    const authoritative = positions.filter((p) => p.authority === 'AUTHORITATIVE' && p.current);
    const authoritativeValues = new Set(authoritative.map((p) => canonicalJson(p.value)));
    conflicts.push({
      subject,
      positions: positions.map(({ itemId, authority, value }) => ({ itemId, authority, value })),
      authoritativeItemId: authoritativeValues.size === 1 ? authoritative[0]!.itemId : null,
    });
  }
  return conflicts;
}

function excludeCandidate(c: Candidate, reason: ContextExclusionReason, representedBy: string | null = null): void {
  c.state = 'excluded';
  c.reason = reason;
  c.representedBy = representedBy;
}

function candidate(item: ContextItem, position: number): Candidate {
  return { item, position, time: Date.parse(item.observedAt ?? item.createdAt), freshness: 'unknown', historical: false, required: false, tokens: 0, state: 'pending', reason: null, representedBy: null, section: null, includeOrder: -1, newSummary: null, covers: [] };
}

function compiledItem(c: Candidate): CompiledContextItem {
  const { item } = c;
  return {
    itemId: item.itemId,
    sourceId: item.sourceId,
    kind: item.kind,
    authority: item.authority,
    freshness: c.freshness,
    sensitivity: item.sensitivity === 'SENSITIVE' ? 'SENSITIVE' : 'NORMAL',
    content: item.content,
    assertions: item.assertions,
    createdAt: item.createdAt,
    observedAt: item.observedAt,
    validUntil: item.validUntil,
    provenance: {
      recordType: item.provenance.recordType,
      recordId: item.provenance.recordId,
      recordVersion: item.provenance.recordVersion,
      producedBy: item.provenance.producedBy,
      derivedFromCount: item.provenance.derivedFrom.length,
    },
  };
}

function decisionsOf(candidates: Candidate[]): ContextItemDecision[] {
  return [...candidates]
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      itemId: c.item.itemId,
      sourceId: c.item.sourceId,
      kind: c.item.kind,
      authority: c.item.authority,
      freshness: c.freshness,
      sensitivity: c.item.sensitivity,
      decision: c.state === 'included' ? 'included' : 'excluded',
      section: c.state === 'included' ? c.section : null,
      reason: c.state === 'included' ? null : (c.reason ?? 'policy'),
      representedBy: c.state === 'included' ? null : c.representedBy,
      estimatedTokens: c.tokens,
    }));
}

function withoutSource(item: ContextItem): Omit<ContextItem, 'sourceId'> {
  const { sourceId: _sourceId, ...rest } = item;
  return rest;
}

function sum(candidates: readonly Candidate[]): number {
  return candidates.reduce((total, c) => total + c.tokens, 0);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function chronological(a: Candidate, b: Candidate): number {
  return a.time - b.time || compare(a.item.itemId, b.item.itemId);
}

function newestFirst(a: Candidate, b: Candidate): number {
  return b.time - a.time || compare(a.item.itemId, b.item.itemId);
}

function sortedRecord<V>(record: Partial<Record<string, V>>): Partial<Record<string, V>> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compare(a, b)));
}
