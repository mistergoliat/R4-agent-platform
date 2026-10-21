import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SEC-S1/S2/S3 boundaries of the identity-verification package (decision rev. 02 §4, OA-01, AT-19):
// - the classifier stays pure; only the SecretBox decrypts; only the store reaches PostgreSQL, and only
//   through @r4/persistence-postgres; the package reaches live-ops only for its generic ports;
//   nothing reads the environment, logs or calls the network;
// - no channel or provider names; no plaintext code column in its schema;
// - no Core package, app, harness or pack imports it (S3): the gateway receives its inspection factory from
//   the deploying composition (only the synthetic test composition); live-ops stays generic (no OTP,
//   verification, CIA, code or channel concept);
// - the gateway has no override of the protection guard, and no production composition enables it.

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
  'keys.ts': ['node:crypto', '@r4/live-ops'],
  'secret-box.ts': ['node:crypto'],
  'state-store.ts': ['@r4/persistence-postgres'],
  'migrate.ts': ['node:url', '@r4/persistence-postgres'],
  'inspector.ts': ['node:crypto', '@r4/live-ops', '@r4/persistence-postgres'],
  'gateway.ts': ['@r4/live-ops', '@r4/persistence-postgres'],
  // S4: ports only (the CIA client, the production store and the temporal runtime are injected).
  'dispatcher.ts': ['@r4/live-ops'],
};

/** The only files outside the package (and the tests) that may use it, and why. */
const INTEGRATIONS: readonly string[] = [
  // S5: the commercial layer reads and opens expectations (types and the store only), synthetic composition only.
  'agents/sales/src/capabilities/customer-synthetic.ts',
  'agents/sales/src/capabilities/identity-verification.ts',
];

describe('SEC-S4: only the gateway composition ever reaches the decryption, the dispatcher or the confirm credential (AT-19)', () => {
  const SECRET_SURFACE = /SecretBox|Keyring|VerificationConfirmDispatcher|CiaVerificationConfirmClient|loadCiaVerificationConfirmConfig|R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN|R4_PROD_VERIFICATION_CODE_KEYS/;

  it('no agent pack, worker, API, scheduler or Core package references them', () => {
    const offenders = ['agents', 'apps', 'packages']
      .flatMap((dir) => files(join(ROOT, dir)))
      .filter((path) => SECRET_SURFACE.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });

  it('the CIA confirm client lives in identity-http and is used only through the injected ConfirmPort', () => {
    const users = files(join(ROOT, 'adapters'))
      .filter((path) => /CiaVerificationConfirmClient/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'));
    expect(users.sort()).toEqual(['adapters/domains/identity/http/src/confirm.ts']);
    for (const { path, text } of sources) expect(text, path).not.toMatch(/@r4-adapters\/identity-http/);
  });
});

describe('SEC-S5: the commercial capabilities exist only in the synthetic composition (R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED)', () => {
  it('no Sales profile, definition, registry, CLI or bootstrap names them', () => {
    const named = files(join(ROOT, 'agents'))
      .concat(files(join(ROOT, 'agents/sales'), '.json'))
      .filter((path) => /identity\.start_verification|identity\.verification_status|identityStartVerificationCapability|identityVerificationStatusCapability|composeSyntheticIdentityVerificationCapabilities|IDENTITY_VERIFICATION_CAPABILITY_IDS/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'));
    expect(named.sort()).toEqual(['agents/sales/src/capabilities/customer-synthetic.ts', 'agents/sales/src/capabilities/identity-verification.ts']);
  });
});

describe('identity-verification (SEC-S1/S2/S3) boundaries', () => {
  it('depends only on @r4/persistence-postgres and the live-ops ports', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.name).toBe(NAME);
    expect(manifest.dependencies).toEqual({ '@r4/live-ops': '*', '@r4/persistence-postgres': '*' });
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
    }
    // The code exists only as ciphertext, declared once (S2) and never again in clear in a later migration.
    expect(migrations.filter((m) => /code_ciphertext\s+bytea/.test(m.text)).map((m) => m.path.replace(/\\/g, '/'))).toEqual(['adapters/domains/identity/verification/migrations/0011_identity_verification_state.sql']);
  });

  it('outside the package, only the declared integrations use it: no Core package, harness or pack', () => {
    const users = ['packages', 'apps', 'agents', 'adapters/channels', 'adapters/models', 'adapters/domains/src', 'adapters/domains/identity/http']
      .flatMap((dir) => files(join(ROOT, dir)))
      .filter((path) => /@r4-adapters\/identity-verification|SecretBox|R4_PROD_VERIFICATION_CODE_KEYS/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'));
    expect(users.sort()).toEqual([...INTEGRATIONS].sort());
    for (const dir of ['packages']) {
      for (const path of files(join(ROOT, dir))) expect(readFileSync(path, 'utf8'), relative(ROOT, path)).not.toMatch(/@r4-adapters\/identity-(verification|http)/);
    }
  });

  it('live-ops names no OTP, verification, CIA or channel concept; its inspection port names no code either', () => {
    for (const path of files(join(ROOT, 'packages/live-ops/src'))) {
      expect(readFileSync(path, 'utf8'), relative(ROOT, path)).not.toMatch(/\botp\b|verification|\bcia\b|whatsapp|instagram|messenger|webchat/i);
    }
    expect(readFileSync(join(ROOT, 'packages/live-ops/src/inspection.ts'), 'utf8')).not.toMatch(/\bcodes?\b|identity|email/i);
  });

  it('the inbound lock of the ingress and the package lock are the same algorithm (S3-DEP-01)', () => {
    const keys = readFileSync(join(PACKAGE, 'src/keys.ts'), 'utf8');
    expect(keys).toMatch(/export \{ conversationLockKey \} from '@r4\/live-ops';/);
    const store = readFileSync(join(ROOT, 'packages/persistence-postgres/src/production-store.ts'), 'utf8');
    expect(store).toMatch(/pg_advisory_xact_lock\(\$1::bigint\)', \[conversationLockKey\(e\.channel, conversationKey\)\]/);
  });

  it('the gateway offers no override of the protection guard, and no production composition enables the inspector', () => {
    const gateway = ['apps/channel-gateway/src/inspection.ts', 'apps/channel-gateway/src/platform.ts', 'apps/channel-gateway/src/config.ts'].map((f) => readFileSync(join(ROOT, f), 'utf8'));
    for (const source of [...gateway, readFileSync(join(PACKAGE, 'src/gateway.ts'), 'utf8')]) expect(source).not.toMatch(/FORCE|OVERRIDE|BYPASS|SKIP_PROTECTION|UNSAFE/);
    // Without a composed inspector, the guard runs unconditionally before ingress exists.
    expect(gateway[1]).toMatch(/const inspection = bindings\.inspection \? await bindings\.inspection\(\{[^}]*\}\) : null;\r?\n\s+if \(!inspection\) await assertNoOpenProtection\(pool\);/);
    expect(gateway[0]).toMatch(/throw new PlatformError\('precondition', 'identity_verification_protection_active'/);
    // No pack, profile or CLI plugs an inspection in (synthetic test composition only).
    for (const path of files(join(ROOT, 'agents'))) expect(readFileSync(path, 'utf8'), relative(ROOT, path)).not.toMatch(/identityVerificationInspection|GatewayInspectionFactory|VerificationInspector/);
  });
});
