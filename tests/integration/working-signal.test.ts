import { afterEach, describe, expect, it } from 'vitest';
import { LiveOpsTestbed, say } from '../support/live-ops.js';

/**
 * Working signal (read receipt + typing indicator) through the real gateway and the local WhatsApp fake: only for
 * AUTONOMOUS work, never a message send, never a change to ingestion or delivery; off unless explicitly on.
 */
const CUSTOMER = '56944445555';
const OUTSIDER = '56944446666';
const ON = { R4_GATEWAY_WORKING_SIGNAL: 'on' };
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

describe('gateway working signal', () => {
  it('WS1: an autonomous inbound gets one read + typing signal for its own message; the reply is one normal send and ends the signal', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, env: ON }));
    await b.customer(CUSTOMER, 'wamid.ws.1', 'Hola');
    await expect.poll(() => b.provider.signals.length).toBe(1);
    expect(b.provider.signals).toEqual([{ messageId: 'wamid.ws.1', typing: true, authorized: true }]);
    expect(b.provider.sends).toEqual([]);
    expect(b.gateway.workingSignals?.pending).toBe(1);
    b.next(say('Hola, ¿qué buscas?'));
    await b.runAgent();
    await b.deliver();
    expect(b.provider.sends.map((s) => s.text)).toEqual(['Hola, ¿qué buscas?']);
    await b.gateway.workingSignals!.tick();
    expect(b.gateway.workingSignals?.pending).toBe(0);
    expect(b.provider.signals).toHaveLength(1);
  });

  it('WS2: no signal for a conversation that will not be answered by the agent (outside the cohort, or the kill switch engaged)', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: false, env: ON }));
    await b.customer(CUSTOMER, 'wamid.ws.2', 'Hola');
    await b.customer(OUTSIDER, 'wamid.ws.3', 'Hola');
    await new Promise((r) => setTimeout(r, 200));
    expect(b.provider.signals).toEqual([]);
    expect(b.gateway.workingSignals?.pending).toBe(0);
    expect(await b.rows('select count(*)::int as n from inbound_events where status = $1', ['ingested'])).toEqual([{ n: 2 }]);
  });

  it('WS3: off by default — no signal at all, exactly the previous behaviour', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true }));
    await b.customer(CUSTOMER, 'wamid.ws.4', 'Hola');
    await new Promise((r) => setTimeout(r, 200));
    expect(b.gateway.workingSignals).toBeNull();
    expect(b.provider.signals).toEqual([]);
  });

  it('WS4: the turn ends waiting for a human without replying (a consultation): the signal stops, it does not keep "typing" for minutes', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, env: ON }));
    await b.customer(CUSTOMER, 'wamid.ws.5', 'Hola hola');
    await expect.poll(() => b.provider.signals.length).toBe(1);
    b.next({ type: 'structured', data: { type: 'request_consultation', question: '¿Cuál es la política de envío gratis?', contextRefs: [] } });
    await b.runAgent();
    expect(await b.rows('select status from agent_tasks')).toEqual([{ status: 'waiting' }]);
    await b.gateway.workingSignals!.tick();
    expect(b.gateway.workingSignals?.pending).toBe(0);
    expect(b.provider.signals).toHaveLength(1);
    expect(b.provider.sends).toEqual([]);
  });
});
