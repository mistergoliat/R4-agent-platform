import { FixtureCatalog, offerPriceOf } from '@r4-adapters/domains';
import {
  RUN_FAILURE_RECOVERY_KEY,
  failureClassOf,
  type ActionAttempt,
  type ActionExecution,
  type ActionProposal,
  type ActionReceipt,
  type AgentDecision,
  type AgentRun,
  type AgentTask,
  type DecisionErrorCode,
  type Goal,
  type JsonObject,
  type Observation,
  type PolicyDecision,
  type RunFailureRecovery,
  type RunStep,
  type TaskWait,
  type TerminationReason,
} from '@r4/contracts';
import { buildEvaluationSubject, fingerprint, type ContextSnapshotMeta, type DomainProjection, type EvaluationSubject, type ModelCallRecord, type TrajectoryRecords } from '@r4/evaluation';
import { CATALOG_FRESHNESS_TTL_MS, catalogSearchView, productContextView } from '../../capabilities/catalog.js';
import { SALES_AGENT_ID, SALES_TASK_TYPE, CAPABILITY_IDS } from '../../ids.js';
import { SALES_ROOT_GOAL } from '../../harness/runtime.js';
import { applyOperations, emptyWorkspace, selectionOf, type Workspace, type WorkspaceOperation } from '../../workspace/model.js';
import { SALES_PROJECTION_SCHEMA, SALES_WORKSPACE_PROJECTION, type SalesProjectionData } from '../projection.js';

/**
 * Fixture trajectories for offline evaluation (R4-G). A small builder that
 * writes exactly the durable records R4 would have written for a Sales
 * conversation — run steps, context snapshot metadata, observations, the
 * governed-action ledger, goals, waits, conversational memory and the Sales
 * workspace transitions (through the pack's real `applyOperations`) — and
 * then goes through the SAME `buildEvaluationSubject` as a durable task.
 *
 * Fixtures are representative, minimal reconstructions of phenomena seen in
 * R4-F (scripted scenarios and the live gate). They are synthetic: fixture
 * catalog data, a fixture customer, no private or live data, and they are
 * never presented as a live result.
 */
const BASE_TIME = Date.parse('2026-09-23T12:00:00.000Z');
const POLICY = { policyId: 'sales-reference-policy', version: 1, hash: 'a'.repeat(64), engineVersion: '1.0.0' };
const SCOPES = ['customer.read', 'catalog.read', 'shipping.read', 'sales.workspace.write', 'quote.create'];

export interface FixtureOptions {
  readonly id: string;
  readonly customerRef?: string | null;
  /** Record harness model-call metadata (latency, tokens) — the way `sales:live` would. Default true. */
  readonly modelCalls?: boolean;
  /** Tokens per model call: input grows with the conversation, like an unbounded context. */
  readonly tokens?: { readonly baseInput: number; readonly perStep: number; readonly output: number };
  readonly latencyMs?: number;
}

/** The reason the kernel records on its turn-closing wait (R4-J1E-R2.2), mirrored by fixtures. */
const TURN_WAIT_REASON = 'Platform: the reply was sent; the turn is over until the next input.';

export class SalesFixture {
  readonly id: string;
  readonly #seed: string;
  #counter = 0;
  #clock = 0;
  readonly #options: Required<Omit<FixtureOptions, 'customerRef'>> & { customerRef: string | null };
  readonly task: AgentTask;
  readonly #runs: { run: AgentRun; steps: RunStep[]; contexts: ContextSnapshotMeta[] }[] = [];
  readonly #observations: Observation[] = [];
  readonly #proposals: ActionProposal[] = [];
  readonly #decisions: PolicyDecision[] = [];
  readonly #executions: ActionExecution[] = [];
  readonly #attempts: ActionAttempt[] = [];
  readonly #receipts: ActionReceipt[] = [];
  readonly #goals: Goal[] = [];
  readonly #events: TrajectoryRecords['events'][number][] = [];
  readonly #waits: TaskWait[] = [];
  readonly #conversation: TrajectoryRecords['conversation'][number][] = [];
  readonly #modelCalls: ModelCallRecord[] = [];
  readonly #hidden = new Set<string>();
  #workspace: Workspace;
  readonly #transitions: SalesProjectionData['transitions'][number][] = [];
  readonly #quoteReferences: SalesProjectionData['quoteReferences'][number][] = [];
  #current: { run: AgentRun; steps: RunStep[]; contexts: ContextSnapshotMeta[] } | null = null;
  #quoteSeq = 100_000;
  #mutations: ((records: TrajectoryRecords) => TrajectoryRecords)[] = [];

  constructor(options: FixtureOptions) {
    this.id = options.id;
    this.#seed = fingerprint(options.id).slice(0, 8);
    this.#options = { modelCalls: true, tokens: { baseInput: 9000, perStep: 1500, output: 600 }, latencyMs: 4000, ...options, customerRef: options.customerRef ?? null };
    const rootGoalId = this.#id();
    const at = this.#now();
    this.task = {
      taskId: this.#id(),
      taskType: SALES_TASK_TYPE,
      agentId: SALES_AGENT_ID,
      agentVersion: 1,
      status: 'pending',
      statusReason: null,
      parentTaskId: null,
      rootGoalId,
      currentGoalId: rootGoalId,
      requestedBy: { kind: 'service', ref: 'sales-harness-ingress' },
      input: { channel: 'fixture' },
      constraints: {},
      budget: { maxModelCalls: 40, maxCapabilityCalls: 40, maxWrites: 200 },
      result: null,
      deadlineAt: null,
      idempotencyKey: null,
      correlationId: `fixture-${options.id.toLowerCase()}`,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.#goals.push({ goalId: rootGoalId, taskId: this.task.taskId, parentGoalId: null, description: SALES_ROOT_GOAL.description, successCriteria: [...SALES_ROOT_GOAL.successCriteria], status: 'active', origin: 'requester', correlationId: this.task.correlationId, version: 1, createdAt: at, updatedAt: at });
    this.#workspace = emptyWorkspace(this.task.taskId);
  }

  #id(): string {
    this.#counter += 1;
    return `${this.#seed}-0000-4000-8000-${this.#counter.toString(16).padStart(12, '0')}`;
  }

  #now(advanceMs = 1000): string {
    this.#clock += advanceMs;
    return new Date(BASE_TIME + this.#clock).toISOString();
  }

  /** Moves the clock (e.g. to let catalog evidence expire across a pause). */
  advance(ms: number): this {
    this.#clock += ms;
    return this;
  }

  get rootGoalId(): string {
    return this.task.rootGoalId;
  }

  // --- turns and runs -------------------------------------------------------------

  /** A customer message: canonical input (CONVERSATIONAL memory), which wakes the task into a new run. */
  turn(text: string): this {
    this.#closeRun();
    const at = this.#now();
    const entryId = this.#id();
    const inputId = this.#id();
    this.#conversation.push({ entryId, role: 'participant', text, interactionRef: inputId, recordedAt: at });
    this.#events.push({ eventId: this.#id(), type: 'task.input.received', entityId: inputId, occurredAt: at, responseKey: null, data: {} });
    const open = this.#waits.find((w) => w.status === 'waiting');
    if (open) Object.assign(open, { status: 'completed', resolution: 'input', completedAt: at });
    this.#openRun(at);
    return this;
  }

  /** (ADR-028) A new run of the same task after a recoverable run failure: no new input, a fresh context. */
  recoveryRun(): this {
    this.#closeRun();
    this.#openRun(this.#now());
    return this;
  }

  #openRun(at: string): void {
    const run: AgentRun = {
      runId: this.#id(), taskId: this.task.taskId, sequence: this.#runs.length + 1, agentId: SALES_AGENT_ID, agentVersion: 1, status: 'running', contextSnapshotRef: null,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, capabilityCalls: 0 }, result: null, failure: null, termination: null, recoveries: 0, correlationId: this.task.correlationId, version: 1, startedAt: at, finishedAt: null, createdAt: at, updatedAt: at,
    };
    this.#current = { run, steps: [], contexts: [] };
    this.#runs.push(this.#current);
    Object.assign(this.task, { status: 'running', updatedAt: at });
  }

  #closeRun(): void {
    if (this.#current && this.#current.run.status === 'running') throw new Error(`fixture ${this.id}: run ${this.#current.run.sequence} must end (wait, complete or fail) before the next turn`);
  }

  #end(reason: TerminationReason, code: string, message: string, taskStatus: AgentTask['status'], details: JsonObject | null = null): void {
    const r = this.#current!.run;
    const at = this.#now(10);
    const status = reason === 'completed' ? 'completed' : reason === 'waiting' ? 'suspended' : 'failed';
    Object.assign(r, { status, termination: { reason, failureClass: failureClassOf(reason), code, message, details }, finishedAt: at, updatedAt: at, failure: status === 'failed' ? { code, message } : null });
    Object.assign(this.task, { status: taskStatus, updatedAt: at });
  }

  /** Items shown to the model at a step: agent, task, goals, every turn so far and every observation not hidden. */
  #snapshot(iteration: number): ContextSnapshotMeta {
    const run = this.#current!.run;
    const observations = this.#observations.filter((o) => !this.#hidden.has(o.observationId));
    const turns = this.#conversation.map((c) => `memory:${c.entryId}`);
    const estimated = this.#options.tokens.baseInput + this.#options.tokens.perStep * this.#modelCalls.length;
    const obsTokens = Math.round(estimated * 0.45);
    const convTokens = Math.round(estimated * 0.15);
    const stateTokens = this.#workspace.version > 0 ? 300 : 0;
    const rest = estimated - obsTokens - convTokens - stateTokens;
    return {
      snapshotId: this.#id(),
      runId: run.runId,
      iteration,
      attempt: 1,
      estimatedTokens: estimated,
      includedTokensByKind: { instruction: Math.round(rest * 0.6), capability: rest - Math.round(rest * 0.6), observation: obsTokens, conversation: convTokens, ...(stateTokens ? { state: stateTokens } : {}) },
      includedTokensBySource: { 'platform.agent': Math.round(rest * 0.6), 'platform.capabilities': rest - Math.round(rest * 0.6), 'platform.observations': obsTokens, 'platform.interaction': convTokens, ...(stateTokens ? { [SALES_WORKSPACE_PROJECTION]: stateTokens } : {}) },
      compactedCount: 0,
      includedItemIds: [`agent:${SALES_AGENT_ID}.v1`, `task:${this.task.taskId}`, ...this.#goals.map((g) => `goal:${g.goalId}`), ...turns, ...observations.map((o) => `observation:${o.observationId}`)],
      excludedItemIds: this.#observations.filter((o) => this.#hidden.has(o.observationId)).map((o) => `observation:${o.observationId}`),
    };
  }

  #step(decision: AgentDecision | null, outcome: RunStep['outcome'], extra: Partial<Pick<RunStep, 'error' | 'invocationId' | 'observationId' | 'proposalId'>> = {}, shape: ModelCallRecord['unparsedShape'] = null): RunStep {
    if (!this.#current || this.#current.run.status !== 'running') throw new Error(`fixture ${this.id}: no running run (start one with turn())`);
    const iteration = this.#current.steps.length + 1;
    const snapshot = this.#snapshot(iteration);
    this.#current.contexts.push(snapshot);
    const failed = outcome === 'model_failed';
    const usage = failed ? { inputTokens: 0, outputTokens: 0 } : { inputTokens: snapshot.estimatedTokens, outputTokens: this.#options.tokens.output };
    const at = this.#now();
    const step: RunStep = {
      stepId: this.#id(), runId: this.#current.run.runId, taskId: this.task.taskId, iteration, leaseGeneration: 1, decision, outcome,
      error: extra.error ?? null, invocationId: extra.invocationId ?? null, observationId: extra.observationId ?? null, contextSnapshotId: snapshot.snapshotId, proposalId: extra.proposalId ?? null, origin: 'model',
      usage, correlationId: this.task.correlationId, createdAt: at, completedAt: outcome === 'pending' ? null : at,
    };
    this.#current.steps.push(step);
    const u = this.#current.run.usage;
    this.#current.run.usage = { modelCalls: u.modelCalls + 1, inputTokens: u.inputTokens + usage.inputTokens, outputTokens: u.outputTokens + usage.outputTokens, capabilityCalls: u.capabilityCalls + (extra.invocationId || extra.proposalId ? 1 : 0) };
    if (this.#options.modelCalls) {
      this.#modelCalls.push({ index: this.#modelCalls.length + 1, runId: this.#current.run.runId, finishReason: failed ? null : 'stop', inputTokens: failed ? null : usage.inputTokens, outputTokens: failed ? null : usage.outputTokens, reasoningTokens: null, latencyMs: this.#options.latencyMs, unparsedShape: shape, error: failed ? 'provider call failed' : null });
    }
    return step;
  }

  /** A token-free step the platform records itself (no model call, no context snapshot). */
  #platformStep(decision: AgentDecision): RunStep {
    if (!this.#current || this.#current.run.status !== 'running') throw new Error(`fixture ${this.id}: no running run (start one with turn())`);
    const at = this.#now();
    const step: RunStep = {
      stepId: this.#id(), runId: this.#current.run.runId, taskId: this.task.taskId, iteration: this.#current.steps.length + 1, leaseGeneration: 1, decision, outcome: 'recorded',
      error: null, invocationId: null, observationId: null, contextSnapshotId: null, proposalId: null, origin: 'platform',
      usage: { inputTokens: 0, outputTokens: 0 }, correlationId: this.task.correlationId, createdAt: at, completedAt: at,
    };
    this.#current.steps.push(step);
    return step;
  }

  // --- decisions -----------------------------------------------------------------

  /** A READ capability and its observation. Returns the observation id. */
  read(capabilityId: string, args: JsonObject, payload: unknown, options: { outcome?: 'succeeded' | 'failed'; validForMs?: number | null; hidden?: boolean } = {}): string {
    const invocationId = this.#id();
    const observationId = this.#id();
    const at = this.#now();
    const ok = (options.outcome ?? 'succeeded') === 'succeeded';
    const validFor = options.validForMs === undefined ? (capabilityId.startsWith('catalog.') ? CATALOG_FRESHNESS_TTL_MS : null) : options.validForMs;
    // A payload may depend on the observation instant (the owner's `asOf`).
    if (typeof payload === 'function') payload = (payload as (observedAt: string) => unknown)(at);
    this.#observations.push({
      observationId, taskId: this.task.taskId, runId: this.#current?.run.runId ?? null, agentId: SALES_AGENT_ID,
      source: { kind: 'capability', capabilityId, capabilityVersion: 1, invocationId },
      outcome: ok ? 'succeeded' : 'failed', payload: ok ? (payload as Observation['payload']) : null, error: ok ? null : { code: 'capability_unavailable', message: 'owner unavailable', details: null },
      observedAt: at, validUntil: validFor === null ? null : new Date(Date.parse(at) + validFor).toISOString(), provenance: { owner: capabilityId.split('.')[0]! }, correlationId: this.task.correlationId,
    } as Observation);
    this.#step({ type: 'read_capability', capabilityId, arguments: args }, 'observed', { invocationId, observationId });
    if (options.hidden) this.#hidden.add(observationId);
    return observationId;
  }

  searchCatalog(args: JsonObject, productKeys: readonly string[]): string {
    return this.read(CAPABILITY_IDS.catalogSearch, args, (at: string) => catalogSearchPayload(productKeys, at, typeof args.query === 'string' ? args.query : ''));
  }

  productContext(productKey: string): string {
    return this.read(CAPABILITY_IDS.productContext, { productKey }, (at: string) => productContextPayload(productKey, at));
  }

  customerContext(): string {
    return this.read(CAPABILITY_IDS.customerContext, {}, this.#options.customerRef ? { identity: 'provisional', customer: { displayName: 'Camila Rojas', contact: { email: 'camila.rojas@example.test', phone: '+56900000001' }, preferredCommune: 'Ñuñoa', previousPurchases: [{ productId: 'KB-16', purchasedAt: '2026-03-14T15:00:00.000Z' }] } } : { identity: 'unavailable', reason: 'anonymous' }, { validForMs: null });
  }

  /** An order-basis shipping observation. Amounts are the owner's NET; the customer gross is derived under the real VAT policy. */
  shippingQuote(commune: string, courierNet: number, expressNet: number): string {
    const items = selectionOf(this.#workspace.state);
    const offers = [
      { carrierName: 'Fixture Courier', serviceType: 'NORMAL', price: offerPriceOf(courierNet), estimatedDelivery: '1 a 3 días hábiles', ownerPosition: 0 },
      { carrierName: 'Fixture Express', serviceType: 'EXPRESS', price: offerPriceOf(expressNet), estimatedDelivery: null, ownerPosition: 1 },
    ];
    return this.read(
      CAPABILITY_IDS.shippingQuote,
      { destination: { commune }, basis: 'order', items },
      {
        destination: { communeId: 'fx-003', communeName: commune, regionName: 'Metropolitana de Santiago' },
        basis: { type: 'order', weightKg: 100, declaredValue: { amount: 0, currency: 'CLP', taxIncluded: true }, dimensionsCm: { height: 1, width: 1, depth: 1, source: 'production_convention' } },
        requestedItems: items,
        serviceable: true,
        offers,
        referenceLowestGross: null,
        asOf: this.#now(0),
        ownerValidUntil: null,
        provenance: { owner: 'fixture-shipping', endpoint: 'in-memory', ownerContractVersion: 'fixture-1' },
      },
      { validForMs: 15 * 60_000 },
    );
  }

  /** A governed write through the full ledger: proposal → ALLOW → command → attempt → receipt → observation. */
  #govern(capabilityId: string, args: JsonObject, evidenceRefs: readonly string[], execute: (executionKey: string) => { status: 'succeeded' | 'rejected'; result: unknown; code?: string; externalRef?: string | null }): { observationId: string; receiptId: string; executionKey: string } {
    const proposalId = this.#id();
    const decisionId = this.#id();
    const executionId = this.#id();
    const attemptId = this.#id();
    const receiptId = this.#id();
    const observationId = this.#id();
    const executionKey = `r4x_${fingerprint({ fixture: this.id, proposalId }).slice(0, 32)}`;
    const run = this.#current!.run;
    const step = this.#step({ type: 'propose_action', capabilityId, arguments: args, ...(evidenceRefs.length ? { evidenceRefs: [...evidenceRefs] } : {}) }, 'observed', { proposalId, observationId });
    const at = step.createdAt;
    const riskClass = capabilityId === CAPABILITY_IDS.quoteCreate ? 'IRREVERSIBLE_WRITE' : 'REVERSIBLE_WRITE';
    const outcome = execute(executionKey);
    this.#proposals.push({ proposalId, taskId: this.task.taskId, runId: run.runId, stepId: step.stepId, iteration: step.iteration, agentId: SALES_AGENT_ID, agentVersion: 1, capabilityId, arguments: args, evidenceRefs: [...evidenceRefs], contextSnapshotId: step.contextSnapshotId, leaseGeneration: 1, correlationId: this.task.correlationId, createdAt: at });
    this.#decisions.push({ decisionId, proposalId, taskId: this.task.taskId, runId: run.runId, agentId: SALES_AGENT_ID, agentVersion: 1, capabilityId, capabilityVersion: 1, riskClass, outcome: 'allow', reasonCode: 'autonomous', rule: riskClass === 'IRREVERSIBLE_WRITE' ? 'capabilities.quote.create.autonomy' : 'risk_class.reversible_write', message: 'allowed', policy: POLICY, identityAssurance: this.#options.customerRef ? 'provisional' : 'none', leaseGeneration: 1, correlationId: this.task.correlationId, evaluatedAt: at });
    this.#executions.push({
      executionId, proposalId, policyDecisionId: decisionId, taskId: this.task.taskId, runId: run.runId, capabilityId, capabilityVersion: 1, riskClass, executionKey,
      semantics: riskClass === 'IRREVERSIBLE_WRITE' ? { recovery: 'reconcile_before_retry', reconcileSupported: true, maxAttempts: 3, initialBackoffMs: 0 } : { recovery: 'idempotent_replay', reconcileSupported: false, maxAttempts: 3, initialBackoffMs: 0 },
      validatedArguments: args, trustedContext: { taskId: this.task.taskId, runId: run.runId, agentId: SALES_AGENT_ID, agentVersion: 1, correlationId: this.task.correlationId, grantedScopes: SCOPES, actor: this.#options.customerRef ? { kind: 'user', ref: this.#options.customerRef } : { kind: 'unauthenticated', ref: 'anonymous-visitor' }, identityAssurance: this.#options.customerRef ? 'provisional' : 'none' },
      correlationId: this.task.correlationId, createdAt: at, status: outcome.status, version: 3, updatedAt: at,
    });
    this.#attempts.push({ attemptId, executionId, attemptNumber: 1, kind: 'execute', workerId: 'fixture-worker', leaseGeneration: 1, startedAt: at, finishedAt: at, outcome: outcome.status === 'succeeded' ? 'applied' : 'rejected', errorCode: outcome.code ?? null, detail: null });
    this.#receipts.push({
      receiptId, executionId, proposalId, taskId: this.task.taskId, runId: run.runId, capabilityId, capabilityVersion: 1, executionKey, status: outcome.status,
      resourceRef: null, externalOperationRef: outcome.externalRef ?? null, result: outcome.status === 'succeeded' ? (outcome.result as ActionReceipt['result']) : null,
      error: outcome.status === 'succeeded' ? null : { code: outcome.code ?? 'rejected', message: 'rejected by the owner', details: null },
      executedAt: at, recordedAt: at, evidence: { obtainedVia: 'execute', attemptId, attemptNumber: 1, attempts: 1, replayed: false }, correlationId: this.task.correlationId,
    });
    this.#observations.push({
      observationId, taskId: this.task.taskId, runId: run.runId, agentId: SALES_AGENT_ID,
      source: { kind: 'action', capabilityId, capabilityVersion: 1, proposalId, policyDecisionId: decisionId, executionId, receiptId, approvalRequestId: null },
      outcome: outcome.status, payload: outcome.status === 'succeeded' ? (outcome.result as Observation['payload']) : null,
      error: outcome.status === 'succeeded' ? null : { code: 'action_rejected', message: outcome.code ?? 'rejected', details: null },
      observedAt: at, validUntil: null, provenance: { receiptId }, correlationId: this.task.correlationId,
    });
    return { observationId, receiptId, executionKey };
  }

  /** `sales.workspace.update` applied with the pack's own workspace model. */
  update(operations: readonly WorkspaceOperation[], evidenceRefs: readonly string[] = []): this {
    const input = { operations: [...operations] };
    this.#govern(CAPABILITY_IDS.workspaceUpdate, input as unknown as JsonObject, evidenceRefs, (executionKey) => {
      const at = this.#now(0);
      const application = applyOperations(this.#workspace, input, at);
      if (application.kind === 'rejected') {
        this.#transitions.push({ executionKey, outcome: 'rejected', fromVersion: this.#workspace.version, toVersion: this.#workspace.version, operations: input.operations, changes: [] });
        return { status: 'rejected', result: null, code: application.code };
      }
      const from = this.#workspace.version;
      this.#workspace = { ...this.#workspace, version: from + 1, state: application.state, updatedAt: at, createdAt: this.#workspace.createdAt ?? at };
      this.#transitions.push({ executionKey, outcome: 'applied', fromVersion: from, toVersion: from + 1, operations: input.operations, changes: application.changes });
      return { status: 'succeeded', result: { status: 'applied', version: from + 1, operations: input.operations.length, state: application.state } };
    });
    return this;
  }

  /** `quote.create` for the current workspace, priced from the fixture catalog like the Quote owner. */
  quote(customer: { name: string; email?: string }, options: { evidenceRefs?: readonly string[]; shippingAmount?: number } = {}): { quoteNumber: string; total: number; observationId: string } {
    const lines = selectionOf(this.#workspace.state).map((s) => {
      const item = CATALOG_OWNER.current(s.productId)!;
      return { productId: s.productId, name: item.name, quantity: s.quantity, unitPrice: { ...item.unitPrice }, lineTotal: { amount: item.unitPrice.amount * s.quantity, currency: 'CLP' } };
    });
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal.amount, 0);
    const shipping = options.shippingAmount ?? 42_390;
    this.#quoteSeq += 1;
    const quoteNumber = `COT-${this.#quoteSeq}`;
    const evidence = options.evidenceRefs ?? this.#observations.filter((o) => o.source.capabilityId.startsWith('catalog.') || o.source.capabilityId === CAPABILITY_IDS.shippingQuote).map((o) => o.observationId);
    const issuedAt = this.#now(0);
    const result = { quoteId: `q-${this.#quoteSeq}`, quoteNumber, status: 'issued', lines, shipping: { serviceLevel: 'standard', commune: this.#workspace.state.delivery?.commune ?? 'Ñuñoa', amount: { amount: shipping, currency: 'CLP' } }, subtotal: { amount: subtotal, currency: 'CLP' }, total: { amount: subtotal + shipping, currency: 'CLP' }, issuedAt, validUntil: new Date(Date.parse(issuedAt) + 7 * 86_400_000).toISOString(), documentRef: `doc-${this.#quoteSeq}`, basedOnWorkspaceVersion: this.#workspace.version };
    const { observationId, executionKey } = this.#govern(CAPABILITY_IDS.quoteCreate, { workspaceVersion: this.#workspace.version, customer: { ...customer } }, evidence, () => ({ status: 'succeeded', result, externalRef: quoteNumber }));
    this.#quoteReferences.push({ executionKey, quoteNumber, basedOnWorkspaceVersion: this.#workspace.version });
    return { quoteNumber, total: subtotal + shipping, observationId };
  }

  respond(text: string): this {
    this.#step({ type: 'respond', content: text }, 'recorded');
    return this;
  }

  /**
   * End of the turn: WAIT_FOR_INPUT (a legitimate stop; the task waits, the run is suspended).
   * Right after a recorded `respond` it is the platform's turn-closing wait (R4-J1E-R2.2): origin
   * `platform`, no model call, no tokens, no snapshot — exactly what the kernel records. Anywhere
   * else it is a wait the agent decided.
   */
  wait(reason?: string): this {
    const last = this.#current?.steps.at(-1);
    if (last?.decision?.type === 'respond' && last.outcome === 'recorded') this.#platformStep({ type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: TURN_WAIT_REASON });
    else this.#step({ type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, ...(reason ? { reason } : {}) }, 'recorded');
    const at = this.#now(0);
    this.#waits.push({ waitId: this.#id(), taskId: this.task.taskId, runId: this.#current!.run.runId, kind: 'WAIT_FOR_INPUT', status: 'waiting', resolution: null, referenceId: null, dueAt: null, createdAt: at, completedAt: null, correlationId: this.task.correlationId });
    this.#end('waiting', 'wait_for_input', 'task suspended by a structured agent decision', 'waiting');
    return this;
  }

  complete(summary: string): this {
    this.#step({ type: 'complete', result: { summary, evidence: [] } }, 'recorded');
    this.#end('completed', 'completed', 'agent completed the task', 'completed');
    const root = this.#goals.find((g) => g.goalId === this.task.rootGoalId)!;
    Object.assign(root, { status: 'achieved', version: 2 });
    return this;
  }

  /** manage_goal create under the root (optionally focused). Returns the goal id. */
  createGoal(description: string, makeCurrent = true): string {
    const goalId = this.#id();
    this.#step({ type: 'manage_goal', change: { operation: 'create', parentGoalId: this.task.rootGoalId, description, successCriteria: [], makeCurrent } }, 'recorded');
    const at = this.#now(0);
    this.#goals.push({ goalId, taskId: this.task.taskId, parentGoalId: this.task.rootGoalId, description, successCriteria: [], status: 'active', origin: 'agent', correlationId: this.task.correlationId, version: 1, createdAt: at, updatedAt: at });
    this.#events.push({ eventId: this.#id(), type: 'goal.created', entityId: goalId, occurredAt: at, responseKey: null, data: {} });
    if (makeCurrent) {
      Object.assign(this.task, { currentGoalId: goalId });
      this.#events.push({ eventId: this.#id(), type: 'goal.focused', entityId: goalId, occurredAt: at, responseKey: null, data: {} });
    }
    return goalId;
  }

  /**
   * A model output the platform rejected: the run fails (ADR-008: no retry in the run). Without
   * `recovery` the task fails (the pre-ADR-028 shape recorded trajectories keep); with it, the
   * platform's disposition is stamped on the run and the task continues (`continued`) or waits for
   * a human (`exhausted` / `handed_off`), as the ADR-028 runtime records it.
   */
  invalid(code: DecisionErrorCode, shape: { jsonDocuments: readonly (string | null)[]; otherTextChars: number } | null = null, recovery: RunFailureRecovery | null = null): this {
    this.#step(null, 'invalid', { error: { code, message: `decision rejected: ${code}` } }, shape ? { chars: 200 + shape.otherTextChars, jsonDocuments: [...shape.jsonDocuments], otherTextChars: shape.otherTextChars } : null);
    this.#end('invalid_decision', code, `decision rejected: ${code}`, taskStatusAfter(recovery), recovery ? { [RUN_FAILURE_RECOVERY_KEY]: recovery } : null);
    return this;
  }

  /** The provider call itself failed (transport or malformed answer); `recovery` as for `invalid`. */
  modelFailure(kind: 'provider_error' | 'rate_limited' | 'timeout' | 'invalid_provider_response', recovery: RunFailureRecovery | null = null, retryable = kind === 'timeout' || kind === 'rate_limited'): this {
    this.#step(null, 'model_failed', { error: { code: kind, message: `model call failed: ${kind}` } });
    this.#end('model_failure', kind, `model call failed: ${kind}`, taskStatusAfter(recovery), recovery ? { retryable, [RUN_FAILURE_RECOVERY_KEY]: recovery } : null);
    return this;
  }

  /** Low-level edit of the records before the subject is built (for governance fixtures). */
  mutate(fn: (records: TrajectoryRecords) => TrajectoryRecords): this {
    this.#mutations.push(fn);
    return this;
  }

  records(): TrajectoryRecords {
    const data: SalesProjectionData = { version: this.#workspace.version, state: this.#workspace.state, transitions: this.#transitions, quoteReferences: this.#quoteReferences };
    const base: TrajectoryRecords = {
      source: { kind: 'fixture', ref: `sales/${this.id}` },
      task: { ...this.task },
      agent: { agentId: SALES_AGENT_ID, version: 1, contentHash: null },
      runs: this.#runs.map((r) => ({ run: { ...r.run }, steps: r.steps, contexts: r.contexts })),
      observations: this.#observations,
      ledger: { proposals: this.#proposals, decisions: this.#decisions, executions: this.#executions, attempts: this.#attempts, receipts: this.#receipts },
      goals: this.#goals,
      events: this.#events,
      waits: this.#waits,
      humans: [],
      conversation: this.#conversation,
      domain: { [SALES_WORKSPACE_PROJECTION]: { owner: 'sales', schemaVersion: SALES_PROJECTION_SCHEMA, data: structuredClone(data) as unknown as DomainProjection['data'] } },
      modelCalls: this.#options.modelCalls ? this.#modelCalls : null,
    };
    return this.#mutations.reduce((records, fn) => fn(structuredClone(records)), base);
  }

  build(): EvaluationSubject {
    return buildEvaluationSubject(this.records());
  }
}

// --- catalog payloads, exactly as the Sales capabilities return them ------------

/** The fixture Catalog owner the payloads come from (its records never change here). */
const CATALOG_OWNER = new FixtureCatalog();

/** A complete search answer listing exactly `productKeys`, mapped by the capability's own view. */
export function catalogSearchPayload(productKeys: readonly string[], observedAt: string, query: string): unknown {
  return catalogSearchView(CATALOG_OWNER.searchAnswerOf(productKeys, new Date(observedAt)), query);
}

export function productContextPayload(productKey: string, observedAt: string): unknown {
  return productContextView(CATALOG_OWNER.productContextAt(productKey, new Date(observedAt)));
}

/** The task status an ADR-028 disposition leaves (legacy `failed` when none is recorded). */
function taskStatusAfter(recovery: RunFailureRecovery | null): AgentTask['status'] {
  if (recovery === null) return 'failed';
  return recovery.outcome === 'continued' ? 'running' : 'blocked';
}
