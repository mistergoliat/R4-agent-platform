/**
 * Customer Profile adapter configuration (R4-J4-R2), explicit and fail-closed:
 *
 *   R4_CUSTOMER_MODE                   "synthetic" binds this adapter against a synthetic
 *                                      Customer Profile; unset = not configured.
 *                                      "real" is REFUSED: real customer data stays blocked until
 *                                      D2 (per-customer grant), G-16 (CP owner acceptance) and an
 *                                      approved contract exist.
 *   R4_CUSTOMER_PROFILE_BASE_URL       Customer Profile base URL (no default; never a hardcoded host)
 *   R4_CUSTOMER_PROFILE_BEARER_TOKEN   the r4-sales principal's bearer token (secret: never printed,
 *                                      never logged); CP grants it customer.sales_context.read only
 *   R4_CUSTOMER_PROFILE_TIMEOUT_MS     per-call deadline, 3000–5000 ms. CP's route budget must stay
 *                                      ≤ this − 500 ms (CP default 2500) (alignment §4.5, AP-11)
 *
 * A non-loopback URL requires network to be explicitly allowed and https.
 * Loading a configuration proves only that it is well-formed: it says
 * nothing about connectivity or whether the token is accepted.
 */
export type CustomerProfileLifecycle = 'synthetic' | 'real';

export interface CustomerProfileHttpConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  /** synthetic: accepts `candidate` and `service_scope_only`. real: requires `approved` and `customer_grant_verified`. */
  readonly lifecycle: CustomerProfileLifecycle;
}

export class CustomerProfileConfigError extends Error {
  readonly code: 'customer_profile_config_incomplete' | 'invalid_customer_profile_config' | 'network_not_allowed' | 'customer_real_data_blocked';

  constructor(code: CustomerProfileConfigError['code'], message: string) {
    super(message);
    this.name = 'CustomerProfileConfigError';
    this.code = code;
  }
}

export const CUSTOMER_PROFILE_ENV = ['R4_CUSTOMER_MODE', 'R4_CUSTOMER_PROFILE_BASE_URL', 'R4_CUSTOMER_PROFILE_BEARER_TOKEN', 'R4_CUSTOMER_PROFILE_TIMEOUT_MS'] as const;

export type CustomerMode = 'synthetic' | 'not_configured';

export const CUSTOMER_PROFILE_TIMEOUT_MIN_MS = 3_000;
export const CUSTOMER_PROFILE_TIMEOUT_MAX_MS = 5_000;

/** The selected Customer mode. An unknown value is a configuration error, never a silent fallback. */
export function customerModeOf(env: Readonly<Record<string, string | undefined>>): CustomerMode {
  const raw = env.R4_CUSTOMER_MODE?.trim();
  if (!raw) return 'not_configured';
  if (raw === 'synthetic') return 'synthetic';
  if (raw === 'real') {
    throw new CustomerProfileConfigError('customer_real_data_blocked', 'R4_CUSTOMER_MODE=real is refused: real customer data is blocked until D2, G-16 and an approved Customer Profile contract');
  }
  throw new CustomerProfileConfigError('invalid_customer_profile_config', 'R4_CUSTOMER_MODE must be "synthetic" or unset');
}

/**
 * `allowedHosts` (R4-J4-R5 preparation): a CLOSED allowlist of synthetic test hosts, given only by the isolated
 * canary, which composes with `allowNetwork: false`. A listed host is accepted by its exact name, over https.
 */
export function loadCustomerProfileHttpConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean; readonly allowedHosts?: readonly string[] }): CustomerProfileHttpConfig {
  if (customerModeOf(env) !== 'synthetic') {
    throw new CustomerProfileConfigError('customer_profile_config_incomplete', 'refusing to compose the Customer Profile adapter: R4_CUSTOMER_MODE is not set');
  }
  const missing = CUSTOMER_PROFILE_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new CustomerProfileConfigError('customer_profile_config_incomplete', `refusing to compose the Customer Profile adapter: missing ${missing.join(', ')}`);
  let base: URL;
  try {
    base = new URL(env.R4_CUSTOMER_PROFILE_BASE_URL!.trim());
  } catch {
    throw new CustomerProfileConfigError('invalid_customer_profile_config', 'R4_CUSTOMER_PROFILE_BASE_URL is not a URL');
  }
  if (base.search || base.hash || base.username || base.password) {
    throw new CustomerProfileConfigError('invalid_customer_profile_config', 'R4_CUSTOMER_PROFILE_BASE_URL must not carry credentials, a query or a fragment');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new CustomerProfileConfigError('invalid_customer_profile_config', 'R4_CUSTOMER_PROFILE_BASE_URL must be http(s)');
  if (!isLoopback(base) && !options.allowNetwork && !(options.allowedHosts ?? []).includes(base.hostname)) {
    throw new CustomerProfileConfigError('network_not_allowed', 'refusing a non-local Customer Profile URL without R4_PROD_ALLOW_NETWORK=true');
  }
  if (!isLoopback(base) && base.protocol !== 'https:') throw new CustomerProfileConfigError('invalid_customer_profile_config', 'a non-local Customer Profile URL must use https');
  const bearerToken = env.R4_CUSTOMER_PROFILE_BEARER_TOKEN!.trim();
  // CP accepts opaque tokens of at least 256 bits (43 base64url characters) and at most 512.
  if (!/^[\x21-\x7e]{43,512}$/.test(bearerToken)) {
    throw new CustomerProfileConfigError('invalid_customer_profile_config', 'R4_CUSTOMER_PROFILE_BEARER_TOKEN is not a plausible token (43–512 printable characters)');
  }
  const raw = env.R4_CUSTOMER_PROFILE_TIMEOUT_MS!.trim();
  const timeoutMs = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeoutMs) || timeoutMs < CUSTOMER_PROFILE_TIMEOUT_MIN_MS || timeoutMs > CUSTOMER_PROFILE_TIMEOUT_MAX_MS) {
    throw new CustomerProfileConfigError('invalid_customer_profile_config', 'R4_CUSTOMER_PROFILE_TIMEOUT_MS must be an integer between 3000 and 5000');
  }
  return { baseUrl: base.toString().replace(/\/+$/, ''), bearerToken, timeoutMs, lifecycle: 'synthetic' };
}

/** Safe description (no secret) for plans and readiness. Declarative only. */
export function describeCustomerProfileHttpConfig(config: CustomerProfileHttpConfig): Record<string, string | number | boolean> {
  return {
    binding: 'SYNTHETIC',
    lifecycle: config.lifecycle,
    baseHost: new URL(config.baseUrl).host,
    timeoutMs: config.timeoutMs,
    bearerTokenConfigured: config.bearerToken.length > 0,
    authentication: 'declared, not verified',
    connectivity: 'not tested',
    realCustomerData: false,
  };
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
