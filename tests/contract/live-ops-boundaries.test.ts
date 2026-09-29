import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTROLS_UNAVAILABLE, loadProductionConfig, decideDispatch, ProductionConfigError } from '@r4/live-ops';
import { ShadowExecutionPolicy, loadShadowExecutionConfig } from '@r4/shadow';
import { SALES_PRODUCTION_ACTION_POLICY, SALES_PRODUCTION_PROFILE, UNAVAILABLE_CATALOG, composeSalesProductionWorker } from '@r4-sales/agent/production';
import { CAPABILITY_IDS } from '@r4-sales/agent';
import { respondDecisionSchema } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import type { ProductionStore } from '@r4/live-ops';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, '/');
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}
const text = (f: string) => readFileSync(f, 'utf8');
const importsOf = (f: string) => [...text(f).matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
const deps = (dir: string) => Object.keys((JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {});

const CORE_EXECUTION = ['contracts', 'observability', 'model-gateway', 'capability-runtime', 'task-runtime', 'agent-registry', 'agent-kernel', 'context-compiler', 'policy-engine'].flatMap((p) => files(join(ROOT, 'packages', p, 'src')));
const LIVE_OPS = files(join(ROOT, 'packages/live-ops/src'));
const SALES = files(join(ROOT, 'agents/sales/src'));
const RUNTIME = [...files(join(ROOT, 'packages')), ...files(join(ROOT, 'apps')), ...files(join(ROOT, 'agents/sales/src')), ...files(join(ROOT, 'adapters'))].filter((f) => !f.includes(`${'/'}testing.ts`) && !f.endsWith('testing.ts'));

const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const noPool = { query: () => Promise.reject(new Error('no database')) } as never;
const provenProduction = loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@1', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });

describe('R4-I boundaries: channel neutrality', () => {
  it('Core execution has no channel or provider dependency and never imports the production layer', () => {
    const offending = CORE_EXECUTION.flatMap((f) => importsOf(f).filter((s) => /@r4\/live-ops|@r4\/channel-gateway|@r4-adapters\//.test(s)).map((s) => `${rel(f)}: ${s}`));
    expect(offending).toEqual([]);
    for (const p of ['contracts', 'task-runtime', 'agent-kernel', 'context-compiler', 'policy-engine', 'model-gateway', 'capability-runtime']) expect(deps(`packages/${p}`)).not.toContain('@r4/live-ops');
  });

  it('the production layer is channel-neutral (no provider names) and never reaches models, kernel, capabilities or policy', () => {
    expect(LIVE_OPS.filter((f) => /whatsapp|meta\b|graph\.facebook|wamid|zenvia|n8n/i.test(text(f))).map(rel)).toEqual([]);
    expect(deps('packages/live-ops').sort()).toEqual(['@r4/context-compiler', '@r4/contracts', '@r4/observability', '@r4/task-runtime', 'zod']);
  });

  it('the Sales agent runtime knows no channel: only its production composition (deployment wiring) names WhatsApp', () => {
    const mentions = SALES.filter((f) => /whatsapp/i.test(text(f))).map(rel);
    // Deployment wiring only: the production composition and its CLI (outside the pack runtime).
    expect(mentions.filter((f) => !f.startsWith('agents/sales/src/production/') && !/^agents\/sales\/src\/cli\/production(-validation)?\.ts$/.test(f))).toEqual([]);
    const definition = readFileSync(join(ROOT, 'agents/sales/sales.agent.json'), 'utf8');
    expect(definition).not.toMatch(/whatsapp|delivered|outbound/i);
  });
});

describe('R4-I boundaries: one owner of external delivery', () => {
  it('only the delivery owner submits to a channel provider; the kernel, worker, webhook and packs never do', () => {
    const submitters = RUNTIME.filter((f) => /\.submit\(\s*\{/.test(text(f)) || /adapter\.submit\(/.test(text(f))).map(rel);
    expect(submitters).toEqual(['packages/live-ops/src/outbound.ts']);
    for (const f of [...files(join(ROOT, 'packages/agent-kernel/src')), ...files(join(ROOT, 'apps/worker/src'))]) expect(text(f)).not.toMatch(/fetch\(|OutboundChannelAdapter|outbound_messages/);
  });

  it('only the production store writes outbound or inbound state', () => {
    const writers = RUNTIME.filter((f) => /insert into (outbound_messages|inbound_events|outbound_delivery_|channel_conversation_bindings|autonomy_control)/.test(text(f))).map(rel);
    expect(writers).toEqual(['packages/persistence-postgres/src/production-store.ts']);
  });

  it('respond ≠ delivered: a materialized outbound is born pending (or cancelled as a duplicate), never accepted/delivered', () => {
    const store = text(join(ROOT, 'packages/persistence-postgres/src/production-store.ts'));
    expect(store).toMatch(/live \? 'cancelled' : 'pending'/);
    // The decision carries no channel, recipient or delivery state.
    expect(Object.keys(respondDecisionSchema.shape).sort()).toEqual(['content', 'type']);
  });

  it('Quality cannot dispatch: evaluation, evaluator and shadow do not depend on the production layer or a channel', () => {
    for (const dir of ['packages/evaluation', 'apps/evaluator', 'packages/shadow']) {
      expect(deps(dir)).not.toContain('@r4/live-ops');
      expect(deps(dir)).not.toContain('@r4/channel-gateway');
      expect(deps(dir).filter((d) => d.startsWith('@r4-adapters/'))).toEqual([]);
    }
  });
});

describe('R4-I boundaries: modes and bindings', () => {
  it('shadow can never use a production binding, and production never accepts a shadow declaration', () => {
    const policy = new ShadowExecutionPolicy(loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow' }));
    expect(policy.classify({ domain: 'x', bindingId: 'x', kind: 'production', version: 1, operations: { write: { effect: 'write' } }, contractRef: 'doc', description: 'x' }, 'write').classification).toBe('BLOCKED');
    expect(() => loadProductionConfig({ R4_EXECUTION_MODE: 'shadow' })).toThrow(ProductionConfigError);
  });

  it('CI cannot compose production: nothing in the test environment declares it', () => {
    expect(process.env.R4_EXECUTION_MODE ?? '').not.toBe('production');
    expect(() => loadProductionConfig(process.env)).toThrow(ProductionConfigError);
  });

  it('the production profile never presents fixture commercial truth: no FIXTURE/SHADOW owner, no fixture import', () => {
    expect(Object.values(SALES_PRODUCTION_PROFILE.domains).map((d) => d.status)).not.toContain('FIXTURE');
    expect(Object.values(SALES_PRODUCTION_PROFILE.domains).map((d) => d.status)).not.toContain('SHADOW');
    for (const f of files(join(ROOT, 'agents/sales/src/production'))) expect(text(f)).not.toMatch(/createFixtureDomains|Fixture(Catalog|Customer|Shipping|Quote)|ShadowQuoteService/);
    expect(UNAVAILABLE_CATALOG.bindingKind).toBe('unavailable');
  });

  it('capability availability reflects the real bindings: unavailable owners are not offered to the model', () => {
    const { bindings, report } = composeSalesProductionWorker({ pool: noPool, store: noStore, production: provenProduction, modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger() });
    const offered = bindings.capabilities.list().map((c) => c.capabilityId);
    expect(offered).toEqual([CAPABILITY_IDS.workspaceUpdate]);
    for (const id of [CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, CAPABILITY_IDS.customerContext, CAPABILITY_IDS.shippingQuote, CAPABILITY_IDS.quoteCreate]) expect(offered).not.toContain(id);
    expect(report.writes.requireApproval).toContain(CAPABILITY_IDS.quoteCreate);
    expect(bindings.admission).toBeDefined();
    expect(bindings.actionPolicy).toBe(SALES_PRODUCTION_ACTION_POLICY);
    expect((SALES_PRODUCTION_ACTION_POLICY.capabilities as Record<string, { autonomy: string }>)[CAPABILITY_IDS.quoteCreate]!.autonomy).toBe('require_approval');
  });
});

describe('R4-I boundaries: kill switch defaults safe', () => {
  it('the migration creates the global control DISABLED; unreadable controls read as disabled; the gate then holds', () => {
    const migration = readFileSync(join(ROOT, 'packages/persistence-postgres/migrations/0007_governed_production.sql'), 'utf8');
    expect(migration).toMatch(/values \('global', false,/);
    expect(CONTROLS_UNAVAILABLE.globalEnabled).toBe(false);
    const decision = decideDispatch({ origin: 'agent', channel: 'x', createdAt: new Date().toISOString(), now: new Date().toISOString(), controls: CONTROLS_UNAVAILABLE, binding: { status: 'open', autonomous: true, deniedNow: false }, task: { status: 'waiting', humanOwned: false }, supersededByNewerInput: false, windowOpen: true }, { maxAgeMs: 60_000 });
    expect(decision.kind).toBe('hold');
  });

  it('the worker asks for admission before every claim and fails closed when admission cannot decide', () => {
    const worker = readFileSync(join(ROOT, 'apps/worker/src/worker.ts'), 'utf8');
    expect(worker).toMatch(/if \(!\(await this\.#admitted\(\)\)\) return \{ kind: 'idle' \};\n\s+const claim = await execution\.claimNext/);
    expect(worker).toMatch(/admission\.admit\(\)\.catch\(\(error: unknown\) => \(\{ admitted: false/);
  });
});

describe('R4-I boundaries: production administration (D-5/D-6) is host tooling, not the operator plane', () => {
  const ADMIN = ['packages/live-ops/src/administration.ts', 'apps/channel-gateway/src/administration.ts', 'agents/sales/src/production/control.ts', 'agents/sales/src/cli/production-control.ts'];
  /** Source without comments (the docs name what the code must never do). */
  const code = (f: string) => text(join(ROOT, f)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('never fabricates a human, calls the HTTP operator API, a model, a channel adapter or the delivery owner', () => {
    for (const f of ADMIN) {
      const source = code(f);
      expect(importsOf(join(ROOT, f)).filter((s) => /@r4\/(model-gateway|api|worker|agent-kernel|capability-runtime)|@r4-adapters\/|openai-compatible/.test(s)), f).toEqual([]);
      // The channel gateway package is used only for its administration composition (no adapter, delivery or HTTP).
      expect(source, f).not.toMatch(/composeSalesGateway|createGatewayPlatform|runGatewayProcess|loadWhatsAppCloudConfig|Fastify/);
      expect(source, f).not.toMatch(/TrustedHumanContext|trustedHumanContextSchema|humanContext|humanRef|respondHuman|takeOver|\/v1\/production|fetch\(|OutboundDeliveryRuntime|dispatch(Once)?\(|\.submit\(/);
    }
  });

  it('changes durable state only through existing primitives (no SQL of its own), never reads .env, and exposes exactly one command', () => {
    for (const f of ADMIN) expect(code(f), f).not.toMatch(/\b(update|insert into|delete from)\s+[a-z_]+/i);
    for (const f of ADMIN.slice(2)) expect(code(f), f).not.toMatch(/loadLocalEnv|loadEnvFile|dotenv/);
    const scripts = (JSON.parse(text(join(ROOT, 'package.json'))) as { scripts: Record<string, string> }).scripts;
    expect(Object.keys(scripts).filter((s) => s.startsWith('production:sales:control'))).toEqual(['production:sales:control']);
    expect(scripts['production:sales:control']).toBe('node agents/sales/dist/cli/production-control.js');
  });

  it('production bootstrap registers definitions only through the Agent Registry, explicitly — never at gateway or worker start', () => {
    const BOOTSTRAP = ['apps/api/src/registration.ts', 'agents/sales/src/production/bootstrap.ts', 'agents/sales/src/cli/production-bootstrap.ts'];
    for (const f of BOOTSTRAP) {
      const source = code(f);
      expect(importsOf(join(ROOT, f)).filter((s) => /@r4\/(model-gateway|worker|agent-kernel|capability-runtime|channel-gateway|task-runtime)|@r4-adapters\/|openai-compatible/.test(s)), f).toEqual([]);
      expect(source, f).not.toMatch(/\b(update|insert into|delete from)\s+[a-z_]+/i);
      expect(source, f).not.toMatch(/loadLocalEnv|loadEnvFile|dotenv|fetch\(|setControl|AutonomyControls|setAutonomy|rolloutEligibility|createGatewayPlatform|createWorkerPlatform/);
    }
    const registration = code('apps/api/src/registration.ts');
    expect(registration).toMatch(/loadAgentDefinitionsFromDirectory\(/);
    expect(registration).toMatch(/registry\.sync\(/);
    expect(registration).not.toMatch(/\.register\(/);
    for (const f of ['apps/channel-gateway/src/platform.ts', 'apps/worker/src/platform.ts']) {
      expect(code(f), f).not.toMatch(/\.sync\(|loadAgentDefinitionsFromDirectory|registerAgentDefinitions/);
    }
    const scripts = (JSON.parse(text(join(ROOT, 'package.json'))) as { scripts: Record<string, string> }).scripts;
    expect(scripts['production:sales:bootstrap']).toBe('node agents/sales/dist/cli/production-bootstrap.js');
  });

  it('task retirement goes through the Temporal Runtime only: never binding, rollout or autonomy state, never a human cancellation', () => {
    for (const f of ADMIN) {
      const source = code(f);
      expect(source, f).not.toMatch(/closeBinding|openBinding|attachTask|touchBinding|rolloutEligibility|R4_PROD_ROLLOUT|\.cancelTask\([^)]*(OPERATOR|context|human)/);
    }
    const admin = code('packages/live-ops/src/administration.ts');
    const cancel = admin.slice(admin.indexOf('async cancelTask('));
    const body = cancel.slice(0, cancel.indexOf('\n  }\n'));
    expect(body).toMatch(/this\.#temporal\.cancelTaskByPlatform\(taskId, \{ note, actorRef: PRODUCTION_CONTROL_ACTOR, correlationId: this\.#correlationId \}\)/);
    // Only reads besides the runtime call: no control change, no release, no other store method.
    expect([...body.matchAll(/this\.#(store|controls|temporal)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual(['temporal.cancelTaskByPlatform', 'store.bindingByTask']);
  });

  it('offers no bulk, wildcard or automatic release', () => {
    const control = text(join(ROOT, 'agents/sales/src/production/control.ts'));
    expect(control).not.toMatch(/release-all|releaseAll|--all\b/);
    const admin = text(join(ROOT, 'packages/live-ops/src/administration.ts'));
    // Turning autonomy on only sets the control.
    expect(admin).toMatch(/async setAutonomy\([^)]*\)[^{]*\{\n\s+return this\.#controls\.set\(/);
  });
});
