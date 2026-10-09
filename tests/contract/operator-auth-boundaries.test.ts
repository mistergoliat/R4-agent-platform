import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_ALGORITHMS } from '../../agents/sales/src/operator-auth/index.js';

/**
 * R4-J3D-S (ADR-033): the trust boundary of human approval decisions.
 * A TrustedHumanContext comes from exactly one place — the OIDC humanContext
 * adapter — and a decision reaches the runtime only through the platform's
 * approval route. Host administration (D-5) still never decides.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const rel = (f: string) => relative(ROOT, f).split('\\').join('/');
const text = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const code = (f: string) => text(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith('.ts') ? [path] : [];
  });
}
const SALES = files(join(ROOT, 'agents/sales/src')).map(rel);
const AUTH = SALES.filter((f) => f.startsWith('agents/sales/src/operator-auth/'));
const DECISION = ['agents/sales/src/cli/operator-approval.ts', 'agents/sales/src/cli/operator-command.ts', 'agents/sales/src/cli/operator.ts'];

describe('R4-J3D-S boundaries: trusted human approval', () => {
  // Pre-existing, test-only operators over disposable databases: the scripted harness, shadow, and the offline production validation.
  const TEST_ONLY = (f: string) => /\/(harness|shadow)\//.test(f) || f === 'agents/sales/src/cli/production-validation.ts';

  it('only the OIDC adapter builds a human context (outside pre-existing, test-only operators)', () => {
    const builders = SALES.filter((f) => !TEST_ONLY(f) && /\bhumanRef:/.test(code(f)));
    expect(builders).toEqual(['agents/sales/src/operator-auth/human-context.ts']);
    const adapter = code('agents/sales/src/operator-auth/human-context.ts');
    // The identity is the verified (issuer, subject); the only credential read is the bearer ID token.
    expect(adapter).toMatch(/options\.registry\.find\(identity\.issuer, identity\.subject\)/);
    expect(adapter).toMatch(/request\.headers\.authorization/);
    expect([...adapter.matchAll(/request\.(headers\.[a-z-]+|body|query|params)/g)].map((m) => m[1])).toEqual(['headers.authorization']);
    expect(adapter).not.toMatch(/\.email\b/);
    expect(adapter).toMatch(/if \(!options\.nonces\.consume\(auth\.identity\.nonce\)\) return null;/);
  });

  it('accepts only asymmetric RS256 ID tokens', () => {
    expect(ALLOWED_ALGORITHMS).toEqual(['RS256']);
  });

  it('decides only through the platform approval route with the OIDC adapter: no runtime call, no SQL, no CRM', () => {
    const decision = code('agents/sales/src/cli/operator-approval.ts');
    expect(decision).toMatch(/createPlatform\([\s\S]*humanContext: adapter\.resolve/);
    expect(decision).toMatch(/url: `\/v1\/human-requests\/\$\{input\.requestId\}\/respond`/);
    for (const f of [...AUTH, ...DECISION]) {
      const source = code(f);
      expect(source, f).not.toMatch(/respondHuman|takeOver|TemporalRuntime|\b(insert into|delete from)\b|\bupdate\s+[a-z_]+\s+set\b/i);
      expect(source, f).not.toMatch(/loadLocalEnv|loadEnvFile|dotenv|CRM|hub_session|ADMIN_BYPASS/);
    }
  });

  it('host administration still never decides (D-5) and does not reach the operator sign-in', () => {
    for (const f of ['agents/sales/src/production/control.ts', 'agents/sales/src/cli/production-control.ts', 'agents/sales/src/production/approvals.ts']) {
      expect(code(f), f).not.toMatch(/operator-auth|operator-approval|decideApproval/);
    }
    expect(code('agents/sales/src/production/control.ts')).toMatch(/io\.err\(`error: trusted_human_required: \$\{APPROVAL_DECISION_BLOCKER\}`\);\s*return 1;/);
  });

  it('is exposed as exactly one operator script', () => {
    const scripts = (JSON.parse(text('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(Object.entries(scripts).filter(([k]) => k.startsWith('production:sales:operator'))).toEqual([['production:sales:operator', 'node agents/sales/dist/cli/operator.js']]);
  });
});
