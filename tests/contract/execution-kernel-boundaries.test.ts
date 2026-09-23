import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_DECISION_TYPES, RISK_CLASSES, systemClock, uuidV7Generator } from '@r4/contracts';
import { AGENT_DECISION_JSON_SCHEMA } from '@r4/agent-kernel';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';

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

const kernelSources = sources(join(ROOT, 'packages/agent-kernel/src'));
const runtimeSources = [...sources(join(ROOT, 'packages')), ...sources(join(ROOT, 'apps'))];

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
}

describe('Agent Kernel boundary (ADR-009)', () => {
  it('imports only contracts, the model gateway interface, observability, zod and its own modules', () => {
    const allowed = /^(@r4\/contracts|@r4\/model-gateway|@r4\/observability|zod|\.\/[a-z-]+\.js)$/;
    const violations = kernelSources.flatMap((file) => importsOf(file).filter((spec) => !allowed.test(spec)).map((spec) => `${relative(ROOT, file)}: ${spec}`));
    expect(kernelSources.length).toBeGreaterThan(4);
    expect(violations).toEqual([]);
  });

  it('uses only the provider-neutral surface of the model gateway (no concrete provider)', () => {
    const used = kernelSources.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/import[^;]*\{([^}]*)\}[^;]*from '@r4\/model-gateway'/g)].flatMap((m) => m[1]!.split(',').map((s) => s.replace(/type\s+/, '').trim()).filter(Boolean)));
    expect(used.filter((name) => /Fake|Provider/.test(name))).toEqual([]);
  });

  it('keeps persistence, SQL and transports out of the kernel', () => {
    const text = kernelSources.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(text).not.toMatch(/\b(select|insert|update)\s+[a-z_*]+\s+(from|into|set)\b/i);
    expect(text).not.toMatch(/fastify|pg\.Pool|process\.env/);
  });
});

describe('AgentDecision protocol', () => {
  it('is the C1 subset of the PRD §7 decisions plus R4-D propose_action, and nothing else', () => {
    expect([...AGENT_DECISION_TYPES]).toEqual(['read_capability', 'respond', 'complete', 'propose_action']);
  });

  it('exposes no vendor, model or trusted effect fields to the model', () => {
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        if (record.properties && typeof record.properties === 'object') Object.keys(record.properties).forEach((k) => names.add(k));
        Object.values(record).forEach(walk);
      }
    };
    walk(AGENT_DECISION_JSON_SCHEMA);
    // R4-D adds only `evidenceRefs` (observation ids the platform verifies).
    expect([...names].sort()).toEqual(['arguments', 'capabilityId', 'content', 'data', 'evidence', 'evidenceRefs', 'result', 'summary', 'type']);
  });
});

describe('READ invocation boundary (write audit)', () => {
  it('has exactly one call site for capability handlers: the invoker', () => {
    const callers = runtimeSources.filter((file) => /\.handler\(/.test(readFileSync(file, 'utf8'))).map((file) => relative(ROOT, file).split('\\').join('/'));
    expect(callers).toEqual(['packages/capability-runtime/src/invoker.ts']);
  });

  it('refuses every non-READ risk class at the invoker, even when called directly', async () => {
    for (const riskClass of RISK_CLASSES.filter((r) => r !== 'READ')) {
      let executed = 0;
      const registry = new CapabilityRegistry();
      registry.register({
        definition: {
          capabilityId: 'platform_test.effect',
          version: 1,
          description: 'synthetic effect',
          owner: 'platform-test',
          riskClass,
          requiredScopes: ['platform_test.read'],
          identityRequirement: 'none',
          confirmationPolicy: 'none',
          approvalPolicy: 'none',
          idempotency: 'key_required',
          retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
          timeoutMs: 1_000,
          freshnessTtlMs: null,
          auditLevel: 'full',
        },
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          executed += 1;
          return Promise.resolve({});
        },
      });
      const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger() });
      const ids = uuidV7Generator();
      const observation = await invoker.invoke(
        { capabilityId: 'platform_test.effect', arguments: {} },
        { taskId: ids.next(), runId: ids.next(), agentId: 'probe', agentVersion: 1, correlationId: 'c', grantedScopes: ['platform_test.read'] },
      );
      expect(observation, riskClass).toMatchObject({ outcome: 'rejected', error: { code: 'execution_not_permitted' } });
      expect(executed, riskClass).toBe(0);
    }
  });

  it('has no development bypass for writes anywhere in runtime code', () => {
    const suspicious = /\b(allow_?writes?|bypass|unsafe_?mode|skip_?policy|R4_ALLOW_[A-Z_]+|dangerously)\b/i;
    const hits = runtimeSources.filter((file) => suspicious.test(readFileSync(file, 'utf8'))).map((file) => relative(ROOT, file));
    expect(hits).toEqual([]);
  });
});
