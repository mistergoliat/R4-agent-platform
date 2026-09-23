import { existsSync } from 'node:fs';
import type { InvariantResult } from '../harness/invariants.js';
import type { ScenarioReport } from '../harness/report.js';

/** Loads `.env` from the working directory when present (local development only). */
export function loadLocalEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** Human-readable summary of a report (the JSON artifact has everything). */
export function printReport(report: ScenarioReport, invariants: readonly InvariantResult[]): void {
  print(`\n=== ${report.scenario.id} — ${report.scenario.title} (${report.mode}) — task ${report.finalTaskStatus}`);
  for (const turn of report.turns) {
    print(`\n[${turn.kind} ${turn.index}] ${turn.text}`);
    for (const response of turn.agentResponses) print(`  agent> ${response}`);
  }
  print('\ndecisions:');
  for (const d of report.decisions) print(`  run ${d.runSequence}#${d.iteration} ${d.type ?? '-'}${d.capabilityId ? ` ${d.capabilityId}` : ''} → ${d.outcome}${d.errorCode ? ` (${d.errorCode})` : ''}`);
  print(`\ngoals: ${report.goals.map((g) => `${g.isCurrent ? '*' : ''}${g.description} [${g.status}]`).join(' | ')}`);
  print(`workspace v${report.workspace.version}: ${JSON.stringify(report.workspace.state)}`);
  print(`receipts: ${report.receipts.map((r) => `${r.capabilityId}:${r.status}${r.externalOperationRef ? `(${r.externalOperationRef})` : ''}`).join(', ') || 'none'}`);
  print(`tokens: in=${report.tokens.input} out=${report.tokens.output} calls=${report.tokens.modelCalls}`);
  print('\ninvariants:');
  for (const r of invariants) print(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.invariant.kind} — ${r.detail}`);
}
