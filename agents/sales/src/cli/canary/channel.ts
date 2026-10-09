import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CanonicalInbound, OutboundChannelAdapter, OutboundSubmission, SubmissionResult } from '@r4/live-ops';
import { SYNTHETIC_CHANNEL } from './isolation.js';

/** The provider-side account of every synthetic conversation (identifies the traffic as canary traffic). */
export const SYNTHETIC_ACCOUNT = 'sales-canary';

const CONVERSATION = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function syntheticConversationRef(conversation: string): string {
  if (!CONVERSATION.test(conversation)) throw new Error('--conversation must be 1-64 characters [a-z0-9._-], starting with a letter or digit');
  return `synthetic:${conversation}`;
}

/**
 * One synthetic customer message as canonical inbound — the same shape a
 * channel adapter produces, on the synthetic channel, with a synthetic
 * account, conversation and event identity, and metadata that says so.
 */
export function syntheticInbound(input: { readonly conversation: string; readonly text: string; readonly canaryId: string; readonly eventId?: string; readonly occurredAt?: string }): CanonicalInbound {
  const conversationRef = syntheticConversationRef(input.conversation);
  return {
    channel: SYNTHETIC_CHANNEL,
    accountRef: SYNTHETIC_ACCOUNT,
    conversationRef,
    senderRef: conversationRef,
    providerEventId: `synthetic:${input.eventId ?? randomUUID()}`,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    content: { kind: 'text', text: input.text },
    metadata: { synthetic: true, canaryId: input.canaryId },
  };
}

export interface CapturedOutbound {
  readonly outboundId: string;
  readonly idempotencyKey: string;
  readonly accountRef: string;
  readonly recipientRef: string;
  readonly attempt: number;
  readonly text: string;
  readonly capturedAt: string;
}

/**
 * The canary's outbound "provider": appends each submission to a local
 * JSONL file and acknowledges it. It never opens a network connection; it
 * is declared `local-fake`, so a production gateway (which requires a
 * `real` binding for a REAL channel) can never compose it. The delivery
 * lifecycle around it is the real one (OutboundDeliveryRuntime: claim,
 * lease, fenced outcome).
 */
export class CaptureOutboundAdapter implements OutboundChannelAdapter {
  readonly channel = SYNTHETIC_CHANNEL;
  readonly bindingKind = 'local-fake' as const;
  readonly contractRef = 'r4-sales-canary:local-capture (JSONL file; no provider)';
  readonly customerWindowMs = null;
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
    mkdirSync(dirname(file), { recursive: true });
  }

  get file(): string {
    return this.#file;
  }

  submit(submission: OutboundSubmission): Promise<SubmissionResult> {
    const started = Date.now();
    const record: CapturedOutbound = {
      outboundId: submission.outboundId, idempotencyKey: submission.idempotencyKey, accountRef: submission.accountRef, recipientRef: submission.recipientRef,
      attempt: submission.attempt, text: submission.text, capturedAt: new Date().toISOString(),
    };
    try {
      appendFileSync(this.#file, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    } catch {
      // Nothing was recorded: definitely not delivered, so the delivery owner may retry within its budget.
      return Promise.resolve({ outcome: 'not_sent', providerMessageId: null, httpStatus: null, errorClass: 'capture_write_failed', errorCode: null, retryAfterMs: null, latencyMs: Date.now() - started });
    }
    return Promise.resolve({ outcome: 'accepted', providerMessageId: `capture:${submission.outboundId}`, httpStatus: null, errorClass: null, errorCode: null, retryAfterMs: null, latencyMs: Date.now() - started });
  }
}
