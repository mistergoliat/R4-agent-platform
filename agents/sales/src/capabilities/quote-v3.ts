import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, canonicalJson, quoteV2Totals, type QuoteV2CreateResult } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult, WriteHandlerContext } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { previewIdSchema } from '../workspace/model.js';
import type { AutonomousQuoteCounters } from '../workspace/store.js';
import { snapshotLimitBreaches, type AutonomousQuoteLimits } from './autonomy-limits.js';
import { buildCommercialSnapshot, quoteRequestOf, type CommercialBlocker } from './commercial-snapshot.js';
import { QUOTE_V2_CORRELATION, QUOTE_V2_TIMEOUT_MS, classifySend, quoteCreateV2Output, reconcileQuoteV2Command, settle, type QuoteCreateV2Output, type QuoteV2CapabilityDeps } from './quote-v2.js';

/**
 * What a quote.create@3 proposal states: only WHICH previewed quote the
 * customer asked for. Every commercial fact is recomputed from the workspace
 * and the owners at execution; the model can state no price, quantity,
 * shipping, total, discount or customer datum.
 */
export const quoteCreateV3Input = z.strictObject({ previewId: previewIdSchema });
export type QuoteCreateV3Input = z.infer<typeof quoteCreateV3Input>;

export interface QuoteV3CapabilityDeps extends QuoteV2CapabilityDeps {
  readonly limits: AutonomousQuoteLimits;
}

/**
 * quote.create@3 (R4-J3E, ADR-034) — governed IRREVERSIBLE_WRITE over the
 * same Quote V2 port, request shape, frozen-body idempotency, settlement and
 * reconciliation as quote.create@2. It differs in WHO vouches for the
 * commercial facts: not a human approver but a deterministic commercial
 * decision taken on the first attempt, before anything is frozen or sent:
 *
 *   1. the customer's quote request is recorded in the workspace and names
 *      exactly this previewId;
 *   2. the commercial snapshot recomputed NOW from the workspace and the
 *      owners (Catalog price for the tier, tax, sellability, stock,
 *      freshness; the chosen Shipping offer re-quoted at the agreed NET;
 *      Quote V2 arithmetic) has no blocker and the same previewId;
 *   3. it is within the configured amount, line and quantity limits;
 *   4. under one lock: no earlier authorization of this snapshot in this
 *      conversation, and the per-conversation and per-hour limits hold.
 *
 * The decision is recorded (0008) — authorized together with the frozen
 * request in one transaction, or rejected with its reason — and a refusal is
 * returned as `rejected` (nothing issued) with the reason for the agent to
 * explain. There is no fallback to a human: a refused issuance is refused.
 * approvalPolicy is `none`; whether the platform may run it at all is still
 * decided by the Policy Engine (sales-production@5 policy).
 */
export function quoteCreateV3Capability(deps: QuoteV3CapabilityDeps): WriteCapabilityRegistration<QuoteCreateV3Input, QuoteCreateV2Output> {
  const { store, quotes } = deps;
  const now = deps.now ?? (() => new Date());
  return {
    definition: {
      capabilityId: CAPABILITY_IDS.quoteCreate,
      version: 3,
      description:
        'Issues the formal quote (Quote owner V2) previewed by quote.preview, without a human approval, for the previewId the customer asked for. Before proposing: the selection, destination and shipping choice are final, quote.preview returned status=ready with no limitBreaches, and the customer\'s request for THAT preview was recorded (sales.workspace.update record_quote_request with the previewId and the customer\'s words). The only argument is that previewId. At execution the quote is rebuilt from the workspace and the owners; it is refused, with nothing issued, when anything changed (preview_stale: preview again and show the customer the new figures), the customer did not ask for this preview, an autonomy limit would be exceeded, or the same quote was already issued in this conversation. Quote numbers, totals and validity come only from the result of an issued quote.',
      owner: 'quote',
      riskClass: 'IRREVERSIBLE_WRITE',
      requiredScopes: [SCOPES.quoteCreate],
      identityRequirement: 'provisional',
      confirmationPolicy: 'none',
      // ADR-034: no mandatory human approval for this version; the Policy Engine still decides, and the commercial decision below gates every effect.
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

/** The autonomous commercial decision of one command (first attempt; a decision already recorded for the key is replayed). Sends nothing. */
async function decide(deps: QuoteV3CapabilityDeps, input: QuoteCreateV3Input, context: WriteHandlerContext, now: Date): Promise<Decision> {
  const { store, limits } = deps;
  const taskId = context.execution.taskId;
  const executionKey = context.executionKey;
  const limitsRecord = { ...limits };
  const prior = await store.autonomousDecision(executionKey);
  if (prior) return prior.outcome === 'authorized' ? { status: 'authorized' } : refused(prior.reasonCode, `this command was already refused (${prior.reasonCode})`, {});

  const refuse = async (blocker: CommercialBlocker, extra: { snapshot?: object | null; quoteRequest?: object | null; measurements?: object } = {}): Promise<Decision> => {
    await store.recordAutonomousRejection({ executionKey, taskId, previewId: input.previewId, reasonCode: blocker.code, snapshot: extra.snapshot ?? null, limits: limitsRecord, measurements: extra.measurements ?? { blocker }, quoteRequest: extra.quoteRequest ?? null });
    return refused(blocker.code, blocker.message, blocker.details);
  };

  const workspace = await store.workspace(taskId);
  const request = workspace.state.quoteRequest ?? null;
  if (!request) return refuse({ code: 'quote_not_requested', message: 'the customer\'s request for this quote is not recorded: show the preview and record their request (record_quote_request) before issuing', details: {} });
  const quoteRequest = { previewId: request.previewId, customerWords: request.customerWords, sinceVersion: request.sinceVersion };
  if (request.previewId !== input.previewId) {
    return refuse({ code: 'quote_request_other_preview', message: 'the customer asked for a different preview than the one proposed', details: { requestedPreviewId: request.previewId } }, { quoteRequest });
  }

  let built: Awaited<ReturnType<typeof buildCommercialSnapshot>>;
  try {
    built = await buildCommercialSnapshot(deps, workspace, { signal: context.signal, correlationId: context.execution.correlationId }, now);
  } catch (error) {
    // Nothing was decided, frozen or sent: an owner outage is a definitive "no effect"; the platform may retry the same command.
    if (!(error instanceof DomainError)) throw error;
    return { status: 'refused', result: { status: 'failed', code: 'quote_evidence_unavailable', message: `commercial evidence could not be verified: ${error.message}`, details: { category: error.category, ownerCode: error.code, retryable: true } } };
  }
  if (built.status === 'blocked') {
    const first = built.blockers[0]!;
    return refuse({ ...first, details: { ...first.details, blockers: built.blockers.map((b) => b.code).join(',') } }, { quoteRequest, measurements: { blockers: built.blockers } });
  }
  if (built.previewId !== input.previewId) {
    return refuse({ code: 'preview_stale', message: 'the quote would differ from the preview the customer asked for (an owner price, offer or the selection changed): preview again and show the customer the new figures', details: { currentPreviewId: built.previewId } }, { snapshot: built.snapshot, quoteRequest });
  }
  const breaches = snapshotLimitBreaches(built.snapshot, limits);
  if (breaches.length > 0) return refuse(breaches[0]!, { snapshot: built.snapshot, quoteRequest, measurements: { breaches } });

  const body = quoteRequestOf(built.snapshot, built.evidence, { ...QUOTE_V2_CORRELATION, externalReference: taskId });
  const computed = quoteV2Totals(body);
  if (computed.net !== built.snapshot.totals.net || computed.tax !== built.snapshot.totals.tax || computed.gross !== built.snapshot.totals.gross) {
    // Defensive: the request must carry exactly the snapshot's arithmetic (the owner would refuse it with 422 anyway).
    return refuse({ code: 'expected_totals_mismatch', message: 'the request totals differ from the snapshot totals', details: { computedGross: computed.gross } }, { snapshot: built.snapshot, quoteRequest });
  }
  const units = built.snapshot.lines.reduce((total, l) => total + l.quantity, 0);
  const { decision } = await store.decideAutonomousQuote({
    executionKey,
    taskId,
    previewId: input.previewId,
    snapshot: built.snapshot,
    limits: limitsRecord,
    quoteRequest,
    workspaceVersion: workspace.version,
    request: body,
    requestSha256: createHash('sha256').update(canonicalJson(body)).digest('hex'),
    judge: (counters) => judge(counters, limits, { gross: built.snapshot.totals.gross, lines: built.snapshot.lines.length, units }),
  });
  if (decision.outcome === 'authorized') return { status: 'authorized' };
  return refused(decision.reasonCode, refusalMessage(decision.reasonCode), {});
}

/** The frequency and duplicate checks, measured under the decision lock. */
function judge(counters: AutonomousQuoteCounters, limits: AutonomousQuoteLimits, measured: { gross: number; lines: number; units: number }): { reasonCode: string; measurements: object } {
  const measurements = { ...counters, ...measured };
  if (counters.sameSnapshotAuthorizedBy !== null) return { reasonCode: 'duplicate_quote', measurements };
  if (counters.authorizedInConversation >= limits.maxQuotesPerConversation) return { reasonCode: 'autonomy_limit_conversation', measurements };
  if (counters.authorizedLastHour >= limits.maxQuotesPerHour) return { reasonCode: 'autonomy_limit_rate', measurements };
  return { reasonCode: 'eligible', measurements };
}

function refusalMessage(code: string): string {
  switch (code) {
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

export { quoteCreateV2Output as quoteCreateV3Output };
export type { QuoteCreateV2Output as QuoteCreateV3Output };
