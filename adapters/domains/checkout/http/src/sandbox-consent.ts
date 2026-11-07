import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { CheckoutConsentEvidence, CheckoutConsentSource } from '@r4-adapters/domains';
import { CheckoutConfigError } from './config.js';

/** The only format this source hands over: Checkout's TEST consent (`src/sandboxPurchase/testAuthority.ts`). */
export const CHECKOUT_SANDBOX_CONSENT_FORMAT = 'checkout-sbx-test-consent.v1';
/** An artifact closer than this to its expiry is not handed over (Checkout verifies `exp` when it receives it). */
export const CHECKOUT_SANDBOX_CONSENT_MIN_REMAINING_MS = 120_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * (R-3, sandbox only) The purchase-consent artifact an operator obtained with Checkout's own test tooling
 * (`node dist/src/main.js sign-test-consent …`, CHECKOUT_PROFILE=sandbox-purchase) and placed, as that command printed
 * it, in `<dir>/<quoteId>.json`. R4 never signs, mints or changes consent: it reads the file and checks only that it
 * names this exact quote and version and is not about to expire. Its signature, issuer, buyer, snapshot and document
 * are Checkout's to verify (it is the verifier). No file, or one for another quote, → null: nothing is sent.
 */
export class SandboxConsentDirectory implements CheckoutConsentSource {
  readonly #dir: string;
  readonly #now: () => Date;

  constructor(options: { readonly dir: string; readonly now?: () => Date }) {
    if (!isAbsolute(options.dir)) throw new CheckoutConfigError('invalid_checkout_config', 'R4_CHECKOUT_SBX_CONSENT_DIR must be an absolute path');
    this.#dir = options.dir;
    this.#now = options.now ?? (() => new Date());
  }

  async obtain(request: Parameters<CheckoutConsentSource['obtain']>[0]): Promise<CheckoutConsentEvidence | null> {
    if (!UUID.test(request.quoteId)) return null;
    let raw: string;
    try {
      raw = await readFile(join(this.#dir, `${request.quoteId}.json`), 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
    return consentFor(raw, request, this.#now());
  }
}

/** The artifact in `raw` (Checkout's `{consent:{format,token}}` output, or the bare `{format,token}`) when it is for this quote. */
export function consentFor(raw: string, request: { readonly quoteId: string; readonly quoteVersion: number }, now: Date): CheckoutConsentEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(0, 20_000));
  } catch {
    return null;
  }
  const outer = parsed as { consent?: unknown } | null;
  const c = (outer && typeof outer === 'object' && 'consent' in outer ? outer.consent : parsed) as { format?: unknown; token?: unknown } | null;
  if (!c || c.format !== CHECKOUT_SANDBOX_CONSENT_FORMAT || typeof c.token !== 'string' || c.token.length < 16 || c.token.length > 8192 || !JWS.test(c.token)) return null;
  let claims: { quoteId?: unknown; quoteVersion?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(c.token.split('.')[1]!, 'base64url').toString('utf8')) as typeof claims;
  } catch {
    return null;
  }
  if (claims.quoteId !== request.quoteId || claims.quoteVersion !== request.quoteVersion || typeof claims.exp !== 'number') return null;
  if (claims.exp * 1000 - now.getTime() < CHECKOUT_SANDBOX_CONSENT_MIN_REMAINING_MS) return null;
  return { format: c.format, token: c.token };
}

/** `R4_CHECKOUT_SBX_CONSENT_DIR` (absolute), or null when unset (then no consent source exists and @15 refuses to compose). */
export function sandboxConsentDirOf(env: Readonly<Record<string, string | undefined>>): string | null {
  const dir = env.R4_CHECKOUT_SBX_CONSENT_DIR?.trim();
  return dir ? dir : null;
}
