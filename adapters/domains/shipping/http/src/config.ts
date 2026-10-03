/**
 * Shipping (pc-carrier) adapter configuration, explicit and fail-closed:
 *
 *   R4_SHIPPING_MODE        "real" binds the production owner adapter; unset = not configured
 *   R4_SHIPPING_BASE_URL    pc-carrier base URL (no default; never a hardcoded host),
 *                           e.g. https://<owner-host>/api/pc-carrier
 *   R4_SHIPPING_TIMEOUT_MS  per-owner-call deadline, 100–10000 ms (recommended 5000)
 *
 * The owner's quote endpoints require no credentials, so there is none to
 * configure. A non-loopback URL requires network to be explicitly allowed
 * and https. Loading a configuration proves only that it is well-formed: it
 * says nothing about connectivity.
 */
export interface ShippingHttpConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export class ShippingConfigError extends Error {
  readonly code: 'shipping_config_incomplete' | 'invalid_shipping_config' | 'network_not_allowed';

  constructor(code: ShippingConfigError['code'], message: string) {
    super(message);
    this.name = 'ShippingConfigError';
    this.code = code;
  }
}

export const SHIPPING_ENV = ['R4_SHIPPING_MODE', 'R4_SHIPPING_BASE_URL', 'R4_SHIPPING_TIMEOUT_MS'] as const;

export type ShippingMode = 'real' | 'not_configured';

/** The selected shipping mode. An unknown value is a configuration error, never a silent fallback. */
export function shippingModeOf(env: Readonly<Record<string, string | undefined>>): ShippingMode {
  const raw = env.R4_SHIPPING_MODE?.trim();
  if (!raw) return 'not_configured';
  if (raw === 'real') return 'real';
  throw new ShippingConfigError('invalid_shipping_config', 'R4_SHIPPING_MODE must be "real" or unset');
}

export function loadShippingHttpConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): ShippingHttpConfig {
  if (shippingModeOf(env) !== 'real') throw new ShippingConfigError('shipping_config_incomplete', 'refusing to compose the Shipping adapter: R4_SHIPPING_MODE is not "real"');
  const missing = SHIPPING_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new ShippingConfigError('shipping_config_incomplete', `refusing to compose the Shipping adapter: missing ${missing.join(', ')}`);
  let base: URL;
  try {
    base = new URL(env.R4_SHIPPING_BASE_URL!.trim());
  } catch {
    throw new ShippingConfigError('invalid_shipping_config', 'R4_SHIPPING_BASE_URL is not a URL');
  }
  if (base.search || base.hash || base.username || base.password) throw new ShippingConfigError('invalid_shipping_config', 'R4_SHIPPING_BASE_URL must not carry credentials, a query or a fragment');
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new ShippingConfigError('invalid_shipping_config', 'R4_SHIPPING_BASE_URL must be http(s)');
  if (!isLoopback(base) && !options.allowNetwork) throw new ShippingConfigError('network_not_allowed', 'refusing a non-local shipping URL without R4_PROD_ALLOW_NETWORK=true');
  if (!isLoopback(base) && base.protocol !== 'https:') throw new ShippingConfigError('invalid_shipping_config', 'a non-local shipping URL must use https');
  const raw = env.R4_SHIPPING_TIMEOUT_MS!.trim();
  const timeoutMs = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new ShippingConfigError('invalid_shipping_config', 'R4_SHIPPING_TIMEOUT_MS must be an integer between 100 and 10000');
  return { baseUrl: base.toString().replace(/\/+$/, ''), timeoutMs };
}

/** Safe description for plans and readiness. Declarative only: connectivity is never claimed from configuration. */
export function describeShippingHttpConfig(config: ShippingHttpConfig): Record<string, string | number> {
  return {
    binding: 'REAL',
    baseHost: new URL(config.baseUrl).host,
    timeoutMs: config.timeoutMs,
    connectivity: 'not tested',
  };
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
