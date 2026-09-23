import type { CompiledContext } from '@r4/contracts';
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

/**
 * A compact view of what the model received, projected from the structured
 * compiled context of the request (R4-C2). Observations include expired ones
 * kept as history.
 */
export interface RenderedContext {
  iteration: number;
  task: { taskId: string; input: Record<string, unknown> };
  capabilities: { capabilityId: string }[];
  observations: { observationId: string; capabilityId: string; outcome: string; payload: unknown; error: { code: string } | null }[];
  responses: { iteration: number; content: string }[];
  budget: { remaining: Record<string, number | null> };
}

export function compiledOf(request: ModelRequest): CompiledContext {
  if (!request.context) throw new Error('model request carries no compiled context');
  return request.context;
}

export function contextOf(request: ModelRequest): RenderedContext {
  const { scope, sections } = compiledOf(request);
  const task = sections.task.find((i) => i.kind === 'task')!.content as RenderedContext['task'];
  const execution = sections.task.find((i) => i.kind === 'execution_constraints')!.content as { remaining: Record<string, number | null> };
  return {
    iteration: scope.iteration,
    task,
    capabilities: sections.capabilities.map((i) => i.content as { capabilityId: string }),
    observations: [...sections.observations, ...sections.history.filter((i) => i.kind === 'observation')].map((i) => i.content as RenderedContext['observations'][number]),
    responses: sections.conversation
      .filter((i) => i.sourceId === 'platform.run')
      .map((i) => {
        const content = i.content as { iteration: number; text: string };
        return { iteration: content.iteration, content: content.text };
      }),
    budget: { remaining: execution.remaining },
  };
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

/** R4-D: a proposed action (only capability id, arguments and optional evidence — nothing trusted). */
export function propose(capabilityId: string, args: Record<string, unknown>, evidenceRefs?: string[]): FakeModelStep {
  return { type: 'structured', data: { type: 'propose_action', capabilityId, arguments: args, ...(evidenceRefs ? { evidenceRefs } : {}) } };
}
