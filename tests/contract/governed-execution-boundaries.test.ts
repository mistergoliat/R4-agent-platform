import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_DECISION_TYPES, agentDecisionSchema, trustedActionContextSchema } from '@r4/contracts';
import { AGENT_DECISION_JSON_SCHEMA } from '@r4/agent-kernel';
import { ActionExecutor, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';

/**
 * R4-D architecture audit (§50, §59, §60): who may reach a write handler, who
 * may authorize, and what the model can never set. Static checks over the
 * sources plus behavioral checks of the boundaries.
 */
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

const runtime = [...sources(join(ROOT, 'packages')), ...sources(join(ROOT, 'apps'))];
const rel = (file: string) => relative(ROOT, file).split('\\').join('/');
const text = (file: string) => readFileSync(file, 'utf8');
const filesMatching = (pattern: RegExp) => runtime.filter((file) => pattern.test(text(file))).map(rel).sort();

describe('write handlers are reachable only through the ActionExecutor', () => {
  it('the only call sites of write execute/reconcile handlers are in the ActionExecutor', () => {
    // `write.execute` / `write.reconcile` are the registered handlers (registry.ts stores them, never calls them).
    expect(filesMatching(/\bwrite\.(execute|reconcile)\b|\b(execute|reconcile)\(args\.data|\breconcile\(this\.#context/)).toEqual(['packages/capability-runtime/src/action-executor.ts']);
  });

  it('the Agent Kernel has no write handler, executor, registry, policy or ledger access', () => {
    const kernel = sources(join(ROOT, 'packages/agent-kernel/src')).map(text).join('\n');
    expect(kernel).not.toMatch(/ActionExecutor|registerWrite|WriteCapabilityRegistration|ActionRuntime|ActionPolicyEngine|ActionAuthorizer|executionKey|insertActionReceipt|\.execute\(/);
  });

  it('only the ActionRuntime evaluates policy, and only it creates commands, attempts and receipts', () => {
    expect(filesMatching(/\.evaluate\(\{/)).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    const writers = (method: string) => filesMatching(new RegExp(`uow\\.${method}\\(`));
    expect(writers('insertPolicyDecision')).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    expect(writers('insertActionExecution')).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    expect(writers('insertActionAttempt')).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    expect(writers('insertActionReceipt')).toEqual(['packages/task-runtime/src/action-runtime.ts']);
    expect(writers('insertActionProposal')).toEqual(['packages/task-runtime/src/execution-runtime.ts']);
  });

  it('the execution key is generated in exactly one place, from the durable command id', () => {
    expect(filesMatching(/`r4x_\$\{/)).toEqual(['packages/task-runtime/src/action-runtime.ts']);
  });

  it('the ActionExecutor cannot execute a READ capability', () => {
    const registry = new CapabilityRegistry();
    let called = 0;
    registry.register({
      definition: {
        capabilityId: 'platform_test.read_only',
        version: 1,
        description: 'read',
        owner: 'platform-test',
        riskClass: 'READ',
        requiredScopes: ['platform_test.read'],
        identityRequirement: 'none',
        confirmationPolicy: 'none',
        approvalPolicy: 'none',
        idempotency: 'inherent',
        retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
        timeoutMs: 1_000,
        freshnessTtlMs: null,
        auditLevel: 'standard',
      },
      input: z.object({}),
      output: z.object({}),
      handler: () => {
        called += 1;
        return Promise.resolve({});
      },
    });
    const executor = new ActionExecutor({ registry, logger: createSilentLogger() });
    expect(executor.prepare({ capabilityId: 'platform_test.read_only', arguments: {} })).toMatchObject({ ok: false, cause: 'not_a_write' });
    expect(called).toBe(0);
  });
});

describe('the model cannot generate trusted fields', () => {
  const TRUSTED = ['idempotencyKey', 'executionKey', 'policyDecision', 'policyDecisionId', 'decision', 'riskClass', 'permission', 'permissions', 'receipt', 'receiptId', 'status', 'executionStatus', 'identity', 'identityAssurance', 'actor', 'tenant', 'grantedScopes', 'scopes', 'lease', 'leaseToken', 'approved'];

  it('no trusted field exists anywhere in the decision JSON schema the model receives', () => {
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
    for (const field of TRUSTED) expect(names.has(field), field).toBe(false);
  });

  it('every decision type rejects every trusted field (strict objects, never stripped)', () => {
    const bases: Record<(typeof AGENT_DECISION_TYPES)[number], Record<string, unknown>> = {
      read_capability: { type: 'read_capability', capabilityId: 'x.y', arguments: {} },
      respond: { type: 'respond', content: 'x' },
      complete: { type: 'complete', result: { summary: 's', evidence: [] } },
      propose_action: { type: 'propose_action', capabilityId: 'x.y', arguments: {} },
    };
    for (const type of AGENT_DECISION_TYPES) {
      expect(agentDecisionSchema.safeParse(bases[type]).success, type).toBe(true);
      for (const field of TRUSTED) expect(agentDecisionSchema.safeParse({ ...bases[type], [field]: 'x' }).success, `${type}.${field}`).toBe(false);
    }
  });

  it('the trusted action context is built from durable records in the runtime, never from a proposal', () => {
    const actionRuntime = text(join(ROOT, 'packages/task-runtime/src/action-runtime.ts'));
    const built = /trustedActionContextSchema, \{([\s\S]*?)\}\);/.exec(actionRuntime)![1]!;
    expect(built).not.toMatch(/proposal|arguments|decision/);
    expect(built).toMatch(/task\.requestedBy/);
    expect(Object.keys(trustedActionContextSchema.shape).sort()).toEqual(['actor', 'agentId', 'agentVersion', 'correlationId', 'grantedScopes', 'identityAssurance', 'runId', 'taskId']);
  });
});

describe('the execution ledger is the authority — no textual success detection', () => {
  it('no runtime code decides success by inspecting text (no claim detectors, no success regexes)', () => {
    const detectors = /unbacked|mutation.?claim|success.?claim|claims?.?detector|textual.?success|regex.?confirm/i;
    expect(filesMatching(detectors)).toEqual([]);
    // The kernel never matches words in model content.
    const kernel = sources(join(ROOT, 'packages/agent-kernel/src')).map(text).join('\n');
    expect(kernel).not.toMatch(/content\.(match|includes|search)\(|\/(done|success|updated|applied)\//i);
  });

  it('no blind retry: attempts are chosen only by the durable attempt-log rule', () => {
    const session = text(join(ROOT, 'apps/worker/src/session.ts'));
    // The worker asks the runtime what may happen next; it never loops on executor calls by itself.
    expect(session.match(/this\.#executor\.attempt\(/g)).toHaveLength(1);
    expect(session).toMatch(/actions\.advanceAction\(/);
    expect(filesMatching(/nextActionStep\(/)).toEqual(['packages/task-runtime/src/action-lifecycle.ts', 'packages/task-runtime/src/action-runtime.ts']);
  });
});
