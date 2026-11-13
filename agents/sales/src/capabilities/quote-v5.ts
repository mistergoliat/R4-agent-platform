import { createHash } from 'node:crypto';
import { DomainError, canonicalJson, quoteV2Totals, type QuoteV2CreateResult } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult, WriteHandlerContext } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { snapshotLimitBreaches } from './autonomy-limits.js';
import { buildCommercialSnapshot, quoteRequestOf, type CommercialBlocker } from './commercial-snapshot.js';
import { INTENT_GUARD_VERSION, guardIntentReply, type OfferDelivery } from './confirmation-grammar.js';
import { OFFER_MESSAGE_MAX_CHARS, OFFER_TEMPLATE_V2, OFFER_TEMPLATE_VERSION, offerReference, renderOfferMessage } from './offer-presentation.js';
import type { QuoteParityGuard } from './parity-guard.js';
import type { CommercialEligibility } from './commercial-snapshot.js';
import { QUOTE_V2_CORRELATION, QUOTE_V2_TIMEOUT_MS, classifySend, quoteCreateV2Output, reconcileQuoteV2Command, settle, type QuoteCreateV2Output, type QuoteDocumentDelivery } from './quote-v2.js';
import { quoteCreateV3Input, type QuoteCreateV3Input } from './quote-v3.js';
import { CLOSED_GRAMMAR_JUDGE, confirmedQuoteRefusalMessage, judgeConfirmedQuote, locateConfirmation, type QuoteV4CapabilityDeps, type ReplyJudge } from './quote-v4.js';

/**
 * The kill switch as quote.create@5 reads it, structurally (satisfied by the
 * production AutonomyControls): asked at every execution, never cached; a
 * failure to read counts as not admitted.
 */
export interface QuoteWriteAdmission {
  admit(): Promise<{ readonly admitted: boolean; readonly reason: string }>;
}

export interface QuoteV5CapabilityDeps extends QuoteV4CapabilityDeps {
  readonly admission: QuoteWriteAdmission;
  /** (R4-J5 F1, P-1) When configured, the snapshot recomputed at issuance blocks every line outside the current parity-verified set. */
  readonly parity?: QuoteParityGuard | null;
  /** (F1 commercial eligibility) When configured, every line and the shipping must satisfy the F1 commercial policy. */
  readonly eligibility?: CommercialEligibility | null;
  /** (Quote PDF delivery, @18) When configured, an issued quote's verified PDF is queued for its conversation. */
  readonly documents?: QuoteDocumentDelivery | null;
  /**
   * (@19, owner decision 2026-11-10) quote.create@6: the agent interprets the customer's acceptance in natural language
   * (offer template v2, intent guard); the closed grammar is not required. Absent/false: quote.create@5 (grammar).
   */
  readonly naturalAcceptance?: boolean;
}

/**
 * (@19) The judge of the customer's reply: the agent interprets; the platform refuses questions, negations, hesitations
 * and changes, reading delivery words against the offer the customer answers (delivery excluded or included).
 */
export const intentGuardJudge = (delivery: OfferDelivery): ReplyJudge => Object.freeze<ReplyJudge>({
  version: INTENT_GUARD_VERSION,
  parse: (text) => guardIntentReply(text, delivery),
  refusal: (reason) =>
    reason === 'empty'
      ? 'the customer\'s reply to the offer has no words you can rely on (for example only punctuation): nothing was issued; ask briefly whether they want this quote issued, without presenting the offer again'
      : reason === 'too_long'
        ? 'the customer\'s reply to the offer is long: nothing was issued; answer what they wrote and, if they still want this quote, ask briefly whether to issue it'
        : 'the customer\'s reply to the offer is a question, a negation, a hesitation, a condition or a change request, not an acceptance: nothing was issued; answer it or adjust the selection first, and present a new offer only in a later reply when the quote changes; never present the same offer again without answering',
});

/** Failure code of an issuance stopped by the kill switch before anything reached the Quote owner. */
export const QUOTE_WRITES_BLOCKED = 'autonomy_disabled';

/** The error a guarded Quote port raises instead of calling the owner while the kill switch is engaged ("definitely not sent"). */
export function quoteWritesBlockedError(): DomainError {
  return new DomainError('temporarily_unavailable', QUOTE_WRITES_BLOCKED, 'autonomous operation is disabled: the quote owner was not called');
}

/**
 * quote.create@5 (R4-J3E-C1, sales-production@7) — quote.create@4 with the
 * WHOLE offer bound: the agent message the customer confirmed must be
 * byte-identical to the offer Sales renders now (template
 * `r4-sales-offer-es-v1`) from the snapshot recomputed now and the current
 * reference. Since an equal previewId means an identical canonical snapshot,
 * equality binds every product, variant, quantity, unit price, subtotal,
 * shipping, net, VAT, total and the reference — not only reference and total.
 *
 * Everything else is quote.create@4: the same input ({ previewId }), the
 * confirmation read from the conversation the platform recorded (grammar,
 * immediacy, delivery, window, single use), the limits, the decision ledger,
 * the frozen request, settlement and reconciliation — settled strictly
 * (every amount the owner returns is compared with the frozen request).
 *
 * The kill switch is read before anything is decided, again before the send
 * is recorded, and the Quote port of the @7 composition re-reads it
 * immediately before the mutation. The owner is never called while it is
 * engaged. What a stop leaves behind depends on when it comes:
 *   before the decision  `failed` (nothing authorized: a new proposal can issue once released);
 *   after the decision   `unknown` — the authorization and the frozen body exist, so the command
 *                        is HELD on its own key: the declared backoff returns the task to worker
 *                        admission (which waits while the switch is engaged), then the platform
 *                        reconciles (a lookup: not applied) and replays the same key and body once.
 * Reconciliation only reads (idempotency lookup, quote, operation, document) and is never blocked.
 */
export function quoteCreateV5Capability(deps: QuoteV5CapabilityDeps): WriteCapabilityRegistration<QuoteCreateV3Input, QuoteCreateV2Output> {
  const { store, quotes } = deps;
  const now = deps.now ?? (() => new Date());
  const natural = deps.naturalAcceptance === true;
  return {
    definition: {
      capabilityId: CAPABILITY_IDS.quoteCreate,
      version: natural ? 6 : 5,
      description: natural
        ? 'Issues the formal quote (Quote owner V2) previewed by quote.preview, without a human approval, once the customer accepts the offer Sales wrote, in their own words. Before proposing: quote.preview returned status=ready and issuable=true, your LAST message to the customer was presentation.offerMessage exactly as given, and the customer\'s reply shows that they want that quote (for example "sí", "dale", "ok", "me parece", "perfecto", "sí, emítelas", "mándamela"; any natural wording, no literal phrase). Never propose it when the reply asks something, rejects, hesitates or asks for a change: answer or adjust first. The only argument is the previewId. The platform compares your message with the offer Sales rendered and refuses a reply that is a question, a negation, a hesitation or a change request; it never decides acceptance for you. Refused, with nothing issued, when your message was not exactly the current offerMessage or anything changed since (offer_not_presented, preview_stale: preview again and reply with the new offerMessage), when the reply came too late, when an autonomy limit would be exceeded, when the same quote was already issued, or when autonomous operation is disabled (autonomy_disabled: nothing was sent; say the quote cannot be issued right now). When the outcome is uncertain because the quote owner did not answer or was unavailable, the platform keeps reconciling the same issuance under the same key: tell the customer it is pending and will be confirmed, and do not present the offer again or propose another issuance. Quote numbers, totals and validity come only from the result of an issued quote.'
        :
        'Issues the formal quote (Quote owner V2) previewed by quote.preview, without a human approval, once the customer has explicitly confirmed the exact offer Sales wrote. Before proposing: quote.preview returned status=ready and issuable=true, your LAST message to the customer was presentation.offerMessage exactly as given (nothing added, removed or changed), and the customer\'s reply is an explicit confirmation. The only argument is the previewId. The platform reads the customer\'s confirmation from their own message and compares your message with the offer Sales rendered, never from you. Refused, with nothing issued, when the customer\'s last message is not an explicit, unconditional confirmation (reply again with presentation.offerMessage exactly), when your message was not exactly the current offerMessage or anything changed since (offer_not_presented, preview_stale: preview again and reply with the new offerMessage), when the confirmation came too late, when an autonomy limit would be exceeded, when the same quote was already issued, or when autonomous operation is disabled (autonomy_disabled: nothing was sent; say the quote cannot be issued right now). When the outcome is uncertain because the quote owner did not answer or was unavailable, the platform keeps reconciling the same issuance under the same key: tell the customer it is pending and will be confirmed, and do not present the offer again or propose another issuance. Quote numbers, totals and validity come only from the result of an issued quote.',
      owner: 'quote',
      riskClass: 'IRREVERSIBLE_WRITE',
      requiredScopes: [SCOPES.quoteCreate],
      identityRequirement: 'provisional',
      confirmationPolicy: 'none',
      // ADR-035 / R4-J3E-C1: no human approval; the customer's confirmation of the exact Sales-rendered offer gates every effect.
      approvalPolicy: 'none',
      idempotency: 'key_required',
      // Durable backoff between attempts (20 s, 40 s, 80 s): each one hands the task back to worker admission, where a
      // kill-switch hold waits; and the three in-run reconciliations (≥ 20, 60, 140 s after the attempt) outlast the
      // owner's not-found window (90 + 30 s), so a send recorded just before the guard refused never strands the key.
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 20_000 },
      timeoutMs: QUOTE_V2_TIMEOUT_MS,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: 'reconcile_before_retry',
    input: quoteCreateV3Input,
    output: quoteCreateV2Output,
    async execute(input, context) {
      const admit = () => deps.admission.admit().catch(() => ({ admitted: false, reason: 'autonomy_controls_unavailable' }));
      let record = await store.quoteV2Request(context.executionKey);
      /** Decided in this very call (no wait since the decision validated it against Catalog). */
      let decidedNow = false;
      if (!record) {
        // Before any decision: a stopped issuance leaves no authorization behind, so it can be proposed again once released.
        const gate = await admit();
        if (!gate.admitted) return writesBlocked(gate.reason);
        const decided = await decide(deps, input, context, now());
        if (decided.status !== 'authorized') return decided.result;
        record = await store.quoteV2Request(context.executionKey);
        if (!record) throw new Error(`authorized quote ${context.executionKey} has no frozen request`);
        decidedNow = true;
      }
      // Authorized and frozen: from here a stop is held on this key, never failed (it would strand the authorization).
      const gate = await admit();
      if (!gate.admitted) return sendHeld(gate.reason);
      // (F1-COMMERCIAL-POLICY-v3) A promotional body is validated again immediately before this send, after any wait
      // (kill-switch hold, owner unavailable, restart and reconciliation): never sent once it stopped being true.
      const check = await promotionalSendCheck(deps, record, context, decidedNow, now());
      if (check.status !== 'send') return check.result;
      await store.recordQuoteV2Send(context.executionKey, check.validation);
      let result: QuoteV2CreateResult;
      try {
        result = await quotes.createAndIssue(record.request, context.executionKey, { signal: context.signal, correlationId: context.execution.correlationId });
      } catch (error) {
        // The guarded port refused before calling the owner (the switch was engaged after the check above).
        if (error instanceof DomainError && error.code === QUOTE_WRITES_BLOCKED) return sendHeld('autonomy_disabled');
        // (GAP-16) The owner is temporarily unavailable: held on this key like a kill-switch stop, never failed.
        if (error instanceof DomainError && error.category === 'temporarily_unavailable') return ownerUnavailableHeld(error);
        return classifySend(error);
      }
      return settle(deps, record, result.quote, result.operation, result.replayed, context, { strict: true, documents: deps.documents ?? null });
    },
    reconcile: (context) => reconcileQuoteV2Command(deps, context, { strict: true, documents: deps.documents ?? null }),
  };
}

/** (v3) The promotional lines of a snapshot, as validated now: null when the quote has none (every regular quote). */
function promotionEvidenceOf(built: Extract<Awaited<ReturnType<typeof buildCommercialSnapshot>>, { status: 'ready' }>, policyVersion: string | null, validatedAt: Date): object | null {
  const lines = built.snapshot.lines.flatMap((line, index) => {
    const ev = built.evidence.lines[index];
    if (!ev?.promotionEndsAt) return [];
    return [{
      itemKey: line.itemKey,
      productRef: line.productRef,
      variantRef: line.variantRef,
      quantity: line.quantity,
      unitGross: line.unitPrice.amount,
      promotionEndsAt: ev.promotionEndsAt,
      // Catalog V2 does not identify a promotion: its provenance is the owner's pricing reference and answer instant.
      promotionRef: null,
      pricingReference: ev.pricingReference,
      catalogAsOf: ev.asOf,
    }];
  });
  return lines.length === 0 ? null : { policyVersion, validatedAt: validatedAt.toISOString(), previewId: built.previewId, lines };
}

type SendCheck = { readonly status: 'send'; readonly validation: object | null } | { readonly status: 'stop'; readonly result: WriteExecutionResult<QuoteCreateV2Output> };

/** Code of a promotional quote that is no longer what the customer accepted: settled, nothing sent, nothing re-issued. */
export const PROMOTIONAL_QUOTE_NO_LONGER_VALID = 'promotional_quote_no_longer_valid';

/**
 * (F1-COMMERCIAL-POLICY-v3, owner order «promotional quotes hardening») Immediately before each send of a frozen body
 * that carries a promotional price. A regular quote (no promotion evidence in its decision) is sent exactly as before,
 * with no extra read. Decided in this very call: the decision's own validation is recorded. Otherwise (a replay after
 * a kill-switch hold, an unavailable owner, a restart and its reconciliation) the same snapshot is rebuilt from Catalog
 * and Shipping NOW, through the same eligibility (no second engine, no other price source), and must be ready and
 * produce the SAME previewId: price, variant, quantity, stock, shipping and the promotion's end (the 60-minute quote
 * plus 15 minutes, from now) all as accepted. Otherwise the command is settled `failed` before anything reaches Quote:
 * the authorization is spent and no other quote is created in its place. When Catalog cannot answer, it stays held.
 */
async function promotionalSendCheck(deps: QuoteV5CapabilityDeps, record: { readonly taskId: string; readonly request: unknown }, context: WriteHandlerContext, decidedNow: boolean, now: Date): Promise<SendCheck> {
  const decision = await deps.store.autonomousDecision(context.executionKey);
  const promotion = (decision?.quoteRequest as { promotion?: { previewId?: string; lines?: unknown[] } } | null)?.promotion;
  if (!decision || !promotion) return { status: 'send', validation: null };
  if (decidedNow) return { status: 'send', validation: { ...promotion, source: 'decision' } };
  let built: Awaited<ReturnType<typeof buildCommercialSnapshot>>;
  try {
    const workspace = await deps.store.workspace(record.taskId);
    built = await buildCommercialSnapshot(deps, workspace, { signal: context.signal, correlationId: context.execution.correlationId }, now);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { status: 'stop', result: { status: 'unknown', message: `the promotional quote could not be validated again before its send (${error.code}): nothing was sent; it is held on this execution key and validated again before any send` } };
  }
  const stop = (reason: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): SendCheck => ({
    status: 'stop',
    result: { status: 'failed', code: PROMOTIONAL_QUOTE_NO_LONGER_VALID, message: `the accepted promotional quote is no longer valid (${reason}): nothing was sent to the quote owner and no other quote was issued; tell the customer, and present a new offer only if they still want one`, details: { reason, retryable: false, ...details } },
  });
  if (built.status !== 'ready') return stop(built.blockers[0]?.code ?? 'blocked', { blockers: built.blockers.map((b) => b.code).join(',') });
  if (built.previewId !== decision.previewId) return stop('commercial_change', { currentPreviewId: built.previewId });
  const revalidated = promotionEvidenceOf(built, deps.eligibility?.policyVersion ?? null, now);
  return { status: 'send', validation: { ...(revalidated ?? promotion), source: 'revalidated' } };
}

function writesBlocked(reason: string): WriteExecutionResult<QuoteCreateV2Output> {
  return { status: 'failed', code: QUOTE_WRITES_BLOCKED, message: 'autonomous operation is disabled (kill switch): nothing was sent to the quote owner; the quote can be proposed again once autonomy is enabled', details: { reason, retryable: true } };
}

/**
 * An authorized command stopped before its send. Not `failed`: that settles the command while its authorization and
 * frozen body stay, and no other key may send them. `unknown` is what the platform makes of any attempt that did not
 * reach the domain (the ActionExecutor's own rule); only a lookup establishes "not applied", and then the same key replays.
 */
function sendHeld(reason: string): WriteExecutionResult<QuoteCreateV2Output> {
  return { status: 'unknown', message: `${QUOTE_WRITES_BLOCKED} (${reason}): the authorized quote was not sent to the quote owner; it is held on this execution key and sent once autonomy is enabled` };
}

/**
 * (R4-J3 GAP-16) The owner answered "temporarily unavailable" to the authorized, frozen body. `classifySend` makes
 * that `failed` (definitive), which strands the authorization exactly like a kill-switch stop would; quote.create@2–@4
 * keep that behavior. Here it is `unknown`: the platform reconciles by this key (the owner's not-found window still
 * applies, because the send was recorded) and replays the same key and body under the declared backoff.
 */
function ownerUnavailableHeld(error: DomainError): WriteExecutionResult<QuoteCreateV2Output> {
  return { status: 'unknown', message: `quote owner temporarily unavailable (${error.code}): the authorized quote is held on this execution key; it is reconciled by its key and sent again with the same key and body` };
}

type Decision = { readonly status: 'authorized' } | { readonly status: 'refused'; readonly result: WriteExecutionResult<QuoteCreateV2Output> };

async function decide(deps: QuoteV5CapabilityDeps, input: QuoteCreateV3Input, context: WriteHandlerContext, now: Date): Promise<Decision> {
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

  // 1. The snapshot, recomputed now; the same previewId; the snapshot limits.
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
    return refuse({ code: 'preview_stale', message: 'the quote would differ from the previewed one (an owner price, offer or the selection changed): preview again and present the new offerMessage', details: { currentPreviewId: built.previewId } }, { snapshot: built.snapshot });
  }
  const breaches = snapshotLimitBreaches(built.snapshot, limits);
  if (breaches.length > 0) return refuse(breaches[0]!, { snapshot: built.snapshot, measurements: { breaches } });

  // 2. The offer Sales renders NOW for this snapshot and commercial version: what the customer must have seen.
  const commercialVersion = await store.commercialVersion(taskId);
  const reference = offerReference(built.previewId, commercialVersion);
  const gross = built.snapshot.totals.gross;
  const template = deps.naturalAcceptance === true ? OFFER_TEMPLATE_V2 : OFFER_TEMPLATE_VERSION;
  const expected = renderOfferMessage(built.snapshot, reference, template);
  const offer = { reference, offerTemplate: template, offerMessageSha256: sha256(expected) };
  if (expected.length > OFFER_MESSAGE_MAX_CHARS) {
    return refuse({ code: 'offer_message_too_long', message: `the offer message would exceed ${OFFER_MESSAGE_MAX_CHARS} characters and is never presented`, details: { characters: expected.length, limit: OFFER_MESSAGE_MAX_CHARS } }, { snapshot: built.snapshot, confirmation: offer });
  }

  // 3. The conversation the platform recorded: the offer message, its delivery and the customer's confirmation (quote.create@4 rules).
  const judge = deps.naturalAcceptance === true ? intentGuardJudge(built.snapshot.shipping.kind === 'selected' ? 'selected' : 'excluded') : CLOSED_GRAMMAR_JUDGE;
  const found = locateConfirmation(await deps.conversation.thread(taskId), reference, gross, limits.confirmationWindowSeconds, judge);
  if (found.status !== 'confirmed') return refuse(found.blocker, { snapshot: built.snapshot, confirmation: { ...offer, ...found.trace } });
  const evidence = found.evidence(commercialVersion, reference, gross);

  // 4. Byte for byte: the message the customer answered IS the Sales rendering (the evidence keeps its SHA-256, 0009).
  if (evidence.offerTextSha256 !== offer.offerMessageSha256) {
    return refuse(
      { code: 'offer_not_presented', message: 'the message the customer answered is not exactly the offer Sales rendered for this quote (every line, amount, shipping, total and the reference must match character for character): preview again and reply with presentation.offerMessage exactly', details: { offerTemplate: template, expectedSha256: offer.offerMessageSha256, presentedSha256: evidence.offerTextSha256 } },
      { snapshot: built.snapshot, confirmation: { ...offer, offerRef: evidence.offerRef, confirmationInputId: evidence.confirmationInputId } },
    );
  }
  // (F1-COMMERCIAL-POLICY-v3) A promotional quote keeps, with its decision, what its promotional lines were validated
  // against; every later send of the frozen body is validated again against Catalog (promotionalSendCheck).
  const promotion = promotionEvidenceOf(built, deps.eligibility?.policyVersion ?? null, now);
  const confirmation = { source: 'conversation_thread', ...offer, offerRef: evidence.offerRef, confirmationInputId: evidence.confirmationInputId, grammarVersion: evidence.grammarVersion, grammarRule: evidence.grammarRule, ...(promotion ? { promotion } : {}) };

  // 5. The decision (single use, duplicates, frequency), with the frozen request and the evidence, in one transaction.
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
    judge: (counters) => judgeConfirmedQuote(counters, limits, { gross, lines: built.snapshot.lines.length, units, commercialVersion }),
  });
  if (decision.outcome === 'authorized') return { status: 'authorized' };
  return refused(decision.reasonCode, confirmedQuoteRefusalMessage(decision.reasonCode), {});
}

function refused(code: string, message: string, details: Readonly<Record<string, string | number | boolean | null>>): Decision {
  return { status: 'refused', result: { status: 'rejected', code, message, details: { ...details } } };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
