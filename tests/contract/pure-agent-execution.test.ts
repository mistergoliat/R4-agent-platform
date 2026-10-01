import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as contracts from '@r4/contracts';
import * as kernel from '@r4/agent-kernel';
import { TELEMETRY_EVENTS } from '@r4/observability';

/**
 * R4-J1E-R2.2 — pure agent execution. No synchronous semantic, commercial or
 * grounding judge may sit between AgentDecision.respond and outbound
 * (ADR-031 superseded). Response quality is evaluated post-hoc; authority
 * over side effects stays in the action path (ADR-016/017). These checks fail
 * if a response validator, its verdicts, its recovery machinery or its
 * production binding come back.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const text = (path: string) => readFileSync(join(ROOT, path), 'utf8');
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}
const runtime = ['packages', 'apps', 'agents', 'adapters'].flatMap(sources).map((p) => relative(ROOT, join(ROOT, p)).replace(/\\/g, '/'));

describe('R4-J1E-R2.2 no synchronous response judge between respond and outbound', () => {
  it('Core exports no response-authority contract, validator, verdict or recovery state', () => {
    expect(Object.keys(contracts).filter((k) => /response_?authority|ResponseAuthority|AUTHORITY_CORRECTIONS|REVALIDATION_READS/i.test(k))).toEqual([]);
    expect(Object.keys(kernel).filter((k) => /ResponseAuthority|responseAuthority/i.test(k))).toEqual([]);
  });

  it('no runtime source wires, implements or produces response-authority verdicts', () => {
    // Only the run-step contract documents the durable codes of R4-J1E-R2 history (readable, never produced).
    const mentions = runtime.filter((p) => /response_authority|ResponseAuthority|responseAuthority/.test(text(p)));
    expect(mentions).toEqual(['packages/contracts/src/run-step.ts']);
    expect(text('packages/contracts/src/run-step.ts')).toMatch(/nothing produces them any more/);
  });

  it('the kernel takes no validator: its options are the model gateway and the logger', () => {
    const source = text('packages/agent-kernel/src/kernel.ts');
    expect(source).toMatch(/export interface AgentKernelOptions \{\n {2}readonly gateway: ModelGateway;\n {2}readonly logger: StructuredLogger;\n\}/);
    // Protocol validation stays (validate decision); a response validator, degradation or correction cycle does not.
    expect(source).not.toMatch(/Validator|degrad|correction|notBefore|revalidat/);
  });

  it('a respond is recorded as decided and closes the turn', () => {
    const source = text('packages/agent-kernel/src/kernel.ts');
    expect(source).toMatch(/case 'respond': \{[^}]*session\.recordStep\(step\(\{ decision, outcome: 'recorded'/);
    expect(source).toMatch(/if \(turnResponse\) return this\.#endTurn\(/);
  });

  it('no response-authority telemetry remains', () => {
    expect(TELEMETRY_EVENTS.filter((e) => e.startsWith('response.authority'))).toEqual([]);
  });

  it('the Sales production composition binds no response check (Catalog stays a READ capability only)', () => {
    const composition = text('agents/sales/src/production/composition.ts');
    expect(composition).not.toMatch(/Validator|authority/i);
    expect(runtime.filter((p) => p.startsWith('agents/sales/src/authority/'))).toEqual([]);
  });
});
