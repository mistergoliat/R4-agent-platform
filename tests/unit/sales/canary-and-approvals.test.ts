import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint, type HumanRequest } from '@r4/contracts';
import { canonicalInboundSchema } from '@r4/live-ops';
import { APPROVAL_DECISION_BLOCKER, ApprovalInspection, parseControlCommand, runProductionControl } from '@r4-sales/agent/production';
import { CaptureOutboundAdapter, SYNTHETIC_CHANNEL, syntheticInbound } from '@r4-sales/agent/canary';
import { parseCanaryCommand, runCanary } from '../../../agents/sales/src/cli/canary/command.js';

const T = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ARGS = { workspaceVersion: 2, customer: { kind: 'guest' }, lines: [{ itemKey: 'BAR-OLY20', quantity: 1 }] };

function approval(n: number, overrides: Partial<{ status: HumanRequest['status']; argumentsHash: string; createdAt: string }> = {}): HumanRequest {
  return {
    requestId: T(n), taskId: T(100 + n), runId: T(200 + n), kind: 'approval', status: overrides.status ?? 'requested', humanRef: null,
    createdAt: overrides.createdAt ?? `2026-10-09T10:00:0${n}.000Z`, updatedAt: '2026-10-09T10:00:00.000Z', expiresAt: null, correlationId: 'c',
    payload: { proposalId: T(300 + n), policyDecisionId: T(400 + n), capabilityId: 'quote.create', capabilityVersion: 2, argumentsHash: overrides.argumentsHash ?? fingerprint(ARGS), validatedArguments: ARGS },
  };
}

function inspection(requests: readonly HumanRequest[]) {
  return new ApprovalInspection({
    temporal: { attention: () => Promise.resolve({ requests }) },
    store: {
      bindingByTask: (taskId) => Promise.resolve(taskId === T(101) ? ({ channel: 'r4-synthetic', bindingId: T(9), profile: 'sales-production@4' } as never) : null),
      taskState: () => Promise.resolve({ status: 'blocked', terminalIntent: false, humanOwned: false }),
    },
  });
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe('approval inspection (read-only)', () => {
  it('lists only open approvals, oldest first, with the exact arguments and a recomputed hash check', async () => {
    const handoff = { ...approval(5), kind: 'handoff', payload: { summary: 's', contextRefs: [], initiatedBy: 'agent' } } as HumanRequest;
    const list = await inspection([approval(2), approval(1), approval(3, { status: 'approved' }), handoff, approval(4, { argumentsHash: 'tampered' })]).list();
    expect(list.map((a) => a.requestId)).toEqual([T(1), T(2), T(4)]);
    expect(list[0]).toMatchObject({ task: { taskId: T(101), status: 'blocked' }, conversation: { channel: 'r4-synthetic' }, action: { capabilityId: 'quote.create', capabilityVersion: 2 }, arguments: { hashVerified: true, validated: ARGS } });
    expect(list[2]!.arguments.hashVerified).toBe(false);
  });

  it('show refuses an invalid id, an unknown id and a decided request', async () => {
    const i = inspection([approval(1), approval(3, { status: 'rejected' })]);
    await expect(i.show('nope')).rejects.toMatchObject({ code: 'invalid_request_id' });
    await expect(i.show(T(9))).rejects.toMatchObject({ code: 'approval_not_open' });
    await expect(i.show(T(3))).rejects.toMatchObject({ code: 'approval_not_open' });
    expect((await i.show(T(1))).requestId).toBe(T(1));
  });
});

describe('production:sales:control approvals', () => {
  it('parses list/show strictly and approve/reject only with a request and a reason', () => {
    expect(parseControlCommand(['approvals', 'list'])).toEqual({ kind: 'approvals-list' });
    expect(parseControlCommand(['approvals', 'show', '--request', T(1)])).toEqual({ kind: 'approvals-show', requestId: T(1) });
    expect(parseControlCommand(['approvals', 'approve', '--request', T(1), '--reason', 'ok'])).toEqual({ kind: 'approvals-decide', decision: 'approve', requestId: T(1) });
    expect(() => parseControlCommand(['approvals', 'approve', '--request', T(1)])).toThrow(/--reason is required/);
    expect(() => parseControlCommand(['approvals', 'reject', '--request', T(1), '--reason', ' '])).toThrow(/--reason/);
    expect(() => parseControlCommand(['approvals', 'list', '--all'])).toThrow(/unknown command/);
    expect(() => parseControlCommand(['approvals', 'approve', '--request', T(1), '--reason', 'ok', '--as', 'felipe'])).toThrow(/unexpected argument: --as/);
  });

  it('approve and reject are refused before any configuration or database is read (no identity can be declared)', async () => {
    for (const verb of ['approve', 'reject']) {
      const c = io();
      expect(await runProductionControl(['approvals', verb, '--request', T(1), '--reason', 'ok'], {}, c.io)).toBe(1);
      expect(c.err).toEqual([`error: trusted_human_required: ${APPROVAL_DECISION_BLOCKER}`]);
      expect(c.out).toEqual([]);
    }
  });

  it('list and show still require the production declaration and the injected inspection', async () => {
    const c = io();
    expect(await runProductionControl(['approvals', 'list'], {}, c.io)).toBe(1);
    expect(c.err.join('')).toMatch(/production_mode_not_declared/);
    const d = io();
    const env = { R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@3', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'k'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false', R4_DATABASE_URL: 'postgres://u:secret@127.0.0.1:1/x' };
    expect(await runProductionControl(['approvals', 'list'], env, d.io)).toBe(1);
    expect(d.err.join('')).toMatch(/approvals_unavailable/);
    expect(d.err.join('')).not.toMatch(/secret/);
  });
});

describe('sales:canary command', () => {
  it('parses exactly the documented commands', () => {
    expect(parseCanaryCommand(['init'])).toEqual({ kind: 'init' });
    expect(parseCanaryCommand(['run'])).toEqual({ kind: 'run' });
    expect(parseCanaryCommand(['send', '--conversation', 'c1', '--text', 'hola'])).toEqual({ kind: 'send', conversation: 'c1', text: 'hola' });
    expect(parseCanaryCommand(['identity-key', '--conversation', 'c1'])).toEqual({ kind: 'identity-key', conversation: 'c1' });
    expect(parseCanaryCommand(['approvals', 'show', '--request', T(1)])).toEqual({ kind: 'approvals-show', requestId: T(1) });
    expect(() => parseCanaryCommand(['send', '--conversation', 'c1', '--text', '  '])).toThrow(/--text/);
    expect(() => parseCanaryCommand(['init', 'now'])).toThrow(/unknown command/);
    expect(() => parseCanaryCommand([])).toThrow(/unknown command/);
  });

  it('a decision needs the reviewed argument hash and the canary environment (then an OIDC operator sign-in)', async () => {
    const c = io();
    expect(await runCanary(['approvals', 'approve', '--request', T(1), '--reason', 'ok'], {}, c.io)).toBe(2);
    expect(c.err.join('')).toMatch(/--arguments-hash is required/);
    const b = io();
    expect(await runCanary(['approvals', 'approve', '--request', T(1), '--arguments-hash', 'h', '--reason', 'ok'], {}, b.io)).toBe(1);
    expect(b.err.join('')).toMatch(/production_mode_not_declared/);
    const d = io();
    expect(await runCanary(['status'], {}, d.io)).toBe(1);
    expect(d.err.join('')).toMatch(/production_mode_not_declared/);
    const e = io();
    expect(await runCanary(['bogus'], {}, e.io)).toBe(2);
  });
});

describe('synthetic channel', () => {
  it('a synthetic inbound is canonical, on the synthetic channel, and says it is synthetic', () => {
    const inbound = syntheticInbound({ conversation: 'c1', text: 'Hola', canaryId: 'abc', eventId: 'e1', occurredAt: '2026-10-09T10:00:00.000Z' });
    expect(canonicalInboundSchema.parse(inbound)).toEqual({
      channel: SYNTHETIC_CHANNEL, accountRef: 'sales-canary', conversationRef: 'synthetic:c1', senderRef: 'synthetic:c1', providerEventId: 'synthetic:e1',
      occurredAt: '2026-10-09T10:00:00.000Z', content: { kind: 'text', text: 'Hola' }, metadata: { synthetic: true, canaryId: 'abc' },
    });
    expect(() => syntheticInbound({ conversation: 'Bad Name', text: 'x', canaryId: 'abc' })).toThrow(/--conversation/);
  });

  it('the capture adapter is a local fake that records each submission and never claims to be a real provider', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'r4-capture-')), 'nested', 'outbound.jsonl');
    const adapter = new CaptureOutboundAdapter(file);
    expect(adapter.bindingKind).toBe('local-fake');
    expect(adapter.channel).toBe(SYNTHETIC_CHANNEL);
    const result = await adapter.submit({ outboundId: T(1), idempotencyKey: 'k1', accountRef: 'sales-canary', recipientRef: 'synthetic:c1', text: 'Hola', attempt: 1 });
    expect(result).toMatchObject({ outcome: 'accepted', providerMessageId: `capture:${T(1)}`, httpStatus: null });
    expect(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown)).toEqual([expect.objectContaining({ outboundId: T(1), recipientRef: 'synthetic:c1', text: 'Hola', attempt: 1 })]);
  });
});
