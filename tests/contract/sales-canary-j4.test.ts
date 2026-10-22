import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCustomerProfileHttpConfig } from '@r4-adapters/customer-http';
import { loadCiaVerificationConfirmConfig, loadCustomerIdentityHttpConfig } from '@r4-adapters/identity-http';
import { profileLabel } from '@r4/live-ops';
import { CANARY_PROFILES, SYNTHETIC_INBOUND_ADAPTER, loadCanaryEnvironment, parseCanaryTestHosts } from '@r4-sales/agent/canary';
import { parseCanaryCommand } from '../../agents/sales/src/cli/canary/command.js';

/**
 * R4-J4-R5 preparation: the canary tooling of sales-production@8, without running it. Closed test-host
 * allowlist (empty by default, never in a production path), the J4 expired-evidence policy, the single-gateway
 * commands, and no real identity.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const base = (profile: string, extra: Record<string, string> = {}) => ({
  R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false',
  R4_CANARY_DATABASE_URL: 'postgres://r4@127.0.0.1:55432/r4_canary_contract',
  R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '500000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '5',
  R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '1', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '20', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900', ...extra,
});
const CIA_ENV = { R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001', R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500', R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'synthetic-channel-confirm-token-0001' };
const CP_ENV = { R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij', R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000' };
const HOST = 'cia.j4-canary.example';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('the closed test-host allowlist (R4_CANARY_TEST_HOSTS)', () => {
  it('accepts exact lower-case DNS names only, at most four, no duplicates', () => {
    expect(parseCanaryTestHosts(undefined)).toEqual([]);
    expect(parseCanaryTestHosts('')).toEqual([]);
    expect(parseCanaryTestHosts(`${HOST}, cp.j4-canary.example`)).toEqual([HOST, 'cp.j4-canary.example']);
    for (const bad of ['*', '*.example', '10.0.0.5', 'localhost', 'cia.localhost', 'https://cia.example', 'cia.example:443', 'CIA.Example', 'cia', `${HOST},${HOST}`, 'a.example,b.example,c.example,d.example,e.example']) {
      expect(() => parseCanaryTestHosts(bad), bad).toThrow(/R4_CANARY_TEST_HOSTS/);
    }
  });

  it('opens a non-loopback CIA or Customer Profile host only when listed, over https; the default is unchanged', () => {
    expect(() => loadCustomerIdentityHttpConfig({ ...CIA_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: `https://${HOST}` })).toThrow(/loopback only/);
    expect(loadCustomerIdentityHttpConfig({ ...CIA_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: `https://${HOST}` }, { allowedHosts: [HOST] }).baseUrl).toBe(`https://${HOST}`);
    expect(() => loadCustomerIdentityHttpConfig({ ...CIA_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: `http://${HOST}` }, { allowedHosts: [HOST] })).toThrow(/must use https/);
    expect(() => loadCustomerIdentityHttpConfig({ ...CIA_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'https://other.example' }, { allowedHosts: [HOST] })).toThrow(/explicitly allowed/);
    expect(() => loadCiaVerificationConfirmConfig({ ...CIA_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: `https://${HOST}` })).toThrow(/loopback only/);
    expect(loadCiaVerificationConfirmConfig({ ...CIA_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: `https://${HOST}` }, { allowedHosts: [HOST] }).baseUrl).toBe(`https://${HOST}`);
    // Real mode and non-synthetic credentials stay refused on an allowed host.
    expect(() => loadCustomerIdentityHttpConfig({ ...CIA_ENV, R4_CUSTOMER_MODE: 'real', R4_CUSTOMER_IDENTITY_BASE_URL: `https://${HOST}` }, { allowedHosts: [HOST] })).toThrow(/real is refused/);
    expect(() => loadCustomerIdentityHttpConfig({ ...CIA_ENV, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'prod-r4-sales-agent-token-000000000001', R4_CUSTOMER_IDENTITY_BASE_URL: `https://${HOST}` }, { allowedHosts: [HOST] })).toThrow(/synthetic credential/);
    expect(() => loadCustomerProfileHttpConfig({ ...CP_ENV, R4_CUSTOMER_PROFILE_BASE_URL: 'https://cp.j4-canary.example' }, { allowNetwork: false })).toThrow(/non-local Customer Profile URL/);
    expect(loadCustomerProfileHttpConfig({ ...CP_ENV, R4_CUSTOMER_PROFILE_BASE_URL: 'https://cp.j4-canary.example' }, { allowNetwork: false, allowedHosts: ['cp.j4-canary.example'] }).baseUrl).toBe('https://cp.j4-canary.example');
    expect(() => loadCustomerProfileHttpConfig({ ...CP_ENV, R4_CUSTOMER_PROFILE_BASE_URL: 'http://cp.j4-canary.example' }, { allowNetwork: false, allowedHosts: ['cp.j4-canary.example'] })).toThrow(/must use https/);
  });

  it('only the canary reads it: no production path passes an allowlist', () => {
    const readers = files(join(ROOT, 'agents')).filter((p) => /R4_CANARY_TEST_HOSTS/.test(readFileSync(p, 'utf8'))).map((p) => relative(ROOT, p).replace(/\\/g, '/'));
    expect(readers.sort()).toEqual(['agents/sales/src/cli/canary/identity.ts', 'agents/sales/src/cli/canary/runtime.ts']);
    for (const path of ['agents/sales/src/cli/production.ts', 'agents/sales/src/production/bootstrap.ts', 'agents/sales/src/production/control.ts']) {
      expect(readFileSync(join(ROOT, path), 'utf8'), path).not.toMatch(/allowedHosts|testHosts/);
    }
    for (const path of files(join(ROOT, 'apps')).concat(files(join(ROOT, 'packages')))) expect(readFileSync(path, 'utf8'), path).not.toMatch(/allowedHosts|R4_CANARY_TEST_HOSTS/);
  });
});

describe('the canary environment of sales-production@8', () => {
  it('accepts @8 only with R4_CANARY_CONTEXT_EXPIRED_EVIDENCE=exclude; the allowlist is for @8 only', () => {
    expect(CANARY_PROFILES.map(profileLabel)).toEqual(['sales-production@4', 'sales-production@5', 'sales-production@6', 'sales-production@7', 'sales-production@8']);
    expect(() => loadCanaryEnvironment(base('sales-production@8'))).toThrow(/R4_CANARY_CONTEXT_EXPIRED_EVIDENCE=exclude/);
    expect(() => loadCanaryEnvironment(base('sales-production@8', { R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'include' }))).toThrow(/R4_CANARY_CONTEXT_EXPIRED_EVIDENCE=exclude/);
    expect(() => loadCanaryEnvironment(base('sales-production@8', { R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'maybe' }))).toThrow(/include" or "exclude/);
    expect(loadCanaryEnvironment(base('sales-production@8', { R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'exclude', R4_CANARY_TEST_HOSTS: HOST }))).toMatchObject({ contextExpiredEvidence: 'exclude', testHosts: [HOST] });
    // A paired @7 arm declares the same policy; @7 has no Customer owner to allow.
    expect(loadCanaryEnvironment(base('sales-production@7', { R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'exclude' }))).toMatchObject({ contextExpiredEvidence: 'exclude', testHosts: [] });
    expect(loadCanaryEnvironment(base('sales-production@7'))).toMatchObject({ contextExpiredEvidence: null });
    expect(() => loadCanaryEnvironment(base('sales-production@7', { R4_CANARY_TEST_HOSTS: HOST }))).toThrow(/sales-production@8/);
  });

  it('the synthetic channel attests one-to-one conversations and accepts no webhook', () => {
    expect(SYNTHETIC_INBOUND_ADAPTER).toMatchObject({ channel: 'r4-synthetic', directConversations: true });
    expect(SYNTHETIC_INBOUND_ADAPTER.authenticate('{}', {})).toEqual({ ok: false, reason: 'synthetic_channel_has_no_webhook' });
    expect(SYNTHETIC_INBOUND_ADAPTER.verifySubscription({})).toMatchObject({ ok: false });
  });

  it('parses the gateway, rollback-status and purge commands', () => {
    expect(parseCanaryCommand(['gateway'])).toEqual({ kind: 'gateway', mode: 'full' });
    expect(parseCanaryCommand(['gateway', '--mode', 'protect_only'])).toEqual({ kind: 'gateway', mode: 'protect_only' });
    expect(() => parseCanaryCommand(['gateway', '--mode', 'absent'])).toThrow(/full or protect_only/);
    expect(parseCanaryCommand(['rollback-status'])).toEqual({ kind: 'rollback-status' });
    expect(parseCanaryCommand(['purge', '--confirm', 'abc123'])).toEqual({ kind: 'purge', confirm: 'abc123' });
    expect(() => parseCanaryCommand(['purge'])).toThrow(/--confirm is required/);
  });

  it('the canary worker of @8 receives the customer configuration, never the gateway-only credentials', () => {
    const command = readFileSync(join(ROOT, 'agents/sales/src/cli/canary/command.ts'), 'utf8');
    expect(command).toMatch(/\.\.\.\(isCustomerIdentityProfile\(canary\.profile\) \? \{ customer: \{ env \} \} : \{\}\)/);
    // The composition refuses the gateway-only credentials in that env (tests/contract/sales-profile-v8.test.ts C).
    expect(readFileSync(join(ROOT, 'agents/sales/src/production/composition.ts'), 'utf8')).toMatch(/if \(leaked\.length > 0\) throw refuse\(/);
  });
});
