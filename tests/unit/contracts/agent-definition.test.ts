import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentDefinitionSchema } from '@r4/contracts';

const probe = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../agents/platform-probe/platform-probe.agent.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

describe('AgentDefinition contract', () => {
  it('accepts the repository probe definition', () => {
    const parsed = agentDefinitionSchema.parse(probe);
    expect(parsed.agentId).toBe('platform-probe');
    expect(parsed.capabilityScopes).toEqual(['platform_test.read']);
  });

  it('applies defaults for optional configuration', () => {
    const { skills: _s, contextPolicy: _c, delegationPolicy: _d, evaluationProfile: _e, ...minimal } = probe;
    const parsed = agentDefinitionSchema.parse(minimal);
    expect(parsed.skills).toEqual([]);
    expect(parsed.contextPolicy).toEqual({});
    expect(parsed.delegationPolicy).toEqual({ mode: 'none', allowedAgentIds: [] });
    expect(parsed.evaluationProfile).toBeNull();
  });

  it('rejects unknown fields (no silent configuration drift)', () => {
    expect(agentDefinitionSchema.safeParse({ ...probe, surprise: true }).success).toBe(false);
  });

  it('is provider-neutral: model requirements cannot name a provider or model', () => {
    const withProvider = { ...probe, modelRequirements: { ...(probe.modelRequirements as object), provider: 'any-vendor' } };
    const withModel = { ...probe, modelRequirements: { ...(probe.modelRequirements as object), model: 'any-model' } };
    expect(agentDefinitionSchema.safeParse(withProvider).success).toBe(false);
    expect(agentDefinitionSchema.safeParse(withModel).success).toBe(false);
  });

  it('rejects malformed identifiers, duplicate scopes and empty task types', () => {
    expect(agentDefinitionSchema.safeParse({ ...probe, agentId: 'Bad_Id' }).success).toBe(false);
    expect(agentDefinitionSchema.safeParse({ ...probe, capabilityScopes: ['a.read', 'a.read'] }).success).toBe(false);
    expect(agentDefinitionSchema.safeParse({ ...probe, taskTypes: [] }).success).toBe(false);
    expect(agentDefinitionSchema.safeParse({ ...probe, taskTypes: ['unnamespaced'] }).success).toBe(false);
    expect(agentDefinitionSchema.safeParse({ ...probe, version: 0 }).success).toBe(false);
  });

  it('rejects an allow-list when delegation is disabled', () => {
    const invalid = { ...probe, delegationPolicy: { mode: 'none', allowedAgentIds: ['other-agent'] } };
    expect(agentDefinitionSchema.safeParse(invalid).success).toBe(false);
    const valid = { ...probe, delegationPolicy: { mode: 'allow_listed', allowedAgentIds: ['other-agent'] } };
    expect(agentDefinitionSchema.safeParse(valid).success).toBe(true);
  });
});
