/**
 * Catalog HTTP adapter configuration, explicit and fail-closed:
 *
 *   R4_CATALOG_BASE_URL    catalog-service base URL (no default; never a hardcoded host)
 *   R4_CATALOG_API_KEY     the API key dedicated to R4 (never printed)
 *   R4_CATALOG_TIMEOUT_MS  per-call deadline, 100–10000 ms (≤ the capability timeout)
 *
 * A non-loopback URL requires network to be explicitly allowed and https.
 * Loading a configuration proves only that it is well-formed: it says
 * nothing about connectivity or whether the key is accepted.
 */
export interface CatalogHttpConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export class CatalogConfigError extends Error {
  readonly code: 'catalog_config_incomplete' | 'invalid_catalog_config' | 'network_not_allowed';

  constructor(code: CatalogConfigError['code'], message: string) {
    super(message);
    this.name = 'CatalogConfigError';
    this.code = code;
  }
}

export const CATALOG_ENV = ['R4_CATALOG_BASE_URL', 'R4_CATALOG_API_KEY', 'R4_CATALOG_TIMEOUT_MS'] as const;

export function loadCatalogHttpConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): CatalogHttpConfig {
  const missing = CATALOG_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new CatalogConfigError('catalog_config_incomplete', `refusing to compose the Catalog adapter: missing ${missing.join(', ')}`);
  let base: URL;
  try {
    base = new URL(env.R4_CATALOG_BASE_URL!.trim());
  } catch {
    throw new CatalogConfigError('invalid_catalog_config', 'R4_CATALOG_BASE_URL is not a URL');
  }
  if (base.search || base.hash || base.username || base.password) throw new CatalogConfigError('invalid_catalog_config', 'R4_CATALOG_BASE_URL must not carry credentials, a query or a fragment');
  if (!isLoopback(base) && !options.allowNetwork) throw new CatalogConfigError('network_not_allowed', 'refusing a non-local catalog URL without R4_PROD_ALLOW_NETWORK=true');
  if (!isLoopback(base) && base.protocol !== 'https:') throw new CatalogConfigError('invalid_catalog_config', 'a non-local catalog URL must use https');
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new CatalogConfigError('invalid_catalog_config', 'R4_CATALOG_BASE_URL must be http(s)');
  const apiKey = env.R4_CATALOG_API_KEY!.trim();
  if (apiKey.length < 16) throw new CatalogConfigError('invalid_catalog_config', 'R4_CATALOG_API_KEY is too short to be a real key');
  const raw = env.R4_CATALOG_TIMEOUT_MS!.trim();
  const timeoutMs = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new CatalogConfigError('invalid_catalog_config', 'R4_CATALOG_TIMEOUT_MS must be an integer between 100 and 10000');
  return { baseUrl: base.toString().replace(/\/+$/, ''), apiKey, timeoutMs };
}

/**
 * Safe description (no secrets) for plans and readiness. Declarative only:
 * `authentication` and `connectivity` are never claimed from configuration.
 */
export function describeCatalogHttpConfig(config: CatalogHttpConfig): Record<string, string | number | boolean> {
  return {
    baseHost: new URL(config.baseUrl).host,
    timeoutMs: config.timeoutMs,
    apiKeyConfigured: config.apiKey.length > 0,
    authentication: 'declared, not verified',
    connectivity: 'not tested',
  };
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
