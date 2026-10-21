import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@r4-adapters/domains';
import { GRANT_HEADER } from '@r4-adapters/customer-http';
import { answer, clientWith, fixtureById, GRANT_TOKEN, grantFor, MANIFEST, PACKAGE, set } from './support.js';

// R4-J4-R3 (R3.2, R3.3): the CIA grant on the Customer Profile adapter. Opaque, sent once, never
// decoded; a bearer alone never authorizes a read; a verified answer never outlives the grant.

const REF = 'prestashop_customer:900000201';
const RC2 = join(PACKAGE, 'contract-v1-rc2', 'fixtures');
const rc2 = (file: string) => JSON.parse(readFileSync(join(RC2, file), 'utf8')) as Record<string, unknown>;

async function failureOf(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('the grant leaves R4 only as issued, and only when it is well-formed', () => {
  it('exactly one x-customer-access-grant header with the token unmodified, next to the service bearer', async () => {
    const { client, calls } = clientWith(() => answer(200, fixtureById('SC01')));
    await client.getSalesContext(REF, grantFor());
    expect(GRANT_HEADER).toBe('x-customer-access-grant');
    expect(calls[0]!.init.headers[GRANT_HEADER]).toBe(GRANT_TOKEN);
    expect(calls[0]!.init.headers.authorization).toMatch(/^Bearer /);
    expect(calls[0]!.init.headers.authorization).not.toContain(GRANT_TOKEN);
  });

  it.each<[string, string]>([
    ['a grant above 2048 bytes', `${GRANT_TOKEN}${'A'.repeat(2049 - GRANT_TOKEN.length)}`],
    ['a grant that is not three base64url segments', 'not-a-jws'],
    ['a grant with four segments', `${GRANT_TOKEN}.x`],
    ['a grant with a non-base64url character', GRANT_TOKEN.replace('.', '.+')],
    ['an empty grant', ''],
  ])('%s is refused before any network call (grant_malformed)', async (_name, token) => {
    const { client, calls } = clientWith(() => answer(200, fixtureById('SC01')));
    expect(await failureOf(client.getSalesContext(REF, { ...grantFor(), token }))).toMatchObject({ category: 'validation', code: 'grant_malformed' });
    expect(calls).toHaveLength(0);
  });

  it('a synthetic binding never sends a customer outside the synthetic range (AG-1)', async () => {
    const { client, calls } = clientWith(() => answer(200, fixtureById('SC01')));
    expect(await failureOf(client.getSalesContext('prestashop_customer:12345', grantFor()))).toMatchObject({ category: 'validation', code: 'customer_ref_outside_synthetic_range' });
    expect(await failureOf(client.getSalesContext('prestashop_customer:900000314', grantFor()))).toMatchObject({ code: 'customer_ref_outside_synthetic_range' });
    expect(calls).toHaveLength(0);
  });
});

describe('a bearer alone never authorizes a read (service_scope_only)', () => {
  const responses = MANIFEST.fixtures.filter((entry) => entry.kind === 'response');

  it.each(responses.map((entry) => [entry.id, entry] as const))('%s served as v1-rc1 (service_scope_only) is a contract_violation', async (_id, entry) => {
    const body = fixtureById(entry.id);
    const ref = body.customerRef as string;
    const { client } = clientWith(() => answer(entry.httpStatus!, body, {}, { asServed: true }));
    const call = entry.purpose === 'sales_context' ? client.getSalesContext(ref, grantFor()) : client.getPurchaseHistory(ref, grantFor(), { offset: 0, limit: 10 });
    expect(await failureOf(call)).toMatchObject({ category: 'contract_violation', code: 'authorization_basis_insufficient' });
  });
});

describe('a verified answer never outlives the grant (v1-rc2)', () => {
  it('validUntil equal to the grant expiry passes; one millisecond later is validity_exceeds_grant', async () => {
    const atExpiry = fixtureById('SC01');
    expect(await clientWith(() => answer(200, atExpiry)).client.getSalesContext(REF, grantFor(undefined, '2026-10-15T12:15:00.000Z'))).toMatchObject({ status: 'available', validUntil: '2026-10-15T12:15:00.000Z' });
    expect(await failureOf(clientWith(() => answer(200, atExpiry)).client.getSalesContext(REF, grantFor(undefined, '2026-10-15T12:14:59.999Z')))).toMatchObject({ category: 'contract_violation', code: 'validity_exceeds_grant' });
  });

  it('a degraded answer declares no validity and stays a temporary unavailability', async () => {
    const degraded = set(fixtureById('SC09'), 'customerRef', REF);
    expect(await failureOf(clientWith(() => answer(503, degraded)).client.getSalesContext(REF, grantFor(undefined, '2026-10-15T12:06:00.000Z')))).toMatchObject({ category: 'temporarily_unavailable', code: 'profile_unavailable' });
  });
});

describe('403 grant_rejected (v1-rc2)', () => {
  it('is unauthorized, never retried, never not_found; the owner code is a diagnostic only', async () => {
    const { client, calls, telemetry } = clientWith(() => answer(403, rc2('error-grant-rejected.json')));
    expect(await failureOf(client.getSalesContext(REF, grantFor()))).toMatchObject({ category: 'unauthorized', code: 'profile_unauthorized', retryable: false, details: { ownerCode: 'grant_rejected' } });
    expect(calls).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({ outcome: 'failed', httpStatus: 403, ownerCode: 'grant_rejected' });
  });

  it('a 403 that (wrongly) carries a reason is still unauthorized and the reason is never echoed', async () => {
    const { client, telemetry } = clientWith(() => answer(403, rc2('error-grant-rejected-with-reason.invalid.json')));
    const error = await failureOf(client.getSalesContext(REF, grantFor()));
    expect(error.category).toBe('unauthorized');
    expect(JSON.stringify([error.message, error.details, telemetry])).not.toMatch(/expired|bad_signature|customer_mismatch/);
  });
});

describe('redirects', () => {
  it.each([301, 302, 307, 308])('HTTP %s is never followed: contract_violation, exactly one call, redirect manual', async (status) => {
    const { client, calls } = clientWith(() => answer(status, '', { location: 'https://evil.example/v1/capabilities/customer/sales-context' }));
    expect(await failureOf(client.getSalesContext(REF, grantFor()))).toMatchObject({ category: 'contract_violation', code: 'unexpected_status' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe('manual');
  });
});
