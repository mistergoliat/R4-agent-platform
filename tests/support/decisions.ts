import type { FakeModelScript, FakeModelStep, ModelRequest } from '@r4/model-gateway';

/**
 * Helpers to script FakeModelProvider with AgentDecisions. They produce plain
 * FakeModelSteps — the provider itself needs no decision-specific behavior.
 */

export function read(capabilityId: string, args: Record<string, unknown>): FakeModelStep {
  return { type: 'structured', data: { type: 'read_capability', capabilityId, arguments: args } };
}

export function respond(content: string): FakeModelStep {
  return { type: 'structured', data: { type: 'respond', content } };
}

export function complete(summary: string, evidence: string[] = [], data?: Record<string, unknown>): FakeModelStep {
  return { type: 'structured', data: { type: 'complete', result: { summary, evidence, ...(data ? { data } : {}) } } };
}

/** The execution context document the kernel rendered for this call. */
export interface RenderedContext {
  iteration: number;
  task: { taskId: string; input: Record<string, unknown> };
  capabilities: { capabilityId: string }[];
  observations: { observationId: string; capabilityId: string; outcome: string; payload: unknown; error: { code: string } | null }[];
  responses: { iteration: number; content: string }[];
  budget: { remaining: Record<string, number | null> };
}

export function contextOf(request: ModelRequest): RenderedContext {
  const user = request.messages.find((m) => m.role === 'user');
  if (!user) throw new Error('no user message in model request');
  return JSON.parse(user.content) as RenderedContext;
}

/** Completes citing every observation the model was shown — proves the observation reached the model. */
export function completeFromObservations(summary = 'done'): (request: ModelRequest) => FakeModelStep {
  return (request) => {
    const ctx = contextOf(request);
    return complete(summary, ctx.observations.map((o) => o.observationId), { observed: ctx.observations.map((o) => o.payload) as unknown as Record<string, unknown> });
  };
}

export type ScriptEntry = FakeModelStep | ((request: ModelRequest) => FakeModelStep);

/** Sequential script whose entries may inspect the request. */
export function sequence(entries: readonly ScriptEntry[]): FakeModelScript {
  return (request, index) => {
    const entry = entries[index];
    if (!entry) return { type: 'provider_error', message: `script exhausted at call ${index + 1}` };
    return typeof entry === 'function' ? entry(request) : entry;
  };
}

/**
 * Stateless per-task behavior for concurrent workers: READ the fact while the
 * task has no observation, then complete citing it. Independent of global
 * call order, so any number of tasks can share one provider.
 */
export function readThenComplete(capabilityId: string, args: Record<string, unknown>): FakeModelScript {
  return (request) => (contextOf(request).observations.length === 0 ? read(capabilityId, args) : completeFromObservations('fact retrieved')(request));
}
