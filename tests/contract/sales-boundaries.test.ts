import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFixtureDomains } from '@r4-adapters/domains';
import { parseAgentDecision } from '@r4/agent-kernel';
import { CapabilityInvoker } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import type { ModelResponse } from '@r4/model-gateway';
import { CAPABILITY_IDS, SALES_ACTION_POLICY, composeSales, loadSalesAgentDefinition, quoteCreateInput, workspaceUpdateInputSchema } from '@r4-sales/agent';
import { ActionPolicyEngine } from '@r4/policy-engine';
import { FakeClock, idsFrom } from '../support/deterministic.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';

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

const CORE = [...files(join(ROOT, 'packages')), ...files(join(ROOT, 'apps'))];
const SALES = files(join(ROOT, 'agents/sales/src'));
const DOMAINS = files(join(ROOT, 'adapters/domains/src'));
const PROVIDER = files(join(ROOT, 'adapters/models/openai-compatible/src'));
/**
 * The pack's runtime (what a deployment runs), as opposed to its harness, CLIs
 * and (R4-G) its post-hoc evaluator pack — which reads durable state and is
 * never part of what the agent executes (see contract/quality-boundaries).
 */
const SALES_RUNTIME = SALES.filter((f) => !/[\\/](harness|cli|evaluations)[\\/]/.test(f));

const noDb = { query: () => Promise.reject(new Error('no database in contract tests')), connect: () => Promise.reject(new Error('no database')) } as never;
const sales = composeSales({ pool: noDb, domains: createFixtureDomains(), modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) } });
const definition = loadSalesAgentDefinition();

describe('Core stays Sales-free', () => {
  it('no Core package or app imports the Sales pack or any adapter', () => {
    const violations = CORE.flatMap((f) => importsOf(f).filter((s) => /^@r4-(sales|adapters)\//.test(s) || /agents\/|adapters\//.test(s)).map((s) => `${rel(f)}: ${s}`));
    expect(CORE.length).toBeGreaterThan(30);
    expect(violations).toEqual([]);
  });

  it('Core migrations contain no Sales table; the Sales schema lives with the pack', () => {
    const core = files(join(ROOT, 'packages/persistence-postgres/migrations'), '.sql').map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(core).not.toMatch(/\bsales\b/i);
    const pack = files(join(ROOT, 'agents/sales/migrations'), '.sql');
    expect(pack.map(rel)).toEqual(['agents/sales/migrations/0006_sales_reference_application.sql']);
    const sql = readFileSync(pack[0]!, 'utf8');
    // Sales tables are in their own schema and never reference an R4 runtime table.
    expect(sql).not.toMatch(/references\s+(public\.)?(agent_tasks|agent_runs|observations|action_\w+|goals|memory_entries)/i);
    expect([...sql.matchAll(/create table (\S+)/g)].map((m) => m[1])).toEqual(['sales.conversations', 'sales.workspaces', 'sales.workspace_transitions', 'sales.quote_requests', 'sales.quote_references']);
    // Sales state has no column for domain truth.
    expect(sql).not.toMatch(/\b(price|unit_price|stock|total|subtotal|amount)\b\s+(integer|numeric|bigint|text)/i);
  });
});

describe('Sales Agent Pack boundary', () => {
  it('the agent sees exactly the capabilities its scopes grant', () => {
    const visible = sales.capabilities.discover(definition.capabilityScopes).map((c) => c.capabilityId).sort();
    expect(visible).toEqual(Object.values(CAPABILITY_IDS).sort());
    expect(sales.capabilities.discover(definition.capabilityScopes.filter((s) => s !== 'quote.create')).map((c) => c.capabilityId)).not.toContain(CAPABILITY_IDS.quoteCreate);
    expect(sales.capabilities.discover([])).toEqual([]);
  });

  it('carries no provider, model, endpoint or secret in its definition; no subagents', () => {
    const raw = readFileSync(join(ROOT, 'agents/sales/sales.agent.json'), 'utf8');
    expect(raw).not.toMatch(/api[_-]?key|base[_-]?url|https?:\/\/|openai|deepseek|anthropic|gpt|llama|vllm|\bR4_MODEL/i);
    expect(definition.delegationPolicy).toEqual({ mode: 'none', allowedAgentIds: [] });
    expect(definition.budgets.maxDelegations).toBe(0);
    const agentFiles = files(join(ROOT, 'agents'), '.agent.json').map(rel).sort();
    expect(agentFiles).toEqual(['agents/platform-probe/platform-probe.agent.json', 'agents/sales/sales.agent.json']);
  });

  it('instructions set criteria, not a scripted sequence or an intent router', () => {
    const instructions = definition.instructions;
    expect(instructions.length).toBeLessThan(6_000);
    expect(instructions).not.toMatch(/\bstep\s*\d|\bpaso\s*\d|^\s*\d+\.\s/im);
    expect(instructions).not.toMatch(/\bintent\b|\bstage\b|READY_TO_QUOTE|NEEDS_/i);
    const sources = SALES.map((f) => readFileSync(f, 'utf8')).join('\n');
    // No workflow controller: nothing in the pack keys behavior on a conversation stage or an intent label.
    expect(sources).not.toMatch(/\b(stage|intent|nextStep|workflowState)\b\s*[:=]/);
  });

  it('catalog capabilities are READ-only and the Catalog port has no write operation', () => {
    for (const id of [CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, CAPABILITY_IDS.customerContext, CAPABILITY_IDS.shippingQuote]) {
      const registered = sales.capabilities.resolve(id)!;
      expect(registered.definition.riskClass, id).toBe('READ');
      expect(registered.write, id).toBeUndefined();
    }
    const port = readFileSync(join(ROOT, 'adapters/domains/src/catalog/port.ts'), 'utf8');
    const methods = [...port.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]);
    expect(methods).toEqual(['search', 'getProduct']);
  });

  it('writes are governed: quote.create and workspace updates cannot run through the READ path', async () => {
    const clock = new FakeClock();
    const invoker = new CapabilityInvoker({ registry: sales.capabilities, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
    const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'c', grantedScopes: definition.capabilityScopes };
    for (const id of [CAPABILITY_IDS.quoteCreate, CAPABILITY_IDS.workspaceUpdate]) {
      const o = await invoker.invoke({ capabilityId: id, arguments: { workspaceVersion: 1, customer: { name: 'X', email: 'x@example.test' } } }, context);
      expect(o, id).toMatchObject({ outcome: 'rejected', error: { code: 'execution_not_permitted' } });
      expect(sales.capabilities.resolve(id)!.write, id).toBeDefined();
    }
    // The model cannot ask to *read* a write either: the decision itself is refused.
    const capabilities = sales.capabilities.list().map((c) => ({ capabilityId: c.capabilityId, version: c.version, description: c.description, riskClass: c.riskClass, inputSchema: c.inputSchema }));
    const response = (data: unknown): ModelResponse => ({ content: null, toolCalls: [], structuredData: data, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop', latencyMs: 0, provider: { providerId: 'x', modelId: 'x', requestId: null } });
    expect(parseAgentDecision(response({ type: 'read_capability', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: {} }), { capabilities, observationIds: new Set() })).toMatchObject({ ok: false, error: { code: 'capability_not_permitted' } });
  });

  it('policy: quote.create is autonomous only with evidence and at least provisional identity', () => {
    const engine = new ActionPolicyEngine(SALES_ACTION_POLICY);
    const capability = sales.capabilities.resolve(CAPABILITY_IDS.quoteCreate)!.definition;
    const base = {
      capability: { capabilityId: capability.capabilityId, version: 1, riskClass: capability.riskClass, requiredScopes: capability.requiredScopes, identityRequirement: capability.identityRequirement, confirmationPolicy: capability.confirmationPolicy, approvalPolicy: capability.approvalPolicy, idempotency: capability.idempotency, writeRecovery: capability.writeRecovery ?? null },
      context: { taskId: 't', runId: 'r', agentId: 'sales', agentVersion: 1, correlationId: 'c', grantedScopes: definition.capabilityScopes, actor: { kind: 'service' as const, ref: 'ingress' }, identityAssurance: 'provisional' as const },
      agent: { agentId: 'sales', version: 1, capabilityScopes: definition.capabilityScopes },
      task: { taskId: 't', status: 'running' as const },
      proposal: { proposalId: 'p', evidenceRefs: ['o-1'] },
    };
    expect(engine.evaluate(base as never).outcome).toBe('allow');
    expect(engine.evaluate({ ...base, proposal: { proposalId: 'p', evidenceRefs: [] } })).toMatchObject({ outcome: 'deny', reasonCode: 'evidence_required' });
    expect(engine.evaluate({ ...base, context: { ...base.context, identityAssurance: 'none' } } as never)).toMatchObject({ outcome: 'deny' });
  });

  it('the model cannot set quote identity, number, lines, prices or totals', () => {
    const properties = Object.keys((z.toJSONSchema(quoteCreateInput, { io: 'input' }) as { properties: Record<string, unknown> }).properties);
    expect(properties.sort()).toEqual(['customer', 'workspaceVersion']);
    for (const extra of [{ quoteId: 'q' }, { quoteNumber: 'COT-1' }, { total: { amount: 1, currency: 'CLP' } }, { lines: [] }, { status: 'issued' }]) {
      expect(quoteCreateInput.safeParse({ workspaceVersion: 1, customer: { name: 'Ana Test', email: 'a@example.test' }, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    // Nor can it put prices into Sales state.
    expect(workspaceUpdateInputSchema.safeParse({ operations: [{ op: 'record_fact', key: 'unit_price', value: 1, statedBy: 'agent' }] }).success).toBe(false);
  });
});

describe('domain adapters and the provider adapter stay behind their seams', () => {
  it('domain adapters depend on nothing from R4 and open no database or network connection', () => {
    const violations = DOMAINS.flatMap((f) => importsOf(f).filter((s) => !/^(node:crypto|\.\.?\/[\w/.-]+\.js)$/.test(s)).map((s) => `${rel(f)}: ${s}`));
    expect(violations).toEqual([]);
    const text = DOMAINS.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/\bfetch\(|postgres:\/\/|new pg\.|createPool|http\.request/);
  });

  it('Sales capabilities reach R4 only through public packages, never its persistence internals', () => {
    const violations = SALES_RUNTIME.filter((f) => !/migrate\.ts$/.test(f)).flatMap((f) => importsOf(f).filter((s) => s === '@r4/persistence-postgres' || s === '@r4/task-runtime' || s === '@r4/agent-kernel' || /packages\//.test(s)).map((s) => `${rel(f)}: ${s}`));
    expect(violations).toEqual([]);
    // The only SQL the pack runs is against its own `sales` schema.
    const store = readFileSync(join(ROOT, 'agents/sales/src/workspace/store.ts'), 'utf8');
    // (`on conflict … do update set` is an upsert clause of the same statement, not another table.)
    const tables = [...store.matchAll(/\b(?:from|into|(?<!do )update|join)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1]!.toLowerCase());
    expect(tables.length).toBeGreaterThan(5);
    expect(tables.filter((t) => !t.startsWith('sales.'))).toEqual([]);
  });

  it('the provider adapter depends only on the ModelProvider SPI, and nothing in Core knows it', () => {
    const allowed = /^(@r4\/model-gateway|@r4\/contracts|zod|\.\.?\/[\w/.-]+\.js)$/;
    expect(PROVIDER.flatMap((f) => importsOf(f).filter((s) => !allowed.test(s)).map((s) => `${rel(f)}: ${s}`))).toEqual([]);
    expect(CORE.map((f) => readFileSync(f, 'utf8')).join('\n')).not.toMatch(/openai|OpenAICompatible|chat\/completions/i);
    // The Sales Agent never names a provider either: model selection is deployment configuration.
    expect(SALES_RUNTIME.filter((f) => !/model\.ts$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n')).not.toMatch(/OpenAICompatible|openai-compatible|R4_MODEL_/);
  });

  it('declares allow-listed dependencies for every non-Core workspace package', () => {
    const manifest = (path: string) => Object.keys((JSON.parse(readFileSync(join(ROOT, path, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}).sort();
    expect(manifest('adapters/domains')).toEqual([]);
    expect(manifest('adapters/models/openai-compatible')).toEqual(['@r4/contracts', '@r4/model-gateway', 'zod']);
    const salesDeps = manifest('agents/sales');
    expect(salesDeps.filter((d) => !/^(@r4\/(contracts|observability|model-gateway|capability-runtime|context-compiler|policy-engine|persistence-postgres|agent-kernel|api|worker|evaluation|evaluator)|@r4-adapters\/(domains|openai-compatible)|pg|pino|zod)$/.test(d))).toEqual([]);
    expect(salesDeps).not.toContain('@r4/task-runtime');
  });
});
