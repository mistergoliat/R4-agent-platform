import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fact, factValueMatches, migrateSales, respond, runScenario, update, type SalesScenario } from '@r4-sales/agent';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/** The invariants must catch the failures they name, or passing scenarios would prove nothing. */

let db: TestDatabase;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  const pool = openPool(db.url);
  try {
    await migrateSales(pool);
  } finally {
    await pool.end();
  }
});

afterAll(async () => {
  await db?.drop();
});

const LYING: SalesScenario = {
  id: 'NEG1',
  title: 'false quote claim, repeated question, lost selection',
  turns: [
    { customer: 'Tengo 800 mil.', agent: [update([fact('budget', { amount: 800_000, currency: 'CLP' })]), respond('¡Listo! Tu cotización COT-100001 fue creada.')] },
    { customer: 'Ok', agent: [respond('¿Cuál es tu presupuesto?')] },
  ],
  invariants: [
    { kind: 'no_unbacked_quote_claim' },
    { kind: 'no_question_after_fact', key: 'budget', topic: 'presupuesto' },
    { kind: 'selection_equals', items: [{ productId: 'BAR-OLY20', quantity: 1 }] },
    { kind: 'quotes_issued', equals: 1 },
    { kind: 'goal_kept', matches: 'gimnasio' },
  ],
};

describe('scenario invariants detect violations', () => {
  it('flags a claimed quote without receipt, a repeated question, a wrong selection and a missing goal', async () => {
    const run = await runScenario(LYING, { databaseUrl: db.url, mode: 'scripted' });
    expect(run.passed).toBe(false);
    expect(Object.fromEntries(run.invariants.map((r) => [r.invariant.kind, r.passed]))).toEqual({
      no_unbacked_quote_claim: false,
      no_question_after_fact: false,
      selection_equals: false,
      quotes_issued: false,
      goal_kept: false,
    });
    expect(run.invariants[0]!.detail).toMatch(/COT-100001 without a prior receipt/);
  });
});

/**
 * R4-F live validation (S02, DeepSeek): the agent recorded the customer's
 * budget as `presupuesto_clp: 800000` — a valid workspace fact, since the
 * Sales pack prescribes no key or shape — and `fact_equals budget` reported
 * `budget = null`. The invariant was checking the scripted trajectory's
 * naming, not the property. It now names the fact by pattern and accepts a
 * bare amount for a money value; the workspace is never adapted to it.
 */
describe('budget invariants follow the fact, not one key spelling (live regression)', () => {
  const BUDGET = { matches: '^(budget|presupuesto)(_|$)' };
  const scenario = (operations: Parameters<typeof update>[0], invariants: SalesScenario['invariants']): SalesScenario => ({
    id: 'NEG-BUDGET',
    title: 'budget recorded under a key the agent chose',
    turns: [{ customer: 'Tengo $800.000 y quiero armar un gym para la casa.', agent: [update(operations), respond('Anotado.')] }],
    invariants,
  });

  it('passes on the exact live workspace shape (presupuesto_clp: 800000)', async () => {
    const run = await runScenario(
      scenario([fact('presupuesto_clp', 800_000), fact('objetivo', 'armar un gym para la casa')], [
        { kind: 'fact_equals', key: BUDGET, value: { amount: 800_000, currency: 'CLP' } },
        { kind: 'fact_history', key: BUDGET, values: [{ amount: 800_000, currency: 'CLP' }] },
        // What the old invariant checked: it can only see its own spelling.
        { kind: 'fact_equals', key: 'budget', value: { amount: 800_000, currency: 'CLP' } },
      ]),
      { databaseUrl: db.url, mode: 'scripted' },
    );
    expect(run.invariants.map((r) => [r.passed, r.detail])).toEqual([
      [true, 'presupuesto_clp = 800000'],
      [true, 'history [800000]; 1 current value(s)'],
      [false, 'budget = null'],
    ]);
  });

  it('still fails on a wrong amount, and on two contradicting budget facts', async () => {
    const run = await runScenario(
      scenario([fact('presupuesto_clp', 800_000), fact('budget', { amount: 600_000, currency: 'CLP' })], [
        { kind: 'fact_equals', key: BUDGET, value: { amount: 800_000, currency: 'CLP' } },
        { kind: 'fact_history', key: BUDGET, values: [{ amount: 800_000, currency: 'CLP' }, { amount: 600_000, currency: 'CLP' }] },
      ]),
      { databaseUrl: db.url, mode: 'scripted' },
    );
    expect(run.invariants.map((r) => r.passed)).toEqual([false, false]);
    expect(run.invariants[1]!.detail).toContain('2 current value(s)');
  });

  it('interprets only the money representation, nothing else', () => {
    const clp = { amount: 800_000, currency: 'CLP' };
    expect(factValueMatches(800_000, clp)).toBe(true);
    expect(factValueMatches({ amount: 800_000 }, clp)).toBe(true);
    expect(factValueMatches({ amount: 800_000, currency: 'clp' }, clp)).toBe(true);
    expect(factValueMatches({ amount: 800_000, currency: 'USD' }, clp)).toBe(false);
    expect(factValueMatches('800000', clp)).toBe(false);
    expect(factValueMatches(799_999, clp)).toBe(false);
    expect(factValueMatches(2, 2)).toBe(true);
    expect(factValueMatches(2, 3)).toBe(false);
  });
});
