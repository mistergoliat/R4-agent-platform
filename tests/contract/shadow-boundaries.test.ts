import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShadowQuoteService, createFixtureDomains } from '@r4-adapters/domains';
import { ShadowExecutionPolicy, ShadowViolation, SideEffectRecorder, guardPort, loadShadowExecutionConfig, shadowRunSchema } from '@r4/shadow';
import { SALES_SHADOW_BINDINGS, SALES_SHADOW_OUTBOUND, composeShadowSalesDomains } from '@r4-sales/agent/shadow';

/**
 * R4-H architecture boundaries (ADR-027):
 *   Core (packages/*, apps/*) never depends on Shadow
 *   the Shadow framework is generic, pure and network-free
 *   the Sales Agent (its deployed runtime) does not know shadow mode exists
 *   shadow can never compose a production write binding or a delivering outbound
 *   every domain binding declares every port operation with an effect class
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const rel = (file: string) => relative(ROOT, file).split('\\').join('/');
function files(dir: string, ext = '.ts'): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, ext));
    else if (name.endsWith(ext)) out.push(path);
  }
  return out;
}
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
const text = (list: readonly string[]) => list.map((f) => readFileSync(f, 'utf8')).join('\n');

const FRAMEWORK = files(join(ROOT, 'packages/shadow/src'));
const CORE = [...files(join(ROOT, 'packages')), ...files(join(ROOT, 'apps'))].filter((f) => !FRAMEWORK.includes(f));
const SALES = files(join(ROOT, 'agents/sales/src'));
const SALES_SHADOW = files(join(ROOT, 'agents/sales/src/shadow'));
const SALES_RUNTIME = SALES.filter((f) => !/[\\/](harness|cli|evaluations|shadow)[\\/]/.test(f));
const config = loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow' });

describe('Core has no Shadow dependency', () => {
  it('no Core package or app imports the shadow framework or a pack’s shadow module', () => {
    expect(CORE.length).toBeGreaterThan(50);
    const violations = CORE.flatMap((f) => importsOf(f).filter((s) => s === '@r4/shadow' || /shadow/.test(s)).map((s) => `${rel(f)}: ${s}`));
    expect(violations).toEqual([]);
    for (const file of ['packages/agent-kernel/src/kernel.ts', 'packages/task-runtime/src/action-runtime.ts', 'packages/capability-runtime/src/action-executor.ts', 'packages/policy-engine/src/engine.ts', 'apps/worker/src/platform.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/shadow/i);
    }
  });
});

describe('the Shadow framework is generic, pure and network-free', () => {
  it('imports only contracts, evaluation, the ModelProvider SPI, zod and node:crypto', () => {
    const allowed = /^(@r4\/(contracts|evaluation|model-gateway)|zod|node:crypto|\.\.?\/[\w/.-]+\.js)$/;
    expect(FRAMEWORK.flatMap((f) => importsOf(f).filter((s) => !allowed.test(s)).map((s) => `${rel(f)}: ${s}`))).toEqual([]);
  });

  it('opens no connection and writes no file (artifacts are written by the caller)', () => {
    expect(text(FRAMEWORK)).not.toMatch(/\bfetch\(|https?:\/\/|createPool|new pg\.|writeFileSync|appendFileSync|process\.env\b/);
  });

  it('contains no pack concept (the Sales terms live in the pack’s shadow module)', () => {
    expect(text(FRAMEWORK)).not.toMatch(/\b(sales|quote|cotizaci|product|catalog|customer|workspace|presupuesto|cart|campaign|payment|whatsapp|instagram|facebook)\b/i);
    expect(FRAMEWORK.flatMap((f) => importsOf(f).filter((s) => /@r4-(sales|adapters)|agents\//.test(s)))).toEqual([]);
  });

  it('has exactly one outbound implementation, and it never delivers', () => {
    const implementations = [...text([...FRAMEWORK, ...SALES]).matchAll(/class (\w+) implements OutboundDelivery/g)].map((m) => m[1]);
    expect(implementations).toEqual(['ShadowOutboundSink']);
    expect(readFileSync(join(ROOT, 'packages/shadow/src/outbound.ts'), 'utf8')).toMatch(/actualDelivery: z\.literal\(false\)/);
  });

  it('an executed ShadowRun cannot drop its binding metadata', () => {
    const parsed = shadowRunSchema.safeParse({ status: 'executed', bindings: [], outbound: null, sideEffects: null, safety: [] });
    expect(parsed.success).toBe(false);
  });
});

describe('the Sales Agent does not know shadow mode', () => {
  it('the deployed pack runtime never imports shadow code and never mentions shadow', () => {
    expect(SALES_RUNTIME.length).toBeGreaterThan(10);
    expect(SALES_RUNTIME.flatMap((f) => importsOf(f).filter((s) => /shadow/.test(s)).map((s) => `${rel(f)}: ${s}`))).toEqual([]);
    expect(text(SALES_RUNTIME)).not.toMatch(/shadow/i);
    expect(readFileSync(join(ROOT, 'agents/sales/sales.agent.json'), 'utf8')).not.toMatch(/shadow/i);
    // The pack's main entry does not expose the shadow module (separate `./shadow` entry, like `./evaluations`).
    expect(readFileSync(join(ROOT, 'agents/sales/src/index.ts'), 'utf8')).not.toMatch(/shadow/);
  });

  it('the shadow module reaches the agent only through composeSales ports and a policy profile — no capability or policy edits', () => {
    const src = text(SALES_SHADOW);
    expect(src).not.toMatch(/registerWrite|\.register\(|SALES_ACTION_POLICY\s*=|sales\.agent\.json/);
    expect(src).not.toMatch(/\bfetch\(|https?:\/\//);
  });
});

describe('shadow fails closed on production bindings and delivery', () => {
  it('a production binding for any Sales domain refuses the whole composition before anything is wired', () => {
    for (const domain of ['customer', 'catalog', 'shipping', 'quote']) {
      const bindings = SALES_SHADOW_BINDINGS.map((b) => (b.domain === domain ? { ...b, kind: 'production' as const } : b));
      expect(() => composeShadowSalesDomains(config, { now: () => new Date(), bindings }), domain).toThrow(/production_binding/);
    }
    expect(() => composeShadowSalesDomains(config, { now: () => new Date(), outbound: { ...SALES_SHADOW_OUTBOUND, kind: 'production-delivery' } })).toThrow(/production_delivery/);
  });

  it('a production-write binding is refused at runtime too (defense in depth), and nothing reaches the owner', () => {
    const fixtures = createFixtureDomains();
    const quotes = Object.assign(new ShadowQuoteService({ catalog: fixtures.catalog, shipping: fixtures.shipping }), { bindingKind: 'production' });
    const recorder = new SideEffectRecorder();
    const quoteBinding = { ...SALES_SHADOW_BINDINGS.find((b) => b.domain === 'quote')!, kind: 'production' as const };
    const port = guardPort(quotes, quoteBinding, new ShadowExecutionPolicy(config), recorder);
    expect(() => port.create({ customer: { name: 'Ana Test', email: 'a@example.test', phone: null }, lines: [{ productId: 'BAR-OLY20', quantity: 1 }], delivery: { commune: 'Ñuñoa' } }, 'r4x_' + '0'.repeat(32))).toThrow(ShadowViolation);
    expect(quotes.records).toHaveLength(0);
    expect(recorder.records).toMatchObject([{ outcome: 'blocked', production: false }]);
  });

  it('shadow cannot compose without an explicit shadow declaration', () => {
    expect(() => composeShadowSalesDomains({ mode: 'production' } as never, { now: () => new Date() })).toThrow(/no proven shadow/);
  });
});

describe('domain binding identity', () => {
  const portMethods = (file: string, iface: string) => {
    const src = readFileSync(join(ROOT, 'adapters/domains/src', file), 'utf8');
    const body = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src)![1]!;
    return [...body.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]!).sort();
  };

  it('every Sales binding declares exactly the operations of its port, each with an effect class (never inferred)', () => {
    const expected: Record<string, string[]> = {
      customer: portMethods('customer/port.ts', 'CustomerDirectory'),
      catalog: portMethods('catalog/port.ts', 'CatalogPort'),
      shipping: portMethods('shipping/port.ts', 'ShippingService'),
      quote: portMethods('quote/port.ts', 'QuoteService'),
    };
    for (const b of SALES_SHADOW_BINDINGS) expect(Object.keys(b.operations).sort(), b.domain).toEqual(expected[b.domain]);
    expect(SALES_SHADOW_BINDINGS.find((b) => b.domain === 'catalog')!.operations).toEqual({ search: { effect: 'read' }, getProductContext: { effect: 'read' }, getItemContext: { effect: 'read' } });
    expect(SALES_SHADOW_BINDINGS.find((b) => b.domain === 'quote')!.operations.create).toEqual({ effect: 'write', idempotencyKeyArg: 1 });
  });

  it('the binding set is honest: no live-read or sandbox binding without a documented contract; the Quote owner is shadow', () => {
    for (const b of SALES_SHADOW_BINDINGS) if (b.kind === 'live-read' || b.kind === 'sandbox') expect(b.contractRef, b.domain).not.toBeNull();
    expect(SALES_SHADOW_BINDINGS.map((b) => `${b.domain}=${b.kind}`)).toEqual(['customer=fixture', 'catalog=fixture', 'shipping=fixture', 'quote=shadow']);
  });
});

describe('offline CI and explicit live commands', () => {
  it('npm test never runs a live shadow command; live and smoke commands are separate and explicit', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).not.toMatch(/shadow:sales|--live|--smoke/);
    expect(pkg.scripts['shadow:sales']).toMatch(/--execution-mode shadow/);
    expect(pkg.scripts['shadow:sales']).not.toMatch(/--live|--smoke/);
    expect(pkg.scripts['shadow:sales:live']).toMatch(/--execution-mode shadow --live/);
    expect(pkg.scripts['shadow:sales:smoke']).toMatch(/--execution-mode shadow --smoke/);
  });

  it('the shadow test project runs without model credentials or live opt-ins', () => {
    const shadowTests = files(join(ROOT, 'tests/shadow'));
    expect(text(shadowTests)).not.toMatch(/mode: 'live'|R4_SHADOW_ALLOW_LIVE_MODEL: 'true'|OpenAICompatible/);
  });
});
