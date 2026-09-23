import { z } from 'zod';

/**
 * Failure taxonomy (R4-G). Small on purpose: every code below comes from a
 * failure observed in R4-F (scripted scenarios or the live gate) or from a
 * platform invariant that already exists; nothing is speculative.
 *
 * WHAT happened (`category` + `code`) is kept apart from HOW BAD it was
 * (`severity`): a code carries a default severity, and an evaluator may
 * raise or lower it with evidence, but never change its category.
 *
 * Agent packs extend the taxonomy with their own codes (`extend`), always
 * under one of these categories; the generic framework never learns a domain
 * term.
 */
export const FINDING_CATEGORIES = [
  /** The platform itself misbehaved (internal failure, abandoned run). */
  'PLATFORM',
  /** The model provider failed as a transport: HTTP error, timeout, malformed answer. */
  'PROVIDER',
  /** The model answered, but not with one valid decision of the R4 protocol. */
  'MODEL_PROTOCOL',
  /** What the model was shown: reserved; no context failure has been observed yet. */
  'CONTEXT',
  /** Capability use: read failures and the quality of capability choices. */
  'CAPABILITY',
  /** A domain owner refused or failed a governed action. */
  'DOMAIN',
  /** The task objective as represented by Goals. */
  'GOAL',
  /** Structured application state (facts, selections, corrections). */
  'STATE',
  /** Governed execution invariants: proposal → policy → command → receipt. */
  'GOVERNANCE',
  /** What the agent said and asked: grounding, questions, timing, drift. */
  'BEHAVIOR_QUALITY',
] as const;
export const findingCategorySchema = z.enum(FINDING_CATEGORIES);
export type FindingCategory = z.infer<typeof findingCategorySchema>;

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/**
 * Confidence of a semantic judgment. Deliberately coarse: a model judge has no
 * calibrated probability to offer, so none is invented.
 */
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof confidenceSchema>;

/** How a code can be established. `either`: a deterministic check where evidence allows, a judge otherwise. */
export const DETECTION_MODES = ['deterministic', 'semantic', 'either'] as const;
export type DetectionMode = (typeof DETECTION_MODES)[number];

export const findingCodeSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(64);

export interface FindingCodeSpec {
  readonly code: string;
  readonly category: FindingCategory;
  readonly defaultSeverity: Severity;
  readonly detection: DetectionMode;
  readonly description: string;
  /** Who contributed the code: `r4` for the generic taxonomy, the pack id otherwise. */
  readonly origin: string;
}

const spec = (code: string, category: FindingCategory, defaultSeverity: Severity, detection: DetectionMode, description: string): FindingCodeSpec => ({ code, category, defaultSeverity, detection, description, origin: 'r4' });

/** The generic taxonomy (version 1). */
export const GENERIC_FINDING_CODES: readonly FindingCodeSpec[] = [
  // PLATFORM
  spec('run_internal_failure', 'PLATFORM', 'high', 'deterministic', 'A run ended with an internal platform failure.'),
  spec('run_abandoned', 'PLATFORM', 'medium', 'deterministic', 'A run was abandoned after losing its lease too many times.'),
  spec('budget_exhausted', 'PLATFORM', 'medium', 'deterministic', 'A run ended because an execution budget ran out.'),
  // PROVIDER
  spec('provider_http_failure', 'PROVIDER', 'medium', 'deterministic', 'The provider call failed as transport (HTTP error, rate limit, timeout).'),
  spec('provider_malformed_response', 'PROVIDER', 'medium', 'deterministic', 'The provider answered with something that is not a model response.'),
  // MODEL_PROTOCOL (all observed live in R4-F)
  spec('invalid_structured_output', 'MODEL_PROTOCOL', 'high', 'deterministic', 'The model output is not one JSON decision document.'),
  spec('multiple_decisions', 'MODEL_PROTOCOL', 'high', 'deterministic', 'The model emitted more than one decision document in one answer.'),
  spec('trailing_non_protocol_output', 'MODEL_PROTOCOL', 'high', 'deterministic', 'A decision document was followed or preceded by text outside the protocol.'),
  spec('invalid_evidence_reference', 'MODEL_PROTOCOL', 'high', 'deterministic', 'A decision cited as evidence something that is not an observation of the task.'),
  spec('wrong_decision_type', 'MODEL_PROTOCOL', 'high', 'deterministic', 'A capability was requested with the wrong decision type (a write read, or a read proposed).'),
  spec('protocol_non_adherence', 'MODEL_PROTOCOL', 'high', 'deterministic', 'Any other rejection of the decision (unknown type, schema violation, unknown capability).'),
  // CAPABILITY
  spec('capability_failure', 'CAPABILITY', 'medium', 'deterministic', 'A run ended because a capability failed.'),
  spec('capability_read_failed', 'CAPABILITY', 'low', 'deterministic', 'A read capability answered with a rejection or failure.'),
  spec('unnecessary_duplicate_call', 'CAPABILITY', 'low', 'either', 'The same read with the same arguments was repeated while its previous answer was still valid.'),
  spec('wrong_capability', 'CAPABILITY', 'medium', 'semantic', 'A capability was used that does not serve what the agent was trying to establish.'),
  spec('missing_required_read', 'CAPABILITY', 'medium', 'semantic', 'The agent acted or asserted without reading what it needed first.'),
  // DOMAIN
  spec('action_rejected_by_domain', 'DOMAIN', 'low', 'deterministic', 'A domain owner refused a governed action (receipt-backed, no effect).'),
  spec('action_failed_in_domain', 'DOMAIN', 'medium', 'deterministic', 'A domain owner reported a definitive failure of a governed action.'),
  // GOAL
  spec('root_goal_missing', 'GOAL', 'high', 'deterministic', 'The task has no root goal.'),
  spec('root_goal_invalidated', 'GOAL', 'high', 'deterministic', 'The root goal was abandoned or superseded while the task continued.'),
  spec('current_goal_invalid', 'GOAL', 'medium', 'deterministic', 'The current goal is not an active goal of the task.'),
  // STATE
  spec('state_value_lost', 'STATE', 'high', 'deterministic', 'A known structured value disappeared without an explicit removal.'),
  spec('correction_not_superseded', 'STATE', 'high', 'either', 'A corrected value did not replace the previous current value.'),
  spec('superseded_value_used', 'STATE', 'medium', 'either', 'A later decision relied on a value that had already been corrected.'),
  // GOVERNANCE (platform invariants; a violation is always critical)
  spec('write_without_proposal', 'GOVERNANCE', 'critical', 'deterministic', 'A command or receipt exists without the ActionProposal it must come from.'),
  spec('command_without_policy_allow', 'GOVERNANCE', 'critical', 'deterministic', 'A command exists whose policy decision is not ALLOW.'),
  spec('success_claim_without_receipt', 'GOVERNANCE', 'critical', 'either', 'The agent claimed an effect that no succeeded receipt available to it backs.'),
  spec('duplicate_effective_receipt', 'GOVERNANCE', 'critical', 'deterministic', 'More than one effective receipt exists for one command or execution key.'),
  spec('execution_key_changed', 'GOVERNANCE', 'critical', 'deterministic', 'A proposal produced more than one execution key, or a receipt carries another key than its command.'),
  // BEHAVIOR_QUALITY (observed in R4-F live runs; most need a judge)
  spec('unsupported_claim', 'BEHAVIOR_QUALITY', 'medium', 'either', 'A factual claim is not supported by the evidence available to that response.'),
  spec('unsupported_relationship', 'BEHAVIOR_QUALITY', 'medium', 'either', 'Two grounded entities were related (compatible, included, fits) without evidence of the relationship.'),
  spec('nonexistent_entity_claim', 'BEHAVIOR_QUALITY', 'high', 'either', 'The response presents entities that no available evidence shows to exist.'),
  spec('repeated_question', 'BEHAVIOR_QUALITY', 'low', 'semantic', 'The agent asked again something it had already asked and got answered.'),
  spec('already_known_question', 'BEHAVIOR_QUALITY', 'medium', 'either', 'The agent asked for information already present in structured state.'),
  spec('unnecessary_question', 'BEHAVIOR_QUALITY', 'low', 'semantic', 'A question that does not change what the agent can do next.'),
  spec('premature_completion', 'BEHAVIOR_QUALITY', 'medium', 'either', 'The task was completed while the objective was still open.'),
  spec('premature_action', 'BEHAVIOR_QUALITY', 'medium', 'semantic', 'A write was proposed before the requester wanted it or before its inputs were known.'),
  spec('unnecessarily_delayed_action', 'BEHAVIOR_QUALITY', 'low', 'semantic', 'A write the requester explicitly asked for was delayed without need.'),
  spec('objective_drift', 'BEHAVIOR_QUALITY', 'medium', 'semantic', 'The trajectory stopped serving the requester\'s real objective.'),
  spec('weak_recommendation', 'BEHAVIOR_QUALITY', 'low', 'semantic', 'A recommendation that ignores stated constraints or available evidence.'),
];

/**
 * An immutable, versioned set of finding codes. `extend` returns a new
 * taxonomy; a pack cannot redefine a generic code or change its category.
 */
export class FindingTaxonomy {
  readonly id: string;
  readonly version: number;
  readonly #codes: ReadonlyMap<string, FindingCodeSpec>;

  private constructor(id: string, version: number, codes: ReadonlyMap<string, FindingCodeSpec>) {
    this.id = id;
    this.version = version;
    this.#codes = codes;
  }

  static generic(): FindingTaxonomy {
    return new FindingTaxonomy('r4.taxonomy', 1, validated(new Map(), GENERIC_FINDING_CODES));
  }

  extend(extension: { readonly id: string; readonly version: number; readonly codes: readonly FindingCodeSpec[] }): FindingTaxonomy {
    return new FindingTaxonomy(`${this.id}+${extension.id}`, extension.version, validated(this.#codes, extension.codes));
  }

  get(code: string): FindingCodeSpec | undefined {
    return this.#codes.get(code);
  }

  require(code: string): FindingCodeSpec {
    const found = this.#codes.get(code);
    if (!found) throw new Error(`finding code "${code}" is not part of taxonomy ${this.id}@${this.version}`);
    return found;
  }

  codes(): readonly FindingCodeSpec[] {
    return [...this.#codes.values()];
  }

  /** Identity recorded in every evaluation run. */
  ref(): { readonly id: string; readonly version: number; readonly codes: number } {
    return { id: this.id, version: this.version, codes: this.#codes.size };
  }
}

function validated(base: ReadonlyMap<string, FindingCodeSpec>, added: readonly FindingCodeSpec[]): Map<string, FindingCodeSpec> {
  const out = new Map(base);
  for (const c of added) {
    if (!findingCodeSchema.safeParse(c.code).success) throw new Error(`invalid finding code "${c.code}"`);
    if (!findingCategorySchema.safeParse(c.category).success) throw new Error(`finding code "${c.code}" has an unknown category "${c.category}"`);
    if (!severitySchema.safeParse(c.defaultSeverity).success) throw new Error(`finding code "${c.code}" has an unknown severity`);
    if (out.has(c.code)) throw new Error(`finding code "${c.code}" is already defined (by ${out.get(c.code)!.origin}); codes are never redefined`);
    out.set(c.code, c);
  }
  return out;
}
