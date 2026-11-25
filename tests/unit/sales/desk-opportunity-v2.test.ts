import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@r4/capability-runtime';
import {
  DESK_OPPORTUNITY_CAPABILITY_ID,
  deskContactRef,
  deskOpportunityCapability,
  deskOpportunityKey,
  deskOpportunityV2Capability,
  deskSignalsOf,
  type DeskOpportunityInputV2,
  type TaskObservationReader,
} from '@r4-sales/agent';

/** (ADR-062, owner 2026-11-25) desk.opportunity.record@2: no-intent classification; signals and contactRef by the platform. */
const TASK = '0190a0a0-0000-7000-8000-00000000d101';
const KEY = 'k'.repeat(40);
const PHONE = '56911112222';
const INPUT: DeskOpportunityInputV2 = { trigger: 'conversacion', intent: 'compra', segment: 'persona', complexity: 'estandar', productRefs: ['P823'], summary: 'Quiere mancuernas para su casa.' };
const JOKE: DeskOpportunityInputV2 = { trigger: 'conversacion', intent: 'sin_intencion', noIntentReason: 'broma', segment: 'desconocido', complexity: 'estandar', productRefs: [], summary: 'Pidió un cuento sobre una taza; sin intención de compra.' };

type Obs = Awaited<ReturnType<TaskObservationReader['listByTask']>>[number];
const read = (capabilityId: string, payload: unknown = {}, outcome: Obs['outcome'] = 'succeeded'): Obs => ({ source: { kind: 'capability', capabilityId, capabilityVersion: 1, invocationId: '0190a0a0-0000-7000-8000-0000000000aa' }, outcome, payload: payload as never });
const applied = (capabilityId: string, result: unknown = {}, outcome: Obs['outcome'] = 'succeeded'): Obs => ({ source: { kind: 'action', capabilityId, capabilityVersion: 2, proposalId: '0190a0a0-0000-7000-8000-0000000000bb', policyDecisionId: null, executionId: null, receiptId: outcome === 'succeeded' ? '0190a0a0-0000-7000-8000-0000000000cc' : null }, outcome, payload: outcome === 'succeeded' ? ({ result } as never) : null });

function setup(options: { observations?: Obs[]; channel?: string | null; recipientRef?: string } = {}) {
  const calls: RequestInit[] = [];
  const deps = {
    desk: { url: 'http://127.0.0.1:3201/api/r4/opportunities', key: KEY },
    store: { conversationQuotes: () => Promise.resolve([]) },
    quotes: null,
    bindings: { bindingByTask: () => Promise.resolve(options.channel === null ? null : { channel: options.channel ?? 'whatsapp', recipientRef: options.recipientRef ?? PHONE }) },
    profileChannel: 'whatsapp',
    channels: ['whatsapp', 'web', 'instagram', 'facebook'],
    fetch: (_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response(JSON.stringify({ opportunityId: 'opp_1', created: true }), { status: 200 }));
    },
  };
  const capability = deskOpportunityV2Capability({ ...deps, observations: { listByTask: () => Promise.resolve(options.observations ?? []) } });
  const run = (input: unknown) => capability.execute(capability.input.parse(input), { executionKey: 'x1', attempt: 1, signal: new AbortController().signal, execution: { taskId: TASK, correlationId: 'c1', agentId: 'sales', agentVersion: 28 } as never });
  const sent = (i = 0) => JSON.parse(calls[i]!.body as string) as Record<string, unknown>;
  return { capability, run, calls, sent, v1: deskOpportunityCapability(deps) };
}

describe('desk.opportunity.record@2: input', () => {
  it('registers as version 2 of the same capability, next to @1', () => {
    const { capability, v1 } = setup();
    expect(capability.definition).toMatchObject({ capabilityId: DESK_OPPORTUNITY_CAPABILITY_ID, version: 2, riskClass: 'REVERSIBLE_WRITE', idempotency: 'key_required' });
    expect(v1.definition.version).toBe(1);
    const registry = new CapabilityRegistry();
    registry.registerWrite(v1);
    registry.registerWrite(capability);
    expect(registry.list().map((c) => `${c.capabilityId}@${c.version}`).sort()).toEqual(['desk.opportunity.record@1', 'desk.opportunity.record@2']);
    expect(v1.input.safeParse(JOKE).success).toBe(false);
  });

  it('accepts sin_intencion with a closed reason; refuses unknown reasons and any platform-filled field', () => {
    const { capability } = setup();
    expect(capability.input.safeParse(JOKE).success).toBe(true);
    expect(capability.input.safeParse({ ...INPUT, noIntentReason: null }).success).toBe(true);
    expect(capability.input.safeParse({ ...JOKE, noIntentReason: 'aburrido' }).success).toBe(false);
    for (const extra of [{ signals: ['cotizacion'] }, { contactRef: 'x' }, { version: 2 }, { channel: 'web' }, { taskId: TASK }, { quote: null }]) {
      expect(capability.input.safeParse({ ...INPUT, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });

  it('the reason is required with sin_intencion and refused without it, before sending anything', async () => {
    const { run, calls } = setup();
    expect(await run({ ...JOKE, noIntentReason: undefined })).toMatchObject({ status: 'rejected', code: 'no_intent_reason_required' });
    expect(await run({ ...INPUT, noIntentReason: 'broma' })).toMatchObject({ status: 'rejected', code: 'no_intent_reason_not_allowed' });
    expect(calls).toHaveLength(0);
  });
});

describe('desk.opportunity.record@2: body', () => {
  it('adds version, noIntentReason, the platform signals and the contactRef; everything else as @1', async () => {
    const observations = [read('catalog.get_product_context'), applied('sales.workspace.update', { selection: [{ productId: 'P823', quantity: 2 }] })];
    const { run, sent } = setup({ observations });
    expect(await run(INPUT)).toMatchObject({ status: 'applied', result: { recorded: true } });
    expect(sent()).toEqual({
      version: 2,
      idempotencyKey: deskOpportunityKey(TASK, INPUT, null),
      taskId: TASK,
      channel: 'whatsapp',
      trigger: 'conversacion',
      classification: { intent: 'compra', segment: 'persona', complexity: 'estandar', productRefs: ['P823'], summary: INPUT.summary, noIntentReason: null },
      quote: null,
      signals: ['propuesta', 'producto'],
      contactRef: deskContactRef(KEY, 'whatsapp', PHONE),
      agent: { agentId: 'sales', agentVersion: 28 },
    });
  });

  it('a joke is sent as sin_intencion with its reason and the signals the platform saw (none: the model cannot add any)', async () => {
    const { run, sent } = setup();
    await run(JOKE);
    expect(sent()).toMatchObject({ classification: { intent: 'sin_intencion', noIntentReason: 'broma' }, signals: [] });
  });

  it('the raw recipient never leaves R4; no binding means contactRef null and the profile channel', async () => {
    const a = setup();
    await a.run(INPUT);
    expect(a.calls[0]!.body as string).not.toContain(PHONE);
    const b = setup({ channel: null });
    await b.run(INPUT);
    expect(b.sent()).toMatchObject({ contactRef: null, channel: 'whatsapp' });
  });

  it('the @1 body is unchanged: no version, signals, contactRef or noIntentReason', async () => {
    const { v1, calls } = setup();
    await v1.execute(v1.input.parse(INPUT), { executionKey: 'x1', attempt: 1, signal: new AbortController().signal, execution: { taskId: TASK, correlationId: 'c1', agentId: 'sales', agentVersion: 27 } as never });
    const body = JSON.parse(calls[0]!.body as string) as Record<string, Record<string, unknown>>;
    expect(Object.keys(body).sort()).toEqual(['agent', 'channel', 'classification', 'idempotencyKey', 'quote', 'taskId', 'trigger']);
    expect(Object.keys(body.classification!).sort()).toEqual(['complexity', 'intent', 'productRefs', 'segment', 'summary']);
  });

  it('the key adds the reason only for sin_intencion records (a @1 input keeps its @1 key)', () => {
    const { noIntentReason: _, ...plain } = { ...INPUT, noIntentReason: null };
    expect(deskOpportunityKey(TASK, { ...INPUT, noIntentReason: null }, null)).toBe(deskOpportunityKey(TASK, plain, null));
    expect(deskOpportunityKey(TASK, JOKE, null)).not.toBe(deskOpportunityKey(TASK, { ...JOKE, noIntentReason: 'spam' }, null));
  });
});

describe('contactRef', () => {
  it('is base64url(HMAC-SHA256(key, "contact|<channel>|<recipientRef>")) in 43 characters, stable per contact and channel', () => {
    const ref = deskContactRef(KEY, 'whatsapp', PHONE);
    expect(ref).toBe(createHmac('sha256', KEY).update(`contact|whatsapp|${PHONE}`).digest('base64url').slice(0, 43));
    expect(ref).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deskContactRef(KEY, 'whatsapp', PHONE)).toBe(ref);
    expect(deskContactRef(KEY, 'instagram', PHONE)).not.toBe(ref);
    expect(deskContactRef(KEY, 'whatsapp', '56933334444')).not.toBe(ref);
    expect(deskContactRef('z'.repeat(40), 'whatsapp', PHONE)).not.toBe(ref);
    expect(ref).not.toContain(PHONE);
  });
});

describe('deskSignalsOf: only what this conversation recorded', () => {
  it('maps each succeeded observation to its signal, in the closed order', () => {
    const all = [
      read('quote.preview'),
      applied('sales.workspace.update', { selection: [{ productId: 'P1', quantity: 1 }] }),
      read('shipping.quote', { destination: { communeId: '13101', communeName: 'Santiago', regionName: 'RM' } }),
      read('catalog.get_product_context'),
    ];
    expect(deskSignalsOf(all, 'traspaso')).toEqual(['cotizacion', 'propuesta', 'despacho', 'producto', 'traspaso']);
    expect(deskSignalsOf([applied('quote.create')], 'cotizacion')).toEqual(['cotizacion']);
  });

  it('(owner 2026-11-25) a web home-gym build step with options or chosen products is a propuesta; an empty step is not', () => {
    const step = (payload: unknown) => read('catalog.build_step', payload);
    expect(deskSignalsOf([step({ options: [{ productKey: 'P1' }], selectedTotalClp: 0 })], 'conversacion')).toEqual(['propuesta']);
    expect(deskSignalsOf([step({ options: [], selectedTotalClp: 189_990 })], 'conversacion')).toEqual(['propuesta']);
    expect(deskSignalsOf([step({ options: [], selectedTotalClp: 0 })], 'conversacion')).toEqual([]);
    expect(deskSignalsOf([read('catalog.build_step', { options: [{ productKey: 'P1' }] }, 'failed')], 'conversacion')).toEqual([]);
  });

  it('nothing for failed or rejected observations, an empty selection, a read posing as a write, or other capabilities', () => {
    const none = [
      read('quote.preview', {}, 'failed'),
      applied('quote.create', {}, 'rejected'),
      applied('sales.workspace.update', { selection: [] }),
      read('sales.workspace.update', { result: { selection: [{ productId: 'P1', quantity: 1 }] } }),
      read('shipping.quote', { destination: { communeId: '' } }),
      read('catalog.search'),
      read('catalog.discover'),
      read('desk.opportunity.record'),
    ];
    expect(deskSignalsOf(none, 'conversacion')).toEqual([]);
    expect(deskSignalsOf([], 'consulta')).toEqual([]);
  });
});
