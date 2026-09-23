import { describe, expect, it } from 'vitest';
import { contextCompilationPolicySchema, policyVersionOf } from '@r4/context-compiler';
import { DEFAULT_CONTEXT_POLICY, loadWorkerConfig, validateWorkerConfig } from '@r4/worker';

const env = { R4_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' };

describe('worker context policy (R4-C2, ADR-015)', () => {
  it('defaults to an UNBOUNDED budget: no artificial R4 limit', () => {
    const policy = contextCompilationPolicySchema.parse(loadWorkerConfig(env).context);
    expect(policy).toMatchObject({
      budget: { mode: 'unbounded' },
      expiredEvidence: 'include',
      conversation: { recentTurns: 20, compaction: { enabled: true, chunkTurns: 10 } },
      requiredKinds: ['agent_definition', 'task', 'execution_constraints', 'goal', 'capability'],
      selectionOrder: ['state', 'observation', 'conversation_turn', 'working_note', 'episode', 'derived_summary'],
    });
    expect(policy.budget).not.toHaveProperty('maxEstimatedTokens');
  });

  it('supports an explicit FIXED budget from the environment', () => {
    const config = loadWorkerConfig({ ...env, R4_CONTEXT_BUDGET_MODE: 'fixed', R4_CONTEXT_MAX_TOKENS: '4000', R4_CONTEXT_RECENT_TURNS: '5', R4_CONTEXT_COMPACTION_CHUNK: '3', R4_CONTEXT_EXPIRED_EVIDENCE: 'exclude' });
    expect(config.context).toMatchObject({ budget: { mode: 'fixed', maxEstimatedTokens: 4_000 }, expiredEvidence: 'exclude', conversation: { recentTurns: 5, compaction: { chunkTurns: 3 } } });
  });

  it.each([
    ['fixed budget without a limit', { ...env, R4_CONTEXT_BUDGET_MODE: 'fixed' }],
    ['a limit without a fixed budget (ambiguous)', { ...env, R4_CONTEXT_MAX_TOKENS: '4000' }],
    ['zero context budget', { ...env, R4_CONTEXT_BUDGET_MODE: 'fixed', R4_CONTEXT_MAX_TOKENS: '0' }],
    ['unknown budget mode', { ...env, R4_CONTEXT_BUDGET_MODE: 'auto' }],
    ['unknown expired-evidence mode', { ...env, R4_CONTEXT_EXPIRED_EVIDENCE: 'maybe' }],
  ])('fails the boot on %s', (_name, bad) => {
    expect(() => loadWorkerConfig(bad)).toThrow();
  });

  it('rejects an invalid programmatic context policy', () => {
    const config = loadWorkerConfig(env);
    expect(() => validateWorkerConfig({ ...config, context: { budget: { mode: 'fixed', maxEstimatedTokens: 10 }, requiredKinds: ['state'], selectionOrder: ['state'] } })).toThrow(/context policy/);
    expect(() => validateWorkerConfig({ ...config, context: { budget: { mode: 'unbounded', maxEstimatedTokens: 10 } as never } })).toThrow(/context policy/);
  });

  it('the default policy for platform-less sessions equals an empty environment (same policy version)', () => {
    const fromEnv = contextCompilationPolicySchema.parse(loadWorkerConfig(env).context);
    const fromDefault = contextCompilationPolicySchema.parse(DEFAULT_CONTEXT_POLICY);
    expect(policyVersionOf(fromDefault)).toBe(policyVersionOf(fromEnv));
  });
});
