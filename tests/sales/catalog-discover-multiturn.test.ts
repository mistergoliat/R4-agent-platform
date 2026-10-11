import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureDomains } from '@r4-adapters/domains';
import { FakeModelProvider } from '@r4/model-gateway';
import {
  CAPABILITY_IDS,
  NON_PRODUCTION_CAPABILITY_IDS,
  SalesHarness,
  clp,
  fact,
  migrateSales,
  read,
  respond,
  scriptedAgent,
  update,
  type CatalogDiscoverView,
  type ContextView,
  type ScriptedStep,
  type ShiftableClock,
} from '@r4-sales/agent';
import { DISCOVER_T0, canonicalBody, replayDiscover, turnFixture } from '../support/catalog-discover-contract.js';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-DISCOVER-I1 §7 — the mandatory five-turn case on the REAL R4 process: platform API, worker,
 * kernel, context compiler, capability invoker, governed workspace writes and PostgreSQL. The
 * model is the scripted CI stand-in (it proves platform + pack semantics, not what a real model
 * would decide); Catalog is the OWNER's answers replayed over R4's real HTTP adapter, matched by
 * the exact structured request R4 sent. Conversational state is the existing Sales workspace:
 * nothing new is stored, and Catalog stores nothing.
 */

const DISCOVER = NON_PRODUCTION_CAPABILITY_IDS.catalogDiscover;
let db: TestDatabase | null = null;

afterEach(async () => {
  await db?.drop();
  db = null;
});

/** Owner time starts at the fixtures' instant and runs 100× slower than the wall clock (the owner windows are 15 s). */
function ownerClock(): ShiftableClock {
  const started = Date.now();
  const clock = { offsetMs: 0, now: () => new Date(DISCOVER_T0.getTime() + 1_000 + Math.floor((Date.now() - started) / 100) + clock.offsetMs) };
  return clock;
}

/**
 * What the scripted stand-in sends, derived ONLY from the durable workspace it sees in context
 * (the conversation's existing state): the consolidated need, the use context, the budget.
 */
function discoverArgs(v: ContextView): Record<string, unknown> {
  const facts = v.workspace.facts;
  const budget = (facts.budget?.value as { amount?: number } | undefined)?.amount;
  return {
    need: facts.need!.value,
    ...(facts.use_context ? { useContext: facts.use_context.value } : {}),
    ...(budget !== undefined ? { constraints: { maxUnitPriceClp: budget } } : {}),
    limit: 8,
  };
}

const latestDiscover = (v: ContextView) => v.latest(DISCOVER).payload as CatalogDiscoverView;
const names = (d: CatalogDiscoverView) => d.candidates.map((c) => `${c.name} (${c.reading.allowedClaims.includes('PRICE_CURRENT') && c.commercial.status === 'OBSERVED' ? clp(c.commercial.unit?.finalGrossClp ?? c.commercial.price.finalGrossClp!) : c.reading.allowedClaims.includes('PRICE_FROM') && c.commercial.status === 'OBSERVED' ? `desde ${clp(c.commercial.price.finalGrossClp!)}` : 'precio por confirmar'})`).join(', ');

/** A reply that only says what the reading allows: no "these are all" unless allowed, no "none" unless allowed. */
function answer(v: ContextView, ask: string): string {
  const d = latestDiscover(v);
  if (d.candidates.length === 0) {
    return d.reading.canAssertNoneExist
      ? `En el catálogo no hay ${d.request.need}${d.request.budgetFromWorkspace ? ` hasta ${clp(d.request.constraints.maxUnitPriceClp as number)}` : ''}. ${ask}`
      : `Por ahora no puedo confirmar opciones para ${d.request.need}. ${ask}`;
  }
  const variant = d.reading.askCustomer.reasons.includes('VARIANT_CHOICE') ? ' El remo tiene variantes: ¿qué color prefieres?' : '';
  return `Opciones que cumplen: ${names(d)}.${variant} ${ask}`.trim();
}

const TURNS: readonly { customer: string; agent: readonly ScriptedStep[] }[] = [
  {
    customer: 'Necesito una máquina para entrenar espalda',
    agent: [update([fact('need', 'máquina para entrenar espalda')]), read(DISCOVER, discoverArgs), respond((v) => answer(v, '¿Cuánto espacio tienes?'))],
  },
  {
    customer: 'Tengo poco espacio',
    agent: [update([fact('use_context', 'poco espacio')]), read(DISCOVER, discoverArgs), respond((v) => answer(v, '¿Tienes un presupuesto?'))],
  },
  {
    customer: 'Mi presupuesto es de $300.000',
    agent: [update([fact('budget', { amount: 300_000, currency: 'CLP' })]), read(DISCOVER, discoverArgs), respond((v) => answer(v, ''))],
  },
  {
    // A new preference replaces the product term (the need is one fact: replaced, never accumulated).
    customer: 'Prefiero una polea',
    agent: [update([fact('need', 'polea para entrenar espalda'), fact('preference', 'polea')]), read(DISCOVER, discoverArgs), respond((v) => answer(v, '¿Quieres ampliar el presupuesto o ver las opciones anteriores?'))],
  },
  {
    customer: 'Puede costar hasta $400.000',
    agent: [
      // A stand-in that applies the new budget BEFORE recording it: the capability refuses it (the workspace still says 300 000) …
      read(DISCOVER, (v) => ({ ...discoverArgs(v), constraints: { maxUnitPriceClp: 400_000 } })),
      // … so it records the correction (replacing the old budget) and reads again.
      update([fact('budget', { amount: 400_000, currency: 'CLP' })]),
      read(DISCOVER, discoverArgs),
      respond((v) => answer(v, 'La polea que tenemos está sobre ese monto. ¿Te muestro alternativas compactas?')),
    ],
  },
];

describe('R4-DISCOVER-I1 — five-turn constraints on the real R4 process (scripted model, owner answers replayed)', () => {
  it('keeps, replaces and consolidates constraints in the workspace and sends Catalog one coherent structured request per turn', async () => {
    db = await createMigratedTestDatabase();
    const pool = openPool(db.url);
    try {
      await migrateSales(pool);
    } finally {
      await pool.end();
    }
    const fixtures = [1, 2, 3, 4, 5].map(turnFixture);
    const replay = replayDiscover(fixtures);
    const clock = ownerClock();
    const domains = createFixtureDomains({ now: () => clock.now() });
    const harness = await SalesHarness.start({
      databaseUrl: db.url,
      modelProvider: new FakeModelProvider(scriptedAgent(TURNS.flatMap((t) => t.agent))),
      clock,
      domains,
      ports: { ...domains, catalogDiscover: replay.port },
      execution: { modelCallTimeoutMs: 10_000 },
    });
    try {
      const taskId = await harness.openConversation({ correlationId: 'scenario-i1-multiturn' });
      for (const turn of TURNS) await harness.say(taskId, turn.customer);
      const state = await harness.inspect(taskId);

      // 1. Catalog received exactly the five consolidated requests (owner fixtures matched by body), in order.
      expect(replay.requests.map((r) => canonicalBody(r.body))).toEqual(fixtures.map((f) => canonicalBody(f.request)));
      for (const [i, r] of replay.requests.entries()) expect(r.body).toMatchObject({ ...fixtures[i]!.request, limit: 8 });
      // Never the conversation, never customer data, always bounded; correlation is transport context only.
      for (const r of replay.requests) {
        expect(String(r.body.need).length).toBeLessThanOrEqual(300);
        expect(String(r.body.need)).not.toMatch(/necesito|tengo|prefiero|presupuesto|\$/i);
        expect(Object.keys(r.body).sort()).toEqual(expect.arrayContaining(['need', 'schemaVersion']));
        expect(Object.keys(r.body).every((k) => ['schemaVersion', 'need', 'limit', 'constraints', 'context'].includes(k))).toBe(true);
      }

      // 2. Constraints: conserved (use context from turn 2 on), budget replaced (300 000 → 400 000, never both), need replaced by the preference.
      expect(replay.requests.map((r) => r.body.need)).toEqual([
        'máquina para entrenar espalda',
        'máquina para entrenar espalda poco espacio',
        'máquina para entrenar espalda poco espacio',
        'polea para entrenar espalda poco espacio',
        'polea para entrenar espalda poco espacio',
      ]);
      expect(replay.requests.map((r) => (r.body.constraints as { maxUnitPriceClp?: number } | undefined)?.maxUnitPriceClp ?? null)).toEqual([null, null, 300_000, 300_000, 400_000]);
      const facts = Object.fromEntries(Object.entries(state.workspace.state.facts).map(([k, f]) => [k, f.value]));
      expect(facts).toEqual({ need: 'polea para entrenar espalda', use_context: 'poco espacio', budget: { amount: 400_000, currency: 'CLP' }, preference: 'polea' });
      const budgetChanges = state.workspaceTransitions.flatMap((t) => t.changes).filter((c) => c.kind === 'fact' && c.key === 'budget');
      expect(budgetChanges.map((c) => [(c as { from: { value: unknown } | null }).from?.value ?? null, (c as { to: { value: unknown } | null }).to?.value ?? null])).toEqual([
        [null, { amount: 300_000, currency: 'CLP' }],
        [{ amount: 300_000, currency: 'CLP' }, { amount: 400_000, currency: 'CLP' }],
      ]);

      // 3. The stale budget was refused BEFORE reaching Catalog (no contradiction ever accumulates).
      const discovers = state.observations.filter((o) => o.source.kind === 'capability' && o.source.capabilityId === DISCOVER);
      expect(discovers.map((o) => o.outcome)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed', 'succeeded']);
      expect(discovers[4]!.error).toMatchObject({ details: { code: 'budget_not_current', discoverFailure: 'INVALID_REQUEST', retryable: false } });

      // 4. Interpretation as R4 read it, turn by turn.
      const views = discovers.filter((o) => o.outcome === 'succeeded').map((o) => o.payload as CatalogDiscoverView);
      expect(views.map((v) => v.candidates.map((c) => c.productKey))).toEqual([['P6', 'P7', 'P14'], ['P7', 'P6', 'P14'], ['P7', 'P6'], [], []]);
      expect(views[1]!.interpretation.preferred).toEqual(['USE_CONTEXT:SMALL_SPACE']);
      // Small space is a preference: never asserted as met.
      for (const c of views[1]!.candidates) expect(c.reading.forbiddenClaims).toContain('MEETS:USE_CONTEXT:SMALL_SPACE');
      // Turn 3: the budget is the workspace's; P7 fits through a witness unit (some variant), so the customer must choose one.
      expect(views[2]!.request).toMatchObject({ budgetFromWorkspace: 'budget' });
      const p7 = views[2]!.candidates.find((c) => c.productKey === 'P7')!;
      expect(p7.reading).toMatchObject({ unitBasis: 'WITNESS', allowedClaims: expect.arrayContaining(['WITHIN_BUDGET', 'PRICE_FROM']) });
      expect(p7.reading.forbiddenClaims).toEqual(expect.arrayContaining(['PRICE_CURRENT', 'VARIANT_FIXED']));
      expect(views[2]!.reading.askCustomer.reasons).toContain('VARIANT_CHOICE');
      // Turns 4–5: a COMPLETE, exhaustive, empty answer under the budget: "none up to $X" is allowed, and it is about that budget.
      for (const v of views.slice(3)) expect(v.reading).toMatchObject({ canAssertNoneExist: true, answerAllowed: expect.arrayContaining(['NONE_EXIST']) });
      expect(views.map((v) => v.interpretation.required)).toEqual([
        ['ANATOMY:BACK'], ['ANATOMY:BACK'], ['ANATOMY:BACK', 'price<=300000CLP'],
        ['PRODUCT_TYPE:CABLE_MACHINE', 'ANATOMY:BACK', 'price<=300000CLP'], ['PRODUCT_TYPE:CABLE_MACHINE', 'ANATOMY:BACK', 'price<=400000CLP'],
      ]);

      // 5. Every turn answered; the replies asked (clarifications) instead of inventing.
      expect(state.turns).toHaveLength(5);
      // The agent's replies are its respond decisions (run steps); conversation memory holds the customer's turns.
      const said = JSON.stringify(state.runs.map((r) => r.steps));
      expect(state.conversation.map((m) => (m.content as { text: string }).text)).toEqual(TURNS.map((t) => t.customer));
      expect(said).toContain('¿qué color prefieres?');
      expect(said).toContain('no hay polea para entrenar espalda poco espacio hasta $300.000');
      expect(said).toContain('no hay polea para entrenar espalda poco espacio hasta $400.000');
      // Catalog is stateless and holds nothing from the conversation: R4 sent no transcript and no identity.
      expect(JSON.stringify(replay.requests)).not.toMatch(/scenario-i1-multiturn.*Necesito|customerRef|cust-/);
      expect(state.observations.some((o) => o.source.kind === 'capability' && o.source.capabilityId === CAPABILITY_IDS.catalogSearch)).toBe(false);
    } finally {
      await harness.close();
    }
  }, 120_000);
});
