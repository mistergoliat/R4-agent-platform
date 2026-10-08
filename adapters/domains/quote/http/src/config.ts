/**
 * Quote V2 adapter configuration, explicit and fail-closed:
 *
 *   R4_QUOTE_MODE          "real" binds the Quote V2 owner adapter; unset = not configured
 *   R4_QUOTE_BASE_URL      Quote Service base URL (no default; never a hardcoded host).
 *                          EC2 integration: http://127.0.0.1:4020 (same host only; never public)
 *   R4_QUOTE_BEARER_TOKEN  the R4 principal's bearer token (secret: never printed, never logged)
 *   R4_QUOTE_TIMEOUT_MS    per-call deadline, 1000–30000 ms (owner handoff recommends ≈ 20000:
 *                          above its 15 s request timeout plus the 5 s synchronous issuance budget)
 *
 * A non-loopback URL requires network to be explicitly allowed and https.
 * Loading a configuration proves only that it is well-formed: it says
 * nothing about connectivity or whether the token is accepted.
 */
export interface QuoteHttpConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
}

export class QuoteConfigError extends Error {
  readonly code: 'quote_config_incomplete' | 'invalid_quote_config' | 'network_not_allowed';

  constructor(code: QuoteConfigError['code'], message: string) {
    super(message);
    this.name = 'QuoteConfigError';
    this.code = code;
  }
}

export const QUOTE_ENV = ['R4_QUOTE_MODE', 'R4_QUOTE_BASE_URL', 'R4_QUOTE_BEARER_TOKEN', 'R4_QUOTE_TIMEOUT_MS'] as const;

export type QuoteMode = 'real' | 'not_configured';

/** The selected Quote mode. An unknown value is a configuration error, never a silent fallback. */
export function quoteModeOf(env: Readonly<Record<string, string | undefined>>): QuoteMode {
  const raw = env.R4_QUOTE_MODE?.trim();
  if (!raw) return 'not_configured';
  if (raw === 'real') return 'real';
  throw new QuoteConfigError('invalid_quote_config', 'R4_QUOTE_MODE must be "real" or unset');
}

export function loadQuoteHttpConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): QuoteHttpConfig {
  if (quoteModeOf(env) !== 'real') throw new QuoteConfigError('quote_config_incomplete', 'refusing to compose the Quote adapter: R4_QUOTE_MODE is not "real"');
  const missing = QUOTE_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new QuoteConfigError('quote_config_incomplete', `refusing to compose the Quote adapter: missing ${missing.join(', ')}`);
  let base: URL;
  try {
    base = new URL(env.R4_QUOTE_BASE_URL!.trim());
  } catch {
    throw new QuoteConfigError('invalid_quote_config', 'R4_QUOTE_BASE_URL is not a URL');
  }
  if (base.search || base.hash || base.username || base.password) throw new QuoteConfigError('invalid_quote_config', 'R4_QUOTE_BASE_URL must not carry credentials, a query or a fragment');
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new QuoteConfigError('invalid_quote_config', 'R4_QUOTE_BASE_URL must be http(s)');
  if (!isLoopback(base) && !options.allowNetwork) throw new QuoteConfigError('network_not_allowed', 'refusing a non-local quote URL without R4_PROD_ALLOW_NETWORK=true');
  if (!isLoopback(base) && base.protocol !== 'https:') throw new QuoteConfigError('invalid_quote_config', 'a non-local quote URL must use https');
  const bearerToken = env.R4_QUOTE_BEARER_TOKEN!.trim();
  if (bearerToken.length < 32 || !/^[\x21-\x7e]+$/.test(bearerToken)) throw new QuoteConfigError('invalid_quote_config', 'R4_QUOTE_BEARER_TOKEN is not a plausible token (at least 32 printable characters)');
  const raw = env.R4_QUOTE_TIMEOUT_MS!.trim();
  const timeoutMs = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new QuoteConfigError('invalid_quote_config', 'R4_QUOTE_TIMEOUT_MS must be an integer between 1000 and 30000');
  return { baseUrl: base.toString().replace(/\/+$/, ''), bearerToken, timeoutMs };
}

/** Safe description (no secret) for plans and readiness. Declarative only: authentication and connectivity are never claimed from configuration. */
export function describeQuoteHttpConfig(config: QuoteHttpConfig): Record<string, string | number | boolean> {
  return {
    binding: 'REAL',
    baseHost: new URL(config.baseUrl).host,
    timeoutMs: config.timeoutMs,
    bearerTokenConfigured: config.bearerToken.length > 0,
    authentication: 'declared, not verified',
    connectivity: 'not tested',
  };
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
