import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PlatformError } from '@r4/contracts';
import { loadConfig, toErrorResponse } from '@r4/api';

describe('loadConfig', () => {
  it('applies safe defaults (loopback bind)', () => {
    const config = loadConfig({ R4_DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(config).toEqual({
      databaseUrl: 'postgres://u:p@localhost:5432/db',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'info',
      agentDefinitionsDir: './agents',
      dbPoolMax: 10,
    });
  });

  it('fails the boot on invalid configuration', () => {
    expect(() => loadConfig({})).toThrow(/R4_DATABASE_URL/);
    expect(() => loadConfig({ R4_DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
    expect(() => loadConfig({ R4_DATABASE_URL: 'postgres://x', R4_HTTP_PORT: 'eighty' })).toThrow();
  });
});

describe('toErrorResponse', () => {
  it.each([
    ['validation', 400],
    ['not_found', 404],
    ['conflict', 409],
    ['precondition', 422],
    ['unavailable', 503],
  ] as const)('maps %s to HTTP %i with the stable code', (kind, status) => {
    const mapped = toErrorResponse(new PlatformError(kind, 'some_code', 'msg', { a: 1 }), 'corr');
    expect(mapped.status).toBe(status);
    expect(mapped.body.error).toEqual({ code: 'some_code', message: 'msg', details: { a: 1 }, correlationId: 'corr' });
  });

  it('never leaks internal error details', () => {
    const fromPlatform = toErrorResponse(new PlatformError('internal', 'db_secret', 'password=hunter2', { dsn: 'x' }), 'c');
    const fromUnknown = toErrorResponse(new Error('stack trace with secrets'), 'c');
    for (const mapped of [fromPlatform, fromUnknown]) {
      expect(mapped.status).toBe(500);
      expect(mapped.internal).toBe(true);
      expect(mapped.body.error).toEqual({ code: 'internal_error', message: 'internal error', correlationId: 'c' });
    }
  });

  it('maps schema errors to validation failures', () => {
    const error = z.object({ a: z.string() }).safeParse({}).error!;
    expect(toErrorResponse(error, 'c').status).toBe(400);
  });
});
