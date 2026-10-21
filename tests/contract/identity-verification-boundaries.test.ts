import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SEC-S1/S2 boundaries of the identity-verification package (decision rev. 02 §4, OA-01):
// - the classifier stays pure; only the SecretBox decrypts; only the store reaches PostgreSQL, and only
//   through @r4/persistence-postgres; nothing reads the environment, logs or calls the network;
// - no channel or provider names; no plaintext code column in its schema;
// - nothing outside the package and the tests uses it yet: no ingress, store, gateway, harness or pack
//   integration, and no agent/harness/app code can reach the decryption or its keys.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGE = join(ROOT, 'adapters/domains/identity/verification');
const NAME = '@r4-adapters/identity-verification';

function files(dir: string, extension = '.ts'): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    return statSync(path).isDirectory() ? files(path, extension) : path.endsWith(extension) ? [path] : [];
  });
}

const sources = files(join(PACKAGE, 'src')).map((path) => ({ file: basename(path), path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
const migrations = files(join(PACKAGE, 'migrations'), '.sql').map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

/** Every source file and the only external modules it may import ('./…' is always allowed). */
const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'classifier.ts': [],
  'markers.ts': [],
  'index.ts': [],
  'keys.ts': ['node:crypto'],
  'secret-box.ts': ['node:crypto'],
  'state-store.ts': ['@r4/persistence-postgres'],
  'migrate.ts': ['node:url', '@r4/persistence-postgres'],
};

describe('identity-verification (SEC-S1/S2) boundaries', () => {
  it('depends only on @r4/persistence-postgres', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.name).toBe(NAME);
    expect(manifest.dependencies).toEqual({ '@r4/persistence-postgres': '*' });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it('every source file imports only what it is allowed to', () => {
    expect(sources.map((s) => s.file).sort()).toEqual(Object.keys(ALLOWED_IMPORTS).sort());
    for (const { file, path, text } of sources) {
      const specifiers = [...text.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
      expect(specifiers.filter((s) => !s.startsWith('./') && !(ALLOWED_IMPORTS[file] ?? []).includes(s)), path).toEqual([]);
      expect(text, path).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    }
  });

  it('the classifier stays pure (no I/O, clock, randomness, crypto or database)', () => {
    for (const { file, path, text } of sources.filter((s) => s.file === 'classifier.ts' || s.file === 'markers.ts')) {
      expect(text, `${file} ${path}`).not.toMatch(/\bfetch\s*\(|\bprocess\.|\bDate\b|Math\.random|\bcrypto\b|setTimeout|setInterval|\bconsole\.|node:|\bpg\b/);
    }
  });

  it('no source reads the environment, logs, or reaches the network', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/\bprocess\.|\bconsole\.|\bfetch\s*\(|node:(?:net|http|https|dns|child_process|fs)/);
    }
  });

  it('only the SecretBox decrypts', () => {
    for (const { file, path, text } of sources) {
      if (file !== 'secret-box.ts') expect(text, path).not.toMatch(/createDecipheriv|createCipheriv/);
    }
  });

  it('names no channel, provider or commerce platform (sources and migrations)', () => {
    for (const { path, text } of [...sources, ...migrations]) {
      expect(text, path).not.toMatch(/whatsapp|wamid|(?<!import\.)\bmeta\b|instagram|messenger|webchat|prestashop|telegram/i);
    }
  });

  it('its schema has no plaintext code or key column', () => {
    for (const { path, text } of migrations) {
      expect(text, path).not.toMatch(/\b(?:code|otp|plaintext|secret|key_material|keyring)\s+(?:text|varchar|char|bytea|integer)\b/i);
      expect(text, path).toMatch(/code_ciphertext\s+bytea/);
    }
  });

  it('is not used outside its package and the tests: no ingress, store, gateway, harness or pack integration', () => {
    const offenders = ['packages', 'apps', 'agents', 'adapters/channels', 'adapters/models', 'adapters/domains/src', 'adapters/domains/identity/http']
      .flatMap((dir) => files(join(ROOT, dir)))
      .filter((path) => /@r4-adapters\/identity-verification|SecretBox|R4_PROD_VERIFICATION_CODE_KEYS/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });

  it('live-ops still names no OTP, verification, CIA or channel concept', () => {
    for (const path of files(join(ROOT, 'packages/live-ops/src'))) {
      expect(readFileSync(path, 'utf8'), relative(ROOT, path)).not.toMatch(/\botp\b|identity-verification|verificationId|\bcia\b/i);
    }
  });
});
