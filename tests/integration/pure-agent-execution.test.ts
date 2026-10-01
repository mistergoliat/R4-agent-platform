import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_PRODUCTS, FixtureCatalog, type FixtureProductRecord } from '@r4-adapters/domains';
import { LiveOpsTestbed, say } from '../support/live-ops.js';

/**
 * R4-J1E-R2.2 — pure agent execution over the REAL production compositions
 * (gateway + Sales production worker, profile sales-production@2, Catalog
 * REAL through a fixture owner that derives price basis and sellability the
 * way catalog-service does).
 *
 * A protocol-valid `respond` is persisted and sent exactly as the agent
 * decided it — right or wrong — and is terminal for the turn. Nothing judges
 * it on the way out: its quality is an Evaluation/Reviewer concern, post-hoc,
 * over the durable trajectory this test reads back.
 */

const CUSTOMER = '56977778888';
const QUESTION = '¿Cuánto cuesta la colchoneta Oxford negro/rojo de segunda selección?';
const OXFORD_REPLY =
  'La Colchoneta Oxford Negro/Rojo 100x50x5cm de 2da Selección figura a $6.296, pero está sin stock y no se puede pedir. La versión nueva está disponible a $13.990.';

const base = FIXTURE_PRODUCTS[0]!;
const product = (overrides: Pick<FixtureProductRecord, 'productId' | 'productKey' | 'sku' | 'name' | 'regularGross' | 'availableQuantity'> & { finalGross?: number }): FixtureProductRecord => ({
  ...base,
  ...overrides,
  finalGross: overrides.finalGross ?? overrides.regularGross,
  shortDescription: null,
  specifications: [],
  promotion: null,
  backorderAllowed: false,
  weightKg: 2,
  variants: [],
  frequentlyBoughtTogether: [],
  searchTerms: ['colchoneta', 'oxford'],
});
/** The two products of the Oxford incident, as the owner stored them. */
const OXFORD_CATALOG = [
  // As in production: discounted from the regular $13.990 to $6.296, out of stock.
  product({ productId: '2340', productKey: 'P2340', sku: 'FICLE3-SU55', name: 'Colchoneta Oxford Negro/Rojo 100x50x5cm - 2da Selección', regularGross: 13_990, finalGross: 6_296, availableQuantity: 0 }),
  product({ productId: '872', productKey: 'P872', sku: 'OX-NEW', name: 'Colchoneta Oxford Negro/Rojo 100x50x5cm', regularGross: 13_990, availableQuantity: 8 }),
];
const search = { type: 'structured' as const, data: { type: 'read_capability', capabilityId: 'catalog.search', arguments: { query: 'colchoneta oxford' } } };
const productContext = { type: 'structured' as const, data: { type: 'read_capability', capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P2340' } } };

let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

async function turn(...script: Parameters<LiveOpsTestbed['next']>) {
  bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, env: { R4_PROD_POLICY_PROFILE: 'sales-production@2' }, catalog: Object.assign(new FixtureCatalog({ products: OXFORD_CATALOG }), { bindingKind: 'real' }) });
  bed.next(...script);
  await bed.customer(CUSTOMER, 'wamid.in.1', QUESTION);
  const worker = await bed.worker('worker-1');
  for (let i = 0; i < 5 && (await worker.worker.runOnce()).kind !== 'idle'; i += 1);
  const taskId = await bed.taskOf(CUSTOMER);
  await bed.deliver();
  await bed.deliver();
  return { taskId, worker };
}

/** The durable trajectory a Reviewer would read: runs, steps, observations, outbound. */
async function trajectory(taskId: string) {
  const runs = await bed!.rows<{ run_id: string; status: string; termination_reason: string | null; model_calls: number }>(
    'select run_id, status, termination_reason, model_calls from agent_runs where task_id = $1 order by sequence',
    [taskId],
  );
  const steps = await bed!.rows<{ run_id: string; decision_type: string | null; outcome: string; origin: string; error_code: string | null; capability: string | null; content: string | null; snapshot: string | null; input_tokens: number }>(
    `select run_id, decision_type, outcome, origin, error_code, decision->>'capabilityId' as capability, decision->>'content' as content, context_snapshot_id as snapshot, input_tokens
       from agent_run_steps where task_id = $1 order by created_at, iteration`,
    [taskId],
  );
  const observations = await bed!.rows<{ capability_id: string; payload: { results?: { productKey: string; price: { kind: string; basis: string; finalGross: { amount: number } }; availability: { sellability: string; reason: string } }[] } }>(
    `select capability_id, payload from observations where task_id = $1 order by observed_at`,
    [taskId],
  );
  const outbound = await bed!.rows<{ status: string }>('select status from outbound_messages where task_id = $1', [taskId]);
  const schedules = await bed!.rows('select kind from schedules where task_id = $1', [taskId]);
  return { runs, steps, observations, outbound, schedules };
}

const shape = (steps: Awaited<ReturnType<typeof trajectory>>['steps']) => steps.map((s) => [s.decision_type, s.outcome, s.origin, s.error_code ?? s.capability]);

describe('R4-J1E-R2.2 pure agent execution (production compositions)', () => {
  it('Oxford regression: the correct reply about P2340 (not offerable, out of stock) and P872 is sent as is, once; the turn ends; no model call after it', async () => {
    const { taskId } = await turn(search, say(OXFORD_REPLY), say('a second reply must never be asked for'));
    const t = await trajectory(taskId);

    // Catalog said exactly what the incident's Catalog said.
    const results = t.observations.find((o) => o.capability_id === 'catalog.search')!.payload.results!;
    expect(results.find((r) => r.productKey === 'P2340')).toMatchObject({ price: { kind: 'exact', basis: 'not_offerable', finalGross: { amount: 6_296 } }, availability: { sellability: 'not_sellable', reason: 'out_of_stock' } });
    expect(results.find((r) => r.productKey === 'P872')).toMatchObject({ price: { kind: 'exact', basis: 'offerable', finalGross: { amount: 13_990 } }, availability: { sellability: 'sellable', reason: 'in_stock' } });

    expect(shape(t.steps)).toEqual([
      ['read_capability', 'observed', 'model', 'catalog.search'],
      ['respond', 'recorded', 'model', null],
      ['wait', 'recorded', 'platform', null], // the turn ends: platform WAIT_FOR_INPUT, token-free
    ]);
    expect(t.steps.some((s) => s.outcome === 'refused' || (s.error_code ?? '').startsWith('response_authority'))).toBe(false);
    expect(t.runs).toEqual([{ run_id: expect.any(String), status: 'suspended', termination_reason: 'waiting', model_calls: 2 }]);
    expect(bed!.pendingSteps).toBe(1); // the scripted second reply was never requested
    expect(t.schedules).toEqual([]); // no WAIT_UNTIL of any kind
    expect(bed!.provider.sends.map((s) => s.text)).toEqual([OXFORD_REPLY]);
    expect(t.outbound).toHaveLength(1);
    expect((await bed!.rows<{ status: string }>('select status from agent_tasks where task_id = $1', [taskId]))[0]!.status).toBe('waiting');
  });

  it('exact production Oxford draft: recorded and sent once, never validated, corrected or degraded; the platform closes the turn; the next inbound opens a new run', async () => {
    const PRODUCTION_DRAFT =
      'La Colchoneta Oxford Negro/Rojo 100x50x5cm de 2da Selección (FICLE3-SU55) figura a $6.296 CLP, con descuento sobre su precio normal de $13.990 CLP — pero es un precio de referencia: hoy aparece sin stock, así que no se puede pedir.\n\n' +
      'La versión nueva, misma medida (100x50x5 cm), sí está disponible y sellable a $13.990 CLP.';
    const { taskId, worker } = await turn(search, say(PRODUCTION_DRAFT), say('a second reply must never be asked for'));
    const t = await trajectory(taskId);

    const results = t.observations[0]!.payload.results!;
    expect(results.find((r) => r.productKey === 'P2340')).toMatchObject({ price: { kind: 'exact', basis: 'not_offerable', finalGross: { amount: 6_296 } }, availability: { sellability: 'not_sellable', reason: 'out_of_stock' } });
    expect(shape(t.steps)).toEqual([
      ['read_capability', 'observed', 'model', 'catalog.search'],
      ['respond', 'recorded', 'model', null], // recorded exactly as drafted
      ['wait', 'recorded', 'platform', null], // platform WAIT_FOR_INPUT
    ]);
    expect(t.steps[1]!.content).toBe(PRODUCTION_DRAFT);
    const [closing] = await bed!.rows<{ condition: string }>(`select decision->'condition'->>'kind' as condition from agent_run_steps where task_id = $1 and decision_type = 'wait'`, [taskId]);
    expect(closing!.condition).toBe('WAIT_FOR_INPUT');
    // Zero semantic validation, correction or degradation: nothing refused, no authority code, no platform READ or reply.
    expect(t.steps.filter((s) => s.outcome === 'refused' || (s.error_code ?? '').startsWith('response_authority') || (s.origin === 'platform' && s.decision_type !== 'wait'))).toEqual([]);
    expect(t.schedules).toEqual([]);
    expect(bed!.pendingSteps).toBe(1); // zero model calls after the response
    expect(t.runs).toEqual([{ run_id: expect.any(String), status: 'suspended', termination_reason: 'waiting', model_calls: 2 }]);
    expect(bed!.provider.sends.map((s) => s.text)).toEqual([PRODUCTION_DRAFT]);
    expect(t.outbound).toHaveLength(1);

    // The next inbound opens a NEW run (the scripted second reply answers it).
    await bed!.customer(CUSTOMER, 'wamid.in.2', 'Ok, gracias');
    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    const runs = (await trajectory(taskId)).runs;
    expect(runs.map((r) => [r.status, r.model_calls])).toEqual([['suspended', 2], ['suspended', 1]]);
    expect(runs[1]!.run_id).not.toBe(runs[0]!.run_id);
  });

  it('read → read → respond → FIN over Catalog', async () => {
    const { taskId } = await turn(search, productContext, say(OXFORD_REPLY), search);
    const t = await trajectory(taskId);
    expect(shape(t.steps)).toEqual([
      ['read_capability', 'observed', 'model', 'catalog.search'],
      ['read_capability', 'observed', 'model', 'catalog.get_product_context'],
      ['respond', 'recorded', 'model', null],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(bed!.pendingSteps).toBe(1); // no READ after the response
    expect(bed!.provider.sends).toHaveLength(1);
  });

  it('deliberately wrong reply ("Sí, tenemos stock" while Catalog says out_of_stock) passes the harness unchanged and stays auditable', async () => {
    const WRONG = 'Sí, tenemos stock de la Colchoneta Oxford Negro/Rojo de 2da Selección, a $6.296.';
    const { taskId } = await turn(search, say(WRONG));
    const t = await trajectory(taskId);
    // Sent as the agent decided: not corrected, replaced, degraded or retried.
    expect(bed!.provider.sends.map((s) => s.text)).toEqual([WRONG]);
    expect(shape(t.steps)).toEqual([
      ['read_capability', 'observed', 'model', 'catalog.search'],
      ['respond', 'recorded', 'model', null],
      ['wait', 'recorded', 'platform', null],
    ]);
    // The contradiction is auditable post-hoc: the owner evidence, the decision (with the context it was made in) and the outbound are durable.
    const evidence = t.observations[0]!.payload.results!.find((r) => r.productKey === 'P2340')!;
    expect(evidence.availability).toEqual(expect.objectContaining({ sellability: 'not_sellable', reason: 'out_of_stock' }));
    const decision = t.steps.find((s) => s.decision_type === 'respond')!;
    expect(decision).toMatchObject({ content: WRONG, origin: 'model' });
    expect(decision.input_tokens).toBeGreaterThanOrEqual(0);
    expect(t.outbound).toHaveLength(1);

    // R4-J1E-R2.2 observability seam: input → context → decision → evidence → outbound → run, all durable.
    const [snapshot] = await bed!.rows<{ compiled_context: unknown }>('select compiled_context from context_snapshots where snapshot_id = $1', [decision.snapshot]);
    const seen = JSON.stringify(snapshot!.compiled_context);
    expect(seen).toContain(QUESTION); // the customer input the decision was made on
    expect(seen).toContain('out_of_stock'); // the owner evidence was in the model's context
    const [sent] = await bed!.rows<{ response_step_id: string; status: string }>(
      `select o.response_step_id, o.status from outbound_messages o join agent_run_steps s on s.step_id = o.response_step_id where o.task_id = $1 and s.decision->>'content' = $2`,
      [taskId, WRONG],
    );
    expect(sent).toBeDefined(); // the outbound points at the exact response step
    const [run] = await bed!.rows<{ started_at: Date; finished_at: Date | null; input_tokens: number; output_tokens: number }>('select started_at, finished_at, input_tokens, output_tokens from agent_runs where task_id = $1', [taskId]);
    expect(run!.finished_at).not.toBeNull(); // run latency is durable
    expect(run!.input_tokens).toBeGreaterThanOrEqual(0);
  });

  it('the next customer message opens a NEW run (the task was left ready for input)', async () => {
    const { taskId, worker } = await turn(search, say(OXFORD_REPLY), say('Perfecto, te espero.'));
    await bed!.customer(CUSTOMER, 'wamid.in.2', 'Gracias, lo pienso.');
    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    const t = await trajectory(taskId);
    expect(t.runs.map((r) => [r.status, r.termination_reason, r.model_calls])).toEqual([
      ['suspended', 'waiting', 2],
      ['suspended', 'waiting', 1],
    ]);
    await bed!.deliver();
    expect(bed!.provider.sends.map((s) => s.text)).toEqual([OXFORD_REPLY, 'Perfecto, te espero.']);
  });
});
