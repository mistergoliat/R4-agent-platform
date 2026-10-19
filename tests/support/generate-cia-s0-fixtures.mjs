// CIA-S0: writes MANIFEST.json (provenance + content hashes) and, with --grants,
// regenerates the synthetic grant fixtures and the resolve "verified" answer.
// Node stdlib only. Synthetic data only.
//
//   node tests/support/generate-cia-s0-fixtures.mjs           # refresh hashes
//   node tests/support/generate-cia-s0-fixtures.mjs --grants  # new keys, new grants, then hashes
//
// ECDSA signatures are randomized and the private keys are discarded after
// signing, so --grants is NOT reproducible byte for byte. What is reproducible
// is the MANIFEST: every hash is sha256(JSON.stringify(JSON.parse(file))) of
// the committed files and the contract test recomputes it.
import { Buffer } from 'node:buffer';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../docs/contracts/cia/v1/', import.meta.url));
const FIX = join(ROOT, 'fixtures');
const write = (path, value) => writeFileSync(join(FIX, path), `${JSON.stringify(value, null, 2)}\n`);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const hash = (text) => createHash('sha256').update(JSON.stringify(JSON.parse(text))).digest('hex');
const b64u = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

// Pinned verifier configuration of the synthetic deployment (adapter values, not core types).
const IAT = 1792432800; // 2026-10-19T18:00:00Z
const KID = 'cia-synthetic-s0';
const ISS = 'https://cia.synthetic.test';
const REQUEST = { principal: 'r4-sales', customerRef: 'prestashop_customer:900000201', purpose: 'purchase_history' };

function generateGrants() {
  const issuer = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const attacker = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const header = { alg: 'ES256', kid: KID, typ: 'cia-grant+jwt' };
  const claims = {
    cv: 1, iss: ISS, aud: 'customer-profile', azp: 'r4-sales', sub: REQUEST.customerRef, purposes: ['purchase_history'],
    iat: IAT, nbf: IAT, exp: IAT + 300, jti: '01K8SYNTHGRANT000000000001', lnk: 'lnk_synthetic_0001', lver: 1,
    amr: ['email_otp'], vat: IAT - 600, sbh: createHmac('sha256', 'synthetic-subject-key').update('whatsapp|100000000000001|15555550101').digest('base64url'),
  };
  const es256 = (h, c, key = issuer.privateKey) => {
    const input = `${b64u(h)}.${b64u(c)}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const valid = es256(header, claims);
  const [vh, , vs] = valid.split('.');
  const hs256 = (() => {
    const h = { ...header, alg: 'HS256' };
    const input = `${b64u(h)}.${b64u(claims)}`;
    const secret = issuer.publicKey.export({ type: 'spki', format: 'pem' });
    return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
  })();
  const { jti: _omit, ...withoutJti } = claims;

  // [id, file, scenario, token, expected, request/verifyAt overrides]
  const cases = [
    ['G01', 'valid.purchase-history', 'grant issued correctly (V-01)', valid, null],
    ['G02', 'valid.two-purposes', 'multi-purpose grant used for one granted purpose', es256(header, { ...claims, purposes: ['sales_context', 'purchase_history'] }), null, { request: { purpose: 'sales_context' } }],
    ['G10', 'forged.foreign-key', 'signed by a key that is not pinned, same kid (V-14)', es256(header, claims, attacker.privateKey), 'bad_signature'],
    ['G11', 'forged.alg-none', 'alg none (V-14)', `${b64u({ ...header, alg: 'none' })}.${b64u(claims)}.`, 'unsupported_alg'],
    ['G12', 'forged.hs256-public-key', 'HS256 keyed with the public key (V-14)', hs256, 'unsupported_alg'],
    ['G13', 'forged.unknown-kid', 'kid not in the pinned JWKS (V-14)', es256({ ...header, kid: 'cia-unknown' }, claims), 'unknown_key'],
    ['G14', 'forged.tampered-sub', 'payload swapped to another customer, original signature (V-13/V-19)', `${vh}.${b64u({ ...claims, sub: 'prestashop_customer:900000202' })}.${vs}`, 'bad_signature'],
    ['G15', 'forged.two-segments', 'not a compact JWS', `${vh}.${b64u(claims)}`, 'malformed'],
    ['G16', 'forged.missing', 'no grant header', null, 'missing'],
    ['G17', 'forged.wrong-typ', 'typ JWT instead of cia-grant+jwt', es256({ ...header, typ: 'JWT' }, claims), 'malformed'],
    ['G18', 'forged.claims-schema', 'signed claims without jti', es256(header, withoutJti), 'malformed'],
    ['G03', 'valid.last-second', 'accepted one second before exp', valid, null, { verifyAt: IAT + 299 }],
    ['G04', 'valid.issuer-clock-ahead', 'issuer clock 60 s ahead of the verifier (maximum skew)', valid, null, { verifyAt: IAT - 60 }],
    ['G20', 'incompatible.expired', 'used at exp: no skew on expiry (V-15)', valid, 'expired', { verifyAt: IAT + 300 }],
    ['G21', 'incompatible.not-yet-valid', 'nbf 120 s after iat, used at iat', es256(header, { ...claims, nbf: IAT + 120 }), 'not_yet_valid', { verifyAt: IAT }],
    ['G22', 'incompatible.ttl-too-long', 'exp - iat = 900 s (V-15)', es256(header, { ...claims, exp: IAT + 900 }), 'ttl_too_long'],
    ['G30', 'temporal.issued-in-future', 'iat one hour ahead of the verifier', es256(header, { ...claims, iat: IAT + 3600, nbf: IAT + 3600, exp: IAT + 3900 }), 'issued_in_future'],
    ['G31', 'temporal.nbf-after-exp', 'nbf later than exp: empty validity window', es256(header, { ...claims, nbf: IAT + 400 }), 'invalid_time_claims'],
    ['G32', 'temporal.exp-before-iat', 'exp earlier than iat', es256(header, { ...claims, exp: IAT - 1 }), 'invalid_time_claims'],
    ['G33', 'temporal.nbf-before-iat', 'nbf backdated before iat', es256(header, { ...claims, nbf: IAT - 3600 }), 'invalid_time_claims'],
    ['G34', 'temporal.vat-after-iat', 'proof of control later than issuance', es256(header, { ...claims, vat: IAT + 10 }), 'invalid_time_claims'],
    ['G35', 'temporal.proof-too-old', 'proof of control older than the maximum link age (90 days)', es256(header, { ...claims, vat: IAT - 7776001 }), 'invalid_time_claims'],
    ['G36', 'temporal.iat-not-integer', 'iat as a string', es256(header, { ...claims, iat: String(IAT) }), 'malformed'],
    ['G37', 'temporal.exp-fractional', 'exp with a fraction of a second', es256(header, { ...claims, exp: IAT + 299.5 }), 'malformed'],
    ['G23', 'incompatible.wrong-audience', 'grant for another service (V-17)', es256(header, { ...claims, aud: 'other-service' }), 'wrong_audience'],
    ['G24', 'incompatible.consumer-mismatch', 'presented by another principal (V-17)', valid, 'consumer_mismatch', { request: { principal: 'other-consumer' } }],
    ['G25', 'incompatible.customer-mismatch', 'valid grant of A used for B (V-13)', valid, 'customer_mismatch', { request: { customerRef: 'prestashop_customer:900000202' } }],
    ['G26', 'incompatible.purpose-not-granted', 'sales_context grant used for purchase_history (V-18)', es256(header, { ...claims, purposes: ['sales_context'] }), 'purpose_not_granted'],
    ['G27', 'incompatible.wrong-issuer', 'issuer not pinned', es256(header, { ...claims, iss: 'https://other-issuer.synthetic.test' }), 'wrong_issuer'],
    ['G28', 'incompatible.unsupported-version', 'claims version 2', es256(header, { ...claims, cv: 2 }), 'unsupported_version'],
  ];
  for (const [id, name, scenario, token, reason, over = {}] of cases) {
    write(`grants/${id}.${name}.json`, {
      id, scenario, token,
      verifyAt: over.verifyAt ?? IAT + 60,
      request: { ...REQUEST, ...over.request },
      expected: reason ? { accepted: false, reason } : { accepted: true },
    });
  }
  write('grants/verifier-config.json', {
    synthetic: true, iss: ISS, aud: 'customer-profile', typ: 'cia-grant+jwt', algorithms: ['ES256'], supportedClaimsVersions: [1],
    maxTtlSeconds: 300, clockSkewSeconds: 60, maxProofAgeSeconds: 7776000, maxTokenBytes: 2048,
    jwks: { keys: [{ ...issuer.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' }] },
  });
  write('resolve/response.verified.json', {
    schemaVersion: 1, status: 'verified', customerRef: claims.sub,
    grant: { token: valid, expiresAt: new Date(claims.exp * 1000).toISOString().replace('.000Z', 'Z'), purposes: claims.purposes },
    resolvedAt: new Date(IAT * 1000).toISOString().replace('.000Z', 'Z'),
  });
}

// Fixture metadata: [id, file, schema ref, valid, httpStatus, scenario].
const S = (file, def) => `${file}.v1.schema.json${def ? `#/$defs/${def}` : ''}`;
const VS = (d) => S('verification-start', d), VC = (d) => S('verification-confirm', d), RS = (d) => S('resolve', d), LR = (d) => S('link-revoke', d), ER = S('error');
const BODIES = [
  ['VS01', 'verification-start/request.valid.json', VS('request'), true, null, 'OTP start'],
  ['VS02', 'verification-start/response.challenge-issued.json', VS('response'), true, 202, 'OTP start: uniform answer for any well-formed email'],
  ['VS90', 'verification-start/request.invalid.email-filter-injection.json', VS('request'), false, null, 'email with a filter metacharacter (V-23)', { instancePath: '/email', keyword: 'pattern' }],
  ['VS91', 'verification-start/request.invalid.legacy-flat-context.json', VS('request'), false, null, 'pre-omnichannel flat fields instead of context', { instancePath: '', keyword: 'required' }],
  ['VS92', 'verification-start/request.invalid.consumer-in-body.json', VS('request'), false, null, 'consumer identity in the body (it is the bearer principal)', { instancePath: '', keyword: 'additionalProperties' }],
  ['VS93', 'verification-start/request.invalid.verification-purpose-as-data-purpose.json', VS('request'), false, null, 'verification purpose mixed into data purposes', { instancePath: '', keyword: 'required' }],
  ['VC01', 'verification-confirm/request.valid.json', VC('request'), true, null, 'OTP confirmation'],
  ['VC10', 'verification-confirm/response.linked.json', VC('response'), true, 200, 'correct verification: exactly one eligible account'],
  ['VC11', 'verification-confirm/response.no-eligible-account.json', VC('response'), true, 200, 'nonexistent account (or only deleted)'],
  ['VC12', 'verification-confirm/response.ineligible-account.json', VC('response'), true, 200, 'only guest or inactive accounts'],
  ['VC13', 'verification-confirm/response.ambiguous.json', VC('response'), true, 200, 'ambiguous account: several eligible'],
  ['VC14', 'verification-confirm/response.conflicted.json', VC('response'), true, 200, 'subject already linked to another account'],
  ['VC15', 'verification-confirm/response.invalid-code.json', VC('response'), true, 200, 'wrong code, or context/session/consumer differs from the challenge (V-11, N-02)'],
  ['VC16', 'verification-confirm/response.expired.json', VC('response'), true, 200, 'expired verification (V-08)'],
  ['VC17', 'verification-confirm/response.locked.json', VC('response'), true, 200, 'attempts exhausted (V-10)'],
  ['VC90', 'verification-confirm/request.invalid.code-not-normalized.json', VC('request'), false, null, 'code not normalized by the channel integration', { instancePath: '/code', keyword: 'pattern' }],
  ['VC91', 'verification-confirm/request.invalid.missing-session.json', VC('request'), false, null, 'context without sessionRef', { instancePath: '/context', keyword: 'required' }],
  ['VC92', 'verification-confirm/response.invalid.linked-with-customer-ref.json', VC('response'), false, 200, 'confirm must never return an account reference', { instancePath: '', keyword: 'additionalProperties' }],
  ['VC93', 'verification-confirm/response.invalid.invalid-code-without-attempts.json', VC('response'), false, 200, 'invalid_code without attemptsRemaining', { instancePath: '', keyword: 'required' }],
  ['RS01', 'resolve/request.valid.json', RS('request'), true, null, 'resolution for one data purpose'],
  ['RS10', 'resolve/response.verified.json', RS('response'), true, 200, 'correct verification: grant issued (token = G01)'],
  ['RS11', 'resolve/response.not-linked.json', RS('response'), true, 200, 'nonexistent account, no link, or revoked link'],
  ['RS12', 'resolve/response.not-verified.json', RS('response'), true, 200, 'expired verification: link stale/expired or recent-verification window elapsed'],
  ['RS13', 'resolve/response.ambiguous.json', RS('response'), true, 200, 'ambiguous account'],
  ['RS14', 'resolve/response.conflicted.json', RS('response'), true, 200, 'conflicting link'],
  ['RS15', 'resolve/response.not-authorized.json', RS('response'), true, 200, 'guest/inactive account or purpose denied by policy'],
  ['RS90', 'resolve/request.invalid.empty-purposes.json', RS('request'), false, null, 'no data purpose', { instancePath: '/purposes', keyword: 'minItems' }],
  ['RS91', 'resolve/request.invalid.channel-shape.json', RS('request'), false, null, 'channel that is not a registered identifier', { instancePath: '/context/channel', keyword: 'pattern' }],
  ['RS92', 'resolve/response.invalid.not-linked-with-customer-ref.json', RS('response'), false, 200, 'account reference outside verified', { instancePath: '', keyword: 'oneOf' }],
  ['RS93', 'resolve/response.invalid.verified-without-grant.json', RS('response'), false, 200, 'verified without grant', { instancePath: '', keyword: 'oneOf' }],
  ['RS94', 'resolve/response.invalid.master-customer-id.json', RS('response'), false, 200, 'masterCustomerId is never disclosed (CS-02)', { instancePath: '', keyword: 'oneOf' }],
  ['LR01', 'link-revoke/request.valid.json', LR('request'), true, null, 'revocation at the customer\'s request'],
  ['LR10', 'link-revoke/response.revoked.json', LR('response'), true, 200, 'revocation'],
  ['LR11', 'link-revoke/response.no-active-link.json', LR('response'), true, 200, 'revocation without an active link'],
  ['LR90', 'link-revoke/request.invalid.free-text-reason.json', LR('request'), false, null, 'free-text reason', { instancePath: '/reason', keyword: 'enum' }],
  ['ER01', 'errors/invalid-request.json', ER, true, 400, 'malformed request'],
  ['ER02', 'errors/unauthenticated.json', ER, true, 401, 'missing or invalid credential'],
  ['ER03', 'errors/consumer-not-allowed.json', ER, true, 403, 'unauthorized context (channel/account/purpose outside allowlist, N-03) or confirm without the channel-integration scope (N-01)'],
  ['ER04', 'errors/idempotency-conflict.json', ER, true, 409, 'idempotency key reused with another body'],
  ['ER05', 'errors/rate-limited.json', ER, true, 429, 'any limit, indistinguishable'],
  ['ER06', 'errors/dependency-unavailable.json', ER, true, 503, 'dependency unavailable: account provider down, challenge not consumed (V-21)'],
  ['ER07', 'errors/delivery-unavailable.json', ER, true, 503, 'dependency unavailable: email delivery'],
  ['ER08', 'errors/operation-in-progress.json', ER, true, 409, 'same idempotency key and body while the first request is still executing'],
  ['ER90', 'errors/invalid.dependency-unavailable-not-retryable.json', ER, false, 503, 'retryable must follow the code', { instancePath: '/error/retryable', keyword: 'const' }],
  ['ER91', 'errors/invalid.free-text-message.json', ER, false, 400, 'no free text (CS-04)', { instancePath: '/error', keyword: 'additionalProperties' }],
];

// Mandated scenarios (CIA-S0 §3) → fixture ids.
const SCENARIOS = {
  otp_start_and_confirm: ['VS01', 'VS02', 'VC01'],
  verification_correct: ['VC10', 'RS10', 'G01'],
  account_nonexistent: ['VC11', 'RS11'],
  account_ambiguous: ['VC13', 'RS13'],
  verification_expired: ['VC16', 'RS12'],
  context_unauthorized: ['ER03', 'VC15', 'RS91', 'VS92'],
  revocation: ['LR01', 'LR10', 'LR11'],
  dependency_unavailable: ['ER06', 'ER07'],
  grant_issued: ['G01', 'G02', 'RS10'],
  grant_forged_or_incompatible: ['G10', 'G11', 'G12', 'G13', 'G14', 'G15', 'G16', 'G17', 'G18', 'G20', 'G21', 'G22', 'G23', 'G24', 'G25', 'G26', 'G27', 'G28'],
  grant_temporal_coherence: ['G03', 'G04', 'G20', 'G21', 'G22', 'G30', 'G31', 'G32', 'G33', 'G34', 'G35', 'G36', 'G37'],
  idempotency: ['ER04', 'ER08', 'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09', 'D01', 'D02', 'D03', 'D04', 'D05'],
};

if (process.argv.includes('--grants')) generateGrants();

const grantFiles = readdirSync(join(FIX, 'grants')).filter((f) => /^G\d\d\./.test(f)).sort();
const manifest = {
  contract: 'customer-identity-authority',
  schemaVersion: 1,
  revision: 'v1-s0-candidate',
  contractStatus: 'candidate',
  owner: 'pending (D1: producer owner not designated)',
  synthetic: true,
  specification: 'CIA_V1_CONTRACT.md',
  provenance: {
    mandate: 'R4-J4-CIA-S0-CONTRACT-FOUNDATION-01',
    designBase: ['docs/architecture/R4_J4_R3_CIA_OMNICHANNEL_DESIGN_REVIEW.md', 'docs/architecture/R4_J4_R3_CIA_CONTRACT_PROPOSAL.md', 'docs/architecture/R4_J4_R3_CIA_DISCOVERY_REPORT.md'],
    repositoryBase: 'R4-agent-platform@3e7b4ee',
    generator: 'tests/support/generate-cia-s0-fixtures.mjs',
    keys: 'grant fixtures signed with ephemeral synthetic P-256 keys; private keys discarded; public key in fixtures/grants/verifier-config.json',
    data: 'synthetic only: .test emails, 555-01xx fictional numbers, Customer Profile synthetic ids 900000201-900000313',
  },
  hash: 'sha256(JSON.stringify(JSON.parse(file)))',
  schemas: readdirSync(join(ROOT, 'schemas')).sort().map((file) => ({ file: `schemas/${file}`, sha256: hash(read(`schemas/${file}`)) })),
  scenarios: SCENARIOS,
  fixtures: [
    ...BODIES.map(([id, file, schema, valid, httpStatus, scenario, expectedError]) => ({ id, file: `fixtures/${file}`, kind: 'body', schema, valid, httpStatus, scenario, ...(expectedError ? { expectedError } : {}), sha256: hash(read(`fixtures/${file}`)) })),
    ...grantFiles.map((file) => {
      const g = JSON.parse(read(`fixtures/grants/${file}`));
      return { id: g.id, file: `fixtures/grants/${file}`, kind: 'grant', valid: g.expected.accepted, scenario: g.scenario, sha256: hash(read(`fixtures/grants/${file}`)) };
    }),
    { id: 'GCFG', file: 'fixtures/grants/verifier-config.json', kind: 'verifier-config', sha256: hash(read('fixtures/grants/verifier-config.json')) },
    ...readdirSync(join(FIX, 'idempotency')).sort().map((file) => {
      const s = JSON.parse(read(`fixtures/idempotency/${file}`));
      return { id: s.id, file: `fixtures/idempotency/${file}`, kind: s.id.startsWith('D') ? 'delivery-scenario' : 'idempotency-scenario', rules: s.rules, scenario: s.title, sha256: hash(read(`fixtures/idempotency/${file}`)) };
    }),
  ],
};
writeFileSync(join(ROOT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`MANIFEST.json: ${manifest.schemas.length} schemas, ${manifest.fixtures.length} fixtures (${relative(process.cwd(), ROOT) || '.'})\n`);
