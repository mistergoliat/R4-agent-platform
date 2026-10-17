import { describe, expect, it } from 'vitest';
import { CustomerProfileConfigError, customerModeOf, describeCustomerProfileHttpConfig, loadCustomerProfileHttpConfig } from '@r4-adapters/customer-http';
import { TOKEN } from './support.js';

// R4-J4-R2: the Customer Profile adapter configuration is explicit and fail-closed; real data is refused.

const ENV = {
  R4_CUSTOMER_MODE: 'synthetic',
  R4_CUSTOMER_PROFILE_BASE_URL: 'http://127.0.0.1:4310/',
  R4_CUSTOMER_PROFILE_BEARER_TOKEN: TOKEN,
  R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
};
const local = { allowNetwork: false };
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerProfileConfigError);
    return (error as CustomerProfileConfigError).code;
  }
  throw new Error('expected a configuration error');
};

describe('Customer mode', () => {
  it('unset is not configured; synthetic is the only accepted mode', () => {
    expect(customerModeOf({})).toBe('not_configured');
    expect(customerModeOf({ R4_CUSTOMER_MODE: ' ' })).toBe('not_configured');
    expect(customerModeOf({ R4_CUSTOMER_MODE: 'synthetic' })).toBe('synthetic');
  });

  it('real is refused: real customer data stays blocked (D2, G-16, approved contract)', () => {
    expect(codeOf(() => customerModeOf({ R4_CUSTOMER_MODE: 'real' }))).toBe('customer_real_data_blocked');
    expect(codeOf(() => loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_MODE: 'real' }, { allowNetwork: true }))).toBe('customer_real_data_blocked');
  });

  it('any other value is an error, never a fallback', () => {
    for (const mode of ['REAL', 'fixture', 'live', 'true']) expect(codeOf(() => customerModeOf({ R4_CUSTOMER_MODE: mode })), mode).toBe('invalid_customer_profile_config');
  });
});

describe('loadCustomerProfileHttpConfig', () => {
  it('loads a complete local configuration as synthetic, without a trailing slash', () => {
    expect(loadCustomerProfileHttpConfig(ENV, local)).toEqual({ baseUrl: 'http://127.0.0.1:4310', bearerToken: TOKEN, timeoutMs: 3000, lifecycle: 'synthetic' });
  });

  it('refuses a missing mode or variable', () => {
    expect(codeOf(() => loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_MODE: undefined }, local))).toBe('customer_profile_config_incomplete');
    for (const name of ['R4_CUSTOMER_PROFILE_BASE_URL', 'R4_CUSTOMER_PROFILE_BEARER_TOKEN', 'R4_CUSTOMER_PROFILE_TIMEOUT_MS']) {
      expect(codeOf(() => loadCustomerProfileHttpConfig({ ...ENV, [name]: '' }, local)), name).toBe('customer_profile_config_incomplete');
    }
  });

  it('refuses credentials, queries or fragments in the URL, and non-http schemes', () => {
    for (const url of ['http://u:p@127.0.0.1:4310', 'http://127.0.0.1:4310/?x=1', 'http://127.0.0.1:4310/#f', 'ftp://127.0.0.1', 'not a url']) {
      expect(codeOf(() => loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_PROFILE_BASE_URL: url }, local)), url).toBe('invalid_customer_profile_config');
    }
  });

  it('a non-local URL needs network allowed and https', () => {
    expect(codeOf(() => loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_PROFILE_BASE_URL: 'https://cp.internal' }, local))).toBe('network_not_allowed');
    expect(codeOf(() => loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_PROFILE_BASE_URL: 'http://cp.internal' }, { allowNetwork: true }))).toBe('invalid_customer_profile_config');
    expect(loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_PROFILE_BASE_URL: 'https://cp.internal' }, { allowNetwork: true }).baseUrl).toBe('https://cp.internal');
  });

  it('requires a plausible token (43–512 printable characters)', () => {
    for (const token of ['short', 'x'.repeat(42), `${'x'.repeat(42)} y`, 'x'.repeat(513)]) {
      expect(codeOf(() => loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_PROFILE_BEARER_TOKEN: token }, local))).toBe('invalid_customer_profile_config');
    }
  });

  it('bounds the timeout to 3000–5000 ms (CP budget ≤ timeout − 500 ms)', () => {
    for (const timeout of ['2999', '5001', '100', 'abc', '3000.5']) {
      expect(codeOf(() => loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_PROFILE_TIMEOUT_MS: timeout }, local)), timeout).toBe('invalid_customer_profile_config');
    }
    expect(loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_PROFILE_TIMEOUT_MS: '5000' }, local).timeoutMs).toBe(5000);
  });

  it('errors and the safe description never contain the token', () => {
    const described = describeCustomerProfileHttpConfig(loadCustomerProfileHttpConfig(ENV, local));
    expect(described).toMatchObject({ binding: 'SYNTHETIC', lifecycle: 'synthetic', realCustomerData: false, authentication: 'declared, not verified' });
    expect(JSON.stringify(described)).not.toContain(TOKEN);
    try {
      loadCustomerProfileHttpConfig({ ...ENV, R4_CUSTOMER_PROFILE_TIMEOUT_MS: 'bad' }, local);
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});
