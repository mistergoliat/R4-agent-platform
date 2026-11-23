import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createServiceReader } from '@r4/api';

const TOKEN = 'console-reader-token-0123456789abcdef0123456789';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const req = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as unknown as FastifyRequest;

describe('ADR-049 service reader', () => {
  it('does not exist unless its hash is configured (fail closed)', () => {
    expect(createServiceReader(undefined)).toBeUndefined();
  });

  it('refuses a malformed configured hash at boot', () => {
    expect(() => createServiceReader('abc')).toThrow(/64 lowercase hex/);
    expect(() => createServiceReader(HASH.toUpperCase())).toThrow(/64 lowercase hex/);
  });

  it('accepts only the exact bearer token', () => {
    const reader = createServiceReader(HASH)!;
    expect(reader(req(`Bearer ${TOKEN}`))).toBe(true);
    expect(reader(req(`Bearer ${TOKEN}x`))).toBe(false);
    expect(reader(req(`bearer ${TOKEN}`))).toBe(false);
    expect(reader(req(`Basic ${TOKEN}`))).toBe(false);
    expect(reader(req(HASH))).toBe(false);
    expect(reader(req('Bearer short'))).toBe(false);
    expect(reader(req())).toBe(false);
  });

  it('(ADR-048 phase 2) several readers, one hash each (comma-separated): each token works, each can be dropped alone', () => {
    const DESK = 'desk-reader-token-0123456789abcdef0123456789abc';
    const both = createServiceReader(`${HASH},${createHash('sha256').update(DESK).digest('hex')}`)!;
    expect(both(req(`Bearer ${TOKEN}`))).toBe(true);
    expect(both(req(`Bearer ${DESK}`))).toBe(true);
    expect(both(req(`Bearer ${DESK}x`))).toBe(false);
    expect(createServiceReader(HASH)!(req(`Bearer ${DESK}`))).toBe(false);
    expect(() => createServiceReader(`${HASH},`)).toThrow(/64 lowercase hex/);
    expect(() => createServiceReader(`${HASH},abc`)).toThrow(/64 lowercase hex/);
  });
});
