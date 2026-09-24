/**
 * Autonomy precedence (R4-I) — pure, total, one place.
 *
 *   kill switch (global or channel)  >  explicit deny  >  rollout eligibility
 *   (stable per conversation)  >  inbound content policy  >  production policy
 *
 * Human ownership is not decided here: it is durable task state (R4-E) and
 * always wins — a hold on a human-owned task is a no-op, and delivery never
 * sends agent output for a task humans own. Policy ALLOW (R4-D) is evaluated
 * only for actions of a run that exists, i.e. after everything above allowed
 * autonomy: it can never override the kill switch or the rollout.
 */
export interface AutonomyControlsState {
  /** False when the global kill switch is engaged, or when it cannot be read (fail closed). */
  readonly globalEnabled: boolean;
  /** Per-channel switches; a channel without a row follows the global switch. */
  readonly channels: Readonly<Record<string, boolean>>;
  /** Monotonic version of the controls (audit: which state a decision saw). */
  readonly version: string;
}

export function autonomyEnabledFor(controls: AutonomyControlsState, channel: string): { enabled: boolean; scope: 'global' | 'channel' } {
  if (!controls.globalEnabled) return { enabled: false, scope: 'global' };
  if (Object.hasOwn(controls.channels, channel) && controls.channels[channel] === false) return { enabled: false, scope: 'channel' };
  return { enabled: true, scope: 'global' };
}

/** Reason codes of platform holds (task status reasons; also the handoff reason). */
export const HOLD_REASONS = {
  killSwitch: 'autonomy_disabled',
  denied: 'autonomy_denied',
  rolloutExcluded: 'rollout_excluded',
  unsupportedContent: 'unsupported_inbound_content',
} as const;
export type HoldReason = (typeof HOLD_REASONS)[keyof typeof HOLD_REASONS];

export type InboundAutonomyDecision = { readonly kind: 'autonomous' } | { readonly kind: 'hold'; readonly reason: HoldReason; readonly summary: string };

export interface InboundAutonomyFacts {
  readonly controls: AutonomyControlsState;
  readonly channel: string;
  /** The conversation is on the rollout denylist now. */
  readonly deniedNow: boolean;
  /** The conversation's binding was created eligible (stable per conversation). */
  readonly bindingAutonomous: boolean;
  readonly unsupportedContent: boolean;
  readonly unsupportedContentPolicy: 'handoff' | 'inform_agent';
}

/** What a new inbound event may do to its task: continue autonomously, or hold the task for humans. */
export function decideInboundAutonomy(f: InboundAutonomyFacts): InboundAutonomyDecision {
  const control = autonomyEnabledFor(f.controls, f.channel);
  if (!control.enabled) return { kind: 'hold', reason: HOLD_REASONS.killSwitch, summary: `Autonomous operation is disabled (${control.scope} autonomy control). The contact's message was recorded; an operator must handle the conversation or release it once autonomy is enabled again.` };
  if (f.deniedNow) return { kind: 'hold', reason: HOLD_REASONS.denied, summary: 'This conversation is explicitly excluded from autonomous operation. The contact message was recorded for an operator.' };
  if (!f.bindingAutonomous) return { kind: 'hold', reason: HOLD_REASONS.rolloutExcluded, summary: 'This conversation is not in an enabled production cohort. The contact message was recorded for an operator; no autonomous response is produced.' };
  if (f.unsupportedContent && f.unsupportedContentPolicy === 'handoff') return { kind: 'hold', reason: HOLD_REASONS.unsupportedContent, summary: 'The contact sent content R4 cannot represent (e.g. media). An operator must look at it in the channel.' };
  return { kind: 'autonomous' };
}
