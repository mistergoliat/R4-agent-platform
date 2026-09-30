import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogFetch } from '@r4-adapters/catalog-http';

/** The Catalog owner's published contract fixtures (unchanged copies, see the README there). */
export const CATALOG_FIXTURES_DIR = fileURLToPath(new URL('../../adapters/domains/catalog/http/fixtures', import.meta.url));

export interface CatalogFixtureManifest {
  readonly contract: string;
  readonly schemaVersion: number;
  readonly owner: string;
  readonly fixtures: readonly { readonly file: string; readonly endpoint: string; readonly httpStatus: number; readonly sha256: string }[];
}

export function catalogFixtureText(file: string): string {
  return readFileSync(join(CATALOG_FIXTURES_DIR, file), 'utf8');
}

export function catalogFixture(file: string): Record<string, unknown> {
  return JSON.parse(catalogFixtureText(file)) as Record<string, unknown>;
}

export function catalogFixtureManifest(): CatalogFixtureManifest {
  return JSON.parse(catalogFixtureText('MANIFEST.json')) as CatalogFixtureManifest;
}

/** Every JSON file in the directory except the manifest and the sync record. */
export function catalogFixtureFiles(): string[] {
  return readdirSync(CATALOG_FIXTURES_DIR).filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json' && f !== 'SOURCE.json').sort();
}

/** The owner's hash: sha256 of the canonical JSON (line-ending independent). */
export function catalogFixtureHash(text: string): string {
  return createHash('sha256').update(JSON.stringify(JSON.parse(text))).digest('hex');
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A fake transport: answers each request with `respond`, recording what was sent. */
export function fakeCatalogFetch(respond: (request: RecordedRequest, signal: AbortSignal) => Promise<{ status: number; body: string }> | { status: number; body: string }): { fetch: CatalogFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      const request = { url, method: init.method, headers: init.headers, body: init.body };
      requests.push(request);
      const answer = await respond(request, init.signal);
      return { status: answer.status, text: () => Promise.resolve(answer.body) };
    },
  };
}

export const json = (status: number, body: unknown) => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** Never answers until aborted (a hung owner). */
export function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
}

export const TEST_CATALOG_CONFIG = { baseUrl: 'http://127.0.0.1:4010', apiKey: 'test-api-key-0123456789', timeoutMs: 200 } as const;
