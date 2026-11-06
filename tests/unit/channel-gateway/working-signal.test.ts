import { describe, expect, it } from 'vitest';
import { WorkingSignals, loadGatewayConfig } from '@r4/channel-gateway';
import type { OutboundChannelAdapter, OutboundRecord } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { WhatsAppOutboundAdapter, loadWhatsAppCloudConfig, type FetchLike } from '@r4-adapters/whatsapp-cloud';

/** The cosmetic working signal: read receipt + typing indicator while an autonomous turn runs (best effort). */
const INPUT = { channel: 'whatsapp', accountRef: '1098765432', providerEventId: 'wamid.in.1', taskId: 't1' };

function bed(options: { outbound?: () => Promise<Pick<OutboundRecord, 'createdAt'>[]>; adapter?: Partial<OutboundChannelAdapter> } = {}) {
  let now = 1_000_000;
  const calls: { providerEventId: string }[] = [];
  const adapter = { channel: 'whatsapp', signalWorking: (s: { providerEventId: string }) => (calls.push(s), Promise.resolve(true)), ...options.adapter } as unknown as OutboundChannelAdapter;
  const store = { outboundForTask: options.outbound ?? (() => Promise.resolve([])) } as never;
  const signals = new WorkingSignals({ adapters: [adapter], store, logger: createSilentLogger(), now: () => now });
  return { signals, calls, advance: (ms: number) => (now += ms), at: () => now };
}

describe('WorkingSignals', () => {
  it('signals at once, refreshes every 20 s while the turn has not answered, and stops after 3 min', async () => {
    const b = bed();
    b.signals.started(INPUT);
    await Promise.resolve();
    expect(b.calls).toHaveLength(1);
    b.advance(10_000);
    await b.signals.tick();
    expect(b.calls).toHaveLength(1);
    b.advance(10_000);
    await b.signals.tick();
    expect(b.calls).toHaveLength(2);
    expect(b.calls.every((c) => c.providerEventId === 'wamid.in.1')).toBe(true);
    b.advance(170_000);
    await b.signals.tick();
    expect(b.signals.pending).toBe(0);
    expect(b.calls).toHaveLength(2);
  });

  it('stops as soon as the task has an outbound created after the inbound (the turn answered)', async () => {
    let answered = false;
    const b = bed({ outbound: () => Promise.resolve(answered ? [{ createdAt: new Date(b.at()).toISOString() }] : []) });
    b.signals.started(INPUT);
    answered = true;
    b.advance(25_000);
    await b.signals.tick();
    expect(b.signals.pending).toBe(0);
    expect(b.calls).toHaveLength(1);
  });

  it('an earlier answer (before this inbound) does not stop the signal', async () => {
    const b = bed({ outbound: () => Promise.resolve([{ createdAt: new Date(b.at() - 60_000).toISOString() }]) });
    b.signals.started(INPUT);
    b.advance(21_000);
    await b.signals.tick();
    expect(b.signals.pending).toBe(1);
    expect(b.calls).toHaveLength(2);
  });

  it('never throws: a failing adapter, an adapter without the signal, an unreachable store', async () => {
    const failing = bed({ adapter: { signalWorking: () => Promise.reject(new Error('boom')) } });
    expect(() => failing.signals.started(INPUT)).not.toThrow();
    // An adapter that does not implement the optional signal: nothing is sent, nothing fails.
    const without = new WorkingSignals({ adapters: [{ channel: 'whatsapp' } as OutboundChannelAdapter], store: { outboundForTask: () => Promise.resolve([]) }, logger: createSilentLogger() });
    expect(() => without.started(INPUT)).not.toThrow();
    await expect(without.tick()).resolves.toBeUndefined();
    const unreachable = bed({ outbound: () => Promise.reject(new Error('db down')) });
    unreachable.signals.started(INPUT);
    unreachable.advance(21_000);
    await expect(unreachable.signals.tick()).resolves.toBeUndefined();
    expect(unreachable.signals.pending).toBe(1);
  });

  it('is off unless R4_GATEWAY_WORKING_SIGNAL=on', () => {
    const base = { R4_DATABASE_URL: 'postgres://x' };
    expect(loadGatewayConfig(base).workingSignal).toBe(false);
    expect(loadGatewayConfig({ ...base, R4_GATEWAY_WORKING_SIGNAL: 'off' }).workingSignal).toBe(false);
    expect(loadGatewayConfig({ ...base, R4_GATEWAY_WORKING_SIGNAL: 'on' }).workingSignal).toBe(true);
    expect(() => loadGatewayConfig({ ...base, R4_GATEWAY_WORKING_SIGNAL: 'yes' })).toThrow();
  });
});

describe('WhatsAppOutboundAdapter.signalWorking', () => {
  const config = loadWhatsAppCloudConfig({ R4_WHATSAPP_APP_SECRET: 's'.repeat(16), R4_WHATSAPP_VERIFY_TOKEN: 'v'.repeat(16), R4_WHATSAPP_ACCESS_TOKEN: 'a'.repeat(24), R4_WHATSAPP_PHONE_NUMBER_ID: '1098765432', R4_WHATSAPP_GRAPH_BASE_URL: 'http://127.0.0.1:9' }, { allowNetwork: false });
  const answering = (status: number, body: string) => {
    const requests: { url: string; body: unknown }[] = [];
    const fetch: FetchLike = (url, init) => (requests.push({ url, body: JSON.parse(init.body) }), Promise.resolve({ status, headers: { get: () => null }, text: () => Promise.resolve(body) }));
    return { adapter: new WhatsAppOutboundAdapter(config, { fetch }), requests };
  };

  it('sends the documented read + typing request for the received message and is true on {"success": true}', async () => {
    const { adapter, requests } = answering(200, '{"success": true}');
    expect(await adapter.signalWorking({ accountRef: '1098765432', providerEventId: 'wamid.in.1' }, { timeoutMs: 1000 })).toBe(true);
    expect(requests).toEqual([{ url: 'http://127.0.0.1:9/v25.0/1098765432/messages', body: { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.in.1', typing_indicator: { type: 'text' } } }]);
  });

  it('is false (never throws) on a provider error, a non-success body, another business number or a network failure', async () => {
    expect(await answering(400, '{"error":{"code":100}}').adapter.signalWorking({ accountRef: '1098765432', providerEventId: 'w' }, { timeoutMs: 1000 })).toBe(false);
    expect(await answering(200, '{}').adapter.signalWorking({ accountRef: '1098765432', providerEventId: 'w' }, { timeoutMs: 1000 })).toBe(false);
    const foreign = answering(200, '{"success": true}');
    expect(await foreign.adapter.signalWorking({ accountRef: '999', providerEventId: 'w' }, { timeoutMs: 1000 })).toBe(false);
    expect(foreign.requests).toHaveLength(0);
    const down = new WhatsAppOutboundAdapter(config, { fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    expect(await down.signalWorking({ accountRef: '1098765432', providerEventId: 'w' }, { timeoutMs: 1000 })).toBe(false);
  });
});
