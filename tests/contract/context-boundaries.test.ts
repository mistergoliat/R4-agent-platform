import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_DECISION_TYPES,
  MEMORY_AUTHORITY,
  MEMORY_TYPES,
  compiledContextSchema,
  contextBudgetPolicySchema,
  contextCompositionSchema,
  contextItemSchema,
  conversationalMemoryContentSchema,
  contextSnapshotSchema,
  memoryEntrySchema,
} from '@r4/contracts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split('\\').join('/');
const compilerSources = sources(join(ROOT, 'packages/context-compiler/src'));
const kernelSources = sources(join(ROOT, 'packages/agent-kernel/src'));
const runtimeSources = [...sources(join(ROOT, 'packages')), ...sources(join(ROOT, 'apps'))];
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

function propertyNames(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const item of schema) propertyNames(item, out);
  else if (schema !== null && typeof schema === 'object') {
    const record = schema as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') for (const key of Object.keys(record.properties)) out.add(key);
    for (const value of Object.values(record)) propertyNames(value, out);
  }
  return out;
}

const C2_CONTRACTS = {
  ContextItem: contextItemSchema,
  CompiledContext: compiledContextSchema,
  ContextSnapshot: contextSnapshotSchema,
  MemoryEntry: memoryEntrySchema,
  ContextBudgetPolicy: contextBudgetPolicySchema,
  ContextComposition: contextCompositionSchema,
};
const names = (schema: z.ZodType) => [...propertyNames(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))];

describe('Context Compiler boundary (ADR-010)', () => {
  it('imports only contracts, observability, zod and its own modules', () => {
    const allowed = /^(@r4\/contracts|@r4\/observability|zod|\.\.?\/[a-z-/]+\.js)$/;
    const violations = compilerSources.flatMap((file) => importsOf(file).filter((spec) => !allowed.test(spec)).map((spec) => `${rel(file)}: ${spec}`));
    expect(compilerSources.length).toBeGreaterThan(8);
    expect(violations).toEqual([]);
  });

  it('contains no SQL, transport, environment or model access', () => {
    const text = compilerSources.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(text).not.toMatch(/\b(select|insert|update|delete)\s+[a-z_*]+\s+(from|into|set)\b/i);
    expect(text).not.toMatch(/fastify|pg\.Pool|process\.env|ModelGateway|generate\(/);
  });

  it('the kernel never knows how context is compiled: no import, no reference', () => {
    for (const file of kernelSources) {
      const text = readFileSync(file, 'utf8');
      expect(importsOf(file), rel(file)).not.toContain('@r4/context-compiler');
      expect(text, rel(file)).not.toMatch(/ContextCompiler|ContextSource|MemoryReader|compile\(/);
    }
  });
});

describe('C2 contracts are provider- and domain-neutral', () => {
  const VENDOR_OR_MODEL = /^(provider|providerId|model|modelId|modelName|vendor|apiKey|endpoint|baseUrl)$/i;
  const PROVIDER_RENDERING = /^(messages|message|system|prompt|completion|cache_?control|tool_?use|tool_?calls?)$/i;
  const DOMAIN = /(quote|cart|opportunit|campaign|product|payment|catalog|customer|order|shipping|commercial|sales)/i;

  it.each(Object.entries(C2_CONTRACTS))('%s names no vendor, model or provider-rendering field', (_name, schema) => {
    expect(names(schema).filter((n) => VENDOR_OR_MODEL.test(n) || PROVIDER_RENDERING.test(n))).toEqual([]);
  });

  it.each(Object.entries(C2_CONTRACTS))('%s carries no domain field', (_name, schema) => {
    expect(names(schema).filter((n) => DOMAIN.test(n))).toEqual([]);
  });

  it('describes who spoke by interaction role, never by provider message role', () => {
    const roles = conversationalMemoryContentSchema.shape.actor.shape.role.options;
    expect(roles).toEqual(['requester', 'agent', 'participant', 'operator']);
    for (const providerRole of ['system', 'user', 'assistant', 'tool']) expect(roles).not.toContain(providerRole);
  });
});

describe('no model-written canonical truth', () => {
  it('the model can still only read, respond, complete or PROPOSE — no memory or state writes', () => {
    // R4-D adds propose_action: a proposal the platform governs, never a direct write of memory or state.
    // R4-E adds wait / consultation / handoff requests and manage_goal, each validated by the
    // Temporal Runtime: goals are cognitive state, never memory or business state.
    expect([...AGENT_DECISION_TYPES]).toEqual(['read_capability', 'respond', 'complete', 'propose_action', 'wait', 'request_consultation', 'request_handoff', 'manage_goal']);
    for (const type of AGENT_DECISION_TYPES) expect(type).not.toMatch(/memory|state|write|execute|commit/);
  });

  it('no memory type is AUTHORITATIVE', () => {
    for (const type of MEMORY_TYPES) expect(MEMORY_AUTHORITY[type]).not.toBe('AUTHORITATIVE');
  });

  it('AUTHORITATIVE items are produced only by platform sources over platform records', () => {
    const producers = runtimeSources.filter((file) => /authority:\s*[^,\n]*'AUTHORITATIVE'/.test(readFileSync(file, 'utf8'))).map(rel);
    expect(producers).toEqual(['packages/context-compiler/src/sources/platform.ts']);
  });

  it('memory is written only by the append API and the snapshot transaction — neither reachable from model output', () => {
    const writers = runtimeSources.filter((file) => /insertMemoryEntry\(/.test(readFileSync(file, 'utf8'))).map(rel).sort();
    expect(writers).toEqual([
      'packages/persistence-postgres/src/execution-store.ts',
      'packages/persistence-postgres/src/memory-store.ts',
      'packages/task-runtime/src/execution-runtime.ts',
      'packages/task-runtime/src/ports.ts',
      // R4-E: canonical inbound input — the C2 conversation-ingestion seam — recorded by the resolved (non-model) principal.
      'packages/task-runtime/src/temporal-runtime.ts',
    ]);
    // The execution runtime only ever writes compaction summaries, recorded as the system.
    const runtime = readFileSync(join(ROOT, 'packages/task-runtime/src/execution-runtime.ts'), 'utf8');
    expect(runtime).toMatch(/memoryType: 'DERIVED_SUMMARY'/);
    expect(runtime).toMatch(/recordedBy: CONTEXT_COMPILER_PRINCIPAL/);
    // The temporal runtime writes exactly one kind of memory: the CONVERSATIONAL text of a submitted input.
    const temporal = readFileSync(join(ROOT, 'packages/task-runtime/src/temporal-runtime.ts'), 'utf8');
    expect(temporal.match(/insertMemoryEntry\(/g)).toHaveLength(1);
    expect(temporal).toMatch(/memoryType: 'CONVERSATIONAL', occurredAt: body\.occurredAt, recordedAt: now, recordedBy: principal/);
    expect(temporal).not.toMatch(/memoryType: '(WORKING|EPISODIC|DERIVED_SUMMARY)'/);
    // Neither the kernel nor the session port can write memory.
    const kernel = kernelSources.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(kernel).not.toMatch(/MemoryEntry|memoryType|insertMemoryEntry|MemoryReader/);
  });
});
