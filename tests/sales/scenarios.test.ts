import { afterEach, describe, expect, it } from 'vitest';
import { ALL_SCENARIOS, CENTRAL_SCENARIO, SCENARIOS, migrateSales, runScenario, type ScenarioRun } from '@r4-sales/agent';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-F acceptance scenarios, offline and deterministic: the scripted
 * stand-in model, the fixture domain owners and a real PostgreSQL. What is
 * asserted is platform + pack semantics (invariants over durable state),
 * never the quality of language — that is `npm run sales:live`, not CI.
 */

let db: TestDatabase | null = null;

afterEach(async () => {
  await db?.drop();
  db = null;
});

async function run(id: string): Promise<ScenarioRun> {
  db = await createMigratedTestDatabase();
  const pool = openPool(db.url);
  try {
    await migrateSales(pool);
  } finally {
    await pool.end();
  }
  const scenario = ALL_SCENARIOS.find((s) => s.id === id)!;
  return runScenario(scenario, { databaseUrl: db.url, mode: 'scripted' });
}

function failures(result: ScenarioRun): string[] {
  return result.invariants.filter((r) => !r.passed).map((r) => `${r.invariant.kind}: ${r.detail}`);
}

describe('R4-F acceptance scenarios (scripted, offline)', () => {
  it('covers S01–S15 plus the extra and central cases', () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    for (let n = 1; n <= 15; n += 1) expect(ids).toContain(`S${String(n).padStart(2, '0')}`);
    expect(ids).toContain('CENTRAL');
    // Each scenario states what must hold, and every scenario checks the no-false-success rule.
    for (const s of ALL_SCENARIOS) expect(s.invariants.map((i) => i.kind), s.id).toContain('no_unbacked_quote_claim');
  });

  it.each(SCENARIOS.map((s) => [s.id, s.title]))('%s — %s', async (id) => {
    const result = await run(id);
    expect(failures(result)).toEqual([]);
    // The report is structured and reusable (R4-G input): every model call is a recorded decision.
    expect(result.report.decisions.length).toBe(result.report.tokens.modelCalls);
    expect(result.report.decisions.every((d) => d.outcome !== 'invalid' && d.outcome !== 'model_failed')).toBe(true);
  });

  it(`${CENTRAL_SCENARIO.id} — ${CENTRAL_SCENARIO.title}`, async () => {
    const result = await run(CENTRAL_SCENARIO.id);
    expect(failures(result)).toEqual([]);
    const { report } = result;
    expect(report.finalTaskStatus).toBe('waiting');
    expect(report.turns).toHaveLength(5);
    // The quote the agent reports is the Quote owner's, from the receipt: total = owner-priced lines + owner shipping.
    const quote = report.receipts.find((r) => r.capabilityId === 'quote.create')!;
    expect(quote).toMatchObject({ status: 'succeeded', externalOperationRef: 'COT-100001' });
    expect(report.turns.at(-1)!.agentResponses.join(' ')).toContain('COT-100001');
    expect(report.turns.at(-1)!.agentResponses.join(' ')).toContain('$932.331');
    // Context accounting is available per snapshot (C2 telemetry reused), incl. the Sales workspace source.
    expect(report.context.length).toBeGreaterThan(0);
    expect(report.context.every((c) => (c.includedTokensBySource['sales.workspace'] ?? 0) > 0)).toBe(true);
  });
});
