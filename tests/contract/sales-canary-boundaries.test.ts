import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R4-J3D-R: the isolated Sales canary is test tooling of the Sales pack.
 * It reuses the real ingress, worker composition, delivery owner and
 * scheduler; it never reaches a channel provider, never fabricates an
 * operator, never calls a capability directly and writes no state of its
 * own except the database marker.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = join(ROOT, 'agents/sales/src/cli/canary');
const CANARY = [...readdirSync(DIR).filter((f) => f.endsWith('.ts')).map((f) => join(DIR, f)), join(ROOT, 'agents/sales/src/cli/canary.ts')];
const text = (f: string) => readFileSync(f, 'utf8');
/** Source without comments (the docs name what the code must never do). */
const code = (f: string) => text(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importsOf = (f: string) => [...text(f).matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

describe('R4-J3D-R boundaries: the isolated Sales canary', () => {
  it('never composes a channel provider or the production gateway', () => {
    // R4-J4-R5 preparation: + identity.ts (the @8 single gateway, rollback readiness and purge).
    expect(CANARY.length).toBe(7);
    for (const f of CANARY) {
      expect(importsOf(f).filter((s) => /whatsapp|@r4\/channel-gateway/.test(s)), f).toEqual([]);
      expect(text(f), f).not.toMatch(/whatsapp|graph\.facebook|R4_WHATSAPP_|composeSalesGateway|createGatewayPlatform|runGatewayProcess/i);
    }
  });

  it('never builds an operator identity or decides a human request', () => {
    for (const f of CANARY) expect(code(f), f).not.toMatch(/TrustedHumanContext|trustedHumanContextSchema|humanContext|humanRef|respondHuman|takeOver|approval\.decide|\/v1\/human-requests/);
  });

  it('runs the agent only through the production worker composition: no capability registered, executed or reconciled here', () => {
    const runtime = code(join(DIR, 'runtime.ts'));
    expect(runtime).toMatch(/composeSalesProductionWorker\(/);
    expect(runtime).toMatch(/createWorkerPlatform\(options\.worker, \{ \.\.\.composed\.bindings, admission: new CanaryAdmission\(pool, composed\.controls\) \}/);
    expect(runtime).toMatch(/new ChannelIngress\(/);
    expect(runtime).toMatch(/salesConversationTaskFactory\(pool, salesProductionAgentVersion\(canary\.profile\)\)/);
    for (const f of CANARY) expect(code(f), f).not.toMatch(/\.register(Write)?\(|\.execute\(|\.reconcile\(|CapabilityInvoker|ActionRuntime|new ActionPolicyEngine|actionPolicy:/);
  });

  // R4-J4-R5 preparation: plus exactly one purge statement (D7 of the canary, owner decision), inside purgeCanary only.
  it('writes no runtime state of its own: the only statements it issues are the database marker and the purge', () => {
    for (const f of CANARY) expect(code(f).replace(/await client\.query\(`truncate \$\{/, ''), f).not.toMatch(/\b(insert into|delete from|truncate|drop)\b|\bupdate\s+[a-z_]+\s+set\b/i);
    const identity = code(join(DIR, 'identity.ts'));
    expect([...identity.matchAll(/\btruncate\b/gi)]).toHaveLength(1);
    expect(identity.slice(identity.indexOf('export async function purgeCanary('))).toMatch(/await client\.query\(`truncate \$\{/);
    const isolation = code(join(DIR, 'isolation.ts'));
    expect([...isolation.matchAll(/comment on database/g)]).toHaveLength(1);
  });

  it('never reads .env and takes the production database URL only to refuse it or to replace it with the canary one', () => {
    for (const f of CANARY) expect(code(f), f).not.toMatch(/loadLocalEnv|loadEnvFile|dotenv/);
    const uses = CANARY.flatMap((f) => [...code(f).matchAll(/.*\bR4_DATABASE_URL\b.*/g)].map((m) => m[0].trim())).sort();
    expect(uses).toEqual([
      'const scoped = { ...env, R4_DATABASE_URL: canary.databaseUrl };',
      'if (env.R4_DATABASE_URL && sameDatabase(env.R4_DATABASE_URL, databaseUrl)) {',
      "throw new ProductionConfigError('canary_shares_production_database', 'R4_CANARY_DATABASE_URL names the same database as R4_DATABASE_URL; the canary needs its own database');",
    ]);
  });

  it('is exposed as exactly one script', () => {
    const scripts = (JSON.parse(text(join(ROOT, 'package.json'))) as { scripts: Record<string, string> }).scripts;
    expect(Object.entries(scripts).filter(([k]) => k.startsWith('sales:canary'))).toEqual([['sales:canary', 'node agents/sales/dist/cli/canary.js']]);
  });
});
