import { CAPABILITY_IDS } from '../ids.js';
import { projectWorkspace } from '../workspace/context-source.js';
import type { FactValue } from '../workspace/model.js';
import type { ConversationState } from './runtime.js';

/**
 * Expected properties of a scenario, checked against durable state. They are
 * the reusable seed of R4-G evaluation, not an evaluation framework: each is
 * a precise, mechanical statement ("a quote.create receipt exists", "the
 * budget fact was superseded"), never a judgment of language quality. Two
 * checks look at the agent's text — only to catch claims of quotes that no
 * receipt backs.
 */
/**
 * Which workspace fact an invariant is about. Fact keys are the agent's own
 * choice (free snake_case: `budget`, `budget_clp`, `presupuesto_clp`…), so
 * a live check names the fact by a pattern; an exact key is for scripted
 * trajectories that fix their own keys.
 */
export type FactKey = string | { readonly matches: string };

export type Invariant =
  | { readonly kind: 'capability_used'; readonly capabilityId: string; readonly min?: number }
  | { readonly kind: 'capability_not_used'; readonly capabilityId: string }
  | { readonly kind: 'quotes_issued'; readonly equals: number }
  | { readonly kind: 'no_unbacked_quote_claim' }
  | { readonly kind: 'root_goal_active' }
  | { readonly kind: 'goal_kept'; readonly matches: string }
  | { readonly kind: 'no_goal_abandoned' }
  | { readonly kind: 'fact_equals'; readonly key: FactKey; readonly value: FactValue }
  | { readonly kind: 'fact_history'; readonly key: FactKey; readonly values: readonly FactValue[] }
  | { readonly kind: 'selection_equals'; readonly items: readonly { productId: string; quantity: number }[] }
  | { readonly kind: 'delivery_equals'; readonly commune: string }
  | { readonly kind: 'task_status'; readonly in: readonly string[] }
  | { readonly kind: 'responded_every_turn' }
  | { readonly kind: 'no_question_after_fact'; readonly key: FactKey; readonly topic: string }
  | { readonly kind: 'refreshed_after_expiry'; readonly capabilityId: string }
  | { readonly kind: 'consultation_answered_and_resumed' }
  | { readonly kind: 'waited_and_resumed' }
  | { readonly kind: 'quote_cites_evidence' }
  | { readonly kind: 'write_rejected_then_recovered'; readonly capabilityId: string; readonly code: string }
  | { readonly kind: 'shipping_evidence_superseded_by_destination' }
  | { readonly kind: 'one_receipt_per_execution' }
  | { readonly kind: 'failure_observed'; readonly capabilityId: string; readonly category: string }
  | { readonly kind: 'current_goal_matches'; readonly matches: string }
  | { readonly kind: 'prior_response_in_context' }
  | { readonly kind: 'quote_line_price'; readonly productId: string; readonly amount: number };

export interface InvariantResult {
  readonly invariant: Invariant;
  readonly passed: boolean;
  readonly detail: string;
}

const QUOTE_NUMBER = /\bCOT-\d{6}\b/g;
const QUOTE_CLAIM = /(cotizaci[oó]n\s+(n[°ºo.]*\s*)?(creada|generada|emitida|lista)|quote\s+(was\s+)?(created|issued))/i;

export function evaluateInvariants(invariants: readonly Invariant[], state: ConversationState): InvariantResult[] {
  return invariants.map((invariant) => ({ invariant, ...check(invariant, state) }));
}

/**
 * Order is taken from the step log (run sequence, iteration) — never by
 * comparing timestamps written by different clocks (the process clock and
 * the database's temporal clock).
 */
function positions(state: ConversationState) {
  const byStep = new Map<string, number>();
  const byObservation = new Map<string, number>();
  const byRun = new Map<string, number>();
  for (const { run, steps } of state.runs) {
    byRun.set(run.runId, run.sequence);
    for (const s of steps) {
      const at = run.sequence * 10_000 + s.iteration;
      byStep.set(s.stepId, at);
      if (s.observationId) byObservation.set(s.observationId, at);
    }
  }
  const proposalAt = new Map(state.ledger.proposals.map((p) => [p.proposalId, byStep.get(p.stepId) ?? Number.MAX_SAFE_INTEGER]));
  const executionAt = new Map(state.ledger.executions.map((e) => [e.executionKey, proposalAt.get(e.proposalId) ?? Number.MAX_SAFE_INTEGER]));
  return { byStep, byObservation, byRun, proposalAt, executionAt };
}

function check(invariant: Invariant, state: ConversationState): { passed: boolean; detail: string } {
  const reads = state.observations.filter((o) => o.source.kind === 'capability');
  const order = positions(state);
  const steps = state.runs.flatMap((r) => r.steps);
  const responses = steps.flatMap((s) => (s.decision?.type === 'respond' ? [{ position: order.byStep.get(s.stepId) ?? 0, text: s.decision.content }] : []));
  const quoteReceipts = state.ledger.receipts.filter((r) => r.capabilityId === CAPABILITY_IDS.quoteCreate && r.status === 'succeeded');
  const used = (capabilityId: string) =>
    state.observations.filter((o) => o.source.capabilityId === capabilityId).length;
  switch (invariant.kind) {
    case 'capability_used': {
      const n = used(invariant.capabilityId);
      return result(n >= (invariant.min ?? 1), `${invariant.capabilityId} observed ${n} time(s)`);
    }
    case 'capability_not_used': {
      const n = used(invariant.capabilityId);
      return result(n === 0, `${invariant.capabilityId} observed ${n} time(s)`);
    }
    case 'quotes_issued':
      return result(quoteReceipts.length === invariant.equals && state.quoteReferences.length === invariant.equals, `${quoteReceipts.length} succeeded quote receipt(s), ${state.quoteReferences.length} quote reference(s)`);
    case 'no_unbacked_quote_claim': {
      const problems: string[] = [];
      for (const r of responses) {
        const backed = quoteReceipts.filter((q) => (order.proposalAt.get(q.proposalId) ?? Number.MAX_SAFE_INTEGER) < r.position);
        const numbers = new Set(backed.map((q) => (q.result as { quoteNumber?: string } | null)?.quoteNumber));
        for (const n of r.text.match(QUOTE_NUMBER) ?? []) if (!numbers.has(n)) problems.push(`mentions ${n} without a prior receipt`);
        if (QUOTE_CLAIM.test(r.text) && backed.length === 0) problems.push('claims a quote before any quote receipt');
      }
      return result(problems.length === 0, problems.length ? problems.join('; ') : `${responses.length} response(s) checked`);
    }
    case 'root_goal_active': {
      const root = state.goals.find((g) => g.goalId === state.task.rootGoalId);
      return result(root?.status === 'active', `root goal is ${root?.status ?? 'missing'}`);
    }
    case 'goal_kept': {
      const pattern = new RegExp(invariant.matches, 'i');
      const goal = state.goals.find((g) => g.origin === 'agent' && pattern.test(g.description));
      return result(goal !== undefined && goal.status !== 'abandoned' && goal.status !== 'superseded', goal ? `goal "${goal.description}" is ${goal.status}` : 'no agent goal matches');
    }
    case 'no_goal_abandoned': {
      const abandoned = state.goals.filter((g) => g.status === 'abandoned');
      return result(abandoned.length === 0, `${abandoned.length} abandoned goal(s)`);
    }
    case 'fact_equals': {
      // Every current fact about this subject must hold the value: one right key does not excuse a contradicting one.
      const facts = Object.entries(state.workspace.state.facts).filter(([key]) => keyMatches(invariant.key, key));
      const shown = facts.length ? facts.map(([key, f]) => `${key} = ${JSON.stringify(f.value)}`).join(', ') : `${describeKey(invariant.key)} = null`;
      return result(facts.length > 0 && facts.every(([, f]) => factValueMatches(f.value, invariant.value)), shown);
    }
    case 'fact_history': {
      const values = state.workspaceTransitions.flatMap((t) => t.changes.flatMap((c) => (c.kind === 'fact' && keyMatches(invariant.key, c.key) && c.to ? [c.to.value] : [])));
      const current = Object.keys(state.workspace.state.facts).filter((k) => keyMatches(invariant.key, k)).length;
      const matches = values.length === invariant.values.length && values.every((v, i) => factValueMatches(v, invariant.values[i]!));
      return result(matches && current === 1, `history ${JSON.stringify(values)}; ${current} current value(s)`);
    }
    case 'selection_equals': {
      const actual = state.workspace.state.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
      const norm = (l: readonly { productId: string; quantity: number }[]) => JSON.stringify([...l].sort((a, b) => a.productId.localeCompare(b.productId)));
      return result(norm(actual) === norm(invariant.items), `selection ${norm(actual)}`);
    }
    case 'delivery_equals':
      return result(state.workspace.state.delivery?.commune === invariant.commune, `delivery ${state.workspace.state.delivery?.commune ?? 'none'}`);
    case 'task_status':
      return result(invariant.in.includes(state.task.status), `task is ${state.task.status}`);
    case 'responded_every_turn': {
      const silent = state.turns.filter((t) => !t.runIds.some((id) => state.runs.find((r) => r.run.runId === id)?.steps.some((s) => s.decision?.type === 'respond')));
      return result(silent.length === 0, silent.length ? `no response to turn(s) ${silent.map((t) => t.index).join(', ')}` : `${state.turns.length} turn(s) answered`);
    }
    case 'no_question_after_fact': {
      const recorded = state.workspaceTransitions.find((t) => t.changes.some((c) => c.kind === 'fact' && keyMatches(invariant.key, c.key) && c.to));
      if (!recorded) return result(false, `fact ${describeKey(invariant.key)} was never recorded`);
      const recordedAt = order.executionAt.get(recorded.executionKey) ?? Number.MAX_SAFE_INTEGER;
      const topic = new RegExp(invariant.topic, 'i');
      const repeated = responses.filter((r) => r.position > recordedAt && r.text.includes('?') && topic.test(r.text));
      return result(repeated.length === 0, repeated.length ? `asked again: ${repeated.map((r) => JSON.stringify(r.text.slice(0, 80))).join(' | ')}` : 'not asked again');
    }
    case 'refreshed_after_expiry': {
      // Observation times and validity come from the same (process) clock, so comparing them is sound.
      const of = reads.filter((o) => o.source.capabilityId === invariant.capabilityId || (invariant.capabilityId === 'catalog.*' && o.source.capabilityId.startsWith('catalog.')));
      const firstExpiry = of.find((o) => o.validUntil !== null)?.validUntil ?? null;
      const fresh = of.filter((o) => firstExpiry !== null && o.observedAt >= firstExpiry);
      const quoteAt = quoteReceipts.length ? Math.min(...quoteReceipts.map((q) => order.proposalAt.get(q.proposalId) ?? Number.MAX_SAFE_INTEGER)) : null;
      const beforeQuote = quoteAt === null || fresh.some((o) => (order.byObservation.get(o.observationId) ?? Number.MAX_SAFE_INTEGER) < quoteAt);
      return result(fresh.length > 0 && beforeQuote, firstExpiry ? `first evidence valid until ${firstExpiry}; re-read ${fresh.length} time(s) after; before the quote=${beforeQuote}` : 'no evidence with a freshness window');
    }
    case 'consultation_answered_and_resumed': {
      const consultation = state.temporal.humans.find((h) => h.kind === 'consultation');
      const askedIn = consultation?.runId ? order.byRun.get(consultation.runId) ?? null : null;
      const resumed = consultation?.status === 'answered' && askedIn !== null && state.runs.some((r) => r.run.sequence > askedIn && r.steps.length > 0);
      return result(resumed, consultation ? `consultation ${consultation.status}; resumed=${resumed}` : 'no consultation');
    }
    case 'waited_and_resumed': {
      const waits = state.temporal.waits.filter((w) => w.kind === 'WAIT_FOR_INPUT' && w.resolution === 'input');
      const resumed = waits.some((w) => {
        const openedIn = w.runId ? order.byRun.get(w.runId) ?? null : null;
        return openedIn !== null && state.runs.some((r) => r.run.sequence > openedIn && r.steps.length > 0);
      });
      return result(resumed, `${waits.length} wait(s) resolved by input; resumed=${resumed}`);
    }
    case 'quote_cites_evidence': {
      const proposals = state.ledger.proposals.filter((p) => p.capabilityId === CAPABILITY_IDS.quoteCreate);
      const cited = proposals.length > 0 && proposals.every((p) => p.evidenceRefs.length > 0);
      return result(cited, `${proposals.length} quote proposal(s); all cite evidence=${cited}`);
    }
    case 'write_rejected_then_recovered': {
      // Platform codes (write_validation_failure, policy_denied, …) or the domain's own code of a receipt-backed rejection.
      const codeOf = (o: (typeof state.observations)[number]) => [o.error?.code, (o.error?.details as { domainCode?: string } | null)?.domainCode];
      const rejection = state.observations.find((o) => o.source.kind === 'action' && o.source.capabilityId === invariant.capabilityId && o.outcome !== 'succeeded' && codeOf(o).includes(invariant.code));
      const at = (o: (typeof state.observations)[number]) => order.byObservation.get(o.observationId) ?? -1;
      const success = state.observations.find((o) => o.source.kind === 'action' && o.source.capabilityId === invariant.capabilityId && o.outcome === 'succeeded' && rejection !== undefined && at(o) > at(rejection));
      return result(rejection !== undefined && success !== undefined, `rejection=${rejection?.error?.code ?? 'none'}; later success=${success !== undefined}`);
    }
    case 'shipping_evidence_superseded_by_destination': {
      const shipping = reads.filter((o) => o.source.capabilityId === CAPABILITY_IDS.shippingQuote && o.outcome === 'succeeded');
      const destinations = new Set(shipping.map((o) => (o.payload as { destination: { commune: string } }).destination.commune));
      const current = state.workspace.state.delivery?.commune;
      const lastForCurrent = shipping.at(-1) && (shipping.at(-1)!.payload as { destination: { commune: string } }).destination.commune === current;
      // What the agent is shown now: evidence for the old destination is marked as not applying.
      const projection = projectWorkspace({ workspace: state.workspace, binding: null, quotes: state.quoteReferences, transitions: state.workspaceTransitions, observations: state.observations, now: new Date() });
      const evidence = projection.shippingEvidence as { destination: string; forCurrentDestination: boolean }[];
      const stale = evidence.filter((e) => e.destination !== current);
      const flagged = stale.length > 0 && stale.every((e) => !e.forCurrentDestination) && evidence.some((e) => e.forCurrentDestination);
      return result(destinations.size >= 2 && lastForCurrent === true && flagged, `shipping quoted for ${[...destinations].join(' → ')}; current destination ${current ?? 'none'}; old evidence flagged=${flagged}`);
    }
    case 'one_receipt_per_execution': {
      const byExecution = new Map<string, number>();
      for (const r of state.ledger.receipts) byExecution.set(r.executionId, (byExecution.get(r.executionId) ?? 0) + 1);
      const duplicated = [...byExecution.values()].filter((n) => n > 1).length;
      return result(duplicated === 0 && state.ledger.executions.every((e) => e.status !== 'needs_reconciliation'), `${state.ledger.executions.length} execution(s), ${state.ledger.receipts.length} receipt(s)`);
    }
    case 'current_goal_matches': {
      const current = state.goals.find((g) => g.goalId === state.task.currentGoalId);
      return result(current !== undefined && new RegExp(invariant.matches, 'i').test(current.description), `current focus: ${current?.description ?? 'none'}`);
    }
    case 'prior_response_in_context': {
      // Every run after the first must have been shown what the agent said in earlier runs (cross-run continuity).
      const earlier = new Map<number, Set<string>>();
      const said = new Set<string>();
      for (const { run, steps: runSteps } of [...state.runs].sort((a, b) => a.run.sequence - b.run.sequence)) {
        earlier.set(run.sequence, new Set(said));
        for (const s of runSteps) if (s.decision?.type === 'respond') said.add(`response:${s.stepId}`);
      }
      const missing = state.runs.filter(({ run, contexts }) => {
        const expected = earlier.get(run.sequence) ?? new Set<string>();
        const first = contexts.find((c) => c.iteration === 1);
        return expected.size > 0 && (!first || [...expected].some((id) => !first.itemIds.includes(id)));
      });
      return result(state.runs.length > 1 && missing.length === 0, missing.length ? `runs ${missing.map((r) => r.run.sequence).join(', ')} started without earlier responses` : `${state.runs.length} run(s) checked`);
    }
    case 'quote_line_price': {
      const lines = quoteReceipts.flatMap((q) => ((q.result as { lines?: { productId: string; unitPrice: { amount: number } }[] } | null)?.lines ?? []).filter((l) => l.productId === invariant.productId));
      return result(lines.length > 0 && lines.every((l) => l.unitPrice.amount === invariant.amount), `quoted unit price(s) ${lines.map((l) => l.unitPrice.amount).join(', ') || 'none'}`);
    }
    case 'failure_observed': {
      const failure = state.observations.find((o) => o.source.capabilityId === invariant.capabilityId && o.outcome === 'failed' && (o.error?.details as { category?: string } | null)?.category === invariant.category);
      return result(failure !== undefined, failure ? `${invariant.capabilityId} failed with ${invariant.category}` : 'no such failure observed');
    }
  }
}

function keyMatches(expected: FactKey, key: string): boolean {
  return typeof expected === 'string' ? key === expected : new RegExp(expected.matches, 'i').test(key);
}

function describeKey(key: FactKey): string {
  return typeof key === 'string' ? key : `/${key.matches}/`;
}

/**
 * Value equality, plus one representation rule: an expected money value
 * `{ amount, currency }` is also met by the bare amount, or by an object with
 * that amount and no other currency (`presupuesto_clp: 800000`). Nothing is
 * parsed from text and no other shape is interpreted.
 */
export function factValueMatches(actual: FactValue, expected: FactValue): boolean {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return true;
  const money = expected !== null && typeof expected === 'object' && typeof expected.amount === 'number' && typeof expected.currency === 'string' ? { amount: expected.amount, currency: expected.currency } : null;
  if (money === null) return false;
  if (typeof actual === 'number') return actual === money.amount;
  if (actual === null || typeof actual !== 'object' || actual.amount !== money.amount) return false;
  return actual.currency === undefined || (typeof actual.currency === 'string' && actual.currency.toUpperCase() === money.currency.toUpperCase());
}

function result(passed: boolean, detail: string): { passed: boolean; detail: string } {
  return { passed, detail };
}
