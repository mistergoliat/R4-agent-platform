import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AT-ALT-01 (SEC-OTP decision §10; gates BA-01…BA-06): the inventory of every route and runtime call that
// writes text into a task or its context. Only E-1 (the channel webhook, through ChannelIngress) passes the
// identity-verification inspector; every other entry is NOT an equivalent protected channel input and stays
// a gate of real activation. A new route or caller fails this test until it is classified here.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const text = (f: string) => readFileSync(join(ROOT, f), 'utf8');
function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : path.endsWith('.ts') ? [path.replace(/\\/g, '/')] : [];
  });
}

/** Every mutating route of the API, with its classification (decision §10; the SEC-S3 report updates it). */
const API_WRITE_ROUTES: Readonly<Record<string, string>> = {
  'POST /v1/tasks': 'E-3 BA-02 request.input enters the context',
  'POST /v1/tasks/:id/inputs': 'E-2 BA-01 a channel-equivalent input WITHOUT inspection',
  'POST /v1/tasks/:id/cancel': 'no text (empty body)',
  'POST /v1/tasks/:id/handoff': 'E-5 BA-04 takeover note enters the context',
  'POST /v1/human-requests/:id/respond': 'E-4 BA-03 human content enters the context',
  'POST /v1/executions/:id/reconciliation/reschedule': 'no free text (responseKey identifier only)',
  'POST /v1/production/controls': 'E-9 BA-02 procedure: operator reason, persisted in control events (not in task context)',
  'POST /v1/tasks/:id/operator-messages': 'E-6 BA-05 operator text, persisted and sent to the customer',
  'POST /v1/outbound/:id/resolve': 'E-7 BA-02 procedure: operator note',
  'POST /v1/outbound/:id/cancel': 'no text (empty body)',
};

describe('AT-ALT-01: alternative inputs are inventoried and none of them is treated as a protected channel input', () => {
  it('the API exposes exactly the classified mutating routes', () => {
    const routes = [...text('apps/api/src/app.ts').matchAll(/app\.(post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    expect(routes.sort()).toEqual(Object.keys(API_WRITE_ROUTES).sort());
  });

  it('the channel gateway exposes one mutating route: the webhook (E-1), whose content passes the inspector', () => {
    const routes = [...text('apps/channel-gateway/src/platform.ts').matchAll(/app\.(post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    expect(routes).toEqual(['POST /v1/channels/:channel/webhook']);
    expect(text('apps/channel-gateway/src/platform.ts')).toMatch(/ingress\.receive\(request\.params\.channel, raw, headers/);
    expect(text('packages/live-ops/src/ingress.ts')).toMatch(/recordInboundInspected\(inbound, \{/);
  });

  it('runtime code that submits task inputs is exactly the known set', () => {
    const runtime = [...files('packages'), ...files('apps'), ...files('agents/sales/src'), ...files('adapters')];
    const callers = runtime.filter((f) => /\.submitInput\(/.test(text(f)) && !f.startsWith('packages/task-runtime/'));
    expect(callers.sort()).toEqual([
      // E-8: the Sales harness (the shadow executor goes through it): synthetic corpus; BA-06, never fed real traffic outside the protected ingress.
      'agents/sales/src/harness/runtime.ts',
      // E-2.
      'apps/api/src/app.ts',
      // E-1: the channel ingress, after the inspected transaction.
      'packages/live-ops/src/ingress.ts',
    ].sort());
  });
});
