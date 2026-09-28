import { FakeModelProvider } from '@r4/model-gateway';
import { createLogger } from '@r4/observability';
import { createPool } from '@r4/persistence-postgres';
import { ShadowRecordingModelProvider, loadShadowExecutionConfig } from '@r4/shadow';
import { loadWorkerConfig, runWorkerProcess } from '@r4/worker';
import { composeSales } from '../composition.js';
import { scriptedAgent } from '../harness/scripted.js';
import { applySalesFault, composeShadowSalesDomains } from './bindings.js';
import { scriptFor } from './corpus.js';
import { policyProfile } from './profiles.js';

/**
 * A shadow Sales worker as an OS process (R4-H multi-process E2E). The same
 * generic `runWorkerProcess` a deployment would run, composed with the Sales
 * pack over GUARDED shadow ports — it refuses to start unless
 * R4_EXECUTION_MODE=shadow. The model is the case's scripted stand-in
 * (`R4_SHADOW_CASE`, from step `R4_SHADOW_SCRIPT_FROM`): this process exists
 * to prove process boundaries in CI, not model behavior.
 *
 * Every external call and model call is emitted as one metadata-only JSON
 * line on stdout (`shadow.side_effect`, `shadow.model_call`), so the parent
 * can build the side-effect manifest even after this process is killed.
 */
const config = loadShadowExecutionConfig(process.env);
const caseId = process.env.R4_SHADOW_CASE;
if (!caseId) throw new Error('R4_SHADOW_CASE is required');
const from = Number(process.env.R4_SHADOW_SCRIPT_FROM ?? '0');
const emit = (event: string, data: object) => process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);

const domains = composeShadowSalesDomains(config, { now: () => new Date(), onRecord: (record) => emit('shadow.side_effect', record) });
for (const f of JSON.parse(process.env.R4_SHADOW_FAULTS ?? '[]') as { target: string; fault: string }[]) applySalesFault(domains, f.target, f.fault);
const provider = new ShadowRecordingModelProvider(new FakeModelProvider(scriptedAgent(scriptFor(caseId).slice(from))), { onCall: (call) => emit('shadow.model_call', call) });
const workerConfig = loadWorkerConfig(process.env);
const pool = createPool({ connectionString: workerConfig.databaseUrl, logger: createLogger({ service: 'shadow-sales-worker', level: 'silent' }), applicationName: `shadow-sales:${workerConfig.workerId}`.slice(0, 63), max: 2 });
const sales = composeSales({ pool, domains: domains.ports, modelProvider: provider });
await runWorkerProcess(workerConfig, { ...sales.bindings, actionPolicy: policyProfile(process.env.R4_SHADOW_POLICY_PROFILE).policy, presence: { executionMode: 'shadow', runtimeProfile: 'sales-shadow@1' } });
emit('shadow.worker.started', { caseId, from, bindings: domains.composition.bindings.map((b) => `${b.domain}=${b.kind}`) });
