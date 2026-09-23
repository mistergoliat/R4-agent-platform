import type { Observation } from '@r4/contracts';
import type { ObservationStore } from '@r4/capability-runtime';

/**
 * Test double for unit tests of the invocation contract. NOT a runtime
 * implementation: production state is durable (PostgresObservationStore).
 */
export class InMemoryObservationStore implements ObservationStore {
  readonly byInvocation = new Map<string, Observation>();

  record(observation: Observation): Promise<Observation> {
    if (observation.source.kind !== 'capability') throw new Error('READ observations only');
    const existing = this.byInvocation.get(observation.source.invocationId);
    if (existing) return Promise.resolve(existing);
    this.byInvocation.set(observation.source.invocationId, observation);
    return Promise.resolve(observation);
  }

  findByInvocationId(invocationId: string): Promise<Observation | null> {
    return Promise.resolve(this.byInvocation.get(invocationId) ?? null);
  }
}
