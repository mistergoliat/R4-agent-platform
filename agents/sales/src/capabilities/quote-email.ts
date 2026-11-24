import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type QuoteV2Service } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult } from '@r4/capability-runtime';
import type { ConversationThreadReader } from './quote-v4.js';

export const QUOTE_EMAIL_CAPABILITY_ID = 'quote.email';
export const QUOTE_EMAIL_SCOPE = 'quote.email';

/** One mailbox, as the Quote owner's strict check accepts it: no spaces, no list or comment syntax, exactly one @. */
const MAILBOX = /^[^\s<>,;:"()[\]\\@]{1,64}@[^\s<>,;:"()[\]\\@]{1,189}\.[^\s<>,;:"()[\]\\@]{2,63}$/;

export const quoteEmailInput = z.strictObject({
  quoteNumber: z.string().trim().min(1).max(40),
  email: z.string().trim().max(254),
});
export type QuoteEmailInput = z.infer<typeof quoteEmailInput>;

export const quoteEmailOutput = z.strictObject({
  quoteNumber: z.string(),
  status: z.enum(['pending', 'sending', 'sent', 'failed', 'unknown']),
  /** The owner's masked address (e.g. ca***@gmail.com): what the agent may tell the customer. */
  recipientMasked: z.string(),
});
export type QuoteEmailOutput = z.infer<typeof quoteEmailOutput>;

export interface QuoteEmailDeps {
  /** The quotes issued in this conversation: Quote V2 issuance records them in sales.quote_v2_issued (conversationQuotes). */
  readonly store: { conversationQuotes(taskIds: readonly string[], options: { readonly since: string; readonly limit: number }): Promise<readonly { readonly quoteId: string; readonly quoteNumber: string }[]> };
  readonly quotes: QuoteV2Service;
  /** The conversation the platform recorded: the address must be one the customer wrote. */
  readonly conversation: ConversationThreadReader;
}

type Refusal = Extract<WriteExecutionResult<never>, { status: 'rejected' | 'failed' }>;
const rejected = (code: string, message: string): Refusal => ({ status: 'rejected', code, message });

/**
 * (ADR-057 C4) quote.email@1: asks the Quote owner to email the issued quote's PDF to the customer
 * (POST /v2/quotes/{id}/deliveries/email). Model output is untrusted, so the platform checks, before anything is sent:
 *  - the quote was issued in THIS conversation (never another customer's quote);
 *  - the address appears in the customer's OWN messages of this conversation (never one the model wrote or guessed);
 *  - it is one strict mailbox.
 * The same quote and address always use the same owner key: a retry or a repeated request replays the one delivery,
 * never a second email. Only the owner's masked address comes back; the raw address is never in the output.
 */
export function quoteEmailCapability(deps: QuoteEmailDeps): WriteCapabilityRegistration<QuoteEmailInput, QuoteEmailOutput> {
  return {
    definition: {
      capabilityId: QUOTE_EMAIL_CAPABILITY_ID,
      version: 1,
      description:
        'Emails the PDF of a quote issued in this conversation to the customer, through the quote owner. Use it only when the customer asked for the quote by email and wrote their email address in this conversation; pass the quoteNumber of the issued quote and that address exactly as they wrote it. Refused, with nothing sent, when the quote was not issued in this conversation, when the address does not appear in the customer\'s own messages (ask them to write it), when it is not a single valid address, or when email is unavailable right now (say so; never promise the email). The result gives only the masked address (for example ca***@gmail.com): tell the customer it was sent there, never the full address, and never that it arrived.',
      owner: 'quote',
      riskClass: 'EXTERNAL_COMMUNICATION',
      requiredScopes: [QUOTE_EMAIL_SCOPE],
      identityRequirement: 'provisional',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 1_000 },
      timeoutMs: 15_000,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: 'idempotent_replay',
    input: quoteEmailInput,
    output: quoteEmailOutput,
    async execute(input, context) {
      const taskId = context.execution.taskId;
      const email = input.email.toLowerCase();
      if (!MAILBOX.test(email)) return rejected('invalid_email', 'that is not one valid email address: ask the customer to write it again');
      const quote = (await deps.store.conversationQuotes([taskId], { since: '1970-01-01T00:00:00Z', limit: 100 })).find((q) => q.quoteNumber.toUpperCase() === input.quoteNumber.toUpperCase());
      if (!quote) return rejected('quote_not_in_conversation', 'no quote with that number was issued in this conversation: only a quote issued here can be emailed');
      const thread = await deps.conversation.thread(taskId);
      const fromCustomer = thread.some((e) => e.kind === 'contact' && typeof e.text === 'string' && e.text.toLowerCase().includes(email));
      if (!fromCustomer) return rejected('email_not_from_customer', 'the customer has not written that address in this conversation: ask them to write the email address where they want the quote');
      // ponytail: one delivery per (quote, address); no cap on how many different addresses the customer writes — add one if abused.
      const key = `r4-qe_${createHash('sha256').update(`${taskId}|${quote.quoteId}|${email}`).digest('hex').slice(0, 48)}`;
      try {
        const { delivery } = await deps.quotes.requestEmailDelivery(quote.quoteId, { recipient: { email } }, key, { signal: context.signal, correlationId: context.execution.correlationId });
        return { status: 'applied', result: { quoteNumber: quote.quoteNumber, status: delivery.status, recipientMasked: delivery.recipientMasked }, resourceRef: `quote-delivery:${delivery.deliveryId}`, externalOperationRef: key, replayed: false };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        // The owner queued nothing: say so honestly.
        if (error.code === 'email_provider_unavailable' || error.code === 'autonomy_disabled' || error.category === 'temporarily_unavailable') return { status: 'failed', code: 'email_unavailable', message: 'the quote cannot be emailed right now (nothing was sent): tell the customer plainly and offer to try again later; never promise the email' };
        if (error.category === 'conflict') return { status: 'failed', code: 'quote_not_issued', message: 'the quote is no longer valid (expired or cancelled): it cannot be emailed; nothing was sent' };
        if (error.category === 'validation') return rejected('invalid_email', 'the quote owner refused that address: ask the customer to check it');
        // Possibly queued (5xx after send, timeout): the same key replays the one delivery on the next attempt.
        if (error.category === 'unknown_outcome' || error.category === 'timeout') return { status: 'unknown', message: 'the quote owner did not confirm the email request; it is retried with the same key, so it is never sent twice' };
        return { status: 'failed', code: 'email_failed', message: `the quote could not be emailed (${error.code}); nothing was sent` };
      }
    },
  };
}
