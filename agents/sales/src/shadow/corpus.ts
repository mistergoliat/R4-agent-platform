import { WORKLOAD_CASE_SCHEMA_VERSION, parseWorkloadCase, type WorkloadCase, type WorkloadCorpus, type WorkloadEvent, type WorkloadInvariant } from '@r4/shadow';
import { CAPABILITY_IDS } from '../ids.js';
import type { Invariant } from '../harness/invariants.js';
import { CENTRAL_SCENARIO, scenarioById, type SalesScenario } from '../harness/scenarios.js';
import { add, clp, customerOnFile, destination, fact, observedQuote, proposeQuote, read, respond, update, waitForCustomer, type ScriptedStep } from '../harness/scripted.js';

/**
 * Sales shadow workload corpus (R4-H), version 1.
 *
 * Small enough to read, varied enough to show distributions:
 *   H01–H14  the reference shadow suite (vague request, correction,
 *            incidental question, quote, wait/restart, stale evidence over
 *            days, catalog outage, provider timeout, trailing prose, unknown
 *            write reconciled by the scheduler, approval, handoff,
 *            cancellation — also with an uncertain write — a long
 *            conversation, a CENTRAL-like case)
 *   S02 S03 S04 S11 CENTRAL   the R4-F/R4-G reference scenarios, unchanged turns
 *   R01–R07  more curated conversations: colloquial Chilean Spanish,
 *            misspellings, several constraints in one message, constraints
 *            revealed late, preference changes, unrelated questions, and two
 *            derived from reviewed regressions (REG-0005, REG-0006)
 *
 * Cases state events, constraints and properties — never a tool sequence.
 * Everything is `synthetic` / `curated` / `regression-derived`: R4-H has no
 * legal source of real conversations, so no case is a replay. Customer data
 * is the fixture owner's fictitious test data (example.test).
 *
 * Each case also has an offline scripted trajectory (CI stand-in model):
 * plausible, never prescribed; with a real model the script is ignored.
 */
export const SALES_SHADOW_CORPUS_ID = 'sales.shadow-corpus';
export const SALES_SHADOW_CORPUS_VERSION = 1;

const KNOWN = 'cust-demo-001';
const BUDGET = { matches: '^(budget|presupuesto)(_|$)' };
const clpv = (amount: number) => ({ amount, currency: 'CLP' as const });

const inv = (cls: WorkloadInvariant['class']) => (kind: string, params: Record<string, unknown> = {}): WorkloadInvariant => ({ kind, class: cls, params: params as WorkloadInvariant['params'] });
const safety = inv('safety');
const technical = inv('technical');
const behavioral = inv('behavioral');

/** Properties every Sales shadow run must keep, whatever the model does. */
const SAFE: readonly WorkloadInvariant[] = [safety('sales.no_unbacked_quote_claim'), safety('sales.one_receipt_per_execution'), technical('shadow.shadow_quotes_match_receipts')];
const CONVERSING: readonly WorkloadInvariant[] = [...SAFE, technical('sales.root_goal_active'), behavioral('shadow.responded_every_input')];

const input = (text: string): WorkloadEvent => ({ kind: 'input', text });
const advance = (ms: number, scope: 'process' | 'process_and_temporal', note?: string): WorkloadEvent => ({ kind: 'advance_time', ms, scope, ...(note ? { note } : {}) });
const fault = (target: string, name: string, note?: string): WorkloadEvent => ({ kind: 'fault', target, fault: name, ...(note ? { note } : {}) });
const operator = (action: Extract<WorkloadEvent, { kind: 'operator' }>['action'], text: string): WorkloadEvent => ({ kind: 'operator', action, text });
const restartWorker: WorkloadEvent = { kind: 'process', process: 'worker', action: 'restart' };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface CaseSpec {
  readonly id: string;
  readonly title: string;
  readonly sourceType: WorkloadCase['sourceType'];
  readonly source: string;
  readonly derivedFrom?: readonly string[];
  readonly subjectRef?: string | null;
  readonly profiles?: Record<string, string>;
  readonly events: readonly WorkloadEvent[];
  readonly invariants: readonly WorkloadInvariant[];
  readonly acceptableStops?: readonly string[];
  readonly constraints?: readonly string[];
  readonly tags: readonly string[];
  /** Offline stand-in trajectory (one entry per model call). */
  readonly script: readonly ScriptedStep[];
}

const build = (spec: CaseSpec): { workload: WorkloadCase; script: readonly ScriptedStep[] } => ({
  workload: parseWorkloadCase({
    schemaVersion: WORKLOAD_CASE_SCHEMA_VERSION,
    id: spec.id,
    version: 1,
    title: spec.title,
    sourceType: spec.sourceType,
    source: { ref: spec.source, derivedFrom: [...(spec.derivedFrom ?? [])] },
    initialContext: { subjectRef: spec.subjectRef ?? null, channelRef: 'shadow', profiles: { ...(spec.profiles ?? {}) } },
    events: [...spec.events],
    expectations: { invariants: [...spec.invariants], acceptableStops: [...(spec.acceptableStops ?? ['awaiting_input'])], constraints: [...(spec.constraints ?? [])] },
    privacy: { classification: 'synthetic', sanitized: false, redactions: {}, note: 'fictitious fixture data only' },
    tags: [...spec.tags],
  }),
  script: spec.script,
});

// --- offline stand-in trajectories -------------------------------------------------

const answer = (text: string | Parameters<typeof respond>[0]): ScriptedStep[] => [respond(text), waitForCustomer()];
const generic = (turns: number): ScriptedStep[] => Array.from({ length: turns }, () => answer('Entiendo. Cuéntame un poco más para ayudarte con una propuesta que calce.')).flat();
const quoteReply = (v: Parameters<ScriptedStep>[0]) => `Listo: cotización ${observedQuote(v).quoteNumber} por ${clp(observedQuote(v).total.amount)}, despacho incluido.`;

/** The R4-F reference scenarios, reused as workloads: same turns and properties, their scripted trajectories for CI. */
function fromScenario(scenario: SalesScenario, tags: readonly string[]): CaseSpec {
  const events: WorkloadEvent[] = [];
  for (const turn of scenario.turns) {
    if ('customer' in turn) events.push(input(turn.customer));
    else if ('operator' in turn) events.push(operator('answer_consultation', turn.operator));
    else if (scenario.id === 'CENTRAL') events.push(restartWorker, advance(30 * 60_000, 'process', 'catalog evidence expires'));
    else throw new Error(`scenario ${scenario.id} has a control turn with no workload equivalent`);
  }
  const mapped = scenario.invariants.flatMap((i): WorkloadInvariant[] => {
    const { kind, ...params } = i as Invariant & Record<string, unknown>;
    if (kind === 'responded_every_turn') return [behavioral('shadow.responded_every_input')];
    const cls = kind === 'no_unbacked_quote_claim' || kind === 'one_receipt_per_execution' ? 'safety' : kind === 'root_goal_active' || kind === 'waited_and_resumed' || kind === 'prior_response_in_context' ? 'technical' : 'behavioral';
    return [inv(cls)(`sales.${kind}`, params)];
  });
  const invariants = [...mapped, ...SAFE.filter((s) => !mapped.some((m) => m.kind === s.kind))];
  return {
    id: scenario.id,
    title: scenario.title,
    sourceType: 'regression-derived',
    source: `r4-f-scenario:${scenario.id}`,
    derivedFrom: [scenario.id],
    subjectRef: scenario.customerRef ?? null,
    events,
    invariants,
    tags,
    script: scenario.turns.flatMap((t) => ('agent' in t ? t.agent : [])),
  };
}

const SPECS: readonly CaseSpec[] = [
  {
    id: 'H01',
    title: 'vague request to start training at home',
    sourceType: 'curated',
    source: 'h-reference-suite',
    events: [input('hola! quiero empezar a entrenar en la casa pero la verdad no cacho mucho qué necesito jaja'), input('vivo en un depto chico, no tengo mucho espacio. y no quiero gastar tanto'), input('como 300 lucas máximo')],
    invariants: [...CONVERSING, behavioral('sales.quotes_issued', { equals: 0 })],
    constraints: ['small apartment', 'budget revealed late: ~CLP 300.000', 'no product named'],
    tags: ['h-reference', 'vague', 'colloquial'],
    script: generic(3),
  },
  {
    id: 'H02',
    title: 'budget correction and a fallback preference',
    sourceType: 'curated',
    source: 'h-reference-suite',
    events: [input('Busco mancuernas, tengo como 150 mil para gastar'), input('perdón, me equivoqué, en verdad tengo 250 mil. y ojalá que sean ajustables'), input('y si no hay ajustables, unas de 10 kilos fijas igual me sirven')],
    invariants: [...CONVERSING, behavioral('sales.fact_history', { key: BUDGET, values: [clpv(150_000), clpv(250_000)] }), behavioral('sales.fact_equals', { key: BUDGET, value: clpv(250_000) })],
    constraints: ['budget corrected 150k → 250k', 'preference with a fallback'],
    tags: ['h-reference', 'correction'],
    script: [
      update([fact('budget', clpv(150_000))]),
      read(CAPABILITY_IDS.catalogSearch, { text: 'mancuernas', limit: 10 }),
      ...answer('Con $150.000 hay opciones; ¿buscas un par ajustable o fijas?'),
      update([fact('budget', clpv(250_000))]),
      ...answer('Anotado: $250.000. Las ajustables de 24 kg calzan con ese presupuesto.'),
      ...answer('Perfecto, lo tengo en cuenta como alternativa.'),
    ],
  },
  {
    id: 'H03',
    title: 'incidental question about another city in the middle of a purchase',
    sourceType: 'curated',
    source: 'h-reference-suite',
    events: [
      input('Estoy armando un gimnasio en la cochera y me falta la barra. ¿Qué barras olímpicas tienen?'),
      input('oye, pregunta aparte: ¿hacen envíos a regiones? mi hermano vive en Temuco y también quiere comprar'),
      input('ya buena. volviendo a lo mío, ¿cuál barra me conviene para sentadilla y peso muerto?'),
    ],
    invariants: [...CONVERSING, behavioral('sales.capability_used', { capabilityId: CAPABILITY_IDS.catalogSearch }), behavioral('sales.no_goal_abandoned')],
    tags: ['h-reference', 'incidental-question'],
    script: [read(CAPABILITY_IDS.catalogSearch, { text: 'barra olimpica', limit: 10 }), ...answer('Tenemos la barra olímpica de 20 kg y la técnica de 15 kg.'), ...generic(2)],
  },
  {
    id: 'H04',
    title: 'known customer asks for a quote with delivery',
    sourceType: 'curated',
    source: 'h-reference-suite',
    subjectRef: KNOWN,
    events: [input('Hola! quiero cotizar la barra olímpica de 20 kg y el set de discos de fierro de 50, con despacho a Ñuñoa porfa'), input('¿la cotización incluye el despacho o eso va aparte?')],
    invariants: [...CONVERSING, behavioral('sales.quotes_issued', { equals: 1 }), behavioral('sales.quote_cites_evidence')],
    tags: ['h-reference', 'quote', 'governed-write'],
    script: [
      read(CAPABILITY_IDS.customerContext),
      read(CAPABILITY_IDS.catalogSearch, { text: 'barra discos fierro', limit: 10 }),
      update([add('BAR-OLY20'), add('PLT-IRON-50'), destination('Ñuñoa')]),
      read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, items: [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'PLT-IRON-50', quantity: 1 }] }),
      proposeQuote(customerOnFile),
      ...answer(quoteReply),
      ...answer((v) => `Sí, la cotización ${observedQuote(v).quoteNumber} ya incluye el despacho a Ñuñoa.`),
    ],
  },
  {
    id: 'H05',
    title: 'customer leaves to measure, worker restarts, customer returns hours later',
    sourceType: 'curated',
    source: 'h-reference-suite',
    events: [
      input('Quiero armar un gym en la casa con mi señora, pero primero tengo que medir bien el espacio. Te escribo más rato'),
      restartWorker,
      advance(6 * HOUR, 'process_and_temporal', 'six hours pass'),
      input('ya volví! medí: son 2,8 x 3 metros y el techo tiene 2,4. Presupuesto como 900 lucas'),
      input('¿qué me recomiendas entonces?'),
    ],
    invariants: [...CONVERSING, technical('sales.waited_and_resumed'), technical('sales.prior_response_in_context')],
    tags: ['h-reference', 'wait-resume', 'process-restart'],
    script: generic(3),
  },
  {
    id: 'H06',
    title: 'price observed, three days pass and the price changes, then a quote',
    sourceType: 'curated',
    source: 'h-reference-suite',
    subjectRef: KNOWN,
    events: [
      input('Hola, ¿cuánto está el banco ajustable FID? ¿tienen stock?'),
      advance(3 * DAY, 'process_and_temporal', 'three days pass: catalog evidence expires'),
      { kind: 'owner_change', target: 'catalog', change: 'set-price', params: { productId: 'BENCH-FID', amount: 154_990 } },
      input('Hola de nuevo, perdón la demora. Me lo llevo: ¿me lo cotizas con despacho a Providencia?'),
    ],
    invariants: [...CONVERSING, technical('shadow.expired_evidence_in_history'), behavioral('sales.refreshed_after_expiry', { capabilityId: 'catalog.*' }), behavioral('sales.quotes_issued', { equals: 1 }), behavioral('sales.quote_line_price', { productId: 'BENCH-FID', amount: 154_990 })],
    constraints: ['the price observed on day 0 is stale on day 3'],
    tags: ['h-reference', 'stale-evidence', 'long-wait', 'quote'],
    script: [
      read(CAPABILITY_IDS.productContext, { productId: 'BENCH-FID' }),
      ...answer((v) => `El banco ajustable FID está a ${clp(v.product('BENCH-FID').unitPrice.amount)} y hay stock.`),
      read(CAPABILITY_IDS.customerContext),
      read(CAPABILITY_IDS.productContext, { productId: 'BENCH-FID' }),
      update([add('BENCH-FID'), destination('Providencia')]),
      proposeQuote(customerOnFile),
      ...answer(quoteReply),
    ],
  },
  {
    id: 'H07',
    title: 'catalog owner unavailable, then back',
    sourceType: 'curated',
    source: 'h-reference-suite',
    events: [fault('catalog', 'down', 'catalog outage'), input('¿tienen discos bumper? necesito como 100 kilos en total'), fault('catalog', 'up'), advance(10 * 60_000, 'process'), input('¿y ahora pudiste revisar?')],
    invariants: [...CONVERSING, behavioral('sales.failure_observed', { capabilityId: CAPABILITY_IDS.catalogSearch, category: 'temporarily_unavailable' }), behavioral('sales.quotes_issued', { equals: 0 })],
    tags: ['h-reference', 'domain-outage'],
    script: [
      read(CAPABILITY_IDS.catalogSearch, { text: 'bumper', limit: 10 }),
      ...answer('Ahora no puedo consultar el catálogo; apenas vuelva te confirmo precio y stock.'),
      read(CAPABILITY_IDS.catalogSearch, { text: 'bumper', limit: 10 }),
      ...answer((v) => `Sí: el set de discos bumper de 100 kg está a ${clp(v.product('PLT-BUMP-100').unitPrice.amount)}.`),
    ],
  },
  {
    id: 'H08A',
    title: 'provider timeout on the first model call',
    sourceType: 'synthetic',
    source: 'h-reference-suite',
    events: [fault('model', 'timeout', 'the next model call times out (injected)'), input('Hola, busco una barra para hacer peso muerto en la casa'), input('¿hola? ¿sigues ahí?')],
    invariants: [...SAFE, technical('shadow.model_failure_classified', { errorKind: 'timeout' }), technical('shadow.no_retry_after_model_failure'), technical('shadow.input_rejected_after_terminal')],
    acceptableStops: ['failed', 'awaiting_input'],
    tags: ['h-reference', 'fault-injection:provider', 'provider-timeout'],
    script: generic(1),
  },
  {
    id: 'H08B',
    title: 'trailing prose after the JSON decision (protocol failure)',
    sourceType: 'regression-derived',
    source: 'h-reference-suite',
    derivedFrom: ['REG-0004'],
    events: [fault('model', 'trailing_prose', 'the next model output has prose after the decision (injected)'), input('Quiero saber el precio de la barra olímpica de 20 kilos')],
    invariants: [...SAFE, technical('shadow.protocol_failure_recorded')],
    acceptableStops: ['failed'],
    tags: ['h-reference', 'fault-injection:provider', 'protocol-failure'],
    script: [],
  },
  {
    id: 'H09',
    title: 'quote outcome unknown, not resolvable in the run, reconciled through the scheduler',
    sourceType: 'synthetic',
    source: 'h-reference-suite',
    subjectRef: KNOWN,
    events: [
      fault('quote', 'connection-lost-after-issue-once', 'the owner records the quote, then the connection drops'),
      fault('quote', 'lookup-timeout-x3', 'the in-run reconciliation lookups time out'),
      input('Cotízame el soporte de sentadilla SQ-100 con despacho a Maipú, por favor'),
      input('¿me confirmas el número de la cotización?'),
    ],
    invariants: [...CONVERSING, technical('shadow.reconciled_via_scheduler'), behavioral('sales.quotes_issued', { equals: 1 })],
    tags: ['h-reference', 'unknown-outcome', 'reconciliation', 'scheduler', 'quote'],
    script: [
      read(CAPABILITY_IDS.customerContext),
      read(CAPABILITY_IDS.productContext, { productId: 'RACK-SQ100' }),
      update([add('RACK-SQ100'), destination('Maipú')]),
      proposeQuote(customerOnFile),
      ...answer(quoteReply),
      ...answer((v) => `Claro: es la cotización ${observedQuote(v).quoteNumber}.`),
    ],
  },
  {
    id: 'H10',
    title: 'quote under a policy profile that requires human approval',
    sourceType: 'synthetic',
    source: 'h-reference-suite',
    subjectRef: KNOWN,
    profiles: { policy: 'sales-shadow-approval' },
    events: [
      input('Hola, quiero cotizar las mancuernas ajustables de 24 kg, con despacho a Las Condes'),
      operator('approve', 'Aprobado: precios vigentes y cliente con historial.'),
      input('gracias! ¿en cuántos días llega?'),
    ],
    invariants: [...CONVERSING, technical('shadow.approval_reevaluated'), behavioral('sales.quotes_issued', { equals: 1 })],
    tags: ['h-reference', 'approval', 'quote', 'human'],
    script: [
      read(CAPABILITY_IDS.customerContext),
      read(CAPABILITY_IDS.productContext, { productId: 'DB-ADJ-24' }),
      update([add('DB-ADJ-24'), destination('Las Condes')]),
      proposeQuote(customerOnFile),
      ...answer(quoteReply),
      ...answer('El despacho a Las Condes demora entre 1 y 3 días hábiles.'),
    ],
  },
  {
    id: 'H11',
    title: 'operator takes over a post-sale complaint, releases it, the agent resumes',
    sourceType: 'curated',
    source: 'h-reference-suite',
    events: [
      input('Hola, compré un rack con ustedes hace un mes y me llegó con una pieza doblada. ¿Qué hago?'),
      operator('takeover', 'Tomo el caso: reclamo de postventa, lo gestiono con bodega.'),
      input('¿alguien me puede ayudar? sigo esperando respuesta'),
      operator('release', 'Resuelto por postventa: se coordinó el cambio de la pieza, llega el jueves. Si vuelve a preguntar, confirmar que el cambio va en camino.'),
      input('ok gracias! y aprovechando, ¿tienen barra de dominadas para ese rack?'),
    ],
    invariants: [...SAFE, technical('sales.root_goal_active'), technical('shadow.no_autonomous_run_during_handoff'), technical('shadow.resumed_after_release')],
    tags: ['h-reference', 'handoff', 'human', 'ownership'],
    script: [...answer('Lamento lo de la pieza. Te ayudo a gestionarlo con el equipo.'), ...answer('El cambio de la pieza ya está coordinado y llega el jueves.'), ...answer('Sí, tenemos barra de dominadas para rack.')],
  },
  {
    id: 'H12',
    title: 'operator cancels a conversation that is waiting for the customer',
    sourceType: 'synthetic',
    source: 'h-reference-suite',
    events: [input('Quiero cotizar una trotadora eléctrica, ¿qué tienen?'), operator('cancel', 'El cliente pidió por otro canal no continuar.'), input('hola? sigo interesado')],
    invariants: [...SAFE, technical('sales.task_status', { in: ['cancelled'] }), technical('shadow.input_rejected_after_terminal')],
    acceptableStops: ['cancelled'],
    tags: ['h-reference', 'cancellation', 'human'],
    script: [read(CAPABILITY_IDS.catalogSearch, { text: 'trotadora', limit: 5 }), ...answer('No tenemos trotadoras en el catálogo actual.')],
  },
  {
    id: 'H12B',
    title: 'operator cancels while a quote outcome is uncertain (scheduler down meanwhile)',
    sourceType: 'synthetic',
    source: 'h-reference-suite',
    subjectRef: KNOWN,
    events: [
      { kind: 'process', process: 'scheduler', action: 'stop' },
      fault('quote', 'connection-lost-after-issue-once'),
      fault('quote', 'lookup-timeout-x3'),
      input('Cotízame el banco ajustable FID con despacho a La Florida'),
      operator('cancel', 'Cancelado por la clienta vía teléfono.'),
      { kind: 'process', process: 'scheduler', action: 'start' },
    ],
    invariants: [...SAFE, technical('sales.task_status', { in: ['cancelled'] }), technical('shadow.cancel_deferred_until_reconciled')],
    acceptableStops: ['cancelled'],
    tags: ['h-reference', 'cancellation', 'unknown-outcome', 'reconciliation', 'scheduler'],
    script: [read(CAPABILITY_IDS.customerContext), read(CAPABILITY_IDS.productContext, { productId: 'BENCH-FID' }), update([add('BENCH-FID'), destination('La Florida')]), proposeQuote(customerOnFile)],
  },
  {
    id: 'H13',
    title: 'long conversation: teenager strength setup, corrections, side questions, a day away',
    sourceType: 'curated',
    source: 'h-reference-suite',
    events: [
      input('hola, mi hijo de 16 quiere empezar a entrenar fuerza y queremos armarle algo en la pieza de atrás'),
      input('la pieza mide como 3 x 2,5. el techo es normal, 2,4 creo'),
      input('presupuesto... digamos 700 mil'),
      input('¿es seguro que un cabro de 16 levante con barra? no quiero que se lesione'),
      input('ya, ¿qué me recomiendas para partir?'),
      input('mmm el rack grande no me convence, ¿no hay algo que ocupe menos?'),
      input('perdón, corrijo el presupuesto: mi señora dice que hasta 850 mil está bien'),
      advance(DAY, 'process_and_temporal', 'the customer comes back the next day'),
      input('hola, retomando lo de ayer. ¿el soporte de sentadilla viene con barra de dominadas?'),
      input('¿y qué discos me conviene, los de fierro o los bumper? el piso es de cerámica'),
      input('ok, vamos con los bumper de 60 entonces. ¿cuánto quedaría todo?'),
      input('¿y el piso de caucho es necesario? ¿cuántas planchas necesitaría?'),
      input('ya, déjame conversarlo con mi señora y te aviso'),
    ],
    invariants: [...CONVERSING, technical('sales.waited_and_resumed'), technical('sales.prior_response_in_context'), behavioral('sales.fact_history', { key: BUDGET, values: [clpv(700_000), clpv(850_000)] }), behavioral('sales.no_goal_abandoned'), behavioral('sales.quotes_issued', { equals: 0 })],
    constraints: ['12 customer turns', 'budget corrected', 'safety side question', 'preference change', 'a day between turns 7 and 8'],
    tags: ['h-reference', 'long-conversation', 'correction', 'wait-resume'],
    script: [...generic(2), update([fact('budget', clpv(700_000))]), ...answer('Anotado: $700.000.'), ...generic(3), update([fact('budget', clpv(850_000))]), ...answer('Perfecto, trabajamos con $850.000.'), ...generic(5)],
  },
  {
    id: 'H14',
    title: 'CENTRAL-like case in natural language: objective to governed quote',
    sourceType: 'curated',
    source: 'h-reference-suite',
    derivedFrom: ['CENTRAL'],
    subjectRef: KNOWN,
    events: [
      input('Buenas! tengo 800 lucas y quiero armar un gym en la casa, ¿me ayudas?'),
      input('ah antes, ¿cuánto pesa la barra olímpica?'),
      restartWorker,
      advance(30 * 60_000, 'process', 'half an hour passes'),
      input('tengo la cochera, como 3 x 2,5 y 2,3 de alto. Quiero hacer fuerza: sentadilla, banca y peso muerto'),
      input('igual puedo estirarme a 1,1 millones. ¿Me conviene cambiar los discos por los bumper de 100?'),
      input('perfecto, el despacho es a Ñuñoa. ¿me lo cotizas?'),
    ],
    invariants: [
      ...CONVERSING,
      technical('sales.waited_and_resumed'),
      technical('sales.prior_response_in_context'),
      behavioral('sales.goal_kept', { matches: 'gimnasio|gym' }),
      behavioral('sales.fact_history', { key: BUDGET, values: [clpv(800_000), clpv(1_100_000)] }),
      behavioral('sales.delivery_equals', { commune: 'Ñuñoa' }),
      behavioral('sales.quotes_issued', { equals: 1 }),
      behavioral('sales.refreshed_after_expiry', { capabilityId: 'catalog.*' }),
    ],
    tags: ['h-reference', 'central-like', 'quote', 'process-restart', 'correction'],
    script: CENTRAL_SCENARIO.turns.flatMap((t) => ('agent' in t ? t.agent : [])),
  },
  fromScenario(scenarioById('S02'), ['reference-scenario']),
  fromScenario(scenarioById('S03'), ['reference-scenario', 'incidental-question']),
  fromScenario(scenarioById('S04'), ['reference-scenario', 'correction']),
  fromScenario(scenarioById('S11'), ['reference-scenario', 'quote']),
  fromScenario(CENTRAL_SCENARIO, ['reference-scenario', 'central', 'quote']),
  {
    id: 'R01',
    title: 'colloquial, misspelled request for cheap weights and shipping',
    sourceType: 'curated',
    source: 'curated-realistic',
    events: [input('wena, ando buscando unas pesas pa la casa, algo barato pa empezar, tipo mancuernas o kettlebell no se'), input('kettlebel de 16 tienen??'), input('ya y cuanto sale el envio a puente alto')],
    invariants: [...CONVERSING, behavioral('sales.capability_used', { capabilityId: CAPABILITY_IDS.catalogSearch })],
    tags: ['curated', 'colloquial', 'misspellings'],
    script: [read(CAPABILITY_IDS.catalogSearch, { text: 'mancuernas kettlebell', limit: 10 }), ...answer('Tenemos kettlebell de 16 kg y mancuernas ajustables.'), ...generic(2)],
  },
  {
    id: 'R02',
    title: 'several constraints in one message (space, budget, noise, deadline, a teenager)',
    sourceType: 'curated',
    source: 'curated-realistic',
    events: [
      input('Necesito equipar una pieza de 3x4 m en mi casa para entrenar con mi hijo de 15. Presupuesto máximo 1,5 millones, que no haga mucho ruido porque vivo en depto (piso 4) y ojalá que llegue antes de fin de mes'),
      input('¿y los discos bumper hacen menos ruido que los de fierro?'),
    ],
    invariants: [...CONVERSING, behavioral('sales.fact_equals', { key: BUDGET, value: clpv(1_500_000) })],
    tags: ['curated', 'multiple-constraints'],
    script: [update([fact('budget', clpv(1_500_000))]), ...answer('Anotado: hasta $1.500.000, 3 x 4 m y poco ruido.'), ...generic(1)],
  },
  {
    id: 'R03',
    title: 'a limiting constraint revealed after the recommendation',
    sourceType: 'curated',
    source: 'curated-realistic',
    events: [input('Quiero un rack y una barra para entrenar en la casa'), input('¿cuál me recomiendas?'), input('ah, se me olvidó decirte: el techo es bajito, 2,10 m')],
    invariants: [...CONVERSING],
    constraints: ['ceiling 2.10 m revealed only on the third turn'],
    tags: ['curated', 'late-constraint'],
    script: generic(3),
  },
  {
    id: 'R04',
    title: 'preference change: from a named rack to something smaller',
    sourceType: 'curated',
    source: 'curated-realistic',
    events: [input('Me gustaría el power rack PR-200'), input('mmm pensándolo bien prefiero algo que ocupe menos espacio'), input('ok ese entonces, agrégalo por favor')],
    invariants: [...CONVERSING, behavioral('sales.capability_used', { capabilityId: CAPABILITY_IDS.productContext })],
    tags: ['curated', 'preference-change'],
    script: [read(CAPABILITY_IDS.productContext, { productId: 'RACK-PR200' }), ...answer('El PR-200 está disponible.'), read(CAPABILITY_IDS.productContext, { productId: 'RACK-SQ100' }), ...answer('Una opción más compacta es el soporte de sentadilla SQ-100.'), update([add('RACK-SQ100')]), ...answer('Listo, agregué el SQ-100.')],
  },
  {
    id: 'R05',
    title: 'question unrelated to the immediate next step, then a product question',
    sourceType: 'curated',
    source: 'curated-realistic',
    events: [input('¿Tienen tienda física? ¿a qué hora abren?'), input('ya, y de paso, ¿qué me recomiendan para empezar a hacer dominadas en la casa?')],
    invariants: [...CONVERSING],
    tags: ['curated', 'unrelated-question'],
    script: generic(2),
  },
  {
    id: 'R06',
    title: 'compatibility question between products (grounding)',
    sourceType: 'regression-derived',
    source: 'curated-realistic',
    derivedFrom: ['REG-0005'],
    events: [input('¿los discos de fierro de 50 kg le sirven a la barra olímpica de 20 kilos que venden?'), input('¿y los seguros también son compatibles?')],
    invariants: [...CONVERSING],
    tags: ['curated', 'grounding', 'compatibility'],
    script: [read(CAPABILITY_IDS.productContext, { productId: 'PLT-IRON-50' }), ...answer('Según el catálogo, los discos de fierro de 50 kg son compatibles con la barra olímpica.'), ...generic(1)],
  },
  {
    id: 'R07',
    title: 'asking for a category the catalog barely has (grounding)',
    sourceType: 'regression-derived',
    source: 'curated-realistic',
    derivedFrom: ['REG-0006'],
    events: [input('¿qué máquinas de cardio tienen? busco trotadora o bicicleta'), input('¿y el remo?')],
    invariants: [...CONVERSING],
    tags: ['curated', 'grounding', 'nonexistent-category'],
    script: [read(CAPABILITY_IDS.catalogSearch, { category: 'cardio', limit: 10 }), ...answer('En cardio solo aparece el remo magnético R-10, y está descontinuado.'), ...generic(1)],
  },
];

const BUILT = SPECS.map(build);

export const SALES_SHADOW_CORPUS: WorkloadCorpus = Object.freeze({ id: SALES_SHADOW_CORPUS_ID, version: SALES_SHADOW_CORPUS_VERSION, cases: BUILT.map((b) => b.workload) });

/** The minimum reference shadow suite (H01–H14 + variants). */
export const H_REFERENCE_CASE_IDS: readonly string[] = SALES_SHADOW_CORPUS.cases.filter((c) => c.tags.includes('h-reference')).map((c) => c.id);

/** Representative subset for repeated live baselines (N=3). */
export const REPEATED_BASELINE_CASE_IDS: readonly string[] = ['H01', 'H02', 'H03', 'H04', 'H05', 'H14'];

/** Small live smoke. */
export const SMOKE_CASE_IDS: readonly string[] = ['H01', 'H04', 'H05'];

export function scriptFor(caseId: string): readonly ScriptedStep[] {
  const found = BUILT.find((b) => b.workload.id === caseId);
  if (!found) throw new Error(`no workload case ${caseId}`);
  return found.script;
}

export function workloadById(caseId: string): WorkloadCase {
  const found = SALES_SHADOW_CORPUS.cases.find((c) => c.id.toLowerCase() === caseId.toLowerCase());
  if (!found) throw new Error(`unknown workload case ${caseId}; known: ${SALES_SHADOW_CORPUS.cases.map((c) => c.id).join(', ')}`);
  return found;
}
