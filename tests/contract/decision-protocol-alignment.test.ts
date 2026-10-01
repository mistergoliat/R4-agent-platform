import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DECISION_PROTOCOL, PROTOCOL_INSTRUCTIONS } from '@r4/agent-kernel';

/**
 * R4-J1E-R2.2.1 — the model-facing decision protocol must say what the
 * runtime does: a `respond` is sent to the requester and ends the current turn
 * (the kernel then records a platform WAIT_FOR_INPUT; no decision follows).
 * These checks read the semantics, not a stored copy of the text: each
 * required property and each retired claim is a separate assertion, and the
 * runtime side is checked in the kernel source.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const text = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const respondLine = PROTOCOL_INSTRUCTIONS.split('\n').find((l) => l.startsWith('- {"type":"respond"'))!;
/** The contract's own documentation of `respond` (decision.ts header bullet). */
const contractDoc = /\* - respond:([\s\S]*?)\n \* - complete:/.exec(text('packages/contracts/src/decision.ts'))![1]!;
const salesInstructions = (JSON.parse(text('agents/sales/sales.agent.json')) as { instructions: string }).instructions;

/** Claims of the retired (v4) semantics: respond as intermediate, undelivered, non-terminal, continued. */
const RETIRED = [
  /intermediate output/i,
  /not delivered/i,
  /does not end/i,
  /never terminal/i,
  /\bcontinue[sd]? (?:working |deciding |acting )?after (?:a |the |your )?(?:respond|reply|response)/i,
  /\(respond\)\s*;\s*then wait/i,
  /then wait for the customer/i,
];

describe('R4-J1E-R2.2.1 decision protocol and runtime agree on respond', () => {
  it('the protocol version is v5 and is stated to the model', () => {
    expect(DECISION_PROTOCOL).toBe('r4.agent_decision.v5');
    expect(PROTOCOL_INSTRUCTIONS.split('\n')[0]).toBe('Decision protocol r4.agent_decision.v5.');
  });

  it('the model is told respond is sent to the requester', () => {
    expect(respondLine).toMatch(/\bsends? the text to the requester\b/);
  });

  it('the model is told respond ends the current turn and nothing follows it until new input', () => {
    expect(respondLine).toMatch(/\bends your current turn\b/);
    expect(respondLine).toMatch(/no decision follows it until new input arrives/);
  });

  it('the model is told every read, state update and action comes before responding', () => {
    expect(respondLine).toMatch(/\bread\b[^.]*\bstate update\b[^.]*\bproposed action\b[^.]*\bbefore responding\b/);
  });

  it('the model is told not to wait after respond: the platform waits by itself', () => {
    expect(respondLine).toMatch(/\bnever emit wait after respond\b/i);
    expect(respondLine).toMatch(/\bthe platform waits for the next input\b/);
  });

  it.each(RETIRED.map((pattern) => [String(pattern), pattern] as const))('no source describes the retired semantics %s', (_name, pattern) => {
    expect(PROTOCOL_INSTRUCTIONS).not.toMatch(pattern);
    expect(contractDoc).not.toMatch(pattern);
    expect(salesInstructions).not.toMatch(pattern);
  });

  it('the agent instructions never script a wait decision (the platform owns the turn-closing wait)', () => {
    expect(salesInstructions).not.toMatch(/WAIT_FOR_INPUT|\(wait\b|"type":"wait"/);
    expect(salesInstructions).toMatch(/A respond ends your turn/);
  });

  it('the contract documentation states the same semantics', () => {
    expect(contractDoc).toMatch(/ENDS the current turn/);
    expect(contractDoc).toMatch(/no further[\s*]+decision/);
    expect(contractDoc).toMatch(/belongs[\s*]+before it/);
  });

  it('the runtime does what the protocol says: a recorded respond closes the turn with a platform WAIT_FOR_INPUT', () => {
    const kernel = text('packages/agent-kernel/src/kernel.ts');
    expect(kernel).toMatch(/if \(turnResponse\) return this\.#endTurn\(/);
    expect(kernel).toMatch(/condition: \{ kind: 'WAIT_FOR_INPUT' \}/);
    expect(kernel).toMatch(/origin: 'platform'/);
  });
});
