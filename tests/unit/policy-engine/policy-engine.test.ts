import { describe, expect, it } from 'vitest';
import { POLICY_OUTCOMES, RISK_CLASSES, type PolicyInput, type RiskClass } from '@r4/contracts';
import { ActionPolicyEngine, DEFAULT_ACTION_POLICY, POLICY_ENGINE_VERSION, loadActionPolicy } from '@r4/policy-engine';

const TASK = '0190e7a3-0000-7000-8000-000000000001';
const RUN = '0190e7a3-0000-7000-8000-000000000002';

function input(overrides: { riskClass?: RiskClass; capability?: Partial<PolicyInput['capability']>; context?: Partial<PolicyInput['context']>; agentScopes?: string[]; evidenceRefs?: string[]; taskStatus?: PolicyInput['task']['status'] } = {}): PolicyInput {
  return {
    proposal: { proposalId: '0190e7a3-0000-7000-8000-000000000003', evidenceRefs: overrides.evidenceRefs ?? [] },
    agent: { agentId: 'probe', version: 1, capabilityScopes: overrides.agentScopes ?? ['test.write'] },
    task: { taskId: TASK, status: overrides.taskStatus ?? 'running' },
    context: {
      taskId: TASK,
      runId: RUN,
      agentId: 'probe',
      agentVersion: 1,
      correlationId: 'c',
      grantedScopes: ['test.write'],
      actor: { kind: 'service', ref: 'caller' },
      identityAssurance: 'provisional',
      ...overrides.context,
    },
    capability: {
      capabilityId: 'test.set_thing',
      version: 1,
      riskClass: overrides.riskClass ?? 'REVERSIBLE_WRITE',
      requiredScopes: ['test.write'],
      identityRequirement: 'none',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'key_required',
      writeRecovery: 'idempotent_replay',
      ...overrides.capability,
    },
  };
}

const engine = new ActionPolicyEngine(DEFAULT_ACTION_POLICY);

describe('Policy Engine: deterministic, model-independent authorization', () => {
  it('REVERSIBLE_WRITE with scope and safe semantics → ALLOW', () => {
    expect(engine.evaluate(input())).toEqual({ outcome: 'allow', reasonCode: 'autonomous', rule: 'risk_classes.REVERSIBLE_WRITE.autonomy', message: expect.any(String) });
  });

  it('IRREVERSIBLE_WRITE and EXTERNAL_COMMUNICATION → REQUIRE_APPROVAL; PRIVILEGED → DENY', () => {
    expect(engine.evaluate(input({ riskClass: 'IRREVERSIBLE_WRITE' }))).toMatchObject({ outcome: 'require_approval', reasonCode: 'risk_class_requires_approval' });
    expect(engine.evaluate(input({ riskClass: 'EXTERNAL_COMMUNICATION' }))).toMatchObject({ outcome: 'require_approval' });
    expect(engine.evaluate(input({ riskClass: 'PRIVILEGED' }))).toMatchObject({ outcome: 'deny', reasonCode: 'risk_class_not_permitted' });
  });

  it('FINANCIAL without suitable authority (verified identity) → DENY', () => {
    expect(engine.evaluate(input({ riskClass: 'FINANCIAL' }))).toMatchObject({ outcome: 'deny', reasonCode: 'insufficient_identity', rule: 'risk_classes.FINANCIAL.minimum_identity' });
    // With the authority the rule asks for, it still needs a human.
    expect(engine.evaluate(input({ riskClass: 'FINANCIAL', context: { identityAssurance: 'verified' } }))).toMatchObject({ outcome: 'require_approval' });
  });

  it('READ is never processed as an action', () => {
    expect(engine.evaluate(input({ riskClass: 'READ' }))).toMatchObject({ outcome: 'deny', reasonCode: 'not_a_write' });
  });

  it('scope enforcement: missing from the trusted grant OR from the agent definition → DENY', () => {
    expect(engine.evaluate(input({ context: { grantedScopes: [] } }))).toMatchObject({ outcome: 'deny', reasonCode: 'scope_denied' });
    expect(engine.evaluate(input({ agentScopes: [] }))).toMatchObject({ outcome: 'deny', reasonCode: 'scope_denied' });
    expect(engine.evaluate(input({ capability: { requiredScopes: ['test.write', 'test.admin'] } }))).toMatchObject({ outcome: 'deny', reasonCode: 'scope_denied', message: expect.stringContaining('test.admin') });
  });

  it('a write without a safe replay/reconciliation strategy is never allowed', () => {
    expect(engine.evaluate(input({ capability: { writeRecovery: null } }))).toMatchObject({ outcome: 'deny', reasonCode: 'unsafe_write_semantics' });
    expect(engine.evaluate(input({ capability: { idempotency: 'unsupported' } }))).toMatchObject({ outcome: 'deny', reasonCode: 'unsafe_write_semantics' });
  });

  it('missing trusted identity requirement → DENY', () => {
    expect(engine.evaluate(input({ capability: { identityRequirement: 'verified' } }))).toMatchObject({ outcome: 'deny', reasonCode: 'identity_requirement_unmet' });
    expect(engine.evaluate(input({ capability: { identityRequirement: 'provisional' }, context: { identityAssurance: 'none' } }))).toMatchObject({ outcome: 'deny', reasonCode: 'identity_requirement_unmet' });
  });

  it('capability approval and confirmation policies require approval; structural denials come first', () => {
    expect(engine.evaluate(input({ capability: { approvalPolicy: 'required' } }))).toMatchObject({ outcome: 'require_approval', reasonCode: 'capability_requires_approval' });
    expect(engine.evaluate(input({ capability: { confirmationPolicy: 'required' } }))).toMatchObject({ outcome: 'require_approval', reasonCode: 'confirmation_required' });
    // Never ask a human to approve what could not execute safely anyway.
    expect(engine.evaluate(input({ capability: { approvalPolicy: 'required', writeRecovery: null } }))).toMatchObject({ outcome: 'deny', reasonCode: 'unsafe_write_semantics' });
  });

  it('a trusted context of another task/agent and a task that is not running are denied', () => {
    expect(engine.evaluate(input({ context: { taskId: RUN } }))).toMatchObject({ outcome: 'deny', reasonCode: 'context_mismatch' });
    expect(engine.evaluate(input({ context: { agentVersion: 2 } }))).toMatchObject({ outcome: 'deny', reasonCode: 'context_mismatch' });
    expect(engine.evaluate(input({ taskStatus: 'requires_approval' }))).toMatchObject({ outcome: 'deny', reasonCode: 'task_not_running' });
  });

  it('required evidence and per-capability overrides are typed rules, not a language', () => {
    const strict = new ActionPolicyEngine({ ...DEFAULT_ACTION_POLICY, policyId: 'strict', capabilities: { 'test.set_thing': { autonomy: 'allow', requireEvidence: true } } });
    expect(strict.evaluate(input())).toMatchObject({ outcome: 'deny', reasonCode: 'evidence_required', rule: 'capabilities.test.set_thing.require_evidence' });
    expect(strict.evaluate(input({ evidenceRefs: ['0190e7a3-0000-7000-8000-000000000009'] }))).toMatchObject({ outcome: 'allow', rule: 'capabilities.test.set_thing.autonomy' });
  });

  it('is deterministic: same input → same evaluation; only enum outcomes', () => {
    for (const riskClass of RISK_CLASSES) {
      const a = engine.evaluate(input({ riskClass }));
      const b = engine.evaluate(structuredClone(input({ riskClass })));
      expect(b).toEqual(a);
      expect(POLICY_OUTCOMES).toContain(a.outcome);
      expect(a.reasonCode).toMatch(/^[a-z][a-z0-9_.]*$/);
    }
  });

  it('ignores anything a model could influence beyond the capability named and the evidence cited', () => {
    // The input type has no arguments at all; model text cannot reach the engine.
    const evaluated = engine.evaluate(Object.assign(input(), { arguments: { grantedScopes: ['*'], approve: true } }));
    expect(evaluated).toEqual(engine.evaluate(input()));
  });
});

describe('policy configuration: versioned, hashed, validated', () => {
  it('identity = (policyId, version, hash of the canonical config, engine version)', () => {
    expect(engine.identity).toEqual({ policyId: 'r4-default-action-policy', version: 1, hash: expect.stringMatching(/^[0-9a-f]{64}$/), engineVersion: POLICY_ENGINE_VERSION });
    // Defaults are part of the canonical form: explicit and implicit defaults hash the same.
    const explicit = loadActionPolicy({ ...DEFAULT_ACTION_POLICY, capabilities: {}, riskClasses: { ...DEFAULT_ACTION_POLICY.riskClasses, REVERSIBLE_WRITE: { autonomy: 'allow', minimumIdentity: 'none', requireEvidence: false } } });
    expect(explicit.identity.hash).toBe(engine.identity.hash);
    const changed = loadActionPolicy({ ...DEFAULT_ACTION_POLICY, riskClasses: { ...DEFAULT_ACTION_POLICY.riskClasses, REVERSIBLE_WRITE: { autonomy: 'deny' } } });
    expect(changed.identity.hash).not.toBe(engine.identity.hash);
  });

  it('must govern every write class explicitly; unknown keys and READ rules are rejected', () => {
    const { PRIVILEGED: _omitted, ...partial } = DEFAULT_ACTION_POLICY.riskClasses;
    expect(() => new ActionPolicyEngine({ ...DEFAULT_ACTION_POLICY, riskClasses: partial })).toThrow(/invalid action policy/);
    expect(() => new ActionPolicyEngine({ ...DEFAULT_ACTION_POLICY, riskClasses: { ...DEFAULT_ACTION_POLICY.riskClasses, READ: { autonomy: 'allow' } } })).toThrow(/invalid action policy/);
    expect(() => new ActionPolicyEngine({ ...DEFAULT_ACTION_POLICY, bypassAll: true })).toThrow(/invalid action policy/);
  });
});

describe('R4-E: human approval is evidence for a new evaluation, never a bypass', () => {
  const PROPOSAL = '0190e7a3-0000-7000-8000-000000000003';
  const approval = (overrides: Partial<NonNullable<PolicyInput['approval']>> = {}): NonNullable<PolicyInput['approval']> => ({
    requestId: '0190e7a3-0000-7000-8000-000000000009', proposalId: PROPOSAL, capabilityId: 'test.set_thing', capabilityVersion: 1, argumentsMatch: true, ...overrides,
  });
  const withApproval = (a: NonNullable<PolicyInput['approval']>, overrides: Parameters<typeof input>[0] = {}): PolicyInput => ({ ...input(overrides), approval: a });

  it('a matching approval satisfies exactly the approval requirement → ALLOW (human_approved)', () => {
    expect(engine.evaluate(input({ riskClass: 'IRREVERSIBLE_WRITE' }))).toMatchObject({ outcome: 'require_approval' });
    expect(engine.evaluate(withApproval(approval(), { riskClass: 'IRREVERSIBLE_WRITE' }))).toMatchObject({ outcome: 'allow', reasonCode: 'human_approved' });
    expect(engine.evaluate(withApproval(approval(), { capability: { approvalPolicy: 'required' } }))).toMatchObject({ outcome: 'allow', reasonCode: 'human_approved' });
    expect(engine.evaluate(withApproval(approval(), { capability: { confirmationPolicy: 'required' } }))).toMatchObject({ outcome: 'allow', reasonCode: 'human_approved' });
  });

  it('is bound to proposal, capability version and validated arguments: any mismatch → DENY, never reusable', () => {
    for (const mismatch of [{ proposalId: '0190e7a3-0000-7000-8000-00000000000a' }, { capabilityId: 'test.other' }, { capabilityVersion: 2 }, { argumentsMatch: false }]) {
      expect(engine.evaluate(withApproval(approval(mismatch), { riskClass: 'IRREVERSIBLE_WRITE' }))).toMatchObject({ outcome: 'deny', reasonCode: 'approval_scope_mismatch', rule: 'governance.approval_scope' });
    }
  });

  it('cannot override any other rule: denied risk classes, scopes, identity, task state and unsafe semantics still deny', () => {
    expect(engine.evaluate(withApproval(approval(), { riskClass: 'PRIVILEGED' }))).toMatchObject({ outcome: 'deny', reasonCode: 'risk_class_not_permitted' });
    expect(engine.evaluate(withApproval(approval(), { riskClass: 'FINANCIAL' }))).toMatchObject({ outcome: 'deny', reasonCode: 'insufficient_identity' });
    expect(engine.evaluate(withApproval(approval(), { riskClass: 'IRREVERSIBLE_WRITE', agentScopes: [] }))).toMatchObject({ outcome: 'deny', reasonCode: 'scope_denied' });
    expect(engine.evaluate(withApproval(approval(), { riskClass: 'IRREVERSIBLE_WRITE', taskStatus: 'requires_approval' }))).toMatchObject({ outcome: 'deny', reasonCode: 'task_not_running' });
    expect(engine.evaluate(withApproval(approval(), { riskClass: 'IRREVERSIBLE_WRITE', capability: { writeRecovery: null } }))).toMatchObject({ outcome: 'deny', reasonCode: 'unsafe_write_semantics' });
    expect(engine.evaluate(withApproval(approval(), { capability: { identityRequirement: 'verified' } }))).toMatchObject({ outcome: 'deny', reasonCode: 'identity_requirement_unmet' });
  });

  it('is deterministic: same input and approval evidence → same evaluation', () => {
    const a = withApproval(approval(), { riskClass: 'IRREVERSIBLE_WRITE' });
    expect(engine.evaluate(a)).toEqual(engine.evaluate(structuredClone(a)));
  });
});
