import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fact, migrateSales, respond, runScenario, update, waitForCustomer, type SalesScenario } from '@r4-sales/agent';
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
    { customer: 'Tengo 800 mil.', agent: [update([fact('budget', { amount: 800_000, currency: 'CLP' })]), respond('¡Listo! Tu cotización COT-100001 fue creada.'), waitForCustomer()] },
    { customer: 'Ok', agent: [respond('¿Cuál es tu presupuesto?'), waitForCustomer()] },
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
