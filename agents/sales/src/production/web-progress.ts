import type pg from 'pg';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import type { WebOutboundAdapter, WebProgressStep } from '@r4-adapters/web';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS } from '../ids.js';

/**
 * (ADR-046) What the web agent is doing while it works — a catalog search, Discover, the product it is checking or the
 * commune it is quoting — so the store chat can say it instead of only "working". Web profiles only.
 *
 * Best effort by construction: a report never delays, changes or fails the read it describes (it is not awaited, its
 * errors are swallowed), and it carries display text only: the catalog's own product name, the commune, or the agent's
 * search words. Nothing it sends is read back by R4.
 */
export interface WebProgressReporter {
  report(taskId: string, step: WebProgressStep, detail: string | null): void;
}

const REPORT_TIMEOUT_MS = 1_500;

/** Sends the report for the task's latest web message (the edge knows the visitor's conversation by that event). */
export function webProgressReporter(pool: Pick<pg.Pool, 'query'>, adapter: Pick<WebOutboundAdapter, 'reportProgress'>, accountRef: string): WebProgressReporter {
  return {
    report(taskId, step, detail) {
      void (async () => {
        const latest = await pool.query<{ provider_event_id: string }>(
          "select provider_event_id from inbound_events where task_id = $1 and channel = 'web' order by received_at desc limit 1",
          [taskId],
        );
        const providerEventId = latest.rows[0]?.provider_event_id;
        if (providerEventId) await adapter.reportProgress({ accountRef, providerEventId, step, detail }, { timeoutMs: REPORT_TIMEOUT_MS });
      })().catch(() => undefined);
    },
  };
}

type Json = Record<string, unknown>;
const field = (value: unknown, ...path: string[]): string | null => {
  let current: unknown = value;
  for (const key of path) current = typeof current === 'object' && current !== null ? (current as Json)[key] : undefined;
  return typeof current === 'string' && current.trim() ? current.trim() : null;
};

/** Which reads report what, and when (before the read with its input, or after it with the owner's answer). */
const REPORTS: Readonly<Record<string, { readonly step: WebProgressStep; readonly when: 'before' | 'after'; readonly detail: (input: unknown, output: unknown) => string | null }>> = {
  [CAPABILITY_IDS.catalogSearch]: { step: 'search', when: 'before', detail: (input) => field(input, 'query') },
  [LANE_CAPABILITY_IDS.catalogDiscover]: { step: 'discover', when: 'before', detail: () => null },
  // The name comes from Catalog's answer (the owner), never from the agent.
  [CAPABILITY_IDS.productContext]: { step: 'product', when: 'after', detail: (_input, output) => field(output, 'facts', 'name') ?? field(output, 'name') },
  [CAPABILITY_IDS.shippingQuote]: { step: 'shipping', when: 'before', detail: (input) => field(input, 'destination', 'commune') },
};

/** The same read registration, reporting progress around its handler; any other capability is returned untouched. */
export function withWebProgress<I, O>(registration: CapabilityRegistration<I, O>, reporter: WebProgressReporter): CapabilityRegistration<I, O> {
  const report = REPORTS[registration.definition.capabilityId];
  if (!report) return registration;
  const say = (taskId: string, input: unknown, output: unknown) => {
    try {
      reporter.report(taskId, report.step, report.detail(input, output));
    } catch {
      // A report never affects the read.
    }
  };
  return {
    ...registration,
    handler: async (input, context) => {
      if (report.when === 'before') say(context.execution.taskId, input, null);
      const output = await registration.handler(input, context);
      if (report.when === 'after') say(context.execution.taskId, input, output);
      return output;
    },
  };
}
