import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CustomerAccessGrant, CustomerPurpose } from '@r4-adapters/domains';
import { CustomerProfileHttpClient, type CustomerProfileCallTelemetry, type CustomerProfileFetch, type CustomerProfileHttpConfig } from '@r4-adapters/customer-http';

// R4-J4-R2 test support: synthetic only. No real customer, no identity resolution, no network
// unless a test starts a local server itself.

export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const PACKAGE = join(ROOT, 'adapters', 'domains', 'customer', 'http');
export const FIXTURES = join(PACKAGE, 'fixtures');
export const CONTRACT = join(PACKAGE, 'contract');

export const TOKEN = 'r4-sales-synthetic-token-0123456789abcdefghijklmnopq';
export const NOW = new Date('2026-10-15T12:05:00.000Z');

export const CONFIG: CustomerProfileHttpConfig = { baseUrl: 'http://127.0.0.1:4310', bearerToken: TOKEN, timeoutMs: 3_000, lifecycle: 'synthetic' };

/** An explicit, deterministic synthetic grant (D2 does not exist: it is never sent). */
export const grantFor = (purposes: readonly CustomerPurpose[] = ['sales_context', 'purchase_history'], expiresAt = '2026-10-15T12:10:00.000Z'): CustomerAccessGrant => ({
  token: 'synthetic-grant-not-sent',
  expiresAt,
  purposes,
});

export type ManifestEntry = { id: string; file: string; kind: 'request' | 'response' | 'error'; purpose: CustomerPurpose | null; httpStatus: number | null; status: string; sha256: string };
export const MANIFEST = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8')) as { fixtures: ManifestEntry[] };
export const fixtureText = (file: string) => readFileSync(join(FIXTURES, file), 'utf8');
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export const fixture = (file: string) => JSON.parse(fixtureText(file)) as JsonObject;

/** The value at a dot path of a JSON copy ('facts.purchasedProducts.items.0.lineKind'); undefined when absent. */
export function get(body: Json, path: string): Json | undefined {
  let node: Json | undefined = body;
  for (const key of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[Number(key)] : node[key];
  }
  return node;
}

/** Sets the value at a dot path of a JSON copy; `undefined` deletes the key. Returns the same body. */
export function set(body: JsonObject, path: string, value: Json | undefined): JsonObject {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.length === 0 ? body : get(body, keys.join('.'));
  if (parent === null || parent === undefined || typeof parent !== 'object') throw new Error(`no container at ${path}`);
  if (Array.isArray(parent)) {
    if (value === undefined) parent.splice(Number(last), 1);
    else parent[Number(last)] = value;
  } else if (value === undefined) {
    delete parent[last];
  } else {
    parent[last] = value;
  }
  return body;
}
export const byId = (id: string) => MANIFEST.fixtures.find((entry) => entry.id === id)!;
export const fixtureById = (id: string) => fixture(byId(id).file);
export const fixtureFiles = () => readdirSync(FIXTURES).filter((file) => file.endsWith('.json'));

export type Recorded = { url: string; init: Parameters<CustomerProfileFetch>[1] };

/** A body served as a UTF-8 stream, optionally split in chunks. */
export function streamOf(text: string | Uint8Array, chunkSize = 4096): ReadableStream<Uint8Array> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

export function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const all: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers };
  return { status, headers: { get: (name: string) => all[name.toLowerCase()] ?? null }, body: streamOf(text) };
}

export function clientWith(respond: (recorded: Recorded) => ReturnType<CustomerProfileFetch> | Awaited<ReturnType<CustomerProfileFetch>>, overrides: Partial<CustomerProfileHttpConfig> = {}) {
  const calls: Recorded[] = [];
  const telemetry: CustomerProfileCallTelemetry[] = [];
  const fetch: CustomerProfileFetch = async (url, init) => {
    const recorded = { url, init };
    calls.push(recorded);
    return respond(recorded);
  };
  const client = new CustomerProfileHttpClient({ config: { ...CONFIG, ...overrides }, fetch, onCall: (event) => telemetry.push(event), now: () => NOW });
  return { client, calls, telemetry };
}

/** A copy of a fixture body (never the file itself). */
export const clone = <T>(value: T): T => structuredClone(value);
