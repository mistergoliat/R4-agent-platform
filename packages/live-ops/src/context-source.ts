import type { ContextContributionInput } from '@r4/contracts';
import type { ContextSource, ContextSourceRequest } from '@r4/context-compiler';
import type { OutboundRecord, ProductionStore } from './ports.js';

export const DELIVERY_SOURCE_ID = 'production.delivery';

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

/** (ADR-041) The platform's fallback notice after a run failure, whatever its delivery state. */
function fallbackItem(o: OutboundRecord, taskId: string): ContextContributionInput {
  return {
    ...item(o, taskId),
    content: {
      about: 'After earlier runs of this task failed, the platform (not you) queued a fixed notice to the contact: a technical problem occurred and a person of the team would continue the conversation. It promised nothing else. Do not repeat it.',
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
