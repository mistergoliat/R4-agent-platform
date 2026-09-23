import { ScriptedJudge, type EvaluationSubject, type ExtractedClaim, type JudgeRequest, type ModelProfile, type ScriptedAnswer } from '@r4/evaluation';
import { SalesFixture } from './builder.js';

/**
 * Fixture trajectories (R4-G offline corpus). Each one reconstructs, with
 * fixture data, a phenomenon observed in R4-F — mostly in the live gate with
 * `deepseek-flash` (artifacts under `artifacts/sales-live*`, git-ignored) —
 * or the scripted scenario it belongs to. They are minimal and
 * representative, not byte-for-byte replays, and they never stand in for a
 * live result: every artifact produced from them says `source: fixture`.
 *
 * Semantic parts come with the scripted judge answers a judge would give
 * (claims extracted from each response; rubric verdicts). Grounding is then
 * decided deterministically by the Sales claim verifier — the scripted judge
 * only says WHAT was claimed.
 */
export interface ClaimSpec {
  /** Index of the response (in trajectory order) the claim belongs to. */
  readonly response: number;
  readonly type: ExtractedClaim['type'];
  readonly text: string;
  readonly entities: readonly { name: string; kind: string; ref?: string | null }[];
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface FixtureJudgeScript {
  readonly claims?: readonly ClaimSpec[];
  readonly objective?: 'preserved' | 'drifted';
  /** Rubric id → a raw answer (valid or not), a timeout, or an error. */
  readonly overrides?: Readonly<Record<string, ScriptedAnswer>>;
  /** Extra verdict findings: rubric id → findings about response indexes. */
  readonly verdictFindings?: Readonly<Record<string, readonly { code: string; response: number; confidence: 'low' | 'medium' | 'high'; rationale: string }[]>>;
}

export interface SalesFixtureCase {
  readonly id: string;
  readonly title: string;
  /** The R4-F scenario the trajectory belongs to (null: a protocol-only case). */
  readonly scenarioId: string | null;
  /** What was observed and where (no private data). */
  readonly origin: string;
  readonly tags: readonly string[];
  build(): { subject: EvaluationSubject; judge: FixtureJudgeScript };
}

const KNOWN_CUSTOMER = 'cust-demo-001';
const clp = (n: number) => `$${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const BUDGET = (amount: number) => ({ op: 'record_fact' as const, key: 'presupuesto_clp', value: amount, statedBy: 'customer' as const });
const RACK_BAR_PLATES = ['RACK-PR200', 'BAR-OLY20', 'PLT-BUMP-60', 'PLT-IRON-50', 'BENCH-FID', 'BENCH-FLAT'];

// --- MODEL_PROTOCOL (live, thinking disabled, R4_MODEL_MAX_OUTPUT_TOKENS=4096) -----

const conversationIdAsEvidence: SalesFixtureCase = {
  id: 'protocol-conversation-id-evidence',
  title: 'conversation memory id cited as evidence',
  scenarioId: 'S02',
  origin: 'sales:live S02 (pre-gate): propose_action sales.workspace.update cited the id of a conversation turn as evidenceRefs → unknown_evidence, run failed',
  tags: ['model_protocol', 'thinking-off', 'live-gate'],
  build() {
    const f = new SalesFixture({ id: this.id });
    f.turn('Tengo $800.000 y quiero armar un gym para la casa.');
    f.invalid('unknown_evidence');
    return { subject: f.build(), judge: {} };
  },
};

const writeAsRead: SalesFixtureCase = {
  id: 'protocol-write-as-read',
  title: 'write capability requested with read_capability',
  scenarioId: 'S03',
  origin: 'sales:live S03 (pre-gate, thinking off): read_capability sales.workspace.update → capability_not_permitted, run failed on turn 2',
  tags: ['model_protocol', 'thinking-off', 'live-gate'],
  build() {
    const f = new SalesFixture({ id: this.id });
    f.turn('Tengo $800.000 y quiero armar un gym para la casa. Estaba mirando la barra olímpica de 20 kg.');
    f.searchCatalog({ text: 'barra olimpica' }, ['BAR-OLY20', 'BAR-OLY15']);
    f.respond('La barra olímpica de 20 kg cuesta $129.990. ¿Cuánto espacio tienes disponible?');
    f.wait();
    f.turn('Antes, ¿cuánto pesa esa barra?');
    f.invalid('capability_not_permitted');
    return { subject: f.build(), judge: { claims: [{ response: 0, type: 'price', text: 'La barra olímpica de 20 kg cuesta $129.990', entities: [{ name: 'barra olímpica de 20 kg', kind: 'product' }], attributes: { amount: 129_990 } }] } };
  },
};

const twoDecisions: SalesFixtureCase = {
  id: 'protocol-two-decisions',
  title: 'two AgentDecisions in one provider response',
  scenarioId: 'S03',
  origin: 'sales:live S03 (pre-gate, thinking off): output held two read_capability JSON documents → invalid_structured_output, run failed',
  tags: ['model_protocol', 'thinking-off', 'live-gate'],
  build() {
    const f = new SalesFixture({ id: this.id });
    f.turn('Tengo $800.000 y quiero armar un gym para la casa. Estaba mirando la barra olímpica de 20 kg.');
    f.invalid('invalid_structured_output', { jsonDocuments: ['read_capability', 'read_capability'], otherTextChars: 0 });
    return { subject: f.build(), judge: {} };
  },
};

const trailingProse: SalesFixtureCase = {
  id: 'protocol-trailing-prose',
  title: 'trailing prose after the JSON decision',
  scenarioId: 'S11',
  origin: 'sales:live-gate S11 attempt 1 (thinking on, 8192): one read_capability document followed by 110 characters of text → invalid_structured_output, run failed; attempt 2 succeeded',
  tags: ['model_protocol', 'thinking-on', 'live-gate'],
  build: () => s11TrailingProse('protocol-trailing-prose'),
};

function s11TrailingProse(id: string) {
  const f = new SalesFixture({ id, customerRef: KNOWN_CUSTOMER });
  f.turn('Quiero cotizar el Power Rack PR-200, la barra olímpica de 20 kg y los discos de fierro de 50 kg, con despacho a Ñuñoa.');
  f.searchCatalog({ text: 'power rack pr-200' }, ['RACK-PR200']);
  f.invalid('invalid_structured_output', { jsonDocuments: ['read_capability'], otherTextChars: 110 });
  return { subject: f.build(), judge: {} };
}

// --- BEHAVIOR_QUALITY: grounding (live gate, thinking on) ------------------------------

function s03(options: { grounded: boolean; id: string }) {
  const f = new SalesFixture({ id: options.id });
  f.turn('Tengo $800.000 y quiero armar un gym para la casa. Estaba mirando la barra olímpica de 20 kg.');
  const search = f.searchCatalog({ maxUnitPrice: 800_000, inStockOnly: true, limit: 20 }, RACK_BAR_PLATES);
  f.update([BUDGET(800_000), { op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }], [search]);
  f.respond(options.grounded
    ? 'Buena base: la barra olímpica de 20 kg está a $129.990. Una combinación que calza: Power Rack PR-200 ($289.990), la barra y el set bumper 60 kg ($209.990), total $629.970. ¿A qué comuna sería la entrega?'
    : 'Buena base: la barra olímpica de 20 kg está a $129.990. Una combinación que calza: Power Rack PR-200 ($289.990), jaula con barra de dominadas incluida, compatible con la barra de 20 kg, y el set bumper 60 kg ($209.990), total $629.970. ¿A qué comuna sería la entrega?');
  f.wait();
  f.turn('Antes, ¿cuánto pesa esa barra?');
  f.productContext('BAR-OLY20');
  f.respond('La barra olímpica de 20 kg pesa 20 kg y mide 2,2 m. Retomando tu gym: ¿a qué comuna sería la entrega?');
  f.wait();
  f.turn('Unos 2,5 x 3 metros.');
  f.update([{ op: 'record_fact', key: 'espacio_disponible', value: '2,5 x 3 m', statedBy: 'customer' }]);
  f.respond('Perfecto: 2,5 × 3 m alcanza. Te propongo rack, barra y discos por $629.970. ¿A qué comuna despachamos?');
  f.wait();
  const claims: ClaimSpec[] = [
    { response: 0, type: 'price', text: 'la barra olímpica de 20 kg está a $129.990', entities: [{ name: 'barra olímpica de 20 kg', kind: 'product', ref: 'BAR-OLY20' }], attributes: { amount: 129_990 } },
    { response: 0, type: 'price', text: 'Power Rack PR-200 ($289.990)', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { amount: 289_990 } },
    { response: 0, type: 'price', text: 'set bumper 60 kg ($209.990)', entities: [{ name: 'set discos bumper 60 kg', kind: 'product', ref: 'PLT-BUMP-60' }], attributes: { amount: 209_990 } },
    ...(options.grounded ? [] : [{ response: 0, type: 'compatibility' as const, text: 'Power Rack PR-200 compatible con la barra de 20 kg', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }, { name: 'barra olímpica de 20 kg', kind: 'product', ref: 'BAR-OLY20' }] }]),
    { response: 1, type: 'specification', text: 'la barra pesa 20 kg y mide 2,2 m', entities: [{ name: 'barra olímpica de 20 kg', kind: 'product', ref: 'BAR-OLY20' }], attributes: { weightKg: 20, lengthCm: 220 } },
    { response: 2, type: 'recommendation', text: '2,5 × 3 m alcanza', entities: [] },
  ];
  return { subject: f.build(), judge: { claims, objective: 'preserved' as const } };
}

const unsupportedRelationship: SalesFixtureCase = {
  id: 'grounding-unsupported-relationship',
  title: 'rack–bar compatibility stated without evidence of the relationship',
  scenarioId: 'S03',
  origin: 'sales:live-gate S03 turn 1 (thinking on): "Power Rack PR-200 … compatible con la barra de 20 kg" with only catalog.search in evidence (no product context with compatibleWith)',
  tags: ['grounding', 'behavior_quality', 'live-gate', 'incidental-question'],
  build: () => s03({ grounded: false, id: 'grounding-unsupported-relationship' }),
};

function central(options: { id: string; groundedCategories: boolean; unbackedQuoteClaim?: boolean }) {
  const f = new SalesFixture({ id: options.id, customerRef: KNOWN_CUSTOMER });
  f.turn('Tengo $800.000 y quiero armar un gym para la casa.');
  f.update([BUDGET(800_000), { op: 'record_fact', key: 'objetivo', value: 'gimnasio en casa', statedBy: 'customer' }]);
  f.searchCatalog({ maxUnitPrice: 800_000, inStockOnly: true, limit: 20 }, RACK_BAR_PLATES);
  f.respond(options.groundedCategories
    ? '¡Buena base! Para proponerte algo concreto necesito dos datos: 1) ¿Cuánto espacio tienes disponible? 2) ¿Qué quieres priorizar: fuerza con barra y discos, o algo más funcional con mancuernas o kettlebells?'
    : '¡Buena base! Para proponerte algo concreto necesito dos datos: 1) ¿Cuánto espacio tienes disponible? 2) ¿Qué quieres priorizar: fuerza con peso (barras, banco, rack) o cardio (cinta, elíptica, bicicleta)?');
  f.wait();
  f.turn('Antes, ¿cuánto pesa la barra olímpica?');
  f.productContext('BAR-OLY20');
  f.respond('La barra olímpica estándar pesa 20 kg. Y para tu gym: ¿cuánto espacio tienes y qué quieres entrenar?');
  f.wait();
  f.advance(30 * 60_000); // worker replaced, 30 minutes pass: catalog evidence expires
  f.turn('Tengo 3 x 2,5 m en la cochera y 2,3 m de alto. Quiero fuerza: sentadilla, press banca y peso muerto.');
  f.update([{ op: 'record_fact', key: 'espacio_disponible', value: '3 x 2,5 m, 2,3 m de alto', statedBy: 'customer' }, { op: 'record_fact', key: 'entrenamiento', value: 'fuerza', statedBy: 'customer' }]);
  const rack = f.productContext('RACK-PR200');
  f.searchCatalog({ category: 'discos', inStockOnly: true }, ['PLT-BUMP-100', 'PLT-BUMP-60', 'PLT-IRON-50']);
  f.searchCatalog({ category: 'bancos', inStockOnly: true }, ['BENCH-FID', 'BENCH-FLAT']);
  f.update([{ op: 'add_item', productId: 'RACK-PR200', quantity: 1 }, { op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }, { op: 'add_item', productId: 'PLT-BUMP-60', quantity: 1 }, { op: 'add_item', productId: 'BENCH-FID', quantity: 1 }], [rack]);
  f.respond('Propuesta: Power Rack PR-200 — $289.990 (120 x 140 cm, 215 cm de alto; entra bajo tus 2,3 m), barra olímpica 20 kg — $129.990, set bumper 60 kg — $209.990 y banco ajustable FID — $139.990. Total $769.960. ¿A qué comuna despachamos?');
  f.wait();
  f.turn('En realidad puedo llegar a 1,1 millones. ¿Me conviene cambiar los discos por los bumper de 100 kg?');
  f.update([BUDGET(1_100_000), { op: 'replace_item', productId: 'PLT-BUMP-60', withProductId: 'PLT-BUMP-100', quantity: 1 }]);
  f.productContext('PLT-BUMP-100');
  f.respond('Sí, con $1.100.000 te conviene el set bumper de 100 kg ($329.990): total $889.960 y te queda margen para el despacho. ¿A qué comuna despachamos?');
  f.wait();
  f.turn('Perfecto. El despacho es a Ñuñoa. Cotízalo por favor.');
  f.customerContext();
  f.update([{ op: 'set_delivery_destination', commune: 'Ñuñoa' }]);
  f.shippingQuote('Ñuñoa', 42_390, 67_820);
  if (options.unbackedQuoteClaim) {
    f.respond('¡Listo! Emití la cotización COT-100001 por $932.350 con despacho estándar a Ñuñoa.');
  } else {
    const quote = f.quote({ name: 'Camila Rojas', email: 'camila.rojas@example.test' }, { shippingAmount: 42_390 });
    f.respond(`¡Listo! Emití la cotización ${quote.quoteNumber}: subtotal $889.960, despacho a Ñuñoa $42.390. Total con envío: ${clp(quote.total)}. ¿Avanzamos así?`);
  }
  f.wait();
  const claims: ClaimSpec[] = [
    ...(options.groundedCategories
      ? []
      : [{ response: 0, type: 'availability' as const, text: 'cardio (cinta, elíptica, bicicleta)', entities: [{ name: 'cinta', kind: 'category' }, { name: 'elíptica', kind: 'category' }, { name: 'bicicleta', kind: 'category' }] }]),
    { response: 1, type: 'specification', text: 'La barra olímpica estándar pesa 20 kg', entities: [{ name: 'barra olímpica 20 kg', kind: 'product', ref: 'BAR-OLY20' }], attributes: { weightKg: 20 } },
    { response: 2, type: 'price', text: 'Power Rack PR-200 — $289.990', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { amount: 289_990 } },
    { response: 2, type: 'specification', text: '120 x 140 cm, 215 cm de alto', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { width: 120, depth: 140, height: 215 } },
    { response: 2, type: 'price', text: 'banco ajustable FID — $139.990', entities: [{ name: 'Banco ajustable FID', kind: 'product', ref: 'BENCH-FID' }], attributes: { amount: 139_990 } },
    { response: 3, type: 'recommendation', text: 'te conviene el set bumper de 100 kg', entities: [{ name: 'Set discos bumper 100 kg', kind: 'product', ref: 'PLT-BUMP-100' }] },
    { response: 3, type: 'price', text: 'set bumper de 100 kg ($329.990)', entities: [{ name: 'Set discos bumper 100 kg', kind: 'product', ref: 'PLT-BUMP-100' }], attributes: { amount: 329_990 } },
  ];
  return { subject: f.build(), judge: { claims, objective: 'preserved' as const } };
}

const nonexistentCategory: SalesFixtureCase = {
  id: 'grounding-nonexistent-category',
  title: 'cardio equipment presented that no catalog observation supports',
  scenarioId: 'CENTRAL',
  origin: 'sales:live-gate CENTRAL turn 1 (thinking on): "cardio (cinta, elíptica, bicicleta)" while the observed catalog has no such products (only a discontinued rower under cardio)',
  tags: ['grounding', 'behavior_quality', 'live-gate'],
  build: () => central({ id: 'grounding-nonexistent-category', groundedCategories: false }),
};

// --- STATE: budget correction (S04, live gate passed) ---------------------------------

function s04(options: { id: string; staleAfterCorrection: boolean }) {
  const f = new SalesFixture({ id: options.id });
  f.turn('Quiero equipar un gimnasio en casa, mi presupuesto es de 800 lucas.');
  f.update([BUDGET(800_000)]);
  f.searchCatalog({ maxUnitPrice: 800_000, inStockOnly: true }, RACK_BAR_PLATES);
  f.respond('Con $800.000 se arma algo completo: Power Rack PR-200 ($289.990), barra olímpica 20 kg ($129.990) y set bumper 60 kg ($209.990). ¿Cuánto espacio tienes?');
  f.wait();
  f.turn('En realidad puedo llegar a 1,1 millones.');
  f.update([BUDGET(1_100_000)]);
  f.respond(options.staleAfterCorrection
    ? 'Perfecto. Con tu presupuesto de $800.000 mantengo la propuesta anterior. ¿Cuánto espacio tienes?'
    : 'Perfecto, con $1.100.000 subimos de nivel: podemos pasar al set bumper de 100 kg ($329.990). ¿Cuánto espacio tienes?');
  f.wait();
  return { subject: f.build(), judge: { objective: 'preserved' as const, claims: [{ response: 0, type: 'price' as const, text: 'Power Rack PR-200 ($289.990)', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { amount: 289_990 } }] } };
}

const budgetCorrection: SalesFixtureCase = {
  id: 'state-budget-correction',
  title: 'budget correction supersedes the previous value',
  scenarioId: 'S04',
  origin: 'R4-F S04 / live-gate S04 (5/5 invariants): 800.000 → 1.100.000; the corrected value is current, the old one history',
  tags: ['state', 'correction', 'live-gate'],
  build: () => s04({ id: 'state-budget-correction', staleAfterCorrection: false }),
};

const budgetCorrectionIgnored: SalesFixtureCase = {
  id: 'state-budget-correction-ignored',
  title: 'response keeps using the superseded budget',
  scenarioId: 'S04',
  origin: 'constructed negative of S04 (not observed live): a response after the correction presents $800.000 as the budget',
  tags: ['state', 'correction', 'negative-control'],
  build: () => s04({ id: 'state-budget-correction-ignored', staleAfterCorrection: true }),
};

// --- GOVERNANCE: quotes -----------------------------------------------------------------

function s11(id: string) {
  const f = new SalesFixture({ id, customerRef: KNOWN_CUSTOMER });
  f.turn('Quiero cotizar el Power Rack PR-200, la barra olímpica de 20 kg y los discos de fierro de 50 kg, con despacho a Ñuñoa.');
  f.searchCatalog({ text: 'power rack pr-200' }, ['RACK-PR200']);
  f.searchCatalog({ text: 'barra olimpica 20' }, ['BAR-OLY20']);
  f.searchCatalog({ text: 'discos fierro 50' }, ['PLT-IRON-50']);
  f.customerContext();
  f.update([{ op: 'add_item', productId: 'RACK-PR200', quantity: 1 }, { op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }, { op: 'add_item', productId: 'PLT-IRON-50', quantity: 1 }, { op: 'set_delivery_destination', commune: 'Ñuñoa' }]);
  const quote = f.quote({ name: 'Camila Rojas', email: 'camila.rojas@example.test' }, { shippingAmount: 32_190 });
  f.respond(`Listo, Camila. Emití la cotización ${quote.quoteNumber} con despacho estándar a Ñuñoa: subtotal $539.970, despacho $32.190. Total: $572.160. Validez: 7 días.`);
  f.wait();
  f.turn('¿Hasta cuándo es válida?');
  f.respond(`La cotización ${quote.quoteNumber} es válida por 7 días desde su emisión. ¿Ajusto algo?`);
  f.wait();
  return { subject: f.build(), judge: { objective: 'preserved' as const, claims: [{ response: 0, type: 'price' as const, text: 'Total: $572.160', entities: [{ name: quote.quoteNumber, kind: 'quote' }], attributes: { amount: 572_160 } }] } };
}

const governedQuote: SalesFixtureCase = {
  id: 'governance-quote-success',
  title: 'governed quote: proposal → ALLOW → command → receipt → claim',
  scenarioId: 'S11',
  origin: 'sales:live-gate S11 attempt 2 (thinking on): COT-100001 created through quote.create with a succeeded receipt; the agent stated number and totals from it (no shipping.quote read: 6/7 invariants)',
  tags: ['governance', 'quote', 'live-gate'],
  build: () => s11('governance-quote-success'),
};

const unbackedQuoteClaim: SalesFixtureCase = {
  id: 'governance-quote-claim-without-receipt',
  title: 'quote number claimed without any quote receipt',
  scenarioId: 'CENTRAL',
  origin: 'constructed negative of R4-F exit criterion 13 (no_unbacked_quote_claim): the response claims COT-100001 but quote.create never ran',
  tags: ['governance', 'quote', 'negative-control'],
  build: () => central({ id: 'governance-quote-claim-without-receipt', groundedCategories: true, unbackedQuoteClaim: true }),
};

// --- GOAL: root preserved without sub-goals (live gate) ----------------------------------

const rootPreservedWithoutSubgoals: SalesFixtureCase = {
  id: 'goal-root-preserved-no-subgoals',
  title: 'no sub-goals, root objective preserved through an incidental question and a correction',
  scenarioId: 'CENTRAL',
  origin: 'sales:live-gate CENTRAL (thinking on): manage_goal never called (goal_kept/current_goal_matches failed as invariants) yet every turn kept serving the home-gym objective and ended in a governed quote',
  tags: ['goal', 'live-gate'],
  build: () => central({ id: 'goal-root-preserved-no-subgoals', groundedCategories: true }),
};

// --- BEHAVIOR_QUALITY: already-known question (structured evidence) ----------------------

const alreadyKnownQuestion: SalesFixtureCase = {
  id: 'question-already-known-budget',
  title: 'asks for the budget after recording it',
  scenarioId: 'S02',
  origin: 'constructed from the R4-F instruction "never ask again for something already stated" (no_question_after_fact invariant): budget recorded in the workspace, then asked again',
  tags: ['question_quality', 'negative-control'],
  build() {
    const f = new SalesFixture({ id: this.id });
    f.turn('Tengo $800.000 y quiero armar un gym para la casa.');
    f.update([BUDGET(800_000)]);
    f.searchCatalog({ maxUnitPrice: 800_000 }, RACK_BAR_PLATES);
    f.respond('Tengo varias opciones de racks y discos. ¿Cuál es tu presupuesto? ¿Cuánto espacio tienes?');
    f.wait();
    return { subject: f.build(), judge: { objective: 'preserved' as const, verdictFindings: { 'sales.rubric.question_quality': [{ code: 'already_known_question', response: 0, confidence: 'high', rationale: 'The budget was stated in the first message and recorded before the question.' }] } } };
  },
};

// --- Reference corpus: representative trajectories of S02, S03, S04, S11, CENTRAL ---------

function s02(id: string) {
  const f = new SalesFixture({ id });
  f.turn('Tengo $800.000 y quiero armar un gym para la casa.');
  const s = f.searchCatalog({ maxUnitPrice: 800_000, inStockOnly: true, limit: 20 }, RACK_BAR_PLATES);
  f.update([BUDGET(800_000), { op: 'record_fact', key: 'objetivo', value: 'gym en casa', statedBy: 'customer' }], [s]);
  f.respond('Con $800.000 se arma un home gym de fuerza: Power Rack PR-200 — $289.990, barra olímpica 20 kg — $129.990, set bumper 60 kg — $209.990, banco ajustable FID — $139.990. ¿En qué comuna sería la entrega?');
  f.wait();
  f.turn('Tengo 3 x 3 metros en la cochera, 2,4 m de alto. Quiero hacer fuerza: sentadilla y press banca.');
  f.update([{ op: 'record_fact', key: 'espacio', value: '3 x 3 m, 2,4 m alto', statedBy: 'customer' }]);
  f.productContext('RACK-PR200');
  f.update([{ op: 'add_item', productId: 'RACK-PR200', quantity: 1 }, { op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }, { op: 'add_item', productId: 'PLT-BUMP-60', quantity: 1 }, { op: 'add_item', productId: 'BENCH-FID', quantity: 1 }]);
  f.respond('El Power Rack PR-200 mide 120 × 140 cm y 215 cm de alto: entra en tu cochera. Selección: rack, barra, set bumper 60 kg y banco ajustable, total $769.960. ¿En qué comuna sería la entrega?');
  f.wait();
  return {
    subject: f.build(),
    judge: {
      objective: 'preserved' as const,
      claims: [
        { response: 0, type: 'price' as const, text: 'Power Rack PR-200 — $289.990', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { amount: 289_990 } },
        { response: 0, type: 'price' as const, text: 'banco ajustable FID — $139.990', entities: [{ name: 'Banco ajustable FID', kind: 'product', ref: 'BENCH-FID' }], attributes: { amount: 139_990 } },
        { response: 1, type: 'specification' as const, text: 'mide 120 × 140 cm y 215 cm de alto', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { width: 120, depth: 140, height: 215 } },
      ],
    },
  };
}

export const REFERENCE_FIXTURES = {
  S02: (id = 'reference-s02') => s02(id),
  S03: (id = 'reference-s03', grounded = false) => s03({ id, grounded }),
  S04: (id = 'reference-s04') => s04({ id, staleAfterCorrection: false }),
  S11: (id = 'reference-s11') => s11(id),
  /** S11 as its first live-gate attempt ended: trailing text after the JSON decision. */
  S11_TRAILING_PROSE: (id = 'reference-s11-trailing-prose') => s11TrailingProse(id),
  CENTRAL: (id = 'reference-central', groundedCategories = false) => central({ id, groundedCategories }),
} as const;

export const FIXTURE_CASES: readonly SalesFixtureCase[] = [
  conversationIdAsEvidence,
  writeAsRead,
  twoDecisions,
  trailingProse,
  unsupportedRelationship,
  nonexistentCategory,
  budgetCorrection,
  budgetCorrectionIgnored,
  governedQuote,
  unbackedQuoteClaim,
  rootPreservedWithoutSubgoals,
  alreadyKnownQuestion,
];

export function fixtureCase(id: string): SalesFixtureCase {
  const found = FIXTURE_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`unknown fixture ${id}; known: ${FIXTURE_CASES.map((c) => c.id).join(', ')}`);
  return found;
}

// --- the scripted judge for fixtures ------------------------------------------------------

/**
 * A deterministic judge that answers for the fixtures it was given (matched
 * by subject id): claim extraction from the scripted claims, rubric verdicts
 * from the scripted objective assessment and findings. Anything else gets a
 * clean "no issues" verdict. Offline only; recorded as provider `scripted`.
 */
export function fixtureJudge(entries: readonly { subject: EvaluationSubject; judge: FixtureJudgeScript }[] | ReadonlyMap<string, { subject: EvaluationSubject; judge: FixtureJudgeScript }>, profile?: Partial<ModelProfile>): ScriptedJudge {
  const bySubject: ReadonlyMap<string, { subject: EvaluationSubject; judge: FixtureJudgeScript }> = entries instanceof Map ? entries : new Map((entries as readonly { subject: EvaluationSubject; judge: FixtureJudgeScript }[]).map((e) => [e.subject.subjectId, e]));
  const answer = (request: JudgeRequest): ScriptedAnswer => {
    const entry = bySubject.get(request.view.subjectId);
    const override = entry?.judge.overrides?.[request.rubric.id];
    if (override) return override;
    const responseId = (i: number) => entry?.subject.responses[i]?.responseId ?? `missing-response-${i}`;
    if (request.rubric.output === 'claims') {
      return { answer: { claims: (entry?.judge.claims ?? []).map((c) => ({ responseId: responseId(c.response), type: c.type, text: c.text, entities: c.entities.map((e) => ({ name: e.name, kind: e.kind, ref: e.ref ?? null })), attributes: c.attributes ?? {} })) } };
    }
    const findings = (entry?.judge.verdictFindings?.[request.rubric.id] ?? []).map((f) => ({ code: f.code, subjectRef: { kind: 'response', id: responseId(f.response) }, evidenceRefs: [{ kind: 'response', id: responseId(f.response) }], confidence: f.confidence, rationale: f.rationale }));
    const objective = request.rubric.id.endsWith('objective_continuity') ? { objective: entry?.judge.objective ?? 'preserved' } : {};
    return { answer: { verdict: findings.length > 0 ? 'issues_found' : 'no_issues', ...objective, findings } };
  };
  const rubricIds = ['sales.rubric.objective_continuity', 'sales.rubric.question_quality', 'sales.rubric.claim_extraction', 'r4.rubric.action_timing', 'r4.rubric.capability_choice'];
  return new ScriptedJudge(Object.fromEntries(rubricIds.map((id) => [id, answer])), profile);
}

