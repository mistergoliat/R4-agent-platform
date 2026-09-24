import { TERMINAL_TASK_STATUSES, type TrustedHumanContext } from '@r4/contracts';
import { fingerprint, type ModelProfile } from '@r4/evaluation';
import { PostgresTrajectoryReader } from '@r4/evaluator';
import { FakeModelProvider, type ModelProvider } from '@r4/model-gateway';
import { createLogger } from '@r4/observability';
import { PostgresActionLedgerStore, PostgresExecutionStore } from '@r4/persistence-postgres';
import { createSchedulerPlatform, type SchedulerPlatform } from '@r4/scheduler';
import {
  MODEL_FAULTS,
  ShadowRecordingModelProvider,
  assertShadowMode,
  createOutboundDelivery,
  toModelCallRecord,
  type EventLogEntry,
  type ModelFault,
  type TurnTiming,
  type WorkloadCase,
  type WorkloadExecution,
  type WorkloadExecutionContext,
  type WorkloadExecutor,
  type WorkloadExecutorDescription,
} from '@r4/shadow';
import { loadSalesAgentDefinition } from '../definition.js';
import { SALES_PROTOCOL_VERSION } from '../evaluations/run.js';
import { salesWorkspaceProjection } from '../evaluations/projection.js';
import { adminDatabaseUrl as defaultAdminUrl, createScenarioDatabase } from '../harness/database.js';
import { SalesHarness, shiftableClock } from '../harness/runtime.js';
import { scriptedAgent } from '../harness/scripted.js';
import { SALES_AGENT_ID } from '../ids.js';
import { PostgresSalesStore } from '../workspace/store.js';
import { SALES_EXTERNAL_WRITE_CAPABILITIES, SALES_SHADOW_BINDINGS, SALES_SHADOW_OUTBOUND, applySalesFault, applySalesOwnerChange, composeShadowSalesDomains } from './bindings.js';
import { scriptFor } from './corpus.js';
import { evaluateWorkloadInvariants, type ExecutionObservations } from './invariants.js';
import { policyProfile } from './profiles.js';

/**
 * Executes one Sales WorkloadCase in shadow (R4-H), end to end on the real
 * runtime:
 *
 *   workload event ─► canonical ingress (TemporalRuntime.submitInput — what
 *   POST /v1/tasks/:id/inputs calls) ─► AgentTask / Goal ─► real worker
 *   (ContextCompiler, ModelProvider, AgentKernel, capabilities, SalesWorkspace,
 *   ActionRuntime + Policy Engine) ─► guarded domain ports (fixture reads,
 *   shadow Quote owner) ─► receipts / observations ─► `respond` in the step
 *   log ─► ShadowOutboundSink (recorded, never delivered)
 *
 * alongside a real scheduler composition (waits, reconciliation) on the same
 * throwaway database. Operator actions go through the same TemporalRuntime
 * operations the API routes call, as a controlled, simulated trusted
 * operator (no IAM exists yet). The trajectory is then rebuilt from durable
 * state by R4-G's canonical reader, for evaluation.
 *
 * `scripted` (CI) uses the case's stand-in trajectory; `live` a configured
 * real ModelProvider. Nothing else differs.
 */
export const SHADOW_OPERATOR: TrustedHumanContext = {
  humanRef: 'shadow-operator',
  scopes: ['consultation.answer', 'approval.decide', 'handoff.manage', 'task.cancel', 'reconciliation.manage'],
  correlationId: 'shadow-operator',
};

export const SHADOW_RECONCILIATION_POLICY = Object.freeze({ maxAttempts: 5, initialBackoffMs: 0, maxBackoffMs: 0, deadlineMs: 7 * 24 * 3_600_000 });

export interface SalesShadowExecutorOptions {
  readonly adminDatabaseUrl?: string;
  readonly mode: 'scripted' | 'live';
  readonly modelProvider?: ModelProvider;
  readonly modelProfile: ModelProfile;
  readonly modelCallTimeoutMs?: number;
}

export class SalesShadowExecutor implements WorkloadExecutor {
  readonly #options: SalesShadowExecutorOptions;
  readonly #agentHash: string;

  constructor(options: SalesShadowExecutorOptions) {
    if (options.mode === 'live' && !options.modelProvider) throw new Error('live shadow execution needs a configured model provider');
    this.#options = options;
    this.#agentHash = fingerprint(loadSalesAgentDefinition());
  }

  describe(): WorkloadExecutorDescription {
    return {
      agent: { agentId: SALES_AGENT_ID, version: loadSalesAgentDefinition().version, contentHash: this.#agentHash },
      protocolVersion: SALES_PROTOCOL_VERSION,
      modelProfile: this.#options.modelProfile,
      liveModel: this.#options.mode === 'live',
      suiteMode: 'controlled-shadow',
      bindings: SALES_SHADOW_BINDINGS,
      outbound: SALES_SHADOW_OUTBOUND,
      externalWriteCapabilities: SALES_EXTERNAL_WRITE_CAPABILITIES,
    };
  }

  async execute(workload: WorkloadCase, context: WorkloadExecutionContext): Promise<WorkloadExecution> {
    const config = assertShadowMode(context.config);
    const startedAt = new Date().toISOString();
    const adminUrl = this.#options.adminDatabaseUrl ?? defaultAdminUrl(process.env);
    const db = await createScenarioDatabase(adminUrl, 'r4_shadow');
    let harness: SalesHarness | null = null;
    let scheduler: SchedulerPlatform | null = null;
    try {
      const clock = shiftableClock();
      const domains = composeShadowSalesDomains(config, { now: () => clock.now() });
      const inner = this.#options.mode === 'scripted' ? new FakeModelProvider(scriptedAgent(scriptFor(workload.id))) : this.#options.modelProvider!;
      const provider = new ShadowRecordingModelProvider(inner);
      const profile = policyProfile(workload.initialContext.profiles.policy);
      harness = await SalesHarness.start({
        databaseUrl: db.url,
        modelProvider: provider,
        domains: domains.fixtures,
        ports: domains.ports,
        clock,
        actionPolicy: profile.policy,
        workerId: `shadow-worker-${context.repetition}`,
        execution: { modelCallTimeoutMs: this.#options.modelCallTimeoutMs ?? (this.#options.mode === 'live' ? 180_000 : 10_000) },
      });
      scheduler = await createSchedulerPlatform(
        { databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 2, owner: 'shadow-scheduler', leaseMs: 30_000, pollMs: 50, reconciliationPolicy: SHADOW_RECONCILIATION_POLICY },
        { logger: createLogger({ service: 'shadow-scheduler', level: 'silent' }) },
      );
      const sink = createOutboundDelivery(config, SALES_SHADOW_OUTBOUND, { salt: context.salt, now: () => new Date() });
      const h = harness;
      const s = scheduler;
      const taskId = await h.openConversation({ customerRef: workload.initialContext.subjectRef, channelRef: workload.initialContext.channelRef, correlationId: `shadow-${workload.id.toLowerCase()}-r${context.repetition}` });

      let schedulerUp = true;
      let temporalOffsetMs = 0;
      let turnIndex = 0;
      const events: EventLogEntry[] = [];
      const turns: TurnTiming[] = [];
      const inputs: { index: number; applied: boolean; runIds: string[]; afterTerminal: boolean }[] = [];
      let handoff: { takenOverAt: number | null; releasedAt: number | null; runsDuringHandoff: string[]; runsAfterRelease: string[] } | null = null;
      let cancel: ExecutionObservations['cancel'] = null;
      const execution = new PostgresExecutionStore(h.pool);

      /**
       * Worker cycles and scheduler firings until neither has anything left
       * (bounded). Nothing is driven before the first input: a real ingress
       * creates the conversation together with its first message, so the
       * agent must never run on an empty conversation.
       */
      const settle = async (): Promise<string[]> => {
        const runIds: string[] = [];
        if (turnIndex === 0) return runIds;
        for (let round = 0; round < 40; round += 1) {
          const worked = await h.runUntilIdle();
          runIds.push(...worked.runIds);
          let fired = 0;
          if (schedulerUp) while ((await s.scheduler.runOnce()).kind === 'fired') fired += 1;
          if (worked.cycles.length === 0 && fired === 0) break;
        }
        return [...new Set(runIds)];
      };
      const responses = async () => {
        const view = await h.api.tasks.getTask(taskId);
        const out: { stepId: string; runId: string; text: string; at: string }[] = [];
        for (const run of view.runs) {
          for (const step of await execution.transaction((uow) => uow.listRunSteps(run.runId))) {
            if (step.decision?.type === 'respond') out.push({ stepId: step.stepId, runId: run.runId, text: step.decision.content, at: step.createdAt });
          }
        }
        return out;
      };
      const dispatchOutbound = async () => {
        for (const r of await responses()) sink.deliver({ taskRef: taskId, turnIndex: turnIndex || null, responseRef: r.stepId, recipient: workload.initialContext.subjectRef, text: r.text, respondedAt: r.at });
      };
      const taskStatus = async () => (await h.api.tasks.getTask(taskId)).task.status as string;
      const log = (index: number, kind: string, applied: boolean, note: string) => events.push({ index, kind, applied, note: note.slice(0, 300) });
      const afterEvent = (runIds: readonly string[]) => {
        const current = inputs.at(-1);
        if (current) current.runIds.push(...runIds);
        if (handoff && handoff.takenOverAt !== null && handoff.releasedAt === null) handoff.runsDuringHandoff.push(...runIds);
        else if (handoff && handoff.releasedAt !== null) handoff.runsAfterRelease.push(...runIds);
      };

      for (const [index, event] of workload.events.entries()) {
        switch (event.kind) {
          case 'input': {
            turnIndex += 1;
            const terminal = (TERMINAL_TASK_STATUSES as readonly string[]).includes(await taskStatus());
            const record = { index: turnIndex, applied: false, runIds: [] as string[], afterTerminal: terminal };
            inputs.push(record);
            const submittedAt = clock.now();
            const wall = Date.now();
            const before = new Set((await responses()).map((r) => r.stepId));
            try {
              const turn = await h.say(taskId, event.text);
              record.applied = true;
              const more = await settle();
              const runIds = [...new Set([...turn.runIds, ...more])];
              afterEvent(runIds);
              const first = (await responses()).filter((r) => !before.has(r.stepId)).map((r) => Date.parse(r.at)).sort((a, b) => a - b)[0];
              turns.push({ index: turns.length + 1, kind: 'input', submittedAt: submittedAt.toISOString(), wallClockMs: Date.now() - wall, userPerceivedMs: first === undefined ? null : Math.max(0, first - submittedAt.getTime()), runsExecuted: runIds.length });
              log(index, 'input', true, `turn ${turnIndex}: ${runIds.length} run(s)`);
            } catch (error) {
              log(index, 'input', false, `turn ${turnIndex} refused: ${error instanceof Error ? error.message : String(error)}`);
            }
            break;
          }
          case 'advance_time': {
            clock.offsetMs += event.ms;
            if (event.scope === 'process_and_temporal') {
              temporalOffsetMs += event.ms;
              // Simulated time of the throwaway shadow database only (same technique as the E tests).
              await h.pool.query(`create or replace function r4_now() returns timestamptz language sql volatile as $$ select clock_timestamp() + interval '${Math.trunc(temporalOffsetMs)} milliseconds' $$`);
            }
            afterEvent(await settle());
            log(index, 'advance_time', true, `+${event.ms} ms (${event.scope})${event.note ? `: ${event.note}` : ''}`);
            break;
          }
          case 'process': {
            if (event.process === 'worker' && event.action === 'restart') await h.restartWorker();
            else if (event.process === 'scheduler' && event.action === 'stop') schedulerUp = false;
            else if (event.process === 'scheduler' && event.action === 'start') schedulerUp = true;
            else {
              log(index, 'process', false, `unsupported: ${event.process} ${event.action}`);
              break;
            }
            afterEvent(await settle());
            log(index, 'process', true, `${event.process} ${event.action}`);
            break;
          }
          case 'fault': {
            if (event.target === 'model') {
              if (!(MODEL_FAULTS as readonly string[]).includes(event.fault)) throw new Error(`unknown model fault ${event.fault}`);
              provider.injectNext(event.fault as ModelFault);
              log(index, 'fault', true, `model: next call → ${event.fault} (injected)`);
            } else log(index, 'fault', true, applySalesFault(domains, event.target, event.fault));
            break;
          }
          case 'owner_change':
            log(index, 'owner_change', true, applySalesOwnerChange(domains, event.target, event.change, event.params));
            break;
          case 'operator': {
            const wall = Date.now();
            const submittedAt = clock.now();
            const { humans } = await h.api.temporal.inspect(taskId);
            const key = `${event.action}-${index}`;
            let applied = true;
            let note = `${event.action}: `;
            try {
              switch (event.action) {
                case 'answer_consultation': {
                  const open = humans.find((x) => x.kind === 'consultation' && x.status === 'requested');
                  if (!open) throw new Error('no open consultation');
                  await h.api.temporal.respondHuman(open.requestId, { responseKey: key, outcome: 'answer', content: event.text }, SHADOW_OPERATOR);
                  break;
                }
                case 'approve':
                case 'reject': {
                  const open = humans.find((x) => x.kind === 'approval' && x.status === 'requested');
                  if (!open) throw new Error('no pending approval (the agent did not propose a write that required one)');
                  await h.api.temporal.respondHuman(open.requestId, { responseKey: key, outcome: event.action, content: event.text }, SHADOW_OPERATOR);
                  break;
                }
                case 'takeover':
                  await h.api.temporal.takeOver(taskId, { responseKey: key, note: event.text }, SHADOW_OPERATOR);
                  handoff = { takenOverAt: Date.now(), releasedAt: null, runsDuringHandoff: [], runsAfterRelease: [] };
                  break;
                case 'release': {
                  const active = humans.find((x) => x.kind === 'handoff' && (x.status === 'active' || x.status === 'requested'));
                  if (!active) throw new Error('no active handoff');
                  await h.api.temporal.respondHuman(active.requestId, { responseKey: key, outcome: 'release', content: event.text }, SHADOW_OPERATOR);
                  if (handoff) handoff.releasedAt = Date.now();
                  break;
                }
                case 'cancel': {
                  const ledger = await new PostgresActionLedgerStore(h.pool).forTask(taskId);
                  await h.api.temporal.cancelTask(taskId, SHADOW_OPERATOR);
                  cancel = { statusAfterCancel: await taskStatus(), uncertainAtCancel: ledger.executions.filter((e) => e.status === 'needs_reconciliation' || e.status === 'executing').length };
                  break;
                }
              }
              note += 'applied';
            } catch (error) {
              applied = false;
              note += `not applied — ${error instanceof Error ? error.message : String(error)}`;
            }
            const runIds = applied ? await settle() : [];
            afterEvent(runIds);
            turns.push({ index: turns.length + 1, kind: 'operator', submittedAt: submittedAt.toISOString(), wallClockMs: Date.now() - wall, userPerceivedMs: null, runsExecuted: runIds.length });
            log(index, 'operator', applied, note);
            break;
          }
        }
        await dispatchOutbound();
      }

      const state = await h.inspect(taskId);
      const reader = new PostgresTrajectoryReader(h.pool, { projections: [salesWorkspaceProjection(new PostgresSalesStore(h.pool))] });
      const subject = await reader.subject(taskId, { sourceRef: `shadow:${workload.id}@${workload.version}:r${context.repetition}`, modelCalls: provider.calls.map(toModelCallRecord) });
      const caseInvariants = evaluateWorkloadInvariants(workload.expectations.invariants, state, { inputs, handoff, cancel, modelCalls: provider.calls, shadowQuoteKeys: domains.quotes.records.map((r) => r.idempotencyKey) });
      return {
        taskId,
        subject,
        composition: domains.composition,
        records: domains.recorder.records,
        outbound: sink.delivered,
        modelCalls: provider.calls,
        turns,
        caseInvariants,
        events,
        policyProfile: profile.identity,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } finally {
      await scheduler?.close().catch(() => undefined);
      await harness?.close().catch(() => undefined);
      await db.drop().catch(() => undefined);
    }
  }
}
