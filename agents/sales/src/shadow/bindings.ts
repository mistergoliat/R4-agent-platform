import { ShadowQuoteService, createFixtureDomains, type FixtureDomains } from '@r4-adapters/domains';
import {
  SideEffectRecorder,
  ShadowExecutionPolicy,
  assertShadowComposition,
  guardPort,
  type DomainBindingDescriptor,
  type OutboundBindingDescriptor,
  type ShadowCompositionReport,
  type ShadowExecutionConfig,
  type SideEffectRecord,
} from '@r4/shadow';
import type { SalesDomains } from '../composition.js';
import { CAPABILITY_IDS } from '../ids.js';

/**
 * The Sales pack's domain bindings for shadow runs (R4-H). Every owner the
 * agent reaches is declared — kind, operations and their effect class — and
 * wrapped by the shadow port guard. The agent pack itself is unchanged: the
 * guarded objects implement the same ports `composeSales` already takes.
 *
 * Integration truth in R4-H (see ADR-027):
 *   customer  FIXTURE  — no Customer contract is documented or configured in R4
 *   catalog   FIXTURE  — the Catalog service contract lives outside this repo
 *                        (secondhand only) and no endpoint/credential is configured
 *   shipping  FIXTURE  — no Shipping contract configured in R4
 *   quote     SHADOW   — record-only owner (no sandbox/preview Quote mode is documented)
 *   outbound  shadow-only sink
 */
export const SALES_SHADOW_BINDINGS: readonly DomainBindingDescriptor[] = Object.freeze([
  { domain: 'customer', bindingId: 'fixture-customer', kind: 'fixture', version: 1, operations: { getContext: { effect: 'read' } }, contractRef: null, description: 'In-memory Customer owner with fictitious test customers (example.test).' },
  { domain: 'catalog', bindingId: 'fixture-catalog', kind: 'fixture', version: 1, operations: { search: { effect: 'read' }, getProduct: { effect: 'read' } }, contractRef: null, description: 'In-memory Catalog owner (home-gym fixture catalog); price/stock can change between reads.' },
  { domain: 'shipping', bindingId: 'fixture-shipping', kind: 'fixture', version: 1, operations: { quote: { effect: 'read' } }, contractRef: null, description: 'In-memory Shipping owner: cost by zone and weight; side-effect free.' },
  {
    domain: 'quote',
    bindingId: 'shadow-quote-owner',
    kind: 'shadow',
    version: 1,
    operations: { create: { effect: 'write', idempotencyKeyArg: 1 }, findByIdempotencyKey: { effect: 'read' } },
    contractRef: null,
    description: 'Record-only Quote owner: same port semantics, quotes recorded in a reserved shadow range, never issued.',
  },
]);

export const SALES_SHADOW_OUTBOUND: OutboundBindingDescriptor = Object.freeze({ bindingId: 'shadow-outbound-sink', kind: 'shadow-sink', version: 1 });

/** Capabilities whose succeeded receipt means an external owner applied a write (the manifest joins them). */
export const SALES_EXTERNAL_WRITE_CAPABILITIES: readonly string[] = [CAPABILITY_IDS.quoteCreate];

export interface ShadowSalesDomains {
  /** Owner-side control of the fixture owners (scenario faults, price changes). Never given to the agent. */
  readonly fixtures: FixtureDomains;
  readonly quotes: ShadowQuoteService;
  /** What the worker's capabilities call: every port guarded and recorded. */
  readonly ports: SalesDomains;
  readonly recorder: SideEffectRecorder;
  readonly composition: ShadowCompositionReport;
}

/**
 * Composes the shadow domain side. Refuses (throws) unless the shadow mode is
 * proven and every binding classifies as allowed; each port then re-checks
 * every call. `bindings` defaults to the Sales set; tests pass mutated sets
 * to prove the refusals.
 */
export function composeShadowSalesDomains(config: ShadowExecutionConfig, options: { now: () => Date; onRecord?: (record: SideEffectRecord) => void; bindings?: readonly DomainBindingDescriptor[]; outbound?: OutboundBindingDescriptor }): ShadowSalesDomains {
  const bindings = options.bindings ?? SALES_SHADOW_BINDINGS;
  const composition = assertShadowComposition(config, bindings, options.outbound ?? SALES_SHADOW_OUTBOUND);
  const policy = new ShadowExecutionPolicy(config);
  const recorder = new SideEffectRecorder({ ...(options.onRecord ? { onRecord: options.onRecord } : {}) });
  const fixtures = createFixtureDomains({ now: options.now });
  // The shadow Quote owner prices from the same owners the agent reads (owner-to-owner calls are not the agent's side effects).
  const quotes = new ShadowQuoteService({ catalog: fixtures.catalog, shipping: fixtures.shipping, now: options.now });
  const descriptor = (domain: string) => {
    const found = bindings.find((b) => b.domain === domain);
    if (!found) throw new Error(`no shadow binding declared for domain ${domain}`);
    return found;
  };
  return {
    fixtures,
    quotes,
    recorder,
    composition,
    ports: {
      customers: guardPort(fixtures.customers, descriptor('customer'), policy, recorder),
      catalog: guardPort(fixtures.catalog, descriptor('catalog'), policy, recorder),
      shipping: guardPort(fixtures.shipping, descriptor('shipping'), policy, recorder),
      quotes: guardPort(quotes, descriptor('quote'), policy, recorder),
    },
  };
}

const once = <T>(value: T, then: T) => {
  let used = false;
  return () => (used ? then : ((used = true), value));
};

/**
 * Controlled faults a WorkloadCase may name (`fault` events). Owner outages
 * and slowness, and the Quote owner's unknown-outcome windows. Returns a note
 * for the event log, or throws for an unknown fault (a corpus error).
 */
export function applySalesFault(domains: ShadowSalesDomains, target: string, fault: string): string {
  const owner = target === 'catalog' ? domains.fixtures.catalog : target === 'customer' ? domains.fixtures.customers : target === 'shipping' ? domains.fixtures.shipping : target === 'quote' ? domains.quotes : null;
  if (owner === null) throw new Error(`unknown fault target ${target}`);
  switch (fault) {
    case 'down':
      owner.availability.set({ mode: 'down' });
      return `${target} owner down`;
    case 'up':
      owner.availability.set({ mode: 'up' });
      return `${target} owner back up`;
    case 'slow':
      owner.availability.set({ mode: 'slow', delayMs: 1_500 });
      return `${target} owner slow (1.5 s)`;
  }
  if (target === 'quote') {
    switch (fault) {
      case 'connection-lost-after-issue-once':
        domains.quotes.faults.afterIssue = once('connection_lost' as const, 'answer' as const);
        return 'next quote create: recorded, then connection lost (outcome unknown)';
      case 'timeout-after-issue-once':
        domains.quotes.faults.afterIssue = once('timeout' as const, 'answer' as const);
        return 'next quote create: recorded, then no answer in time (outcome unknown)';
    }
    const lookups = /^lookup-timeout-x(\d)$/.exec(fault);
    if (lookups) {
      let left = Number(lookups[1]);
      domains.quotes.faults.lookup = () => (left > 0 ? ((left -= 1), 'timeout') : 'answer');
      return `the next ${lookups[1]} quote lookup(s) time out`;
    }
  }
  throw new Error(`unknown fault ${fault} for ${target}`);
}

/** Owner-side data changes (`owner_change` events): what a real owner might change between two reads. */
export function applySalesOwnerChange(domains: ShadowSalesDomains, target: string, change: string, params: Readonly<Record<string, string | number | boolean>>): string {
  if (target !== 'catalog') throw new Error(`unknown owner change target ${target}`);
  const productId = String(params.productId);
  if (change === 'set-price') {
    domains.fixtures.catalog.setPrice(productId, Number(params.amount));
    return `catalog: ${productId} price → ${String(params.amount)}`;
  }
  if (change === 'set-stock') {
    domains.fixtures.catalog.setStock(productId, Number(params.units));
    return `catalog: ${productId} stock → ${String(params.units)}`;
  }
  throw new Error(`unknown owner change ${change}`);
}
