import { createHash, createHmac, createPublicKey, generateKeyPairSync, verify, type JsonWebKey } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_PURPOSES, CUSTOMER_REF_PATTERN } from '@r4-adapters/domains';

// CIA-S0 (R4-J4-CIA-S0-CONTRACT-FOUNDATION-01): the CANDIDATE CIA v1 contract in
// docs/contracts/cia/v1 — schemas, synthetic fixtures, MANIFEST hashes and a
// reference verifier of the grant. Documentary artifacts: no CIA, no R4 runtime.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CIA = join(ROOT, 'docs/contracts/cia/v1');
// The repository pins ajv 8.20.0 through the customer-http adapter; the root ajv is eslint's v6.
const pinned = createRequire(join(ROOT, 'adapters/domains/customer/http/package.json'));
type Validate = ((data: unknown) => boolean) & { errors?: { instancePath: string; keyword: string }[] | null };
type Ajv = { addSchema(schema: object): void; getSchema(id: string): Validate | undefined };
const { Ajv2020 } = pinned('ajv/dist/2020.js') as { Ajv2020: new (options: object) => Ajv };
const addFormats = pinned('ajv-formats') as (ajv: Ajv) => void;

const text = (path: string) => readFileSync(join(CIA, path), 'utf8');
const json = <T = Record<string, unknown>>(path: string) => JSON.parse(text(path)) as T;
const contentHash = (raw: string) => createHash('sha256').update(JSON.stringify(JSON.parse(raw))).digest('hex');
const walk = (dir: string): string[] => readdirSync(join(CIA, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

type Entry = { id: string; file: string; kind: 'body' | 'grant' | 'verifier-config' | 'idempotency-scenario' | 'delivery-scenario'; schema?: string; valid?: boolean; expectedError?: { instancePath: string; keyword: string }; sha256: string };
const MANIFEST = json<{ schemas: { file: string; sha256: string }[]; scenarios: Record<string, string[]>; fixtures: Entry[] }>('MANIFEST.json');
const bodies = MANIFEST.fixtures.filter((e) => e.kind === 'body');
const SCHEMA_FILES = readdirSync(join(CIA, 'schemas')).sort();
const BASE = 'https://pesaschile.cl/contracts/cia/v1/';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const file of SCHEMA_FILES) ajv.addSchema(json(`schemas/${file}`));
const validator = (ref: string) => { const v = ajv.getSchema(BASE + ref); if (!v) throw new Error(`unknown schema ${ref}`); return v; };

describe('CIA v1 schemas', () => {
  it('compile in strict mode with ajv 8.20.0 (the version pinned in the repository)', () => {
    expect((pinned('ajv/package.json') as { version: string }).version).toBe('8.20.0');
    for (const file of SCHEMA_FILES) expect(ajv.getSchema(BASE + file), file).toBeDefined();
  });

  it('name no channel, channel provider, account provider or consumer: the core stays agnostic', () => {
    for (const file of SCHEMA_FILES) expect(text(`schemas/${file}`), file).not.toMatch(/whatsapp|instagram|\bmeta\b|wa_id|phone_number|prestashop|ps_customer|id_shop|r4/i);
  });

  it('every request carries the omnichannel context and every request body is closed', () => {
    for (const op of ['verification-start', 'verification-confirm', 'resolve', 'link-revoke']) {
      const request = (json(`schemas/${op}.v1.schema.json`).$defs as Record<string, { required: string[]; additionalProperties: boolean }>).request;
      expect(request!.required, op).toContain('context');
      expect(request!.additionalProperties, op).toBe(false);
    }
  });
});

describe('MANIFEST provenance and reproducible hashes', () => {
  it('hashes every schema and lists exactly the schema files', () => {
    expect(MANIFEST.schemas.map((s) => s.file)).toEqual(SCHEMA_FILES.map((f) => `schemas/${f}`));
    for (const s of MANIFEST.schemas) expect(contentHash(text(s.file)), s.file).toBe(s.sha256);
  });

  it('hashes every fixture and lists exactly the fixture files', () => {
    expect(MANIFEST.fixtures.map((e) => e.file).sort()).toEqual(walk('fixtures').sort());
    for (const e of MANIFEST.fixtures) expect(contentHash(text(e.file)), e.file).toBe(e.sha256);
    expect(new Set(MANIFEST.fixtures.map((e) => e.id)).size).toBe(MANIFEST.fixtures.length);
  });

  it('maps each mandated scenario to existing fixtures, with valid and invalid fixtures', () => {
    const ids = new Set(MANIFEST.fixtures.map((e) => e.id));
    expect(Object.keys(MANIFEST.scenarios).sort()).toEqual(['account_ambiguous', 'account_nonexistent', 'context_unauthorized', 'dependency_unavailable', 'grant_forged_or_incompatible', 'grant_issued', 'grant_temporal_coherence', 'idempotency', 'otp_start_and_confirm', 'revocation', 'verification_correct', 'verification_expired']);
    for (const [name, list] of Object.entries(MANIFEST.scenarios)) for (const id of list) expect(ids.has(id), `${name}: ${id}`).toBe(true);
    expect(bodies.some((e) => !e.valid) && bodies.some((e) => e.valid)).toBe(true);
  });

  it('uses synthetic data only (.test emails, fictional 555-01xx subjects, CP synthetic ids)', () => {
    const all = walk('fixtures').map((f) => text(f)).join('\n');
    for (const email of all.match(/[\w.+|-]+@[\w.-]+/g) ?? []) expect(email, email).toMatch(/@synthetic\.test$/);
    for (const ref of all.match(/prestashop_customer:\d+/g) ?? []) { const id = Number(ref.split(':')[1]); expect(id >= 900000201 && id <= 900000313, ref).toBe(true); }
    for (const subject of all.match(/"subjectRef": "[^"]+"/g) ?? []) expect(subject).toMatch(/"155555501\d\d"$/);
  });
});

describe('body fixtures against their schema', () => {
  it.each(bodies.map((e) => [e.id, e] as const))('%s', (_id, e) => {
    const validate = validator(e.schema!);
    const ok = validate(json(e.file));
    expect(ok, `${e.file}: ${JSON.stringify(validate.errors)}`).toBe(e.valid);
    if (!e.valid) expect(validate.errors!.some((err) => err.instancePath === e.expectedError!.instancePath && err.keyword === e.expectedError!.keyword), JSON.stringify(validate.errors)).toBe(true);
  });
});

// Reference verifier of the CANDIDATE grant (CIA_V1_CONTRACT.md §6.3, order is normative).
type Config = { iss: string; aud: string; typ: string; algorithms: string[]; supportedClaimsVersions: number[]; maxTtlSeconds: number; clockSkewSeconds: number; maxProofAgeSeconds: number; maxTokenBytes: number; jwks: { keys: (JsonWebKey & { kid: string })[] } };
type Request = { principal: string; customerRef: string; purpose: string };
type Claims = { cv: number; iss: string; aud: string; azp: string; sub: string; purposes: string[]; iat: number; nbf: number; exp: number; vat: number };
const CONFIG = json<Config>('fixtures/grants/verifier-config.json');
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

function verifyGrant(token: string | null, request: Request, now: number, config: Config = CONFIG): string | null {
  if (token === null) return 'missing';
  const parts = token.split('.');
  if (Buffer.byteLength(token) > config.maxTokenBytes || parts.length !== 3) return 'malformed';
  let header: Record<string, unknown>, claims: Claims;
  try { header = decode(parts[0]!); claims = decode(parts[1]!) as unknown as Claims; } catch { return 'malformed'; }
  if (!config.algorithms.includes(header.alg as string)) return 'unsupported_alg';
  if (!validator('grant.v1.schema.json#/$defs/header')(header) || header.typ !== config.typ) return 'malformed';
  const jwk = config.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return 'unknown_key';
  const signed = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url'));
  if (!signed) return 'bad_signature';
  if (!validator('grant.v1.schema.json#/$defs/claims')(claims)) return 'malformed';
  if (!config.supportedClaimsVersions.includes(claims.cv)) return 'unsupported_version';
  if (claims.iss !== config.iss) return 'wrong_issuer';
  if (claims.aud !== config.aud) return 'wrong_audience';
  if (claims.azp !== request.principal) return 'consumer_mismatch';
  // Internal coherence (independent of the verifier clock), then the clock with skew on the future side only.
  if (!(claims.vat <= claims.iat && claims.iat <= claims.nbf && claims.nbf < claims.exp) || claims.iat - claims.vat > config.maxProofAgeSeconds) return 'invalid_time_claims';
  if (claims.exp - claims.iat > config.maxTtlSeconds) return 'ttl_too_long';
  if (claims.iat > now + config.clockSkewSeconds) return 'issued_in_future';
  if (claims.nbf > now + config.clockSkewSeconds) return 'not_yet_valid';
  if (claims.exp <= now) return 'expired';
  if (claims.sub !== request.customerRef) return 'customer_mismatch';
  if (!claims.purposes.includes(request.purpose)) return 'purpose_not_granted';
  return null;
}

type GrantCase = { id: string; token: string | null; verifyAt: number; request: Request; expected: { accepted: true } | { accepted: false; reason: string } };
const grants = MANIFEST.fixtures.filter((e) => e.kind === 'grant').map((e) => json<GrantCase>(e.file));
const REASONS = (json('schemas/grant.v1.schema.json').$defs as { rejectionReason: { enum: string[] } }).rejectionReason.enum;

describe('grant fixtures against the reference verifier', () => {
  it.each(grants.map((g) => [g.id, g] as const))('%s', (_id, g) => {
    const reason = verifyGrant(g.token, g.request, g.verifyAt);
    if (g.expected.accepted) expect(reason).toBeNull();
    else { expect(REASONS).toContain(g.expected.reason); expect(reason).toBe(g.expected.reason); }
  });

  it('covers every rejection reason of v1 (revoked is v1.1, OD-CIA-4)', () => {
    const covered = new Set(grants.flatMap((g) => (g.expected.accepted ? [] : [g.expected.reason])));
    expect(REASONS.filter((r) => !covered.has(r))).toEqual(['revoked']);
  });

  it('the pinned key is a public P-256 key only, and the TTL ceiling is 5 minutes', () => {
    expect(CONFIG.jwks.keys).toHaveLength(1);
    expect(CONFIG.jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(CONFIG.jwks.keys[0]).not.toHaveProperty('d');
    expect(CONFIG.maxTtlSeconds).toBe(300);
  });

  it('the verifier is not vacuous: pinning another key under the same kid rejects the valid grant', () => {
    const g01 = grants.find((g) => g.id === 'G01')!;
    const other = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }), kid: CONFIG.jwks.keys[0]!.kid };
    expect(verifyGrant(g01.token, g01.request, g01.verifyAt, { ...CONFIG, jwks: { keys: [other] } })).toBe('bad_signature');
  });
});

describe('compatibility with the R4-J4-R2 IdentityResolution port (unchanged)', () => {
  const responses = bodies.filter((e) => e.valid && e.schema === 'resolve.v1.schema.json#/$defs/response').map((e) => json(e.file));

  it('covers every IdentityResolution status and nothing else', () => {
    expect(responses.map((r) => r.status).sort()).toEqual(['ambiguous', 'conflicted', 'not_authorized', 'not_linked', 'not_verified', 'verified']);
  });

  it('without schemaVersion, each answer has exactly the fields of the port type', () => {
    for (const { schemaVersion, ...rest } of responses) {
      expect(schemaVersion).toBe(1);
      expect(Object.keys(rest).sort()).toEqual(rest.status === 'verified' ? ['customerRef', 'grant', 'resolvedAt', 'status'] : ['resolvedAt', 'status']);
    }
  });

  it('the verified example agrees with the grant it carries (no contradiction between example and token)', () => {
    const verified = responses.find((r) => r.status === 'verified') as { customerRef: string; grant: { token: string; expiresAt: string; purposes: string[] }; resolvedAt: string };
    const g01 = grants.find((g) => g.id === 'G01')!;
    expect(verified.grant.token).toBe(g01.token);
    const claims = decode(verified.grant.token.split('.')[1]!) as unknown as Claims;
    expect(verified.customerRef).toMatch(CUSTOMER_REF_PATTERN);
    expect(verified.customerRef).toBe(claims.sub);
    expect(Date.parse(verified.grant.expiresAt) / 1000).toBe(claims.exp);
    expect(Date.parse(verified.resolvedAt) / 1000).toBe(claims.iat);
    expect(verified.grant.purposes).toEqual(claims.purposes);
    for (const p of verified.grant.purposes) expect(CUSTOMER_PURPOSES).toContain(p);
  });
});

describe('OTP secrecy in the contract surface', () => {
  it('no response, error or grant carries a code, an email or the verification id of another field', () => {
    for (const e of bodies.filter((b) => b.valid && !b.schema!.endsWith('/request'))) {
      const raw = text(e.file);
      expect(raw, e.file).not.toMatch(/"code":\s*"\d|@|"email"/);
    }
    for (const g of grants) if (g.token) expect(Buffer.from(g.token.split('.')[1] ?? '', 'base64url').toString('utf8'), g.id).not.toMatch(/@|"code"|verificationId/);
  });
});

describe('grant temporal invariants (CIA_V1_CONTRACT.md §6.3)', () => {
  it('bounds the clock skew to 60 s, the TTL to 300 s and the proof age to 90 days', () => {
    expect({ skew: CONFIG.clockSkewSeconds, ttl: CONFIG.maxTtlSeconds, proof: CONFIG.maxProofAgeSeconds }).toEqual({ skew: 60, ttl: 300, proof: 90 * 86400 });
  });

  it('every accepted grant satisfies vat <= iat <= nbf < exp and exp - iat <= 300', () => {
    for (const g of grants.filter((c) => c.expected.accepted)) {
      const c = decode(g.token!.split('.')[1]!) as unknown as Claims;
      expect(c.vat <= c.iat && c.iat <= c.nbf && c.nbf < c.exp && c.exp - c.iat <= 300, g.id).toBe(true);
    }
  });
});

// Reference model of the idempotency semantics (CIA_V1_CONTRACT.md §4.1). Not a storage
// implementation: it only executes the normative rules so the scenario fixtures are checked.
type Wire = { status: number; body: Record<string, unknown> };
type Step = { at: number; ref?: string; complete?: string; principal: string; route: string; key: string; body: string; dependency: 'ok' | 'unavailable' | 'hold' | 'crash'; expect: Wire | null };
type Effects = { failedAttempts: number; links: number; challenges: number; emailsQueued: number };
type Scenario = { id: string; rules: number[]; epoch: number; challenge: { verificationId: string; code: string; issuedAt: number; ttlSeconds: number; maxAttempts: number }; bodies: Record<string, Record<string, unknown>>; steps: Step[]; effects: Effects };
type Rec = { fingerprint: string; state: 'in_progress' | 'completed'; leaseUntil: number; retainUntil: number; response?: Wire };
const LEASE_SECONDS = 30, RETENTION_SECONDS = 86400;
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v);
const fingerprint = (body: unknown) => createHmac('sha256', 'synthetic-fingerprint-key').update(canonical(body)).digest('base64url');
const isoAt = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
const wireError = (status: number, code: string, retryable: boolean): Wire => ({ status, body: { error: { code, retryable } } });

function runScenario(s: Scenario) {
  const ledger = new Map<string, Rec>();
  const effects: Effects = { failedAttempts: 0, links: 0, challenges: 0, emailsQueued: 0 };
  const challenge = { failed: 0, consumed: false };
  const held = new Map<string, () => Wire>();
  const results: (Wire | null)[] = [];
  // The operation's effect and the completion of its record commit in ONE transaction;
  // a transient failure commits nothing and releases the key.
  const execute = (step: Step, id: string, now: number): Wire => {
    const body = s.bodies[step.body]!;
    const commit = (response: Wire, effect: () => void = () => {}) => { effect(); ledger.set(id, { ...ledger.get(id)!, state: 'completed', response, retainUntil: now + RETENTION_SECONDS }); return response; };
    const release = (response: Wire) => { ledger.delete(id); return response; };
    const outcome = (value: string, extra: Record<string, unknown> = {}): Wire => ({ status: 200, body: { schemaVersion: 1, outcome: value, ...extra } });
    if (step.route.endsWith('/confirm')) {
      const c = s.challenge;
      if (now >= c.issuedAt + c.ttlSeconds) return commit(outcome('expired'));
      if (challenge.failed >= c.maxAttempts) return commit(outcome('locked'));
      if (challenge.consumed || body.code !== c.code) return commit(outcome('invalid_code', { attemptsRemaining: c.maxAttempts - challenge.failed - 1 }), () => { challenge.failed += 1; effects.failedAttempts += 1; });
      if (step.dependency === 'unavailable') return release(wireError(503, 'dependency_unavailable', true)); // nothing consumed
      return commit(outcome('linked'), () => { challenge.consumed = true; effects.links += 1; });
    }
    if (step.dependency === 'unavailable') return release(wireError(503, 'delivery_unavailable', true)); // no challenge created
    const verificationId = `Vf0SyntheticChallenge${String.fromCharCode(66 + effects.challenges)}`;
    const t = s.epoch + now;
    return commit({ status: 202, body: { schemaVersion: 1, verificationId, status: 'challenge_issued', expiresAt: isoAt(t + 600), resendAvailableAt: isoAt(t + 60) } }, () => { effects.challenges += 1; effects.emailsQueued += 1; });
  };
  for (const step of s.steps) {
    const now = step.at;
    if (step.complete) { results.push(held.get(step.complete)!()); continue; }
    const id = `${step.principal}|${step.route}|${step.key}`;
    const fp = fingerprint(s.bodies[step.body]);
    let rec = ledger.get(id);
    if (rec?.state === 'completed' && rec.retainUntil <= now) { ledger.delete(id); rec = undefined; }
    if (rec && rec.fingerprint !== fp) { results.push(wireError(409, 'idempotency_conflict', false)); continue; }
    if (rec?.state === 'completed') { results.push(rec.response!); continue; }
    if (rec && rec.leaseUntil > now) { results.push(wireError(409, 'operation_in_progress', true)); continue; }
    ledger.set(id, { fingerprint: fp, state: 'in_progress', leaseUntil: now + LEASE_SECONDS, retainUntil: 0 }); // atomic insert-if-absent, or takeover of an expired lease
    if (step.dependency === 'hold') { held.set(step.ref!, () => execute(step, id, now)); results.push(null); continue; }
    if (step.dependency === 'crash') { results.push(null); continue; }
    results.push(execute(step, id, now));
  }
  return { results, effects, ledger };
}

type DeliveryScenario = { id: string; rules: number[]; providerDeduplicates: boolean; providerResults: string[]; reconciliation: string[]; expect: { state: string; providerCalls: number; delivered: number } };

// Reference policy of the email delivery of a challenge (§4.1, external effect).
function runDelivery(d: DeliveryScenario) {
  const calls = [...d.providerResults], checks = [...d.reconciliation];
  let state = 'pending', providerCalls = 0, delivered = 0, providerHasKey = false;
  while (state === 'pending' || state === 'reconciliation_required') {
    if (state === 'pending') {
      const r = calls.shift();
      if (!r) throw new Error(`${d.id}: provider script exhausted`);
      providerCalls += 1;
      const sent = r === 'accepted' || r === 'timeout_sent';
      if (sent && !(d.providerDeduplicates && providerHasKey)) delivered += 1;
      providerHasKey ||= sent;
      // Unknown outcome: resend only under reliable provider deduplication; otherwise reconcile first.
      state = r === 'accepted' ? 'sent' : r === 'transient_error' || d.providerDeduplicates ? 'pending' : 'reconciliation_required';
    } else {
      const r = checks.shift();
      state = r === 'sent' ? 'sent' : r === 'not_sent' ? 'pending' : 'abandoned'; // unknown until the challenge expires
    }
  }
  return { state, providerCalls, delivered };
}

const scenarios = MANIFEST.fixtures.filter((e) => e.kind === 'idempotency-scenario').map((e) => json<Scenario>(e.file));
const deliveries = MANIFEST.fixtures.filter((e) => e.kind === 'delivery-scenario').map((e) => json<DeliveryScenario>(e.file));
const schemaOf = (route: string) => (route.endsWith('/confirm') ? 'verification-confirm' : 'verification-start');

describe('idempotency scenarios against the reference model', () => {
  it.each(scenarios.map((s) => [s.id, s] as const))('%s', (_id, s) => {
    const { results, effects } = runScenario(s);
    expect(results).toEqual(s.steps.map((step) => step.expect));
    expect(effects).toEqual(s.effects);
  });

  it('every scenario body and expected answer conforms to the contract schemas', () => {
    for (const s of scenarios) for (const step of s.steps.filter((x) => !x.complete)) {
      expect(validator(`${schemaOf(step.route)}.v1.schema.json#/$defs/request`)(s.bodies[step.body]), `${s.id} ${step.body}`).toBe(true);
    }
    for (const s of scenarios) for (const step of s.steps) {
      if (!step.expect) continue;
      const route = step.route ?? s.steps.find((x) => x.ref === step.complete)!.route;
      const ref = step.expect.status >= 400 ? 'error.v1.schema.json' : `${schemaOf(route)}.v1.schema.json#/$defs/response`;
      expect(validator(ref)(step.expect.body), `${s.id} at ${step.at}`).toBe(true);
    }
  });

  it('the idempotency ledger never holds the code, the email or a request body in clear', () => {
    for (const s of scenarios) {
      const stored = JSON.stringify([...runScenario(s).ledger.entries()]);
      expect(stored, s.id).not.toContain(s.challenge.code);
      expect(stored, s.id).not.toMatch(/@|"email"|"code"|"context"/);
    }
  });

  it('the scenarios cover rules 1-6, 8 and 9 (rule 7, no secrets in the ledger, is checked on every scenario above)', () => {
    expect([...new Set([...scenarios, ...deliveries].flatMap((s) => s.rules))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].filter((r) => r !== 7));
  });
});

describe('challenge email delivery scenarios against the reference policy', () => {
  it.each(deliveries.map((d) => [d.id, d] as const))('%s', (_id, d) => {
    const result = runDelivery(d);
    expect(result).toEqual(d.expect);
    expect(result.delivered).toBeLessThanOrEqual(1);
  });
});
