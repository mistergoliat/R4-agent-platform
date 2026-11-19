import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HUMAN_SCOPES, type Clock, type HumanScope, type TrustedHumanContext } from '@r4/contracts';

/**
 * ADR-050: the R4 console's operator identity. The console verifies the
 * owner's Google login itself and signs, per request, an assertion bound to
 * the exact method, path and body bytes. This is the ONLY place in the API
 * that builds a TrustedHumanContext. It reads only the assertion header, the
 * method, the URL and the raw body; the operator is found by (iss, sub) in an
 * owner-provisioned registry, never by email.
 *
 *   x-r4-console-assertion: v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(key, "v1." + payload))>
 *
 * Any failure yields null (the route answers `trusted_human_required`) and
 * logs only a reason code. Without both env vars there is no adapter.
 */
export type HumanContextAdapter = (request: FastifyRequest) => TrustedHumanContext | null;

export const CONSOLE_ASSERTION_MAX_LIFETIME_S = 60;
export const CONSOLE_ASSERTION_CLOCK_SKEW_S = 30;

const EMPTY_BODY = Buffer.alloc(0);
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const ASSERTION = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

const operatorsSchema = z
  .array(
    z.strictObject({
      issuer: z.string().min(1).max(256),
      subject: z.string().min(1).max(255),
      operatorRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      scopes: z.array(z.enum(HUMAN_SCOPES)).min(1),
    }),
  )
  .max(200);

const payloadSchema = z.strictObject({
  v: z.literal(1),
  iss: z.string().min(1).max(256),
  sub: z.string().min(1).max(255),
  scopes: z.array(z.string().max(64)).max(32),
  method: z.literal('POST'),
  path: z.string().min(1).max(2048),
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  jti: z.uuid(),
});

interface ConsoleOperator {
  readonly operatorRef: string;
  readonly scopes: readonly HumanScope[];
}

const identityKey = (issuer: string, subject: string) => `${issuer}\u0000${subject}`;

/** Loads the operators file; refuses one that group or others can access (POSIX) or that lists an identity twice. */
function loadOperators(file: string): ReadonlyMap<string, ConsoleOperator> {
  let raw: string;
  let mode: number;
  try {
    mode = statSync(file).mode;
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error('R4_CONSOLE_OPERATORS_FILE cannot be read');
  }
  // Same rule as ADR-033's operator registry; POSIX modes do not apply on win32 (tests only).
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) throw new Error('R4_CONSOLE_OPERATORS_FILE must not be accessible to group or others (chmod 600)');
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error('R4_CONSOLE_OPERATORS_FILE is not JSON');
  }
  const parsed = operatorsSchema.safeParse(document);
  if (!parsed.success) throw new Error('R4_CONSOLE_OPERATORS_FILE does not match its schema');
  const operators = new Map<string, ConsoleOperator>();
  const refs = new Set<string>();
  for (const o of parsed.data) {
    const key = identityKey(o.issuer, o.subject);
    if (operators.has(key) || refs.has(o.operatorRef)) throw new Error('R4_CONSOLE_OPERATORS_FILE lists an identity or operatorRef twice');
    refs.add(o.operatorRef);
    operators.set(key, { operatorRef: o.operatorRef, scopes: [...new Set(o.scopes)] });
  }
  return operators;
}

export function createConsoleOperatorContext(options: { readonly key?: string | undefined; readonly operatorsFile?: string | undefined; readonly clock: Clock }): HumanContextAdapter | undefined {
  const { key, operatorsFile, clock } = options;
  if (key === undefined && operatorsFile === undefined) return undefined;
  if (key === undefined || operatorsFile === undefined) throw new Error('R4_CONSOLE_OPERATOR_KEY and R4_CONSOLE_OPERATORS_FILE must be set together');
  const secret = BASE64URL.test(key) ? Buffer.from(key, 'base64url') : EMPTY_BODY;
  if (secret.length < 32) throw new Error('R4_CONSOLE_OPERATOR_KEY must be base64url of at least 32 bytes');
  const operators = loadOperators(operatorsFile);
  // ponytail: in-memory jti ledger (r4-api is one process); a restart can only reopen a ≤ 60 s window. Durable ledger if r4-api ever scales out.
  const used = new Map<string, number>();

  const verify = (header: string | string[], request: FastifyRequest): TrustedHumanContext | string => {
    const match = typeof header === 'string' ? ASSERTION.exec(header) : null;
    if (!match) return 'header_malformed';
    const encoded = match[1]!;
    const given = Buffer.from(match[2]!, 'base64url');
    const expected = createHmac('sha256', secret).update(`v1.${encoded}`).digest();
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'signature_invalid';

    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      return 'payload_invalid';
    }
    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) return 'payload_invalid';
    const p = parsed.data;

    const now = Math.floor(clock.now().getTime() / 1000);
    if (p.exp <= p.iat || p.exp - p.iat > CONSOLE_ASSERTION_MAX_LIFETIME_S) return 'lifetime_invalid';
    if (now < p.iat - CONSOLE_ASSERTION_CLOCK_SKEW_S || now > p.exp) return 'not_current';
    if (p.method !== request.method || p.path !== request.url) return 'request_mismatch';
    if (p.bodySha256 !== createHash('sha256').update(request.rawBody ?? EMPTY_BODY).digest('hex')) return 'body_mismatch';

    const operator = operators.get(identityKey(p.iss, p.sub));
    if (!operator) return 'operator_not_registered';
    const scopes = operator.scopes.filter((s) => p.scopes.includes(s));
    if (scopes.length === 0) return 'scope_not_granted';

    // Single use: a jti is consumed once and remembered until its exp.
    for (const [jti, exp] of used) if (exp < now) used.delete(jti);
    if (used.has(p.jti)) return 'replayed';
    used.set(p.jti, p.exp);
    return { humanRef: `oidc:${operator.operatorRef}`, scopes, correlationId: request.id };
  };

  return (request) => {
    const header = request.headers['x-r4-console-assertion'];
    if (header === undefined) return null;
    const result = verify(header, request);
    if (typeof result !== 'string') return result;
    request.log.warn({ event: 'console_assertion.rejected', reason: result }, 'console assertion rejected');
    return null;
  };
}
