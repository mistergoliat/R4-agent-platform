import { describe, expect, it } from 'vitest';
import { CATALOG_EVALUATION_CASES, runCatalogEvaluation } from '@r4-sales/agent/evaluations';

/** R4-J1B §12: deterministic Catalog evaluation scenarios (offline; no live catalog-service). */
describe('Catalog evaluation scenarios (J1B §12)', () => {
  it('covers the fifteen scenarios, each in exactly one dimension', () => {
    expect(CATALOG_EVALUATION_CASES.map((c) => c.scenario)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(new Set(CATALOG_EVALUATION_CASES.map((c) => c.id)).size).toBe(15);
  });

  it.each(CATALOG_EVALUATION_CASES.map((c) => [c.scenario, c.id, c] as const))('§12.%i %s', async (_, __, c) => {
    const outcome = await c.run();
    expect(outcome.passed, outcome.detail).toBe(true);
  });

  it('reports per dimension, with no global score', async () => {
    const report = await runCatalogEvaluation();
    expect(report.byDimension).toEqual({ platform_correctness: { passed: 5, failed: 0 }, agent_quality: { passed: 8, failed: 0 }, business_outcome: { passed: 2, failed: 0 } });
    expect(Object.keys(report).sort()).toEqual(['byDimension', 'cases']);
    expect(JSON.stringify(report)).not.toMatch(/"(score|total|overall)"/);
  });
});
