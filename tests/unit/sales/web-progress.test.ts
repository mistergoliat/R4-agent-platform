import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityHandlerContext, CapabilityRegistration } from '@r4/capability-runtime';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS } from '@r4-sales/agent';
import { webProgressReporter, withWebProgress, type WebProgressReporter } from '@r4-sales/agent/production';

/**
 * ADR-046: while a web agent reads, the store chat can say what it is doing. The report is best effort: it never
 * delays, changes or fails the read, and its detail is display text (the catalog's name, the commune, the search words).
 */
const TASK = '01a1c8a6-4ec5-7f8b-952e-e7261fa0ce15';
const context = { execution: { taskId: TASK }, invocationId: 'inv-1', signal: new AbortController().signal } as unknown as CapabilityHandlerContext;
type Input = Record<string, unknown>;
const read = (capabilityId: string, answer: () => Promise<unknown>): CapabilityRegistration<Input, unknown> => ({
  definition: { capabilityId } as unknown as CapabilityRegistration<Input, unknown>['definition'],
  input: z.record(z.string(), z.unknown()),
  output: z.unknown(),
  handler: () => answer(),
});
const recorder = () => {
  const calls: Array<{ taskId: string; step: string; detail: string | null }> = [];
  const reporter: WebProgressReporter = { report: (taskId, step, detail) => { calls.push({ taskId, step, detail }); } };
  return { calls, reporter };
};

describe('web progress: the store chat says what the agent is reading', () => {
  it('reports the search words before a search and the catalog name after a product read', async () => {
    const { calls, reporter } = recorder();
    await withWebProgress(read(CAPABILITY_IDS.catalogSearch, () => Promise.resolve({ results: [] })), reporter).handler({ query: 'trotadora' }, context);
    const product = { facts: { name: 'Trotadora Plegable T-200' } };
    expect(await withWebProgress(read(CAPABILITY_IDS.productContext, () => Promise.resolve(product)), reporter).handler({ productKey: 'P1974' }, context)).toBe(product);
    await withWebProgress(read(LANE_CAPABILITY_IDS.catalogDiscover, () => Promise.resolve({})), reporter).handler({ need: 'algo para piernas' }, context);
    await withWebProgress(read(CAPABILITY_IDS.shippingQuote, () => Promise.resolve({})), reporter).handler({ destination: { commune: 'Ñuñoa' } }, context);
    expect(calls).toEqual([
      { taskId: TASK, step: 'search', detail: 'trotadora' },
      { taskId: TASK, step: 'product', detail: 'Trotadora Plegable T-200' },
      { taskId: TASK, step: 'discover', detail: null },
      { taskId: TASK, step: 'shipping', detail: 'Ñuñoa' },
    ]);
  });

  it('never changes or fails the read, and leaves any other capability untouched', async () => {
    const throwing: WebProgressReporter = { report: () => { throw new Error('edge down'); } };
    const product = { facts: { name: 'Banco' } };
    expect(await withWebProgress(read(CAPABILITY_IDS.productContext, () => Promise.resolve(product)), throwing).handler({}, context)).toBe(product);
    const other = read('sales.workspace.update', () => Promise.resolve({}));
    expect(withWebProgress(other, throwing)).toBe(other);
    const failing = read(CAPABILITY_IDS.catalogSearch, () => Promise.reject(new Error('catalog 503')));
    await expect(withWebProgress(failing, recorder().reporter).handler({ query: 'x' }, context)).rejects.toThrow('catalog 503');
  });

  it("sends the report for the task's latest web message and swallows every failure", async () => {
    const sent: unknown[] = [];
    const pool = { query: (_sql: string, params: unknown[]) => Promise.resolve({ rows: params[0] === TASK ? [{ provider_event_id: 'evt-9' }] : [] }) };
    const adapter = { reportProgress: (signal: unknown) => { sent.push(signal); return Promise.resolve(true); } };
    const broken = { query: () => Promise.reject(new Error('db down')) };
    webProgressReporter(pool as never, adapter, 'shop-qa').report(TASK, 'product', 'Banco');
    webProgressReporter(pool as never, adapter, 'shop-qa').report('other-task', 'search', 'x');
    webProgressReporter(broken as never, adapter, 'shop-qa').report(TASK, 'search', 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([{ accountRef: 'shop-qa', providerEventId: 'evt-9', step: 'product', detail: 'Banco' }]);
  });
});
