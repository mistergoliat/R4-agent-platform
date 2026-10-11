import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpCatalogDiscoverAdapter, type CatalogDiscoverFetch } from '@r4-adapters/catalog-http';
import type { CatalogDiscoverPort, CatalogDiscoverRequest } from '@r4-adapters/domains';

/**
 * catalog.discover OWNER fixtures (R4-DISCOVER-I1): produced by catalog-service's real
 * OperationalDiscoverService over its real J1 v2 owner and its SYNTHETIC agent catalog,
 * exported by scripts/catalog-discover/export-fixtures.mts. R4 authors none of them.
 */
export const DISCOVER_FIXTURES_DIR = fileURLToPath(new URL('../../adapters/domains/catalog/http/fixtures/discover', import.meta.url));

/** The owner's synthetic answers were read at this instant (commercial windows: +15 s). */
export const DISCOVER_OWNER_AS_OF = '2026-10-09T12:00:00.000Z';
export const DISCOVER_T0 = new Date(DISCOVER_OWNER_AS_OF);

export interface DiscoverFixture {
  readonly id?: number;
  readonly key?: string;
  readonly turn?: number;
  readonly customer?: string;
  readonly request: Record<string, unknown> & { schemaVersion: 1; need: string };
  readonly http: { readonly status: number; readonly body: Record<string, unknown> };
  readonly ownerConsumerExpectation?: {
    readonly status: string | null;
    readonly outcome: string | null;
    readonly labels: readonly string[];
    readonly notLabels: readonly string[];
    readonly allowed: Record<string, readonly string[]>;
    readonly forbidden: Record<string, readonly string[]>;
    readonly answerAllowed: readonly string[];
    readonly answerForbidden: readonly string[];
  };
}

export interface DiscoverManifest {
  readonly capability: string;
  readonly schemaVersion: number;
  readonly contractVersion: string;
  readonly contractRevisions: readonly string[];
  readonly route: string;
  readonly owner: { readonly repository: string; readonly commit: string; readonly contractSourcesUncommitted: boolean; readonly contractSourcesLfSha256: Record<string, string> };
  readonly scenarios: readonly { readonly id: number; readonly key: string; readonly file: string }[];
  readonly r4MultiTurn: readonly { readonly turn: number; readonly file: string }[];
  readonly files: Record<string, string>;
}

export const discoverFixtureText = (file: string): string => readFileSync(join(DISCOVER_FIXTURES_DIR, file), 'utf8');
export const discoverFixture = (file: string): DiscoverFixture => JSON.parse(discoverFixtureText(file)) as DiscoverFixture;
export const discoverManifest = (): DiscoverManifest => JSON.parse(discoverFixtureText('MANIFEST.json')) as DiscoverManifest;
/** The exporter's hash rule: sha256 of the canonical JSON (line-ending independent). */
export const discoverFixtureHash = (text: string): string => `sha256:${createHash('sha256').update(JSON.stringify(JSON.parse(text))).digest('hex')}`;

/** Every JSON file under the fixture directory except the manifest (relative, forward slashes). */
export function discoverFixtureFiles(dir = DISCOVER_FIXTURES_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return discoverFixtureFiles(full);
    return name.endsWith('.json') && name !== 'MANIFEST.json' ? [relative(DISCOVER_FIXTURES_DIR, full).replace(/\\/g, '/')] : [];
  }).sort();
}

export const scenarioFixture = (id: number): DiscoverFixture => discoverFixture(discoverManifest().scenarios.find((s) => s.id === id)!.file);
export const turnFixture = (turn: number): DiscoverFixture => discoverFixture(discoverManifest().r4MultiTurn.find((t) => t.turn === turn)!.file);

export const TEST_DISCOVER_CONFIG = { baseUrl: 'http://127.0.0.1:4010', apiKey: 'r4-discover-test-key-0001', timeoutMs: 4_500 };

export interface RecordedDiscoverRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** Fake transport for the Discover adapter: answers with `respond`, recording what R4 sent. */
export function fakeDiscoverFetch(respond: (request: RecordedDiscoverRequest, signal: AbortSignal) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }> | { status: number; body: unknown; headers?: Record<string, string> }): { fetch: CatalogDiscoverFetch; requests: RecordedDiscoverRequest[] } {
  const requests: RecordedDiscoverRequest[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      const request = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
      requests.push(request);
      const answer = await respond(request, init.signal);
      const headers = answer.headers ?? {};
      return { status: answer.status, text: () => Promise.resolve(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)), headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
    },
  };
}

/** The owner request body R4's adapter would send for a port request (no correlation). */
export function canonicalBody(body: Record<string, unknown>): string {
  // The owner's default limit is 8: an absent limit and limit 8 are the same request.
  const withDefault: Record<string, unknown> = { limit: 8, ...body };
  const { context: _context, ...rest } = withDefault;
  const sorted = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value;
  return JSON.stringify(sorted(rest));
}

/**
 * The real HTTP adapter over a transport that REPLAYS owner fixtures: a request is answered
 * only if its body equals a fixture's owner request exactly; anything else fails the test.
 * This is how scenario tests prove which structured request R4 sent.
 */
export function replayDiscover(fixtures: readonly DiscoverFixture[], onUnmatched: (body: Record<string, unknown>) => never = (body) => { throw new Error(`no owner fixture for the request R4 sent: ${JSON.stringify(body)}`); }): { port: CatalogDiscoverPort; requests: RecordedDiscoverRequest[] } {
  const byBody = new Map(fixtures.map((f) => [canonicalBody(f.request), f]));
  const transport = fakeDiscoverFetch((request) => {
    const fixture = byBody.get(canonicalBody(request.body));
    if (!fixture) return onUnmatched(request.body);
    return { status: fixture.http.status, body: fixture.http.body };
  });
  return { port: new HttpCatalogDiscoverAdapter({ config: TEST_DISCOVER_CONFIG, fetch: transport.fetch }), requests: transport.requests };
}

/** A port answering one fixture (or failing) regardless of the request. */
export function fixedDiscover(answer: { status: number; body: unknown; headers?: Record<string, string> }): { port: CatalogDiscoverPort; requests: RecordedDiscoverRequest[] } {
  const transport = fakeDiscoverFetch(() => answer);
  return { port: new HttpCatalogDiscoverAdapter({ config: TEST_DISCOVER_CONFIG, fetch: transport.fetch }), requests: transport.requests };
}

export type { CatalogDiscoverRequest };
