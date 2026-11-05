import type { ContextContributionInput } from '@r4/contracts';
import type { ContextSource, ContextSourceRequest } from '@r4/context-compiler';
import type { OutboundRecord, ProductionStore, ThreadEntry } from './ports.js';

export const DELIVERY_SOURCE_ID = 'production.delivery';
export const PRIOR_CONVERSATION_SOURCE_ID = 'production.prior_conversation';

const MEANING: Readonly<Record<string, string>> = {
  pending: 'not sent yet',
  dispatching: 'being sent right now',
  unknown: 'it is NOT known whether the contact received it (the provider did not confirm; it will not be re-sent automatically)',
  failed: 'the contact did NOT receive it',
  cancelled: 'it was NOT sent',
};

/**
 * What happened to the agent's earlier responses after R4 accepted them
 * (R4-I): an honest, OBSERVED episode per response whose delivery is not
 * (yet) confirmed — pending, unknown, failed or cancelled with its reason —
 * so the next cognition neither assumes a message arrived nor repeats one
 * that did. Delivered/accepted responses are not repeated here (the
 * conversation projection already shows what the agent said). Registered
 * outside Core through `WorkerBindings.contextSources`; deterministic in the
 * durable delivery state.
 */
export class DeliveryStateContextSource implements ContextSource {
  readonly id = DELIVERY_SOURCE_ID;
  readonly #reader: Pick<ProductionStore, 'outboundForTask'>;

  constructor(reader: Pick<ProductionStore, 'outboundForTask'>) {
    this.#reader = reader;
  }

  async load(request: ContextSourceRequest): Promise<readonly ContextContributionInput[]> {
    const { task } = request.execution;
    const outbound = await this.#reader.outboundForTask(task.taskId);
    return outbound
      .filter((o) => (o.origin === 'agent' && o.status in MEANING && o.status !== 'dispatching') || o.origin === 'platform')
      .map((o) => (o.origin === 'platform' ? fallbackItem(o, task.taskId) : item(o, task.taskId)));
  }
}

const PRIOR_DELIVERY: Readonly<Record<string, string>> = {
  ...MEANING,
  accepted: 'sent; the provider accepted it',
  delivered: 'the contact received it',
  read: 'the contact received it',
};

const PRIOR_ABOUT =
  'Earlier conversation with this same contact, from previous tasks that have ended (the conversation turns marked earlierTask). ' +
  'It is what was said then, not current fact: availability, amounts, terms, approvals and checks stated then may have changed or expired, ' +
  'and nothing from those tasks is evidence for this one. Read again with your capabilities whatever you need to rely on. ' +
  'Do not repeat what the contact already received unless asked.';

/**
 * (R4-J4-R7-4) Continuity across the tasks of one channel conversation. A
 * terminal task is never revived: the next contact message opens a new task
 * (ingress). This source projects what was said in the earlier tasks of the
 * same conversation — the turns of their operator thread (contact, agent with
 * its delivery, operator), from at most `maxTasks` tasks and the last
 * `windowDays`, at most `maxTurns`, newest kept, in one store round trip — as
 * CONVERSATIONAL turns of the current task, plus one required OBSERVED
 * episode saying where they come from. The window bounds only this automatic
 * incorporation: nothing is deleted, and the current task is not filtered.
 *
 * What was said, never evidence: no observation, receipt, approval, goal or
 * workspace state of an earlier task enters, so none of it can be cited or
 * reused. The turns compete for the conversation budget like any other turn.
 * Deterministic in the durable records and the compilation's clock;
 * registered outside Core through `WorkerBindings.contextSources`.
 */
export class PriorConversationContextSource implements ContextSource {
  readonly id = PRIOR_CONVERSATION_SOURCE_ID;
  readonly #reader: Pick<ProductionStore, 'earlierConversationTurns'>;
  readonly #maxTurns: number;
  readonly #maxTasks: number;
  readonly #windowMs: number;

  constructor(reader: Pick<ProductionStore, 'earlierConversationTurns'>, options: { readonly maxTurns?: number; readonly maxTasks?: number; readonly windowDays?: number } = {}) {
    this.#reader = reader;
    this.#maxTurns = options.maxTurns ?? 20;
    this.#maxTasks = options.maxTasks ?? 10;
    this.#windowMs = (options.windowDays ?? 30) * 86_400_000;
  }

  async load(request: ContextSourceRequest): Promise<readonly ContextContributionInput[]> {
    const { taskId } = request.execution.task;
    const since = new Date(request.now.getTime() - this.#windowMs).toISOString();
    // One more than shown: whether older turns were left out.
    const { turns, earlierTasks } = await this.#reader.earlierConversationTurns(taskId, { since, limit: this.#maxTurns + 1, maxTasks: this.#maxTasks });
    if (turns.length === 0) return [];
    const shown = turns.slice(-this.#maxTurns);
    const last = shown.at(-1)!;
    return [
      {
        itemId: `prior_conversation:${taskId}`,
        kind: 'episode',
        authority: 'OBSERVED',
        temporality: 'point_in_time',
        content: { event: 'conversation.earlier_tasks', about: PRIOR_ABOUT, earlierTasks, turnsShown: shown.length, earlierTurnsOmitted: turns.length > shown.length || earlierTasks === this.#maxTasks },
        provenance: { recordType: 'agent_task', recordId: taskId, recordVersion: last.cursor },
        createdAt: last.at,
        observedAt: last.at,
        taskId,
        required: true,
      },
      ...shown.map((e): ContextContributionInput => priorTurn(e, taskId)),
    ];
  }
}

function priorTurn(e: ThreadEntry, taskId: string): ContextContributionInput {
  const ref = e.cursor.slice(e.cursor.indexOf('|') + 1);
  const role = e.kind === 'contact' ? 'participant' : e.kind;
  return {
    itemId: `prior_turn:${ref}`,
    kind: 'conversation_turn',
    authority: 'CONVERSATIONAL',
    temporality: 'point_in_time',
    content: {
      actor: { role },
      text: e.text,
      earlierTask: true,
      ...(e.kind === 'contact' ? {} : { delivery: e.delivery ? (PRIOR_DELIVERY[e.delivery.status] ?? e.delivery.status) : 'not sent' }),
    },
    provenance: { recordType: e.kind === 'contact' ? 'task_input' : e.kind === 'agent' ? 'agent_run_step' : 'outbound_message', recordId: ref },
    createdAt: e.at,
    observedAt: e.at,
    taskId,
  };
}

/** (ADR-041) The platform's fallback notice after a run failure, whatever its delivery state. */
function fallbackItem(o: OutboundRecord, taskId: string): ContextContributionInput {
  return {
    ...item(o, taskId),
    content: {
      about: 'After this task could not continue autonomously (a run failed or reached a limit), the platform (not you) queued a fixed notice to the contact: a technical problem occurred and a person of the team would continue the conversation. It promised nothing else. Do not repeat it.',
      status: o.status,
      meaning: MEANING[o.status] ?? 'the provider accepted it',
      reason: o.cancelReason ?? o.holdReason ?? o.errorClass,
    },
  };
}

function item(o: OutboundRecord, taskId: string): ContextContributionInput {
  return {
    itemId: `delivery:${o.outboundId}`,
    kind: 'episode',
    authority: 'OBSERVED',
    temporality: 'point_in_time',
    content: {
      about: 'Delivery state of one of your earlier responses to the contact, as the delivery owner recorded it. Accepting a response does not mean the contact received it.',
      responseStepId: o.responseStepId,
      status: o.status,
      meaning: MEANING[o.status] ?? o.status,
      reason: o.cancelReason ?? o.holdReason ?? o.errorClass,
    },
    provenance: { recordType: 'outbound_message', recordId: o.outboundId, recordVersion: `${o.status}:${o.updatedAt}`, producedBy: 'delivery' },
    createdAt: o.createdAt,
    observedAt: o.updatedAt,
    taskId,
  };
}
