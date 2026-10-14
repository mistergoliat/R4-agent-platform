import { createHash } from 'node:crypto';
import { DomainError, canonicalJson, quoteV2Totals, type QuoteV2CreateResult } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult, WriteHandlerContext } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { snapshotLimitBreaches } from './autonomy-limits.js';
import { buildCommercialSnapshot, quoteRequestOf, type CommercialBlocker } from './commercial-snapshot.js';
import { OFFER_MESSAGE_MAX_CHARS, OFFER_TEMPLATE_VERSION, offerReference, renderOfferMessage } from './offer-presentation.js';
import { QUOTE_V2_CORRELATION, QUOTE_V2_TIMEOUT_MS, classifySend, quoteCreateV2Output, reconcileQuoteV2Command, settle, type QuoteCreateV2Output } from './quote-v2.js';
import { quoteCreateV3Input, type QuoteCreateV3Input } from './quote-v3.js';
import { confirmedQuoteRefusalMessage, judgeConfirmedQuote, locateConfirmation, type QuoteV4CapabilityDeps } from './quote-v4.js';

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
}

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
  return {
    definition: {
      capabilityId: CAPABILITY_IDS.quoteCreate,
      version: 5,
      description:
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
      if (!record) {
        // Before any decision: a stopped issuance leaves no authorization behind, so it can be proposed again once released.
        const gate = await admit();
        if (!gate.admitted) return writesBlocked(gate.reason);
        const decided = await decide(deps, input, context, now());
        if (decided.status !== 'authorized') return decided.result;
        record = await store.quoteV2Request(context.executionKey);
        if (!record) throw new Error(`authorized quote ${context.executionKey} has no frozen request`);
      }
      // Authorized and frozen: from here a stop is held on this key, never failed (it would strand the authorization).
      const gate = await admit();
      if (!gate.admitted) return sendHeld(gate.reason);
      await store.recordQuoteV2Send(context.executionKey);
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
      return settle(deps, record, result.quote, result.operation, result.replayed, context, { strict: true });
    },
    reconcile: (context) => reconcileQuoteV2Command(deps, context, { strict: true }),
  };
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
  const expected = renderOfferMessage(built.snapshot, reference);
  const offer = { reference, offerTemplate: OFFER_TEMPLATE_VERSION, offerMessageSha256: sha256(expected) };
  if (expected.length > OFFER_MESSAGE_MAX_CHARS) {
    return refuse({ code: 'offer_message_too_long', message: `the offer message would exceed ${OFFER_MESSAGE_MAX_CHARS} characters and is never presented`, details: { characters: expected.length, limit: OFFER_MESSAGE_MAX_CHARS } }, { snapshot: built.snapshot, confirmation: offer });
  }

  // 3. The conversation the platform recorded: the offer message, its delivery and the customer's confirmation (quote.create@4 rules).
  const found = locateConfirmation(await deps.conversation.thread(taskId), reference, gross, limits.confirmationWindowSeconds);
  if (found.status !== 'confirmed') return refuse(found.blocker, { snapshot: built.snapshot, confirmation: { ...offer, ...found.trace } });
  const evidence = found.evidence(commercialVersion, reference, gross);

  // 4. Byte for byte: the message the customer answered IS the Sales rendering (the evidence keeps its SHA-256, 0009).
  if (evidence.offerTextSha256 !== offer.offerMessageSha256) {
    return refuse(
      { code: 'offer_not_presented', message: 'the message the customer answered is not exactly the offer Sales rendered for this quote (every line, amount, shipping, total and the reference must match character for character): preview again and reply with presentation.offerMessage exactly', details: { offerTemplate: OFFER_TEMPLATE_VERSION, expectedSha256: offer.offerMessageSha256, presentedSha256: evidence.offerTextSha256 } },
      { snapshot: built.snapshot, confirmation: { ...offer, offerRef: evidence.offerRef, confirmationInputId: evidence.confirmationInputId } },
    );
  }
  const confirmation = { source: 'conversation_thread', ...offer, offerRef: evidence.offerRef, confirmationInputId: evidence.confirmationInputId, grammarVersion: evidence.grammarVersion, grammarRule: evidence.grammarRule };

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
