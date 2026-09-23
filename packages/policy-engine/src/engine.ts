import {
  identityAssuranceRank,
  type ActionAuthorizer,
  type PolicyEvaluation,
  type PolicyIdentity,
  type PolicyInput,
  type RiskClass,
} from '@r4/contracts';
import { loadActionPolicy, type ActionPolicyConfiguration, type ActionRule } from './configuration.js';

/**
 * Policy Engine (R4-D). Deterministic and pure: the same input and
 * configuration always yield the same evaluation; it performs no I/O, calls
 * no model, reads no natural language and knows no domain. It decides only
 * whether a governed action may execute — never what the agent should do.
 *
 * Rules are evaluated in a fixed order and the first that decides wins.
 * Structural denials come first (a human is never asked to approve something
 * the platform could not execute safely), then approvals, then autonomy.
 */
export class ActionPolicyEngine implements ActionAuthorizer {
  readonly identity: PolicyIdentity;
  readonly #configuration: ActionPolicyConfiguration;

  constructor(configuration: unknown) {
    const loaded = loadActionPolicy(configuration);
    this.identity = loaded.identity;
    this.#configuration = loaded.configuration;
  }

  evaluate(input: PolicyInput): PolicyEvaluation {
    const { capability, context, agent, task, proposal } = input;

    if (capability.riskClass === 'READ') {
      return deny('not_a_write', 'governance.read_is_not_an_action', `${capability.capabilityId} is READ: reads are invoked, not proposed`);
    }
    if (task.status !== 'running') {
      return deny('task_not_running', 'governance.task_running', `the task is ${task.status}`);
    }
    if (context.taskId !== task.taskId || context.agentId !== agent.agentId || context.agentVersion !== agent.version) {
      return deny('context_mismatch', 'governance.trusted_context', 'the trusted context does not belong to this task and agent');
    }
    const granted = new Set(context.grantedScopes);
    const declared = new Set(agent.capabilityScopes);
    const missing = capability.requiredScopes.filter((scope) => !granted.has(scope) || !declared.has(scope));
    if (missing.length > 0) {
      return deny('scope_denied', 'governance.scopes', `the agent lacks required scopes: ${missing.join(', ')}`);
    }
    if (capability.writeRecovery === null || capability.idempotency !== 'key_required') {
      return deny('unsafe_write_semantics', 'governance.write_semantics', `${capability.capabilityId} declares no safe replay or reconciliation strategy`);
    }
    if (identityAssuranceRank(context.identityAssurance) < identityAssuranceRank(capability.identityRequirement)) {
      return deny('identity_requirement_unmet', 'capability.identity_requirement', `${capability.capabilityId} requires ${capability.identityRequirement} identity; the task has ${context.identityAssurance}`);
    }

    const { rule, ruleId } = this.#ruleFor(capability.capabilityId, capability.riskClass);
    if (identityAssuranceRank(context.identityAssurance) < identityAssuranceRank(rule.minimumIdentity)) {
      return deny('insufficient_identity', `${ruleId}.minimum_identity`, `${capability.riskClass} requires ${rule.minimumIdentity} identity; the task has ${context.identityAssurance}`);
    }
    if (rule.requireEvidence && proposal.evidenceRefs.length === 0) {
      return deny('evidence_required', `${ruleId}.require_evidence`, 'this action must cite at least one observation');
    }
    if (rule.autonomy === 'deny') {
      return deny('risk_class_not_permitted', `${ruleId}.autonomy`, `${capability.riskClass} actions are not permitted by policy`);
    }
    if (capability.approvalPolicy === 'required') {
      return requireApproval('capability_requires_approval', 'capability.approval_policy', `${capability.capabilityId} requires approval`);
    }
    if (capability.confirmationPolicy === 'required') {
      return requireApproval('confirmation_required', 'capability.confirmation_policy', `${capability.capabilityId} requires confirmation, which only a human decision can provide`);
    }
    if (rule.autonomy === 'require_approval') {
      return requireApproval('risk_class_requires_approval', `${ruleId}.autonomy`, `${capability.riskClass} actions require approval`);
    }
    return { outcome: 'allow', reasonCode: 'autonomous', rule: `${ruleId}.autonomy`, message: `${capability.riskClass} actions are autonomous under this policy` };
  }

  #ruleFor(capabilityId: string, riskClass: Exclude<RiskClass, 'READ'>): { rule: ActionRule; ruleId: string } {
    const override = this.#configuration.capabilities[capabilityId];
    if (override) return { rule: override, ruleId: `capabilities.${capabilityId}` };
    return { rule: this.#configuration.riskClasses[riskClass], ruleId: `risk_classes.${riskClass}` };
  }
}

function deny(reasonCode: string, rule: string, message: string): PolicyEvaluation {
  return { outcome: 'deny', reasonCode, rule, message };
}

function requireApproval(reasonCode: string, rule: string, message: string): PolicyEvaluation {
  return { outcome: 'require_approval', reasonCode, rule, message };
}
