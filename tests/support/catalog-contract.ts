import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogFetch } from '@r4-adapters/catalog-http';

/** The (temporary) Catalog contract fixtures, as the owner would serve them. */
export const CATALOG_FIXTURES_DIR = fileURLToPath(new URL('../../adapters/domains/catalog/http/fixtures', import.meta.url));

export function catalogFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CATALOG_FIXTURES_DIR, path), 'utf8')) as Record<string, unknown>;
}

export function catalogFixtureNames(): string[] {
  return ['search', 'product', 'item'].flatMap((dir) => readdirSync(join(CATALOG_FIXTURES_DIR, dir)).filter((f) => f.endsWith('.json')).map((f) => `${dir}/${f}`));
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
