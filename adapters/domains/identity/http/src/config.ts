/**
 * Customer Identity Authority adapter configuration (R4-J4-R3), explicit and fail-closed:
 *
 *   R4_CUSTOMER_MODE                    "synthetic" binds this adapter against a synthetic CIA;
 *                                       unset = not configured; "real" is REFUSED (real customer
 *                                       data stays blocked: G-16, AP-*, SEC-OTP-01/02).
 *   R4_CUSTOMER_IDENTITY_BASE_URL       CIA base URL. LOOPBACK ONLY in this slice: there is no
 *                                       network override until a real binding has its own mandate.
 *   R4_CUSTOMER_IDENTITY_BEARER_TOKEN   the r4-sales agent credential of the CIA (secret: never
 *                                       printed or logged). A synthetic credential: "synthetic-…".
 *   R4_CUSTOMER_IDENTITY_TIMEOUT_MS     per-call deadline, 100–3000 ms (specification R4-J4-R1 §8).
 *
 * Loading a configuration proves only that it is well-formed: not connectivity, not that the
 * credential is accepted.
 */
export interface CustomerIdentityHttpConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  /** Only `synthetic` exists: resolved customers must be in the synthetic id range (AG-1). */
  readonly lifecycle: 'synthetic';
}

export class CustomerIdentityConfigError extends Error {
  readonly code: 'customer_identity_config_incomplete' | 'invalid_customer_identity_config' | 'network_not_allowed' | 'customer_real_data_blocked';

  constructor(code: CustomerIdentityConfigError['code'], message: string) {
    super(message);
    this.name = 'CustomerIdentityConfigError';
    this.code = code;
  }
}

export const CUSTOMER_IDENTITY_ENV = ['R4_CUSTOMER_MODE', 'R4_CUSTOMER_IDENTITY_BASE_URL', 'R4_CUSTOMER_IDENTITY_BEARER_TOKEN', 'R4_CUSTOMER_IDENTITY_TIMEOUT_MS'] as const;

export const CUSTOMER_IDENTITY_TIMEOUT_MIN_MS = 100;
export const CUSTOMER_IDENTITY_TIMEOUT_MAX_MS = 3_000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loadCustomerIdentityHttpConfig(env: Readonly<Record<string, string | undefined>>): CustomerIdentityHttpConfig {
  const mode = env.R4_CUSTOMER_MODE?.trim();
  if (mode === 'real') {
    throw new CustomerIdentityConfigError('customer_real_data_blocked', 'R4_CUSTOMER_MODE=real is refused: real customer identity resolution is blocked');
  }
  if (mode !== 'synthetic') {
    throw new CustomerIdentityConfigError(mode ? 'invalid_customer_identity_config' : 'customer_identity_config_incomplete', 'refusing to compose the CIA adapter: R4_CUSTOMER_MODE must be "synthetic"');
  }
  const missing = CUSTOMER_IDENTITY_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new CustomerIdentityConfigError('customer_identity_config_incomplete', `refusing to compose the CIA adapter: missing ${missing.join(', ')}`);

  let base: URL;
  try {
    base = new URL(env.R4_CUSTOMER_IDENTITY_BASE_URL!.trim());
  } catch {
    throw new CustomerIdentityConfigError('invalid_customer_identity_config', 'R4_CUSTOMER_IDENTITY_BASE_URL is not a URL');
  }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new CustomerIdentityConfigError('invalid_customer_identity_config', 'R4_CUSTOMER_IDENTITY_BASE_URL must be scheme://host[:port] with no credentials, path, query or fragment');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new CustomerIdentityConfigError('invalid_customer_identity_config', 'R4_CUSTOMER_IDENTITY_BASE_URL must be http(s)');
  if (!LOOPBACK.has(base.hostname)) throw new CustomerIdentityConfigError('network_not_allowed', 'the CIA is reachable on loopback only in this slice');

  const bearerToken = env.R4_CUSTOMER_IDENTITY_BEARER_TOKEN!.trim();
  if (!/^synthetic-[\x21-\x7e]{14,502}$/.test(bearerToken)) {
    throw new CustomerIdentityConfigError('invalid_customer_identity_config', 'R4_CUSTOMER_IDENTITY_BEARER_TOKEN must be a synthetic credential ("synthetic-…", 24–512 printable characters)');
  }
  const raw = env.R4_CUSTOMER_IDENTITY_TIMEOUT_MS!.trim();
  const timeoutMs = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeoutMs) || timeoutMs < CUSTOMER_IDENTITY_TIMEOUT_MIN_MS || timeoutMs > CUSTOMER_IDENTITY_TIMEOUT_MAX_MS) {
    throw new CustomerIdentityConfigError('invalid_customer_identity_config', 'R4_CUSTOMER_IDENTITY_TIMEOUT_MS must be an integer between 100 and 3000');
  }
  return { baseUrl: base.origin, bearerToken, timeoutMs, lifecycle: 'synthetic' };
}

/** Safe description (no secret) for plans and readiness. Declarative only. */
export function describeCustomerIdentityHttpConfig(config: CustomerIdentityHttpConfig): Record<string, string | number | boolean> {
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
