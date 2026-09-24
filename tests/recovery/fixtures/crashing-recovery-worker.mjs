// Child process for tests/recovery/run-failure-recovery-crash.test.ts.
// A real worker process (built @r4/worker, real heartbeats) whose model first
// answers with invalid output (valid JSON + prose → invalid_decision, a
// recoverable run failure, ADR-028) and then hangs forever inside the
// recovery run, so the parent can SIGKILL it mid-recovery. Test-only.
import { CapabilityRegistry } from '@r4/capability-runtime';
import { FakeModelProvider } from '@r4/model-gateway';
import { loadWorkerConfig, runWorkerProcess } from '@r4/worker';

const modelProvider = new FakeModelProvider((_request, index) =>
  index === 0 ? { type: 'text', content: '{"type":"respond","content":"x"}\n\nEspero que te sirva.' } : { type: 'timeout' },
);

await runWorkerProcess(loadWorkerConfig(process.env), { modelProvider, capabilities: new CapabilityRegistry() });
