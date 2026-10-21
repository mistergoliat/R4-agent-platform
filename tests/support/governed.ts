import { randomBytes, randomUUID } from 'node:crypto';
import { ActionExecutor, type CapabilityRegistry } from '@r4/capability-runtime';
import type { ActionAttemptKind, PolicyDecision, TrustedActionContext } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import type { ActionPolicyEngine } from '@r4/policy-engine';

/**
 * One governed write as the platform executes it (R4-D), without a model: the proposal is prepared by the
 * real ActionExecutor (input schema), authorized by the real ActionPolicyEngine, then executed by the
 * ActionExecutor with the command's platform execution key. Replays reuse the SAME execution key, as the
 * Execution Runtime does. Test support only.
 */
export interface GovernedWrite {
  readonly registry: CapabilityRegistry;
  readonly policy: ActionPolicyEngine;
  readonly taskId: string;
  readonly capabilityId: string;
  readonly args: unknown;
  readonly grantedScopes: readonly string[];
  readonly executionKey?: string;
  readonly attempt?: { readonly number: number; readonly kind: ActionAttemptKind };
}

export type GovernedOutcome =
  | { readonly stage: 'prepare'; readonly cause: string }
  | { readonly stage: 'policy'; readonly outcome: string; readonly reasonCode: string }
  | { readonly stage: 'executed'; readonly executionKey: string; readonly report: Awaited<ReturnType<ActionExecutor['attempt']>> };

export const newExecutionKey = () => `r4x_${randomBytes(16).toString('hex')}`;

export async function governedWrite(write: GovernedWrite): Promise<GovernedOutcome> {
  const executor = new ActionExecutor({ registry: write.registry, logger: createSilentLogger() });
  const prepared = executor.prepare({ capabilityId: write.capabilityId, arguments: write.args });
  if (!prepared.ok) return { stage: 'prepare', cause: prepared.cause };
  const proposalId = randomUUID();
  const runId = randomUUID();
  const correlationId = `governed-${randomBytes(4).toString('hex')}`;
  const context: TrustedActionContext = {
    taskId: write.taskId, runId, agentId: 'sales', agentVersion: 1, correlationId, grantedScopes: [...write.grantedScopes],
    actor: { kind: 'service', ref: 'sales-channel-ingress' }, identityAssurance: 'provisional',
  };
  const evaluation = write.policy.evaluate({
    proposal: { proposalId, evidenceRefs: [] },
    agent: { agentId: 'sales', version: 1, capabilityScopes: [...write.grantedScopes] },
    task: { taskId: write.taskId, status: 'running' },
    context,
    capability: { ...prepared.capability, writeRecovery: prepared.semantics?.recovery ?? null },
  });
  if (evaluation.outcome !== 'allow') return { stage: 'policy', outcome: evaluation.outcome, reasonCode: evaluation.reasonCode };
  const decisionId = randomUUID();
  const executionKey = write.executionKey ?? newExecutionKey();
  const decision = { decisionId, proposalId, capabilityId: prepared.capability.capabilityId, capabilityVersion: prepared.capability.version, outcome: 'allow' } as unknown as PolicyDecision;
  const command = {
    executionId: randomUUID(), proposalId, policyDecisionId: decisionId, taskId: write.taskId, runId, capabilityId: prepared.capability.capabilityId,
    capabilityVersion: prepared.capability.version, riskClass: prepared.capability.riskClass, executionKey, semantics: prepared.semantics!,
    validatedArguments: prepared.validatedArguments, trustedContext: context, correlationId, createdAt: new Date().toISOString(),
  };
  const report = await executor.attempt({ command: command as never, decision }, { attemptNumber: write.attempt?.number ?? 1, kind: write.attempt?.kind ?? 'execute' });
  return { stage: 'executed', executionKey, report };
}
