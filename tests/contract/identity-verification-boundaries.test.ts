import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SEC-S1 boundary: the identity-verification package is pure (no I/O, network, database, clock or
// secrets), names no channel or provider, depends on nothing, and nothing outside tests uses it yet
// (no executable integration with the ingress; decision rev. 02 §4, OA-01).

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGE = join(ROOT, 'adapters/domains/identity/verification');
const NAME = '@r4-adapters/identity-verification';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const sources = files(join(PACKAGE, 'src')).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

describe('identity-verification (SEC-S1) boundaries', () => {
  it('declares no dependencies at all', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.name).toBe(NAME);
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it('imports only its own modules', () => {
    for (const { path, text } of sources) {
      const specifiers = [...text.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(specifiers.filter((s) => !s?.startsWith('./')), path).toEqual([]);
      expect(text, path).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    }
  });

  it('has no network, database, environment, clock, randomness, timers or logging', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/\bfetch\s*\(|\bprocess\.|\bDate\b|Math\.random|\bcrypto\b|setTimeout|setInterval|\bconsole\.|node:|\bpg\b/);
    }
  });

  it('names no channel, provider or commerce platform', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/whatsapp|wamid|\bmeta\b|instagram|messenger|webchat|prestashop|telegram/i);
    }
  });

  it('is not used outside its package and the tests: no ingress, store, gateway or pack integration', () => {
    const offenders = ['packages', 'apps', 'agents', 'adapters/channels', 'adapters/models', 'adapters/domains/src', 'adapters/domains/identity/http']
      .flatMap((dir) => files(join(ROOT, dir)))
      .filter((path) => readFileSync(path, 'utf8').includes(NAME))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });

  it('live-ops still names no OTP, verification, CIA or channel concept', () => {
    for (const path of files(join(ROOT, 'packages/live-ops/src'))) {
      expect(readFileSync(path, 'utf8'), relative(ROOT, path)).not.toMatch(/\botp\b|identity-verification|verificationId|\bcia\b/i);
    }
  });
});
