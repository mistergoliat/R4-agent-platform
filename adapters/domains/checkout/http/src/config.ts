/**
 * Checkout adapter configuration (contract R-1), explicit and fail-closed:
 *
 *   R4_CHECKOUT_MODE          "sandbox" binds the Checkout sandbox-purchase API; unset = not configured. There is
 *                             no production mode: Checkout serves its command API only in the sandbox-purchase profile.
 *   R4_CHECKOUT_BASE_URL      the API listener (EC2: http://127.0.0.1:4031), never the webhook/health port 4030
 *   R4_CHECKOUT_BEARER_TOKEN  R4's service token (secret: never printed, never logged)
 *   R4_CHECKOUT_TIMEOUT_MS    per-call deadline, 1000–30000 ms
 *   R4_CHECKOUT_READINESS_URL the health listener of the same Checkout (EC2: http://127.0.0.1:4030), same host as the
 *                             API: every command first reads its /health/ready and proceeds only when it proves sandbox
 *                             isolation (D7-6; contract §11.4.6)
 *
 * A non-loopback URL requires network to be explicitly allowed and https. Loading a configuration proves only that
 * it is well-formed.
 */
export interface CheckoutHttpConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  /** Origin of Checkout's health listener (GET /health/ready), same host as `baseUrl`. */
  readonly readinessUrl: string;
}

export class CheckoutConfigError extends Error {
  readonly code: 'checkout_config_incomplete' | 'invalid_checkout_config' | 'network_not_allowed';

  constructor(code: CheckoutConfigError['code'], message: string) {
    super(message);
    this.name = 'CheckoutConfigError';
    this.code = code;
  }
}

export const CHECKOUT_ENV = ['R4_CHECKOUT_MODE', 'R4_CHECKOUT_BASE_URL', 'R4_CHECKOUT_BEARER_TOKEN', 'R4_CHECKOUT_TIMEOUT_MS', 'R4_CHECKOUT_READINESS_URL'] as const;

export type CheckoutMode = 'sandbox' | 'not_configured';

export function checkoutModeOf(env: Readonly<Record<string, string | undefined>>): CheckoutMode {
  const raw = env.R4_CHECKOUT_MODE?.trim();
  if (!raw) return 'not_configured';
  if (raw === 'sandbox') return 'sandbox';
  throw new CheckoutConfigError('invalid_checkout_config', 'R4_CHECKOUT_MODE must be "sandbox" or unset');
}

export function loadCheckoutHttpConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): CheckoutHttpConfig {
  if (checkoutModeOf(env) !== 'sandbox') throw new CheckoutConfigError('checkout_config_incomplete', 'refusing to compose the Checkout adapter: R4_CHECKOUT_MODE is not "sandbox"');
  const missing = CHECKOUT_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new CheckoutConfigError('checkout_config_incomplete', `refusing to compose the Checkout adapter: missing ${missing.join(', ')}`);
  const base = originOf(env, 'R4_CHECKOUT_BASE_URL', options);
  const readiness = originOf(env, 'R4_CHECKOUT_READINESS_URL', options);
  if (readiness.hostname !== base.hostname) throw new CheckoutConfigError('invalid_checkout_config', 'R4_CHECKOUT_READINESS_URL must be the same host as R4_CHECKOUT_BASE_URL (the readiness of the Checkout R4 calls)');
  if (readiness.origin === base.origin) throw new CheckoutConfigError('invalid_checkout_config', 'R4_CHECKOUT_READINESS_URL is the health listener, not the API listener');
  const bearerToken = env.R4_CHECKOUT_BEARER_TOKEN!.trim();
  if (bearerToken.length < 32 || !/^[\x21-\x7e]+$/.test(bearerToken)) throw new CheckoutConfigError('invalid_checkout_config', 'R4_CHECKOUT_BEARER_TOKEN is not a plausible token (at least 32 printable characters)');
  const raw = env.R4_CHECKOUT_TIMEOUT_MS!.trim();
  const timeoutMs = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new CheckoutConfigError('invalid_checkout_config', 'R4_CHECKOUT_TIMEOUT_MS must be an integer between 1000 and 30000');
  return { baseUrl: base.origin, bearerToken, timeoutMs, readinessUrl: readiness.origin };
}

function originOf(env: Readonly<Record<string, string | undefined>>, name: 'R4_CHECKOUT_BASE_URL' | 'R4_CHECKOUT_READINESS_URL', options: { readonly allowNetwork: boolean }): URL {
  let url: URL;
  try {
    url = new URL(env[name]!.trim());
  } catch {
    throw new CheckoutConfigError('invalid_checkout_config', `${name} is not a URL`);
  }
  if (url.search || url.hash || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    throw new CheckoutConfigError('invalid_checkout_config', `${name} must be an origin: no credentials, path, query or fragment`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CheckoutConfigError('invalid_checkout_config', `${name} must be http(s)`);
  if (!isLoopback(url) && !options.allowNetwork) throw new CheckoutConfigError('network_not_allowed', 'refusing a non-local Checkout URL without R4_PROD_ALLOW_NETWORK=true');
  if (!isLoopback(url) && url.protocol !== 'https:') throw new CheckoutConfigError('invalid_checkout_config', 'a non-local Checkout URL must use https');
  return url;
}

/** Safe description (no secret) for plans and readiness. */
export function describeCheckoutHttpConfig(config: CheckoutHttpConfig): Record<string, string | number | boolean> {
  return { binding: 'SANDBOX', baseHost: new URL(config.baseUrl).host, timeoutMs: config.timeoutMs, readinessHost: new URL(config.readinessUrl).host, sandboxIsolation: 'checked before every command', bearerTokenConfigured: config.bearerToken.length > 0, authentication: 'declared, not verified', connectivity: 'not tested' };
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
