import { PlatformError } from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import { IDLE_TIMEOUT_REASON, type TemporalRuntime } from '@r4/task-runtime';
import type { IdleConversation, ProductionStore } from './ports.js';

/** Who closes idle cases, as recorded on the task's cancellation event. */
export const CASE_IDLE_CLOSE_ACTOR = 'platform:case-idle-close';
/** The binding's `closed_reason` (and the task's status reason) of an idle close. */
export const IDLE_TIMEOUT = IDLE_TIMEOUT_REASON;

export interface CaseIdleSweep {
  /** Bindings this sweep closed (one already closed by someone else is not counted). */
  readonly closed: number;
  /** Candidates the Temporal Runtime refused under the task lock (e.g. a message arrived meanwhile). */
  readonly notIdle: number;
  /** Candidates whose close failed (logged); the next sweep tries them again. */
  readonly failed: number;
}

/**
 * (Case idle close) Closes the case of a conversation of `channel` whose task has waited for the contact for `idleForMs`:
 * the task ends through the platform cancellation (status reason `idle_timeout`, a `task.cancelled` event carrying
 * the reason and the last activity) and its binding closes `idle_timeout`. Nothing is sent to the contact. The next
 * contact message opens a new binding and task, which sees the earlier turns (PriorConversationContextSource).
 *
 * Durable and concurrent-safe without state of its own: the store only pre-selects; the idle rule is decided again
 * by the Temporal Runtime under the task row lock that every input and delivery claim also takes, and a binding
 * closes only once (`closed_reason` is final). Two sweeps, or a sweep racing a message, therefore never lose the
 * message: it either wakes the old task first (not closed) or finds it terminal and opens the new case. A crash
 * between the task and the binding is finished by the next sweep (the binding of a task already `idle_timeout` is
 * selected again). One failing candidate never stops the others.
 */
export class CaseIdleCloser {
  readonly #store: ProductionStore;
  readonly #temporal: TemporalRuntime;
  readonly #channel: string;
  readonly #idleForMs: number;
  readonly #logger: StructuredLogger;

  constructor(options: { store: ProductionStore; temporal: TemporalRuntime; channel: string; idleForMs: number; logger: StructuredLogger }) {
    if (!Number.isInteger(options.idleForMs) || options.idleForMs <= 0) throw new PlatformError('validation', 'validation_failed', 'idleForMs must be a positive integer');
    this.#store = options.store;
    this.#temporal = options.temporal;
    this.#channel = options.channel;
    this.#idleForMs = options.idleForMs;
    this.#logger = options.logger;
  }

  /** At most `limit` cases, oldest first. */
  async sweep(limit = 50): Promise<CaseIdleSweep> {
    const tally = { closed: 0, notIdle: 0, failed: 0 };
    for (const c of await this.#store.idleConversations({ channel: this.#channel, idleForMs: this.#idleForMs, limit })) {
      try {
        const outcome = await this.#close(c);
        if (outcome !== 'skipped') tally[outcome] += 1;
      } catch (error) {
        tally.failed += 1;
        emitTelemetry(this.#logger, 'conversation.idle_close.skipped', { channel: c.channel, bindingId: c.bindingId, taskId: c.taskId, reason: 'failed', error: error instanceof PlatformError ? error.code : 'infrastructure' });
      }
    }
    return tally;
  }

  async #close(c: IdleConversation): Promise<'closed' | 'notIdle' | 'skipped'> {
    if (c.taskStatus === 'waiting') {
      const r = await this.#temporal.cancelIdleTaskByPlatform(c.taskId, {
        idleForMs: this.#idleForMs,
        note: `no contact message for ${this.#idleForMs / 3_600_000} h: the case is closed; the next message opens a new one`,
        actorRef: CASE_IDLE_CLOSE_ACTOR,
        correlationId: `case-idle-close:${c.taskId}`,
      });
      if (r.outcome === 'not_idle') {
        emitTelemetry(this.#logger, 'conversation.idle_close.skipped', { channel: c.channel, bindingId: c.bindingId, taskId: c.taskId, reason: r.refusal });
        return 'notIdle';
      }
      // Ended meanwhile by something else: whoever ended it decides the binding (ingress closes it on the next message).
      if (r.task.statusReason !== IDLE_TIMEOUT) return 'skipped';
    }
    if (!(await this.#store.closeBinding(c.bindingId, IDLE_TIMEOUT))) return 'skipped';
    emitTelemetry(this.#logger, 'conversation.binding.closed', { channel: c.channel, bindingId: c.bindingId, taskId: c.taskId, reason: IDLE_TIMEOUT });
    return 'closed';
  }
}
