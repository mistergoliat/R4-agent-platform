import { z } from 'zod';
import {
  CATALOG_DISCOVER_VERIFIED_REVISIONS,
  CATALOG_DISCOVER_MAX_KEYS,
  CATALOG_DISCOVER_MAX_LIMIT,
  CATALOG_DISCOVER_MAX_NEED_CHARS,
  CATALOG_SELLABILITY,
  CatalogDiscoverError,
  type CatalogDiscoverAnswer,
  type CatalogDiscoverCandidate,
  type CatalogDiscoverConstraints,
  type CatalogDiscoverPort,
} from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { NON_PRODUCTION_CAPABILITY_IDS, SCOPES } from '../ids.js';
import type { FactValue, Workspace } from '../workspace/model.js';
import { CATALOG_FRESHNESS_TTL_MS, catalogKeySchema } from './catalog.js';
import { domainRead, readDefinition } from './common.js';
import { readAnswer, readCandidate, type DiscoverAnswerReading, type DiscoverCandidateReading } from './discover-reading.js';

/**
 * catalog.discover (R4-DISCOVER-I1): conceptual product discovery, OWNED by
 * catalog-service. Model-visible, READ-only, non-production (registered only
 * when a Discover binding is composed; no production profile lists it).
 *
 * R4's part is deliberately thin:
 *   - a bounded, structured request built from the model's arguments (the
 *     consolidated need, never the conversation; no customer identity field);
 *   - two pre-send guards that keep data out of the request (transcripts,
 *     detectable customer data) — the owner stays the authority and rejects
 *     the same things itself;
 *   - one coherence rule with the Sales workspace, the conversation's existing
 *     durable state: a budget constraint must be the customer's CURRENT
 *     recorded budget (so a replaced or retracted budget can never be sent);
 *   - a view of the owner's answer plus R4's consumption reading (what it
 *     permits to claim). Nothing interprets the need, verifies a constraint,
 *     ranks, prices or picks a variant.
 */

export const DISCOVER_TIMEOUT_MS = 6_000;

const NEED_MAX = 200;
const CONTEXT_MAX = 80;

export const catalogDiscoverInput = z
  .strictObject({
    need: z.string().trim().min(2).max(NEED_MAX).describe('The product need, consolidated from the conversation in a few words (product and/or training goal, e.g. "máquina para entrenar espalda"). Never the conversation, never names, contact data or addresses. Leave prices out: a budget goes in constraints.maxUnitPriceClp.'),
    useContext: z.string().trim().min(2).max(CONTEXT_MAX).optional().describe('Where or how it will be used (e.g. "poco espacio", "departamento"), when the customer said so.'),
    constraints: z
      .strictObject({
        maxUnitPriceClp: z.int().min(1).max(100_000_000).optional().describe('Unit price ceiling in CLP, tax included. Must equal the customer\'s current budget recorded in the Sales workspace (record or correct it there first).'),
        sellableOnly: z.boolean().optional(),
        minUserCapacityKg: z.number().min(1).max(2_000).optional(),
        minLoadKg: z.number().min(1).max(5_000).optional(),
        maxLengthCm: z.number().min(1).max(2_000).optional(),
        maxWidthCm: z.number().min(1).max(2_000).optional(),
        maxHeightCm: z.number().min(1).max(2_000).optional(),
      })
      .optional(),
    referenceProductKeys: z.array(catalogKeySchema).max(CATALOG_DISCOVER_MAX_KEYS).optional().describe('productKeys of products the customer refers to (resolved exactly).'),
    selectedItemKeys: z.array(catalogKeySchema).max(CATALOG_DISCOVER_MAX_KEYS).optional().describe('itemKeys of the variants the customer chose.'),
    limit: z.int().min(1).max(CATALOG_DISCOVER_MAX_LIMIT).default(5),
  })
  .refine((input) => `${input.need}${input.useContext ? ` ${input.useContext}` : ''}`.length <= CATALOG_DISCOVER_MAX_NEED_CHARS, { message: `need and useContext together must fit ${CATALOG_DISCOVER_MAX_NEED_CHARS} characters`, path: ['need'] });
export type CatalogDiscoverInput = z.infer<typeof catalogDiscoverInput>;

// ---- model-visible output -------------------------------------------------------------------

const sellability = z.enum(CATALOG_SELLABILITY);
const claims = z.array(z.string());
const commercialView = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('OBSERVED'),
    asOf: z.string(),
    validUntil: z.string().nullable(),
    price: z.strictObject({ finalGrossClp: z.int().nullable(), kind: z.enum(['exact', 'from']).nullable(), basis: z.enum(['offerable', 'not_offerable']).nullable() }),
    sellability,
    orderable: z.boolean(),
    unit: z.strictObject({ itemKey: z.string(), finalGrossClp: z.int().nullable(), sellability, reason: z.string(), availableQuantity: z.int().nullable(), orderable: z.boolean(), validUntil: z.string().nullable() }).nullable(),
  }),
  z.strictObject({ status: z.literal('EXPIRED'), asOf: z.string(), validUntil: z.string() }),
  z.strictObject({ status: z.literal('UNKNOWN'), reason: z.string() }),
]);

const candidateView = z.strictObject({
  productKey: z.string(),
  itemKey: z.string().nullable(),
  name: z.string(),
  disposition: z.enum(['VERIFIED_MATCH', 'POSSIBLE_MATCH', 'REJECTED']),
  unresolved: z.array(z.string()),
  readings: z.array(z.string()),
  commercial: commercialView,
  reading: z.strictObject({
    presentation: z.enum(['PURCHASABLE', 'WITH_COMMERCIAL_CAVEAT', 'POSSIBILITY_WITH_CAVEATS']),
    unitBasis: z.enum(['SELECTED', 'ONLY_UNIT', 'WITNESS', 'UNDETERMINED']),
    commercial: z.enum(['CURRENT', 'EXPIRED', 'UNKNOWN']),
    requirementsSource: z.enum(['OWNER', 'DERIVED_FROM_DISPOSITION']),
    requirements: z.array(z.strictObject({ code: z.string(), state: z.enum(['SATISFIED', 'UNKNOWN', 'UNSUPPORTED', 'VIOLATED', 'NOT_EVALUATED']), authority: z.string().nullable() })),
    allowedClaims: claims,
    forbiddenClaims: claims,
    next: z.array(z.strictObject({ action: z.enum(['SELECT_ITEM', 'FRESH_COMMERCIAL_LOOKUP', 'CONFIRM_ITEM', 'INSPECT_PRODUCT']), capability: z.string(), key: z.string() })),
  }),
});

export const catalogDiscoverOutput = z.strictObject({
  /** What was sent to the owner (evidence says what it answers). */
  request: z.strictObject({
    need: z.string(),
    constraints: z.record(z.string(), z.union([z.number(), z.boolean()])),
    referenceProductKeys: z.array(z.string()),
    selectedItemKeys: z.array(z.string()),
    limit: z.int(),
    budgetFromWorkspace: z.string().nullable(),
    unappliedWorkspaceBudgets: z.array(z.strictObject({ key: z.string(), amountClp: z.int() })),
  }),
  /** Always a revision R4 verified: the adapter refuses any other label before this view exists. */
  contract: z.strictObject({ schemaVersion: z.literal(1), contractVersion: z.enum(CATALOG_DISCOVER_VERIFIED_REVISIONS) }),
  requestId: z.string(),
  status: z.enum(['COMPLETE', 'PARTIAL', 'DEGRADED']),
  interpretation: z.strictObject({
    required: z.array(z.string()),
    preferred: z.array(z.string()),
    notVerifiable: z.array(z.string()),
    unrecognized: z.array(z.string()),
    structuredApplied: z.array(z.string()),
    ambiguities: z.array(z.strictObject({ groupId: z.string(), text: z.string(), readings: z.array(z.strictObject({ readingId: z.string(), label: z.string(), required: z.array(z.string()), candidates: z.array(z.string()) })) })),
    referenceKeysNotFound: z.array(z.string()),
    selection: z.strictObject({ itemKeys: z.array(z.string()), notFound: z.array(z.string()), unverified: z.array(z.string()) }),
  }),
  candidates: z.array(candidateView),
  completeness: z.strictObject({
    retrieval: z.enum(['COMPLETE', 'TRUNCATED']),
    commercial: z.enum(['NOT_REQUIRED', 'COMPLETE', 'SUFFICIENT', 'INCOMPLETE', 'UNAVAILABLE']),
    exhaustive: z.boolean(),
    moreVerifiedAvailable: z.boolean(),
    pendingHydration: z.int().nonnegative(),
  }),
  absence: z.strictObject({ reason: z.string(), contributing: z.array(z.string()) }).nullable(),
  degradation: z.array(z.strictObject({ component: z.string(), cause: z.string(), retryable: z.boolean() })),
  /** The owner's commercial window for this answer (earliest validUntil over what it observed). */
  freshness: z.strictObject({ status: z.string(), asOf: z.string().nullable(), validUntil: z.string().nullable() }),
  reading: z.strictObject({
    labels: z.array(z.string()),
    canAssertCompleteList: z.boolean(),
    canAssertNoneExist: z.boolean(),
    answerAllowed: claims,
    answerForbidden: claims,
    askCustomer: z.strictObject({ needed: z.boolean(), reasons: z.array(z.string()) }),
    retryable: z.boolean(),
  }),
  warnings: z.array(z.string()),
});
export type CatalogDiscoverView = z.infer<typeof catalogDiscoverOutput>;

// ---- pre-send guards (keep data out; the owner remains the authority) ----------------------

/** Speaker turns ("Cliente: ...", "Agente: ...") or line breaks: a transcript, not a consolidated need. */
const TRANSCRIPT = /(^|[\s.;])(cliente|agente|asesor|vendedor|usuario|asistente|customer|agent|user|assistant|bot)\s*:/iu;
const PERSONAL_DATA: readonly [string, RegExp][] = [
  ['email', /[^\s@]+@[^\s@]+\.[a-z]{2,}/iu],
  ['phone', /(\+?56[\s-]?)?\b9[\s-]?\d{4}[\s-]?\d{4}\b/u],
  ['rut', /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/u],
  ['card', /\b(?:\d[ -]?){13,19}\b/u],
  ['address', /\b(calle|avenida|av\.|pasaje|psje\.?)\s+\p{L}[\p{L}\s]{1,40}\s\d{1,5}\b/iu],
  ['address', /\b(depto\.?|departamento)\s*(n[°º.]?\s*)?\d{1,5}\b/iu],
];

/** Throws INVALID_REQUEST (never sent) when the text is a transcript or carries detectable customer data. Values are never echoed. */
export function guardDiscoverText(field: 'need' | 'useContext', text: string): void {
  if (/[\r\n]/u.test(text) || TRANSCRIPT.test(text)) throw new CatalogDiscoverError('INVALID_REQUEST', 'conversation_transcript', `${field} looks like a conversation transcript: send only the consolidated product need`, { retryable: false, issues: `CONVERSATION_TRANSCRIPT@${field}` });
  for (const [kind, pattern] of PERSONAL_DATA) {
    if (pattern.test(text)) throw new CatalogDiscoverError('INVALID_REQUEST', 'personal_data', `${field} carries customer data (${kind}): send only the product need`, { retryable: false, issues: `PERSONAL_DATA@${field}` });
  }
}

// ---- workspace coherence (the existing conversational state) -------------------------------

/** Budget facts, whatever key the agent chose (the pack prescribes none; same convention as the harness). */
const BUDGET_KEY = /^(budget|presupuesto)(_|$)/;

function amountOf(value: FactValue): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'object' && value !== null) {
    const { amount, currency } = value as Record<string, unknown>;
    if (typeof amount === 'number' && Number.isInteger(amount) && amount > 0 && (currency === undefined || currency === 'CLP')) return amount;
  }
  return null;
}

export function workspaceBudgets(workspace: Pick<Workspace, 'state'>): { key: string; amountClp: number }[] {
  return Object.entries(workspace.state.facts).flatMap(([key, fact]) => {
    const amount = BUDGET_KEY.test(key) ? amountOf(fact.value) : null;
    return amount === null ? [] : [{ key, amountClp: amount }];
  });
}

/**
 * A structured budget must be the customer's CURRENT recorded budget: a replaced
 * value (300 000 → 400 000) or a retracted one can never be sent, and two budgets
 * can never accumulate (the workspace holds one value per key). Omitting a
 * recorded budget is allowed (e.g. to show what exists above it) and is reported.
 */
export function budgetCoherence(maxUnitPriceClp: number | undefined, budgets: readonly { key: string; amountClp: number }[]): { applied: string | null; unapplied: { key: string; amountClp: number }[] } {
  if (maxUnitPriceClp === undefined) return { applied: null, unapplied: [...budgets] };
  const match = budgets.find((b) => b.amountClp === maxUnitPriceClp);
  if (!match) {
    const message = budgets.length === 0
      ? 'constraints.maxUnitPriceClp needs the customer\'s budget recorded in the Sales workspace first (record_fact budget)'
      : `constraints.maxUnitPriceClp (${maxUnitPriceClp}) is not the customer's current recorded budget (${budgets.map((b) => `${b.key}=${b.amountClp}`).join(', ')}); correct the workspace or send the recorded value`;
    throw new CatalogDiscoverError('INVALID_REQUEST', budgets.length === 0 ? 'budget_not_recorded' : 'budget_not_current', message, { retryable: false, issues: 'BUDGET_NOT_COHERENT@constraints.maxUnitPriceClp' });
  }
  return { applied: match.key, unapplied: budgets.filter((b) => b !== match && b.amountClp !== maxUnitPriceClp) };
}

// ---- view -------------------------------------------------------------------------------------

function commercialOf(candidate: CatalogDiscoverCandidate): CatalogDiscoverView['candidates'][number]['commercial'] {
  const c = candidate.commercial;
  if (c.status === 'EXPIRED') return { status: 'EXPIRED', asOf: c.asOf, validUntil: c.validUntil };
  if (c.status === 'UNKNOWN') return { status: 'UNKNOWN', reason: c.reason };
  return {
    status: 'OBSERVED', asOf: c.asOf, validUntil: c.validUntil, price: { ...c.price }, sellability: c.sellability, orderable: c.orderable,
    unit: c.unit ? { itemKey: c.unit.itemKey, finalGrossClp: c.unit.finalGrossClp, sellability: c.unit.sellability, reason: c.unit.reason, availableQuantity: c.unit.availableQuantity, orderable: c.unit.orderable, validUntil: c.unit.validUntil } : null,
  };
}

export function catalogDiscoverView(answer: CatalogDiscoverAnswer, sent: CatalogDiscoverView['request'], now: Date): CatalogDiscoverView {
  const all = [...(answer.exactMatch ? [answer.exactMatch] : []), ...answer.verified, ...answer.possible];
  const readings: DiscoverCandidateReading[] = all.map((c) => readCandidate(c, answer, now));
  const reading: DiscoverAnswerReading = readAnswer(answer, readings);
  const cf = answer.commercialFreshness;
  return {
    request: sent,
    contract: { schemaVersion: 1, contractVersion: answer.contractVersion },
    requestId: answer.requestId,
    status: answer.status,
    interpretation: {
      required: [...answer.interpretation.required],
      preferred: [...answer.interpretation.preferred],
      notVerifiable: [...answer.interpretation.notVerifiable],
      unrecognized: [...answer.interpretation.unrecognized],
      structuredApplied: [...answer.interpretation.structured.applied],
      ambiguities: answer.interpretation.ambiguities.map((g) => ({
        groupId: g.groupId,
        text: g.text,
        readings: g.readingRequirements.map((r) => ({
          readingId: r.readingId,
          label: g.readings.find((l) => l.startsWith(`${r.readingId}:`))?.slice(r.readingId.length + 1) ?? r.readingId,
          required: [...r.required],
          candidates: all.filter((c) => c.readings.some((l) => l.startsWith(`${r.readingId}:`))).map((c) => c.productKey),
        })),
      })),
      referenceKeysNotFound: [...answer.interpretation.hints.notFound],
      selection: { itemKeys: [...answer.interpretation.selection.itemKeys], notFound: [...answer.interpretation.selection.notFound], unverified: [...answer.interpretation.selection.unverified] },
    },
    candidates: all.map((c, i) => ({
      productKey: c.productKey,
      itemKey: c.itemKey ?? null,
      name: c.name,
      disposition: c.disposition,
      unresolved: [...c.unresolved],
      readings: [...c.readings],
      commercial: commercialOf(c),
      reading: { ...readings[i]!, requirements: readings[i]!.requirements.map((r) => ({ ...r })), allowedClaims: [...readings[i]!.allowedClaims], forbiddenClaims: [...readings[i]!.forbiddenClaims], next: readings[i]!.next.map((n) => ({ ...n })) },
    })),
    completeness: {
      retrieval: answer.completeness.retrieval,
      commercial: answer.completeness.commercial,
      exhaustive: answer.completeness.exhaustive,
      moreVerifiedAvailable: answer.completeness.moreVerifiedAvailable,
      pendingHydration: answer.completeness.counts.pendingHydration,
    },
    absence: answer.absence ? { reason: answer.absence.reason, contributing: [...answer.absence.contributing] } : null,
    degradation: answer.degradation.map((d) => ({ ...d })),
    freshness: { status: cf?.status ?? 'NOT_REQUESTED', asOf: cf?.oldestAsOf ?? null, validUntil: cf?.earliestValidUntil ?? null },
    reading: { ...reading, labels: [...reading.labels], answerAllowed: [...reading.answerAllowed], answerForbidden: [...reading.answerForbidden], askCustomer: { needed: reading.askCustomer.needed, reasons: [...reading.askCustomer.reasons] } },
    warnings: [...answer.warnings],
  };
}

/** ADR-030: the owner's declared window for this answer (null = no commercial observation). */
export function discoverOwnerValidUntil(output: CatalogDiscoverView): string | null {
  return output.freshness.validUntil;
}

// ---- capability --------------------------------------------------------------------------------

export interface CatalogDiscoverCapabilityDeps {
  readonly discover: CatalogDiscoverPort;
  /** The Sales workspace (existing conversational state), read for budget coherence. */
  readonly workspaces: { workspace(taskId: string): Promise<Pick<Workspace, 'state'>> };
  readonly now: () => Date;
}

export const CATALOG_DISCOVER_DESCRIPTION =
  'Discovers products for a CONCEPTUAL need (training goal, use, combination of specs, no product name) — owner: Catalog, which interprets the need, verifies constraints and attaches its commercial truth. For a product name, SKU or reference use catalog.search; for a known productKey use catalog.get_product_context. ' +
  'Send the consolidated need (never the conversation, never customer data); a budget goes in constraints.maxUnitPriceClp and must be the budget recorded in the Sales workspace. ' +
  'Read each candidate\'s reading: VERIFIED_MATCH = every required constraint satisfied; POSSIBLE_MATCH = relevant but some requirement unknown (never present it as meeting them). allowedClaims is what you may assert; forbiddenClaims you must not (e.g. a reference price is not an offer, a "from" price is not the chosen variant\'s price, an expired or unknown commercial state has no current price or stock). ' +
  'status COMPLETE is about the execution, not the catalog: say "these are all" / "there is none" only when reading.answerAllowed says so. PARTIAL or DEGRADED answers are usable with reservations. When reading.askCustomer.needed, ask (ambiguity, variant choice). Before any price- or stock-dependent action, the variant must be fixed and confirmed (workspace add_item / quote verify the exact unit with the owner).';

export function catalogDiscoverCapability(deps: CatalogDiscoverCapabilityDeps): CapabilityRegistration<CatalogDiscoverInput, CatalogDiscoverView> {
  return {
    definition: readDefinition({
      capabilityId: NON_PRODUCTION_CAPABILITY_IDS.catalogDiscover,
      description: CATALOG_DISCOVER_DESCRIPTION,
      owner: 'catalog',
      requiredScopes: [SCOPES.catalogRead],
      freshnessTtlMs: CATALOG_FRESHNESS_TTL_MS,
      timeoutMs: DISCOVER_TIMEOUT_MS,
    }),
    input: catalogDiscoverInput,
    output: catalogDiscoverOutput,
    ownerValidUntil: discoverOwnerValidUntil,
    handler: (input, context) =>
      domainRead(async () => {
        guardDiscoverText('need', input.need);
        if (input.useContext) guardDiscoverText('useContext', input.useContext);
        const workspace = await deps.workspaces.workspace(context.execution.taskId);
        const budget = budgetCoherence(input.constraints?.maxUnitPriceClp, workspaceBudgets(workspace));
        const need = input.useContext ? `${input.need} ${input.useContext}` : input.need;
        const constraints = Object.fromEntries(Object.entries(input.constraints ?? {}).filter(([, v]) => v !== undefined)) as CatalogDiscoverConstraints & Record<string, number | boolean>;
        const answer = await deps.discover.discover(
          {
            need,
            limit: input.limit,
            ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
            ...(input.referenceProductKeys?.length ? { productKeys: input.referenceProductKeys } : {}),
            ...(input.selectedItemKeys?.length ? { selectedItemKeys: input.selectedItemKeys } : {}),
          },
          { signal: context.signal, correlationId: context.execution.correlationId },
        );
        const sent: CatalogDiscoverView['request'] = {
          need,
          constraints,
          referenceProductKeys: [...(input.referenceProductKeys ?? [])],
          selectedItemKeys: [...(input.selectedItemKeys ?? [])],
          limit: input.limit,
          budgetFromWorkspace: budget.applied,
          unappliedWorkspaceBudgets: budget.unapplied,
        };
        return catalogDiscoverView(answer, sent, deps.now());
      }),
  };
}
