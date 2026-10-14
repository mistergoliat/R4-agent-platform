import { createHash } from 'node:crypto';
import { DomainError, canonicalJson, quoteV2Totals, type QuoteV2CreateResult } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult, WriteHandlerContext } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import type { AutonomousQuoteCounters, QuoteIntentEvidenceRecord } from '../workspace/store.js';
import { snapshotLimitBreaches, type AutonomousQuoteLimitsV6 } from './autonomy-limits.js';
import { buildCommercialSnapshot, quoteRequestOf, type CommercialBlocker } from './commercial-snapshot.js';
import { CONFIRMATION_GRAMMAR_VERSION, parseConfirmation } from './confirmation-grammar.js';
import { offerReference, presentsOffer } from './offer-presentation.js';
import { QUOTE_V2_CORRELATION, QUOTE_V2_TIMEOUT_MS, classifySend, quoteCreateV2Output, reconcileQuoteV2Command, settle, type QuoteCreateV2Output, type QuoteV2CapabilityDeps } from './quote-v2.js';
import { quoteCreateV3Input, type QuoteCreateV3Input } from './quote-v3.js';

/**
 * (R4-J3E-B) The conversation as the platform recorded it, read through the
 * existing public port `ProductionStore.thread(taskId)` (@r4/live-ops). Kept
 * structural so this capability depends on no runtime package:
 * `contact` = an input the platform accepted into the task (in the production
 * topology only the channel ingress, after provider authentication),
 * `agent` = a response the platform recorded and, when present, its outbound
 * delivery status. The model can create neither.
 */
export interface ConversationThreadEntry {
  readonly cursor: string;
  readonly at: string;
  readonly kind: 'contact' | 'agent' | 'operator' | 'event';
  readonly text: string | null;
  readonly refs: Readonly<Record<string, string | null>>;
  readonly delivery: { readonly outboundId: string; readonly status: string } | null;
}
export interface ConversationThreadReader {
  thread(taskId: string): Promise<readonly ConversationThreadEntry[]>;
}

export interface QuoteV4CapabilityDeps extends QuoteV2CapabilityDeps {
  readonly limits: AutonomousQuoteLimitsV6;
  readonly conversation: ConversationThreadReader;
}

/** Outbound states that prove the provider took the offer message (NOT that the customer read it). */
const OFFER_DELIVERY_STATES: ReadonlySet<string> = new Set(['accepted', 'delivered', 'read']);

/**
 * quote.create@4 (R4-J3E-B, sales-production@6) — quote.create@3 with
 * INDEPENDENT evidence of customer intent. Same input ({ previewId }), Quote V2
 * port, frozen body, settlement and reconciliation. The commercial decision
 * additionally requires, from the conversation the platform recorded (never
 * from capability arguments or the workspace):
 *
 *   1. the customer's LATEST message parses as an explicit confirmation under
 *      the closed grammar `r4-sales-confirmation-es-v1`;
 *   2. the agent message immediately before it (no customer message in
 *      between, no agent message after it) presents THIS snapshot: the
 *      Sales-derived reference `Q-<previewId>-<commercial version>` and the
 *      gross total — so the offer is bound to the current content AND the
 *      current commercial version (a later change of items, quantities,
 *      destination or shipping moves the version and voids the offer);
 *   3. that offer message was taken by the provider (outbound accepted,
 *      delivered or read) and the confirmation arrived within the configured
 *      window after it;
 *   4. that customer message never authorized another quote (unique).
 *
 * The evidence (ids, times, delivery status, hashes; no customer text) is
 * recorded with the authorization in one transaction (0009). Anything else is
 * a refusal, with nothing frozen or sent; there is no fallback to a human.
 */
export function quoteCreateV4Capability(deps: QuoteV4CapabilityDeps): WriteCapabilityRegistration<QuoteCreateV3Input, QuoteCreateV2Output> {
  const { store, quotes } = deps;
  const now = deps.now ?? (() => new Date());
  return {
    definition: {
      capabilityId: CAPABILITY_IDS.quoteCreate,
      version: 4,
      description:
        'Issues the formal quote (Quote owner V2) previewed by quote.preview, without a human approval, once the customer has explicitly confirmed it in the conversation. Before proposing: quote.preview returned status=ready with no limitBreaches, your LAST message to the customer presented that preview (its lines, shipping, presentation.totalText and presentation.reference verbatim) and asked whether to issue it, and the customer\'s reply is an explicit confirmation. The only argument is the previewId. The confirmation is read by the platform from the customer\'s own messages, never from you. Refused, with nothing issued, when the customer\'s last message is not an explicit, unconditional confirmation (ask them to confirm explicitly, for example "CONFIRMO"), when your offer message did not show the current reference and total, when anything changed since (preview again and present it again), when the confirmation came too late, when an autonomy limit would be exceeded, or when the same quote was already issued. Quote numbers, totals and validity come only from the result of an issued quote.',
      owner: 'quote',
      riskClass: 'IRREVERSIBLE_WRITE',
      requiredScopes: [SCOPES.quoteCreate],
      identityRequirement: 'provisional',
      confirmationPolicy: 'none',
      // ADR-035: no human approval; the customer's own confirmation, read from the platform's records, gates every effect.
      approvalPolicy: 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 0 },
      timeoutMs: QUOTE_V2_TIMEOUT_MS,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: 'reconcile_before_retry',
    input: quoteCreateV3Input,
    output: quoteCreateV2Output,
    async execute(input, context) {
      let record = await store.quoteV2Request(context.executionKey);
      if (!record) {
        const decided = await decide(deps, input, context, now());
        if (decided.status !== 'authorized') return decided.result;
        record = await store.quoteV2Request(context.executionKey);
        if (!record) throw new Error(`authorized quote ${context.executionKey} has no frozen request`);
      }
      await store.recordQuoteV2Send(context.executionKey);
      let result: QuoteV2CreateResult;
      try {
        result = await quotes.createAndIssue(record.request, context.executionKey, { signal: context.signal, correlationId: context.execution.correlationId });
      } catch (error) {
        return classifySend(error);
      }
      return settle(deps, record, result.quote, result.operation, result.replayed, context);
    },
    reconcile: (context) => reconcileQuoteV2Command(deps, context),
  };
}

type Decision = { readonly status: 'authorized' } | { readonly status: 'refused'; readonly result: WriteExecutionResult<QuoteCreateV2Output> };
type Evidence = Omit<QuoteIntentEvidenceRecord, 'executionKey' | 'taskId' | 'previewId'>;

async function decide(deps: QuoteV4CapabilityDeps, input: QuoteCreateV3Input, context: WriteHandlerContext, now: Date): Promise<Decision> {
  const { store, limits } = deps;
  const taskId = context.execution.taskId;
  const executionKey = context.executionKey;
  const limitsRecord = { ...limits };
  const prior = await store.autonomousDecision(executionKey);
  if (prior) return prior.outcome === 'authorized' ? { status: 'authorized' } : refused(prior.reasonCode, `this command was already refused (${prior.reasonCode})`, {});

  const refuse = async (blocker: CommercialBlocker, extra: { snapshot?: object | null; confirmation?: object | null; measurements?: object } = {}): Promise<Decision> => {
    await store.recordAutonomousRejection({ executionKey, taskId, previewId: input.previewId, reasonCode: blocker.code, snapshot: extra.snapshot ?? null, limits: limitsRecord, measurements: extra.measurements ?? { blocker }, quoteRequest: extra.confirmation ?? null });
    return refused(blocker.code, blocker.message, blocker.details);
  };

  // 1. The snapshot, recomputed now (as quote.create@3).
  const workspace = await store.workspace(taskId);
  let built: Awaited<ReturnType<typeof buildCommercialSnapshot>>;
  try {
    built = await buildCommercialSnapshot(deps, workspace, { signal: context.signal, correlationId: context.execution.correlationId }, now);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { status: 'refused', result: { status: 'failed', code: 'quote_evidence_unavailable', message: `commercial evidence could not be verified: ${error.message}`, details: { category: error.category, ownerCode: error.code, retryable: true } } };
  }
  if (built.status === 'blocked') {
    const first = built.blockers[0]!;
    return refuse({ ...first, details: { ...first.details, blockers: built.blockers.map((b) => b.code).join(',') } }, { measurements: { blockers: built.blockers } });
  }
  if (built.previewId !== input.previewId) {
    return refuse({ code: 'preview_stale', message: 'the quote would differ from the previewed one (an owner price, offer or the selection changed): preview again and present it to the customer', details: { currentPreviewId: built.previewId } }, { snapshot: built.snapshot });
  }
  const breaches = snapshotLimitBreaches(built.snapshot, limits);
  if (breaches.length > 0) return refuse(breaches[0]!, { snapshot: built.snapshot, measurements: { breaches } });

  // 2. The customer's confirmation, from the conversation the platform recorded.
  const commercialVersion = await store.commercialVersion(taskId);
  const reference = offerReference(built.previewId, commercialVersion);
  const gross = built.snapshot.totals.gross;
  const found = locateConfirmation(await deps.conversation.thread(taskId), reference, gross, limits.confirmationWindowSeconds);
  if (found.status !== 'confirmed') return refuse(found.blocker, { snapshot: built.snapshot, confirmation: { reference, ...found.trace } });
  const evidence = found.evidence(commercialVersion, reference, gross);
  const confirmation = { source: 'conversation_thread', reference, offerRef: evidence.offerRef, confirmationInputId: evidence.confirmationInputId, grammarVersion: evidence.grammarVersion, grammarRule: evidence.grammarRule };

  // 3. The decision, with the frozen request and the evidence, in one transaction.
  const body = quoteRequestOf(built.snapshot, built.evidence, { ...QUOTE_V2_CORRELATION, externalReference: taskId });
  const computed = quoteV2Totals(body);
  if (computed.net !== built.snapshot.totals.net || computed.tax !== built.snapshot.totals.tax || computed.gross !== built.snapshot.totals.gross) {
    return refuse({ code: 'expected_totals_mismatch', message: 'the request totals differ from the snapshot totals', details: { computedGross: computed.gross } }, { snapshot: built.snapshot, confirmation });
  }
  const units = built.snapshot.lines.reduce((total, l) => total + l.quantity, 0);
  const { decision } = await store.decideAutonomousQuote({
    executionKey,
    taskId,
    previewId: input.previewId,
    snapshot: built.snapshot,
    limits: limitsRecord,
    quoteRequest: confirmation,
    workspaceVersion: workspace.version,
    request: body,
    requestSha256: sha256(canonicalJson(body)),
    intentEvidence: evidence,
    judge: (counters) => judge(counters, limits, { gross, lines: built.snapshot.lines.length, units, commercialVersion }),
  });
  if (decision.outcome === 'authorized') return { status: 'authorized' };
  return refused(decision.reasonCode, refusalMessage(decision.reasonCode), {});
}

type Located =
  | { readonly status: 'confirmed'; readonly evidence: (commercialVersion: number, reference: string, gross: number) => Evidence }
  | { readonly status: 'refused'; readonly blocker: CommercialBlocker; readonly trace: Record<string, string | null> };

/**
 * Finds the customer's confirmation of the offer that presented `reference`
 * and `gross`. Deterministic over the recorded thread; never consults the model.
 */
export function locateConfirmation(thread: readonly ConversationThreadEntry[], reference: string, gross: number, windowSeconds: number): Located {
  const entries = [...thread].sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
  const refuse = (code: string, message: string, trace: Record<string, string | null> = {}, details: Record<string, string | number | boolean | null> = {}): Located => ({ status: 'refused', blocker: { code, message, details }, trace });
  const contacts = entries.filter((e) => e.kind === 'contact');
  const confirmation = contacts.at(-1);
  if (!confirmation) return refuse('customer_confirmation_missing', 'the customer has not written anything that could confirm this quote');
  const confirmationInputId = confirmation.refs.inputId ?? null;
  if (!confirmationInputId) return refuse('customer_confirmation_unidentified', 'the customer message has no platform input identity', {});
  const trace = { confirmationInputId };
  // Nothing the agent said after the confirmation may stand between it and the issuance.
  if (entries.some((e) => (e.kind === 'agent' || e.kind === 'operator') && e.cursor > confirmation.cursor)) {
    return refuse('customer_confirmation_superseded', 'the conversation continued after the customer\'s confirmation: present the quote again and ask for a new confirmation', trace);
  }
  const verdict = parseConfirmation(confirmation.text);
  if (!verdict.confirmed) {
    return refuse('customer_confirmation_not_explicit', 'the customer\'s last message is not an explicit, unconditional confirmation of the quote: ask them to confirm it explicitly (for example "CONFIRMO")', trace, { reason: verdict.reason });
  }
  const offer = entries.filter((e) => (e.kind === 'agent' || e.kind === 'operator') && e.cursor < confirmation.cursor).at(-1);
  if (!offer || offer.kind !== 'agent') return refuse('customer_confirmation_without_offer', 'no agent offer precedes the customer\'s confirmation', trace);
  const offerRef = offer.refs.stepId ?? null;
  const offerTrace = { ...trace, offerRef };
  if (contacts.some((c) => c.cursor > offer.cursor && c.cursor < confirmation.cursor)) {
    return refuse('customer_confirmation_not_immediate', 'the customer wrote something else between the offer and the confirmation: present the quote again and ask for a confirmation', offerTrace);
  }
  if (!presentsOffer(offer.text, reference, gross)) {
    return refuse('offer_not_presented', `the message the customer answered did not present this quote (reference ${reference} and total ${gross} CLP): preview again and present it`, offerTrace, { expectedReference: reference, expectedGross: gross });
  }
  if (!offer.delivery || !OFFER_DELIVERY_STATES.has(offer.delivery.status)) {
    return refuse('offer_not_delivered', 'the offer message was not taken by the channel provider', offerTrace, { deliveryStatus: offer.delivery?.status ?? null });
  }
  const elapsedMs = Date.parse(confirmation.at) - Date.parse(offer.at);
  if (!(elapsedMs > 0)) return refuse('customer_confirmation_out_of_order', 'the confirmation is not later than the offer', offerTrace);
  if (elapsedMs > windowSeconds * 1000) {
    return refuse('customer_confirmation_expired', 'the customer confirmed too long after the offer: present the quote again', offerTrace, { elapsedSeconds: Math.floor(elapsedMs / 1000), windowSeconds });
  }
  if (!offerRef) return refuse('offer_unidentified', 'the offer message has no platform step identity', offerTrace);
  const delivery = offer.delivery;
  return {
    status: 'confirmed',
    evidence: (commercialVersion, presentedReference, presentedGross) => ({
      commercialVersion,
      presentedReference,
      presentedGross,
      offerRef,
      offerAt: offer.at,
      offerDeliveryStatus: delivery.status as Evidence['offerDeliveryStatus'],
      offerOutboundId: delivery.outboundId,
      offerTextSha256: sha256(offer.text ?? ''),
      confirmationInputId,
      confirmationAt: confirmation.at,
      confirmationTextSha256: sha256(confirmation.text ?? ''),
      grammarVersion: CONFIRMATION_GRAMMAR_VERSION,
      grammarRule: verdict.rule,
    }),
  };
}

function judge(counters: AutonomousQuoteCounters, limits: AutonomousQuoteLimitsV6, measured: { gross: number; lines: number; units: number; commercialVersion: number }): { reasonCode: string; measurements: object } {
  const measurements = { ...counters, ...measured };
  if (counters.confirmationUsedBy !== null) return { reasonCode: 'customer_confirmation_used', measurements };
  if (counters.sameSnapshotAuthorizedBy !== null) return { reasonCode: 'duplicate_quote', measurements };
  if (counters.authorizedInConversation >= limits.maxQuotesPerConversation) return { reasonCode: 'autonomy_limit_conversation', measurements };
  if (counters.authorizedLastHour >= limits.maxQuotesPerHour) return { reasonCode: 'autonomy_limit_rate', measurements };
  return { reasonCode: 'eligible', measurements };
}

function refusalMessage(code: string): string {
  switch (code) {
    case 'customer_confirmation_used':
      return 'this customer confirmation already authorized a quote; a new quote needs a new confirmation';
    case 'duplicate_quote':
      return 'this exact quote was already issued (or is being issued) in this conversation; a second one is never issued';
    case 'autonomy_limit_conversation':
      return 'this conversation reached the number of quotes that may be issued without a human';
    case 'autonomy_limit_rate':
      return 'the hourly number of quotes that may be issued without a human was reached; try again later or ask a human';
    default:
      return `the quote was not issued (${code})`;
  }
}

function refused(code: string, message: string, details: Readonly<Record<string, string | number | boolean | null>>): Decision {
  return { status: 'refused', result: { status: 'rejected', code, message, details: { ...details } } };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
