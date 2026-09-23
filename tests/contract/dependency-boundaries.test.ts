import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifests(): Map<string, Manifest> {
  const out = new Map<string, Manifest>();
  for (const group of ['packages', 'apps']) {
    for (const dir of readdirSync(join(ROOT, group))) {
      const file = join(ROOT, group, dir, 'package.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      out.set(manifest.name, manifest);
    }
  }
  return out;
}

const all = manifests();
const deps = (name: string) => Object.keys({ ...all.get(name)?.dependencies });

/**
 * Allowed dependency graph (ADR-002/003/004). Anything not listed is a
 * boundary violation that needs an ADR, not a quiet package.json edit.
 */
const ALLOWED: Record<string, string[]> = {
  '@r4/contracts': ['zod'],
  '@r4/observability': ['@r4/contracts', 'pino'],
  '@r4/model-gateway': ['@r4/contracts', '@r4/observability', 'zod'],
  '@r4/capability-runtime': ['@r4/contracts', '@r4/observability', 'zod'],
  '@r4/task-runtime': ['@r4/contracts', '@r4/observability', 'zod'],
  '@r4/agent-registry': ['@r4/contracts', '@r4/observability', 'zod'],
  '@r4/persistence-postgres': ['@r4/contracts', '@r4/observability', '@r4/task-runtime', '@r4/agent-registry', '@r4/capability-runtime', 'pg'],
  '@r4/api': ['@r4/contracts', '@r4/observability', '@r4/task-runtime', '@r4/agent-registry', '@r4/persistence-postgres', 'fastify', 'pino', 'zod'],
  // R4-C1 (ADR-009): the kernel sees models only through the gateway interface
  // and state/capabilities only through its KernelSession port.
  '@r4/agent-kernel': ['@r4/contracts', '@r4/observability', '@r4/model-gateway', 'zod'],
  // The worker is a composition root, like the API — but has no HTTP transport.
  '@r4/worker': [
    '@r4/contracts', '@r4/observability', '@r4/model-gateway', '@r4/capability-runtime', '@r4/task-runtime',
    '@r4/agent-registry', '@r4/persistence-postgres', '@r4/agent-kernel', 'pino', 'zod',
  ],
};

describe('dependency boundaries', () => {
  it('declares an allow-list for every workspace package', () => {
    expect([...all.keys()].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))('%s depends only on its allowed set', (name, allowed) => {
    expect(deps(name).filter((d) => !allowed.includes(d))).toEqual([]);
  });

  it('has an acyclic internal dependency graph', () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, path: string[]) => {
      if (done.has(name)) return;
      if (visiting.has(name)) throw new Error(`cycle: ${[...path, name].join(' -> ')}`);
      visiting.add(name);
      for (const d of deps(name).filter((d) => all.has(d))) visit(d, [...path, name]);
      visiting.delete(name);
      done.add(name);
    };
    for (const name of all.keys()) expect(() => visit(name, [])).not.toThrow();
  });

  it('keeps the model gateway away from state and capability execution', () => {
    expect(deps('@r4/model-gateway')).not.toContain('@r4/persistence-postgres');
    expect(deps('@r4/model-gateway')).not.toContain('@r4/task-runtime');
    expect(deps('@r4/model-gateway')).not.toContain('@r4/capability-runtime');
  });

  it('keeps the agent kernel away from storage, execution runtimes and transports', () => {
    for (const forbidden of ['pg', '@r4/persistence-postgres', '@r4/task-runtime', '@r4/capability-runtime', '@r4/agent-registry', '@r4/api', '@r4/worker', 'fastify']) {
      expect(deps('@r4/agent-kernel')).not.toContain(forbidden);
    }
  });

  it('keeps the worker independent of the API process and of HTTP', () => {
    expect(deps('@r4/worker')).not.toContain('@r4/api');
    expect(deps('@r4/worker')).not.toContain('fastify');
    expect(deps('@r4/api')).not.toContain('@r4/worker');
  });

  it('keeps runtime logic persistence-agnostic (ports, not drivers)', () => {
    for (const name of ['@r4/task-runtime', '@r4/capability-runtime', '@r4/agent-registry', '@r4/model-gateway', '@r4/agent-kernel']) {
      expect(deps(name)).not.toContain('pg');
      expect(deps(name)).not.toContain('@r4/persistence-postgres');
    }
  });

  it('has no forbidden infrastructure or framework dependencies anywhere', () => {
    const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;
    const everything = [rootManifest, ...all.values()].flatMap((m) => [...Object.keys({ ...m.dependencies }), ...Object.keys({ ...m.devDependencies })]);
    const forbidden = /^(next|react|react-dom|kafkajs|ioredis|redis|langchain|@langchain\/.*|langgraph|temporal.*|@temporalio\/.*|bullmq|pgvector|@pinecone.*|chromadb|openai|@anthropic-ai\/.*|deepseek.*)$/;
    expect(everything.filter((d) => forbidden.test(d))).toEqual([]);
  });
});
