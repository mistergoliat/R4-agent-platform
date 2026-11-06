/**
 * Catalog HTTP adapter configuration, explicit and fail-closed:
 *
 *   R4_CATALOG_BASE_URL    catalog-service base URL (no default; never a hardcoded host)
 *   R4_CATALOG_API_KEY     the API key dedicated to R4 (never printed)
 *   R4_CATALOG_TIMEOUT_MS  per-call deadline, 100–10000 ms (≤ the capability timeout)
 *
 * (R4-CATALOG-V2) Two sources of the SAME read contract (/v2/catalog/search, products/{k}/context,
 * items/{k}/context; schemaVersion 1), each with its own variables so both can coexist in one environment:
 *
 *   v1  R4_CATALOG_*     the service the production profiles bind today (the default: nothing changes)
 *   v2  R4_CATALOG_V2_*  Catalog V2 (CAT_V2_R4_J45_HANDOFF §2: its own base URL and R4 key)
 *
 * (ADR-045) Discover is served only by V2 and needs its OWN key (Catalog requires a key listed for Discover; the general
 * R4 key gets 403): R4_CATALOG_V2_DISCOVER_API_KEY, optional, read only for v2. Without it `discover` is refused locally.
 *
 * The caller chooses the source explicitly. Only that source's variables are read: a missing V2 variable is a
 * refusal, never a fallback to V1.
 *
 * A non-loopback URL requires network to be explicitly allowed and https.
 * Loading a configuration proves only that it is well-formed: it says
 * nothing about connectivity or whether the key is accepted.
 */
export type CatalogSource = 'v1' | 'v2';

export interface CatalogHttpConfig {
  /** Which Catalog the configuration points at; absent means v1 (hand-built and historical configurations). */
  readonly source?: CatalogSource;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** (v2 only) The key Catalog accepts on /v2/catalog/discover; absent: Discover is not configured. */
  readonly discoverApiKey?: string;
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
/** (R4-CATALOG-V2) Catalog V2's variables (handoff §2). */
export const CATALOG_V2_ENV = ['R4_CATALOG_V2_BASE_URL', 'R4_CATALOG_V2_API_KEY', 'R4_CATALOG_V2_TIMEOUT_MS'] as const;

/** (ADR-045) Catalog V2's Discover key (handoff §3), optional and only for v2. */
export const CATALOG_V2_DISCOVER_KEY_ENV = 'R4_CATALOG_V2_DISCOVER_API_KEY';

/** The variable names of a source: base URL, API key, timeout. */
export function catalogEnvOf(source: CatalogSource): readonly [string, string, string] {
  return source === 'v2' ? CATALOG_V2_ENV : CATALOG_ENV;
}

export function loadCatalogHttpConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean; readonly source?: CatalogSource }): CatalogHttpConfig {
  const source = options.source ?? 'v1';
  const names = catalogEnvOf(source);
  const [urlVar, keyVar, timeoutVar] = names;
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new CatalogConfigError('catalog_config_incomplete', `refusing to compose the Catalog adapter (${source}): missing ${missing.join(', ')}`);
  let base: URL;
  try {
    base = new URL(env[urlVar]!.trim());
  } catch {
    throw new CatalogConfigError('invalid_catalog_config', `${urlVar} is not a URL`);
  }
  if (base.search || base.hash || base.username || base.password) throw new CatalogConfigError('invalid_catalog_config', `${urlVar} must not carry credentials, a query or a fragment`);
  if (!isLoopback(base) && !options.allowNetwork) throw new CatalogConfigError('network_not_allowed', 'refusing a non-local catalog URL without R4_PROD_ALLOW_NETWORK=true');
  if (!isLoopback(base) && base.protocol !== 'https:') throw new CatalogConfigError('invalid_catalog_config', 'a non-local catalog URL must use https');
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new CatalogConfigError('invalid_catalog_config', `${urlVar} must be http(s)`);
  const apiKey = env[keyVar]!.trim();
  if (apiKey.length < 16) throw new CatalogConfigError('invalid_catalog_config', `${keyVar} is too short to be a real key`);
  const raw = env[timeoutVar]!.trim();
  const timeoutMs = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new CatalogConfigError('invalid_catalog_config', `${timeoutVar} must be an integer between 100 and 10000`);
  const config = { baseUrl: base.toString().replace(/\/+$/, ''), apiKey, timeoutMs };
  if (source !== 'v2') return config; // v1 keeps its exact historical shape; v2 says what it is.
  const discoverApiKey = env[CATALOG_V2_DISCOVER_KEY_ENV]?.trim();
  if (discoverApiKey === undefined || discoverApiKey === '') return { source, ...config };
  if (discoverApiKey.length < 16) throw new CatalogConfigError('invalid_catalog_config', `${CATALOG_V2_DISCOVER_KEY_ENV} is too short to be a real key`);
  if (discoverApiKey === apiKey) throw new CatalogConfigError('invalid_catalog_config', `${CATALOG_V2_DISCOVER_KEY_ENV} must be the Discover key, not the general R4 key`);
  return { source, ...config, discoverApiKey };
}

/**
 * Safe description (no secrets) for plans and readiness. Declarative only:
 * `authentication` and `connectivity` are never claimed from configuration.
 */
export function describeCatalogHttpConfig(config: CatalogHttpConfig): Record<string, string | number | boolean> {
  return {
    // v1 descriptions stay exactly as they were (the production plan output does not change).
    ...(config.source === 'v2' ? { source: 'v2' } : {}),
    baseHost: new URL(config.baseUrl).host,
    timeoutMs: config.timeoutMs,
    apiKeyConfigured: config.apiKey.length > 0,
    ...(config.source === 'v2' ? { discoverKeyConfigured: Boolean(config.discoverApiKey) } : {}),
    authentication: 'declared, not verified',
    connectivity: 'not tested',
  };
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
