import { describe, expect, it } from 'vitest';
import {
  HOLD_REASONS,
  ProductionConfigError,
  assertProductionComposition,
  assertProductionMode,
  assertProductionProfile,
  availableCapabilities,
  capabilityAvailability,
  conversationKey,
  decideInboundAutonomy,
  declaredExecutionMode,
  loadProductionConfig,
  productionConfigFingerprint,
  rolloutBucket,
  rolloutEligibility,
  rolloutFingerprint,
  type AutonomyControlsState,
  type ProductionProfile,
} from '@r4/live-ops';

const KEY = 'k'.repeat(40);
const PRODUCTION_ENV = {
  R4_EXECUTION_MODE: 'production',
  R4_PROD_POLICY_PROFILE: 'test-profile@1',
  R4_PROD_ROLLOUT_PERCENT: '0',
  R4_PROD_IDENTITY_HASH_KEY: KEY,
  R4_PROD_ALLOW_NETWORK: 'false',
};

const PROFILE: ProductionProfile = {
  profileId: 'test-profile', version: 1, description: 'test',
  domains: {
    owner: { status: 'UNAVAILABLE', contractRef: null, note: '' },
    state: { status: 'INTERNAL', contractRef: null, note: '' },
    live: { status: 'REAL', contractRef: 'docs/contract.md', note: '' },
  },
  channel: { id: 'chat', status: 'REAL', contractRef: 'docs/channel.md' },
  capabilities: [
    { capabilityId: 'owner.read', domain: 'owner', effect: 'read' },
    { capabilityId: 'state.write', domain: 'state', effect: 'write', decision: 'ALLOW' },
    { capabilityId: 'live.read', domain: 'live', effect: 'read' },
    { capabilityId: 'live.issue', domain: 'live', effect: 'write', decision: 'REQUIRE_APPROVAL' },
    { capabilityId: 'live.delete', domain: 'live', effect: 'write', decision: 'DENY' },
  ],
  unsupportedContent: 'handoff',
};

describe('explicit production mode (fail closed)', () => {
  it('distinguishes test / shadow / production and refuses unknown modes', () => {
    expect(declaredExecutionMode({})).toBe('test');
    expect(declaredExecutionMode({ R4_EXECUTION_MODE: 'shadow' })).toBe('shadow');
    expect(declaredExecutionMode({ R4_EXECUTION_MODE: 'production' })).toBe('production');
    expect(() => declaredExecutionMode({ R4_EXECUTION_MODE: 'prod' })).toThrow(ProductionConfigError);
  });

  it('missing mode never becomes production', () => {
    const { R4_EXECUTION_MODE: _mode, ...rest } = PRODUCTION_ENV;
    expect(() => loadProductionConfig(rest)).toThrow(/production_mode_not_declared|must be "production"/);
    expect(() => loadProductionConfig({ ...PRODUCTION_ENV, R4_EXECUTION_MODE: 'shadow' })).toThrow(/must be "production"/);
  });

  it.each([
    ['R4_PROD_POLICY_PROFILE', undefined],
    ['R4_PROD_ROLLOUT_PERCENT', undefined],
    ['R4_PROD_IDENTITY_HASH_KEY', 'short'],
    ['R4_PROD_ALLOW_NETWORK', undefined],
    ['R4_PROD_ALLOW_NETWORK', 'yes'],
  ])('refuses production without an explicit %s', (name, value) => {
    expect(() => loadProductionConfig({ ...PRODUCTION_ENV, [name]: value })).toThrow(ProductionConfigError);
  });

  it('defaults to 0 % rollout, no allowlist, and keeps secrets out of the config and its fingerprint', () => {
    const { config, secrets } = loadProductionConfig(PRODUCTION_ENV);
    expect(config.rollout).toEqual({ percent: 0, allowlist: [], denylist: [] });
    expect(config.allowNetwork).toBe(false);
    expect(secrets.identityHashKey).toBe(KEY);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(productionConfigFingerprint(config)).toMatch(/^[0-9a-f]{64}$/);
    expect(assertProductionMode(config)).toEqual(config);
    expect(() => assertProductionMode({ mode: 'shadow' })).toThrow(/production_mode_not_proven|no proven/);
  });

  it('refuses a dispatch lease that does not outlive the provider timeout', () => {
    expect(() => loadProductionConfig({ ...PRODUCTION_ENV, R4_PROD_OUTBOUND_LEASE_MS: '5000', R4_PROD_PROVIDER_TIMEOUT_MS: '10000' })).toThrow(/must exceed/);
  });
});

describe('production profile', () => {
  it('refuses FIXTURE and SHADOW bindings and undocumented REAL bindings', () => {
    expect(() => assertProductionProfile({ ...PROFILE, domains: { ...PROFILE.domains, owner: { status: 'FIXTURE', contractRef: null, note: '' } } })).toThrow(/non_production_binding/);
    expect(() => assertProductionProfile({ ...PROFILE, domains: { ...PROFILE.domains, owner: { status: 'SHADOW', contractRef: null, note: '' } } })).toThrow(/non_production_binding/);
    expect(() => assertProductionProfile({ ...PROFILE, domains: { ...PROFILE.domains, live: { status: 'REAL', contractRef: null, note: '' } } })).toThrow(/undocumented_binding/);
  });

  it('capabilities are available only when their owner binding is real/internal (writes not denied)', () => {
    expect(capabilityAvailability(PROFILE, 'owner.read')).toEqual({ available: false, reason: 'domain_unavailable' });
    expect(capabilityAvailability(PROFILE, 'live.delete').available).toBe(false);
    expect(capabilityAvailability(PROFILE, 'unknown').available).toBe(false);
    expect(availableCapabilities(PROFILE)).toEqual(['state.write', 'live.read', 'live.issue']);
  });

  it('composition gate: a fixture presented as real, or an unavailable capability registered, is refused', () => {
    expect(() => assertProductionComposition(PROFILE, [{ domain: 'live', bindingKind: 'fixture' }], [])).toThrow(/non_production_implementation/);
    expect(() => assertProductionComposition(PROFILE, [{ domain: 'owner', bindingKind: 'real' }], [])).toThrow(/binding_mismatch/);
    expect(() => assertProductionComposition(PROFILE, [], ['owner.read'])).toThrow(/unavailable_capability_registered/);
    const report = assertProductionComposition(PROFILE, [{ domain: 'state', bindingKind: 'internal' }, { domain: 'live', bindingKind: 'real' }], ['state.write', 'live.read']);
    expect(report.writes).toEqual({ allow: ['state.write'], requireApproval: ['live.issue'], deny: ['live.delete'] });
    expect(report.profileFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stable rollout', () => {
  const key = conversationKey(KEY, 'chat', 'acct', '56911112222');

  it('conversation keys are keyed hashes: stable, and meaningless without the key', () => {
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(conversationKey(KEY, 'chat', 'acct', '56911112222')).toBe(key);
    expect(conversationKey('x'.repeat(40), 'chat', 'acct', '56911112222')).not.toBe(key);
    expect(key).not.toContain('56911112222');
  });

  it('default posture: nobody eligible; allowlist; deny beats allowlist; percentage is stable per conversation', () => {
    const base = { percent: 0, allowlist: [], denylist: [] };
    expect(rolloutEligibility(base, key)).toMatchObject({ eligible: false, reason: 'not_in_cohort' });
    expect(rolloutEligibility({ ...base, allowlist: [key] }, key)).toMatchObject({ eligible: true, reason: 'allowlisted' });
    expect(rolloutEligibility({ ...base, allowlist: [key], denylist: [key] }, key)).toMatchObject({ eligible: false, reason: 'denied' });
    expect(rolloutEligibility({ ...base, percent: 100 }, key)).toMatchObject({ eligible: true, reason: 'cohort' });
    const results = new Set(Array.from({ length: 20 }, () => rolloutEligibility({ ...base, percent: 50 }, key).eligible));
    expect(results.size).toBe(1);
    expect(rolloutBucket(key)).toBe(rolloutBucket(key));
    // ~percentage over many conversations
    const eligible = Array.from({ length: 2000 }, (_, i) => rolloutEligibility({ ...base, percent: 25 }, conversationKey(KEY, 'chat', 'acct', `c${i}`)).eligible).filter(Boolean).length;
    expect(eligible).toBeGreaterThan(400);
    expect(eligible).toBeLessThan(600);
    expect(rolloutFingerprint({ ...base, allowlist: [key] })).not.toBe(rolloutFingerprint(base));
  });
});

describe('autonomy precedence (kill switch > deny > rollout > content policy)', () => {
  const on: AutonomyControlsState = { globalEnabled: true, channels: {}, version: 'v' };
  const facts = { controls: on, channel: 'chat', deniedNow: false, bindingAutonomous: true, unsupportedContent: false, unsupportedContentPolicy: 'handoff' as const };

  it('autonomous only when everything allows it', () => {
    expect(decideInboundAutonomy(facts)).toEqual({ kind: 'autonomous' });
  });

  it('each gate holds, in precedence order', () => {
    const all = { ...facts, controls: { ...on, globalEnabled: false }, deniedNow: true, bindingAutonomous: false, unsupportedContent: true };
    expect(decideInboundAutonomy(all)).toMatchObject({ kind: 'hold', reason: HOLD_REASONS.killSwitch });
    expect(decideInboundAutonomy({ ...all, controls: on })).toMatchObject({ reason: HOLD_REASONS.denied });
    expect(decideInboundAutonomy({ ...all, controls: on, deniedNow: false })).toMatchObject({ reason: HOLD_REASONS.rolloutExcluded });
    expect(decideInboundAutonomy({ ...facts, unsupportedContent: true })).toMatchObject({ reason: HOLD_REASONS.unsupportedContent });
    expect(decideInboundAutonomy({ ...facts, unsupportedContent: true, unsupportedContentPolicy: 'inform_agent' })).toEqual({ kind: 'autonomous' });
    expect(decideInboundAutonomy({ ...facts, controls: { ...on, channels: { chat: false } } })).toMatchObject({ reason: HOLD_REASONS.killSwitch });
    expect(decideInboundAutonomy({ ...facts, controls: { ...on, channels: { other: false } } })).toEqual({ kind: 'autonomous' });
  });
});
