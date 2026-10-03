import { CAPABILITY_IDS } from '../ids.js';
import type { Invariant } from './invariants.js';
import type { SalesHarness, SalesHarnessOptions } from './runtime.js';
import {
  add,
  clp,
  completeGoal,
  consult,
  createGoal,
  customerOnFile,
  destination,
  fact,
  focusGoal,
  observedQuote,
  proposeQuote,
  read,
  remove,
  replace,
  respond,
  setQuantity,
  update,
  type ContextView,
  type ScriptedStep,
} from './scripted.js';

/**
 * R4-F acceptance scenarios. Each one is a customer conversation (the turns
 * `sales:live` sends to a real model), a scripted trajectory (what the
 * deterministic CI stand-in decides, one entry per model call) and the
 * invariants that must hold in durable state afterwards. The scripted
 * trajectories are plausible, not prescribed: nothing in the platform or the
 * Sales pack enforces their order.
 */
export type ScenarioTurn =
  | { readonly customer: string; readonly agent: readonly ScriptedStep[]; readonly workerDiesWhen?: (harness: SalesHarness) => boolean }
  | { readonly operator: string; readonly agent: readonly ScriptedStep[] }
  | { readonly control: string; readonly run: (harness: SalesHarness, taskId: string) => Promise<void> | void };

export interface SalesScenario {
  readonly id: string;
  readonly title: string;
  /** Customer reference the conversation is bound to; null/absent = anonymous. */
  readonly customerRef?: string | null;
  /** Part of the representative subset `sales:live` runs against a real model. */
  readonly live?: boolean;
  readonly harness?: Pick<SalesHarnessOptions, 'leaseDurationMs' | 'heartbeatIntervalMs'>;
  readonly turns: readonly ScenarioTurn[];
  readonly invariants: readonly Invariant[];
}

const HOME_GYM = /gimnasio|gym/i;
/** The budget fact, whatever key the agent chose for it (the Sales pack prescribes none). */
const BUDGET = { matches: '^(budget|presupuesto)(_|$)' };
const KNOWN_CUSTOMER = 'cust-demo-001';

const once = <T>(value: T, then: T) => {
  let used = false;
  return () => (used ? then : ((used = true), value));
};
const priceOf = (v: ContextView, id: string) => v.product(id).price!.finalGross.amount;
const sumOf = (v: ContextView, ids: readonly string[]) => ids.reduce((sum, id) => sum + priceOf(v, id), 0);
/** The owner's first offer as observed (the script states one offer; it never ranks or selects for the customer). */
const firstOffer = (v: ContextView) => (v.latest(CAPABILITY_IDS.shippingQuote).payload as { offers: { carrierName: string; price: { customerGross: { amount: number } } }[] }).offers[0]!;
const gymGoal = (v: ContextView) => v.goal(HOME_GYM);

const always: readonly Invariant[] = [{ kind: 'no_unbacked_quote_claim' }, { kind: 'responded_every_turn' }, { kind: 'root_goal_active' }];

export const SCENARIOS: readonly SalesScenario[] = [
  {
    id: 'S01',
    title: 'simple product question',
    live: false,
    turns: [
      {
        customer: '¿Cuánto pesa y cuánto cuesta la barra olímpica de 20 kg?',
        agent: [
          read(CAPABILITY_IDS.catalogSearch, { query: 'barra olimpica', limit: 5 }),
          read(CAPABILITY_IDS.productContext, { productKey: 'BAR-OLY20' }),
          respond((v) => `La ${v.product('BAR-OLY20').name} pesa ${v.product('BAR-OLY20').specification('Peso')} y hoy cuesta ${clp(priceOf(v, 'BAR-OLY20'))}.`),
        ],
      },
    ],
    invariants: [...always, { kind: 'capability_used', capabilityId: CAPABILITY_IDS.productContext }, { kind: 'capability_not_used', capabilityId: CAPABILITY_IDS.quoteCreate }, { kind: 'quotes_issued', equals: 0 }, { kind: 'task_status', in: ['waiting'] }],
  },
  {
    id: 'S02',
    title: 'budget-constrained solution',
    live: true,
    turns: [
      {
        customer: 'Tengo $800.000 y quiero armar un gym para la casa.',
        agent: [
          createGoal('Armar un gimnasio en casa dentro de un presupuesto de $800.000'),
          update([fact('budget', { amount: 800_000, currency: 'CLP' }), fact('objective', 'home gym')]),
          read(CAPABILITY_IDS.catalogSearch, { query: 'racks', filters: { maxUnitPrice: 800_000, sellableOnly: true }, limit: 10 }),
          respond('¡Buena idea! Para proponerte algo que calce: ¿cuánto espacio tienes (largo, ancho y alto) y qué tipo de entrenamiento quieres hacer?'),
        ],
      },
      {
        customer: 'Tengo 3 x 3 metros en la cochera, 2,4 m de alto. Quiero hacer fuerza: sentadilla y press banca.',
        agent: [
          update([fact('available_space', { widthCm: 300, depthCm: 300, heightCm: 240 }), fact('training', 'fuerza: sentadilla y press banca')]),
          read(CAPABILITY_IDS.productContext, { productKey: 'RACK-PR200' }),
          read(CAPABILITY_IDS.catalogSearch, { query: 'discos', filters: { sellableOnly: true }, limit: 10 }),
          read(CAPABILITY_IDS.catalogSearch, { query: 'bancos', filters: { sellableOnly: true }, limit: 10 }),
          read(CAPABILITY_IDS.catalogSearch, { query: 'barras', filters: { sellableOnly: true }, limit: 10 }),
          update([add('RACK-PR200'), add('BAR-OLY20'), add('PLT-IRON-50'), add('BENCH-FID')]),
          respond((v) => `Te propongo: Power Rack PR-200, barra olímpica 20 kg, discos de fierro 50 kg y banco ajustable. Total ${clp(sumOf(v, ['RACK-PR200', 'BAR-OLY20', 'PLT-IRON-50', 'BENCH-FID']))}, dentro de tu presupuesto. ¿Te sirve?`),
        ],
      },
    ],
    invariants: [
      ...always,
      { kind: 'goal_kept', matches: HOME_GYM.source },
      { kind: 'fact_equals', key: BUDGET, value: { amount: 800_000, currency: 'CLP' } },
      { kind: 'capability_used', capabilityId: CAPABILITY_IDS.catalogSearch, min: 2 },
      { kind: 'selection_equals', items: [{ productId: 'RACK-PR200', quantity: 1 }, { productId: 'BAR-OLY20', quantity: 1 }, { productId: 'PLT-IRON-50', quantity: 1 }, { productId: 'BENCH-FID', quantity: 1 }] },
      { kind: 'quotes_issued', equals: 0 },
    ],
  },
  {
    id: 'S03',
    title: 'incidental question preserves the goal',
    live: true,
    turns: [
      {
        customer: 'Tengo $800.000 y quiero armar un gym para la casa. Estaba mirando la barra olímpica de 20 kg.',
        agent: [
          createGoal('Armar un gimnasio en casa dentro de $800.000'),
          update([fact('budget', { amount: 800_000, currency: 'CLP' })]),
          respond('Perfecto. Para armarte una propuesta, ¿cuánto espacio tienes disponible?'),
        ],
      },
      {
        customer: 'Antes, ¿cuánto pesa esa barra?',
        agent: [
          read(CAPABILITY_IDS.productContext, { productKey: 'BAR-OLY20' }),
          respond((v) => `La barra olímpica pesa ${v.product('BAR-OLY20').specification('Peso')}. Volviendo a tu gimnasio: ¿cuánto espacio tienes?`),
        ],
      },
      {
        customer: 'Unos 2,5 x 3 metros.',
        agent: [update([fact('available_space', { widthCm: 250, depthCm: 300 })]), respond('Con ese espacio cabe bien un rack. ¿Qué tipo de entrenamiento te interesa?')],
      },
    ],
    invariants: [...always, { kind: 'goal_kept', matches: HOME_GYM.source }, { kind: 'current_goal_matches', matches: HOME_GYM.source }, { kind: 'no_goal_abandoned' }, { kind: 'fact_equals', key: BUDGET, value: { amount: 800_000, currency: 'CLP' } }],
  },
  {
    id: 'S04',
    title: 'the customer corrects the budget',
    live: true,
    turns: [
      {
        customer: 'Quiero equipar un gimnasio en casa, mi presupuesto es de 800 lucas.',
        agent: [createGoal('Equipar un gimnasio en casa dentro del presupuesto del cliente'), update([fact('budget', { amount: 800_000, currency: 'CLP' })]), respond('Anotado: $800.000. ¿Qué espacio tienes?')],
      },
      {
        customer: 'En realidad puedo llegar a 1,1 millones.',
        agent: [update([fact('budget', { amount: 1_100_000, currency: 'CLP' }, 'customer')]), respond('Perfecto, trabajamos con $1.100.000. ¿Qué espacio tienes?')],
      },
    ],
    invariants: [...always, { kind: 'fact_history', key: BUDGET, values: [{ amount: 800_000, currency: 'CLP' }, { amount: 1_100_000, currency: 'CLP' }] }, { kind: 'fact_equals', key: BUDGET, value: { amount: 1_100_000, currency: 'CLP' } }],
  },
  {
    id: 'S05',
    title: 'add, remove and change products without accidental replacement',
    turns: [
      {
        customer: 'Agrega el rack PR-200 y la barra olímpica de 20 kg.',
        agent: [read(CAPABILITY_IDS.catalogSearch, { query: 'rack barra', limit: 10 }), update([add('RACK-PR200'), add('BAR-OLY20')]), respond('Listo, agregué el rack PR-200 y la barra de 20 kg.')],
      },
      {
        customer: 'Suma también la barra "Titan X" que vi en Instagram.',
        agent: [
          // A made-up id is refused by the Catalog check, never silently selected.
          update([add('BAR-TITANX')]),
          // Adding an already selected item is rejected instead of replacing the selection.
          update([add('BAR-OLY20')]),
          respond('No encuentro la "Titan X" en nuestro catálogo, y la barra de 20 kg ya está en tu selección.'),
        ],
      },
      {
        customer: 'Mejor saca el rack y deja 2 barras.',
        agent: [update([remove('RACK-PR200'), setQuantity('BAR-OLY20', 2)]), respond('Hecho: quité el rack y dejé 2 barras olímpicas.')],
      },
    ],
    invariants: [
      ...always,
      { kind: 'selection_equals', items: [{ productId: 'BAR-OLY20', quantity: 2 }] },
      { kind: 'write_rejected_then_recovered', capabilityId: CAPABILITY_IDS.workspaceUpdate, code: 'unknown_product' },
      { kind: 'write_rejected_then_recovered', capabilityId: CAPABILITY_IDS.workspaceUpdate, code: 'item_already_selected' },
    ],
  },
  {
    id: 'S06',
    title: 'the delivery destination changes',
    turns: [
      {
        customer: 'Quiero la barra olímpica de 20 kg con los discos de fierro de 50 kg, con despacho a Ñuñoa. ¿Cuánto sale el envío?',
        agent: [
          read(CAPABILITY_IDS.catalogSearch, { query: 'barra discos fierro', limit: 10 }),
          update([add('BAR-OLY20'), add('PLT-IRON-50'), destination('Ñuñoa')]),
          read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, basis: 'order', items: [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'PLT-IRON-50', quantity: 1 }] }),
          respond((v) => `El despacho a Ñuñoa con ${firstOffer(v).carrierName} sale ${clp(firstOffer(v).price.customerGross.amount)} (IVA incluido).`),
        ],
      },
      {
        customer: 'Me cambio de casa: el despacho ahora es a Viña del Mar.',
        agent: [
          update([destination('Viña del Mar')]),
          read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Viña del Mar' }, basis: 'order', items: [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'PLT-IRON-50', quantity: 1 }] }),
          respond((v) => `A Viña del Mar el despacho con ${firstOffer(v).carrierName} sale ${clp(firstOffer(v).price.customerGross.amount)} (IVA incluido); el valor anterior era para Ñuñoa.`),
        ],
      },
    ],
    invariants: [...always, { kind: 'delivery_equals', commune: 'Viña del Mar' }, { kind: 'shipping_evidence_superseded_by_destination' }],
  },
  {
    id: 'S07',
    title: 'stale price and stock are read again before quoting',
    customerRef: KNOWN_CUSTOMER,
    turns: [
      {
        customer: 'Me interesa la barra olímpica de 20 kg.',
        agent: [read(CAPABILITY_IDS.productContext, { productKey: 'BAR-OLY20' }), update([add('BAR-OLY20')]), respond((v) => `La barra de 20 kg cuesta ${clp(priceOf(v, 'BAR-OLY20'))} y hay stock.`)],
      },
      { control: 'twenty minutes pass (beyond the catalog freshness window) and the owner changes the price', run: (h) => {
        h.clock.offsetMs += 20 * 60_000;
        h.domains.catalog.setPrice('BAR-OLY20', 139_990);
      } },
      {
        customer: 'Perfecto, cotízamela con despacho a Ñuñoa.',
        agent: [
          read(CAPABILITY_IDS.customerContext),
          // The earlier observation is now history: the price must be read again from its owner.
          read(CAPABILITY_IDS.productContext, { productKey: 'BAR-OLY20' }),
          update([destination('Ñuñoa')]),
          proposeQuote(customerOnFile),
          respond((v) => `Listo: cotización ${observedQuote(v).quoteNumber} por ${clp(observedQuote(v).total.amount)}. Ojo: el precio de la barra se actualizó a ${clp(priceOf(v, 'BAR-OLY20'))}.`),
        ],
      },
    ],
    invariants: [...always, { kind: 'refreshed_after_expiry', capabilityId: CAPABILITY_IDS.productContext }, { kind: 'quotes_issued', equals: 1 }, { kind: 'quote_line_price', productId: 'BAR-OLY20', amount: 139_990 }, { kind: 'quote_cites_evidence' }],
  },
  {
    id: 'S08',
    title: 'anonymous exploration; identity details asked only to quote',
    customerRef: null,
    turns: [
      {
        customer: 'Hola, busco mancuernas ajustables.',
        agent: [read(CAPABILITY_IDS.customerContext), read(CAPABILITY_IDS.catalogSearch, { query: 'mancuernas ajustables', limit: 5 }), respond((v) => `Tenemos las ${v.product('DB-ADJ-24').name} a ${clp(priceOf(v, 'DB-ADJ-24'))}.`)],
      },
      {
        customer: 'Me gustan. Cotízame un par con despacho a Providencia, soy Pedro Soto.',
        agent: [
          update([add('DB-ADJ-24'), destination('Providencia')]),
          // Missing contact: capability validation refuses the mutation; nothing is issued.
          proposeQuote({ name: 'Pedro Soto' }),
          respond('Para emitir la cotización solo me falta un email o teléfono de contacto.'),
        ],
      },
      {
        customer: 'pedro.soto@example.test',
        agent: [proposeQuote({ name: 'Pedro Soto', email: 'pedro.soto@example.test' }), respond((v) => `Cotización ${observedQuote(v).quoteNumber} emitida por ${clp(observedQuote(v).total.amount)}.`)],
      },
    ],
    invariants: [...always, { kind: 'capability_used', capabilityId: CAPABILITY_IDS.catalogSearch }, { kind: 'write_rejected_then_recovered', capabilityId: CAPABILITY_IDS.quoteCreate, code: 'write_validation_failure' }, { kind: 'quotes_issued', equals: 1 }],
  },
  {
    id: 'S09',
    title: 'wait, process boundary, resume',
    turns: [
      {
        customer: 'Quiero armar un gym en la casa para entrenar con mi pareja.',
        agent: [createGoal('Armar un gimnasio en casa para dos personas'), update([fact('users', 2)]), respond('¡Buenísimo! ¿Qué presupuesto tienen en mente?')],
      },
      { control: 'the worker process is replaced (only PostgreSQL survives)', run: (h) => h.restartWorker() },
      {
        customer: 'Unos 600 mil.',
        agent: [update([fact('budget', { amount: 600_000, currency: 'CLP' })]), respond('Perfecto, con $600.000 para dos personas podemos armar algo sólido. ¿Qué espacio tienen?')],
      },
    ],
    invariants: [...always, { kind: 'waited_and_resumed' }, { kind: 'goal_kept', matches: HOME_GYM.source }, { kind: 'fact_equals', key: 'users', value: 2 }, { kind: 'fact_equals', key: BUDGET, value: { amount: 600_000, currency: 'CLP' } }, { kind: 'prior_response_in_context' }],
  },
  {
    id: 'S10',
    title: 'consultation of non-domain human knowledge, then resume',
    turns: [
      {
        customer: '¿Ustedes instalan el power rack en la casa? ¿Tiene costo?',
        // R4-J1E-R2.2: a reply ends the turn, so the consultation comes first; the answer follows once the operator replies.
        agent: [consult('¿Ofrecemos instalación a domicilio del Power Rack PR-200 en la Región Metropolitana? ¿Cuál es el costo y el plazo?')],
      },
      { operator: 'Sí: instalación en la RM por $35.000, se coordina con 48 horas de anticipación.', agent: [respond('Sí instalamos en la RM: cuesta $35.000 y se coordina con 48 horas de anticipación.')] },
    ],
    invariants: [{ kind: 'no_unbacked_quote_claim' }, { kind: 'root_goal_active' }, { kind: 'consultation_answered_and_resumed' }, { kind: 'capability_not_used', capabilityId: CAPABILITY_IDS.quoteCreate }],
  },
  {
    id: 'S11',
    title: 'governed quote success, and continuing after it',
    customerRef: KNOWN_CUSTOMER,
    live: true,
    turns: [
      {
        customer: 'Quiero cotizar el Power Rack PR-200, la barra olímpica de 20 kg y los discos de fierro de 50 kg, con despacho a Ñuñoa.',
        agent: [
          read(CAPABILITY_IDS.customerContext),
          read(CAPABILITY_IDS.catalogSearch, { query: 'power rack', limit: 5 }),
          read(CAPABILITY_IDS.catalogSearch, { query: 'barra olimpica discos fierro', limit: 10 }),
          update([add('RACK-PR200'), add('BAR-OLY20'), add('PLT-IRON-50'), destination('Ñuñoa')]),
          read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, basis: 'order', items: [{ productId: 'RACK-PR200', quantity: 1 }, { productId: 'BAR-OLY20', quantity: 1 }, { productId: 'PLT-IRON-50', quantity: 1 }] }),
          proposeQuote(customerOnFile),
          respond((v) => `Listo, Camila: cotización ${observedQuote(v).quoteNumber} por ${clp(observedQuote(v).total.amount)} con despacho a Ñuñoa.`),
        ],
      },
      {
        customer: '¿Hasta cuándo es válida?',
        agent: [respond((v) => `La cotización ${observedQuote(v).quoteNumber} es válida hasta el ${observedQuote(v).validUntil.slice(0, 10)}.`)],
      },
    ],
    invariants: [...always, { kind: 'quotes_issued', equals: 1 }, { kind: 'quote_cites_evidence' }, { kind: 'one_receipt_per_execution' }, { kind: 'capability_used', capabilityId: CAPABILITY_IDS.shippingQuote }],
  },
  {
    id: 'S12',
    title: 'quote validation rejections and recovery',
    customerRef: KNOWN_CUSTOMER,
    turns: [
      {
        customer: 'Cotízame la barra olímpica de 20 kg.',
        agent: [
          read(CAPABILITY_IDS.customerContext),
          read(CAPABILITY_IDS.productContext, { productKey: 'BAR-OLY20' }),
          update([add('BAR-OLY20')]),
          // The model may not set quote results: an extra field is a validation failure, not a quote.
          proposeQuote(customerOnFile, { total: { amount: 1, currency: 'CLP' } }),
          // Without a destination the Quote capability refuses (receipt-backed rejection, nothing issued).
          proposeQuote(customerOnFile),
          respond('¿A qué comuna te la despachamos?'),
        ],
      },
      {
        customer: 'A Maipú.',
        agent: [update([destination('Maipú')]), proposeQuote(customerOnFile), respond((v) => `Cotización ${observedQuote(v).quoteNumber}: ${clp(observedQuote(v).total.amount)} con despacho a Maipú.`)],
      },
    ],
    invariants: [
      ...always,
      { kind: 'write_rejected_then_recovered', capabilityId: CAPABILITY_IDS.quoteCreate, code: 'write_validation_failure' },
      { kind: 'write_rejected_then_recovered', capabilityId: CAPABILITY_IDS.quoteCreate, code: 'workspace_incomplete' },
      { kind: 'quotes_issued', equals: 1 },
    ],
  },
  {
    id: 'S13',
    title: 'the worker dies after the quote was issued, before its receipt',
    customerRef: KNOWN_CUSTOMER,
    harness: { leaseDurationMs: 1_500, heartbeatIntervalMs: 300 },
    turns: [
      { control: 'the Quote owner will issue the quote and then never answer (the worker dies waiting)', run: (h) => {
        h.domains.quotes.faults.afterIssue = once('hang' as const, 'answer' as const);
      } },
      {
        customer: 'Cotízame la barra olímpica de 20 kg con despacho a Providencia.',
        workerDiesWhen: (h) => h.domains.quotes.issued.length === 1,
        agent: [
          read(CAPABILITY_IDS.customerContext),
          read(CAPABILITY_IDS.productContext, { productKey: 'BAR-OLY20' }),
          update([add('BAR-OLY20'), destination('Providencia')]),
          proposeQuote(customerOnFile),
          // Only after the platform reconciled the command by its execution key does the agent see the quote.
          respond((v) => `Cotización ${observedQuote(v).quoteNumber} emitida por ${clp(observedQuote(v).total.amount)}.`),
        ],
      },
    ],
    invariants: [...always, { kind: 'quotes_issued', equals: 1 }, { kind: 'one_receipt_per_execution' }],
  },
  {
    id: 'S14',
    title: 'no repeated question when the answer is already known',
    live: true,
    turns: [
      {
        customer: 'Tengo 800 mil, un espacio de 2 x 2 metros y quiero entrenar fuerza en casa.',
        agent: [
          createGoal('Armar un gimnasio de fuerza en casa en 2 x 2 m con $800.000'),
          update([fact('budget', { amount: 800_000, currency: 'CLP' }), fact('available_space', { widthCm: 200, depthCm: 200 }), fact('training', 'fuerza')]),
          read(CAPABILITY_IDS.catalogSearch, { query: 'racks', filters: { sellableOnly: true }, limit: 10 }),
          respond((v) => `Para 2 x 2 m te recomiendo el soporte de sentadilla SQ-100 (${clp(priceOf(v, 'RACK-SQ100'))}), que ocupa 120 x 110 cm. ¿Lo complementamos con barra y discos?`),
        ],
      },
      {
        customer: 'Sí, ¿qué me recomiendas entonces?',
        agent: [
          read(CAPABILITY_IDS.catalogSearch, { query: 'discos', filters: { sellableOnly: true }, limit: 10 }),
          read(CAPABILITY_IDS.catalogSearch, { query: 'barras', filters: { sellableOnly: true }, limit: 10 }),
          update([add('RACK-SQ100'), add('BAR-OLY20'), add('PLT-BUMP-100')]),
          respond((v) => `Con tu presupuesto y espacio: SQ-100 + barra de 20 kg + discos bumper de 100 kg = ${clp(sumOf(v, ['RACK-SQ100', 'BAR-OLY20', 'PLT-BUMP-100']))}.`),
        ],
      },
    ],
    invariants: [...always, { kind: 'no_question_after_fact', key: BUDGET, topic: 'presupuesto|budget|cu[aá]nto (dinero|quieres gastar)' }, { kind: 'no_question_after_fact', key: 'available_space', topic: 'espacio|metros|space' }],
  },
  {
    id: 'S15',
    title: 'unavailable product and alternative search',
    turns: [
      {
        customer: 'Quiero el Power Rack PR-300 Pro.',
        agent: [
          read(CAPABILITY_IDS.catalogSearch, { query: 'PR-300', limit: 5 }),
          read(CAPABILITY_IDS.productContext, { productKey: 'RACK-PR300' }),
          read(CAPABILITY_IDS.productContext, { productKey: 'RACK-PR200' }),
          respond((v) => `El PR-300 Pro está sin stock. Una alternativa disponible es el ${v.product('RACK-PR200').name} a ${clp(priceOf(v, 'RACK-PR200'))}.`),
        ],
      },
      { customer: 'Ok, el PR-200 entonces.', agent: [update([add('RACK-PR200')]), respond('Listo, el PR-200 quedó en tu selección.')] },
    ],
    invariants: [...always, { kind: 'selection_equals', items: [{ productId: 'RACK-PR200', quantity: 1 }] }, { kind: 'capability_used', capabilityId: CAPABILITY_IDS.productContext, min: 2 }],
  },
  {
    id: 'S16',
    title: 'catalog outage is reported honestly',
    turns: [
      { control: 'the Catalog owner goes down', run: (h) => h.domains.catalog.availability.set({ mode: 'down' }) },
      {
        customer: '¿Tienen barras olímpicas?',
        agent: [read(CAPABILITY_IDS.catalogSearch, { query: 'barra olimpica', limit: 5 }), respond('Ahora no puedo consultar el catálogo; en cuanto vuelva te confirmo disponibilidad y precio.')],
      },
      { control: 'the Catalog owner is back', run: (h) => h.domains.catalog.availability.set({ mode: 'up' }) },
      { customer: '¿Y ahora?', agent: [read(CAPABILITY_IDS.catalogSearch, { query: 'barra olimpica', limit: 5 }), respond((v) => `Sí: la barra olímpica de 20 kg está a ${clp(priceOf(v, 'BAR-OLY20'))}.`)] },
    ],
    invariants: [...always, { kind: 'failure_observed', capabilityId: CAPABILITY_IDS.catalogSearch, category: 'temporarily_unavailable' }],
  },
  {
    id: 'S17',
    title: 'quote outcome unknown, resolved by reconciliation',
    customerRef: KNOWN_CUSTOMER,
    turns: [
      { control: 'the connection to the Quote owner drops right after it issued the quote', run: (h) => {
        h.domains.quotes.faults.afterIssue = once('connection_lost' as const, 'answer' as const);
      } },
      {
        customer: 'Cotízame el banco ajustable con despacho a La Florida.',
        agent: [
          read(CAPABILITY_IDS.customerContext),
          read(CAPABILITY_IDS.productContext, { productKey: 'BENCH-FID' }),
          update([add('BENCH-FID'), destination('La Florida')]),
          proposeQuote(customerOnFile),
          respond((v) => `Cotización ${observedQuote(v).quoteNumber} emitida por ${clp(observedQuote(v).total.amount)}.`),
        ],
      },
    ],
    invariants: [...always, { kind: 'quotes_issued', equals: 1 }, { kind: 'one_receipt_per_execution' }],
  },
];

/**
 * The central R4-F acceptance case: a vague objective with a budget, an
 * incidental question, a process boundary with time passing, a correction,
 * a product change, shipping and a governed quote — along one trajectory.
 */
export const CENTRAL_SCENARIO: SalesScenario = {
  id: 'CENTRAL',
  title: '$800.000 home gym — objective to governed quote',
  customerRef: KNOWN_CUSTOMER,
  live: true,
  turns: [
    {
      customer: 'Tengo $800.000 y quiero armar un gym para la casa.',
      agent: [
        createGoal('Armar un gimnasio en casa adecuado dentro del presupuesto del cliente'),
        update([fact('budget', { amount: 800_000, currency: 'CLP' }), fact('objective', 'gimnasio en casa')]),
        read(CAPABILITY_IDS.catalogSearch, { query: 'rack barra discos banco', filters: { maxUnitPrice: 800_000, sellableOnly: true }, limit: 10 }),
        createGoal('Entender el espacio disponible y el tipo de entrenamiento', gymGoal),
        respond('¡Vamos! Para que todo calce: ¿cuánto espacio tienes (largo, ancho, alto) y qué te gustaría entrenar?'),
      ],
    },
    {
      customer: 'Antes, ¿cuánto pesa la barra olímpica?',
      agent: [read(CAPABILITY_IDS.productContext, { productKey: 'BAR-OLY20' }), respond((v) => `La barra olímpica pesa ${v.product('BAR-OLY20').specification('Peso')}. Y para tu gimnasio: ¿qué espacio tienes y qué quieres entrenar?`)],
    },
    { control: 'the worker process is replaced and 30 minutes pass (catalog evidence expires)', run: async (h) => {
      await h.restartWorker();
      h.clock.offsetMs += 30 * 60_000;
    } },
    {
      customer: 'Tengo 3 x 2,5 m en la cochera y 2,3 m de alto. Quiero fuerza: sentadilla, press banca y peso muerto.',
      agent: [
        update([fact('available_space', { widthCm: 300, depthCm: 250, heightCm: 230 }), fact('training', 'fuerza: sentadilla, press banca, peso muerto')]),
        completeGoal((v) => v.goal(/espacio/i)),
        focusGoal(gymGoal),
        read(CAPABILITY_IDS.productContext, { productKey: 'RACK-PR200' }),
        read(CAPABILITY_IDS.catalogSearch, { query: 'discos', filters: { sellableOnly: true }, limit: 10 }),
        read(CAPABILITY_IDS.catalogSearch, { query: 'barras', filters: { sellableOnly: true }, limit: 10 }),
        read(CAPABILITY_IDS.catalogSearch, { query: 'bancos', filters: { sellableOnly: true }, limit: 10 }),
        update([add('RACK-PR200'), add('BAR-OLY20'), add('PLT-IRON-50'), add('BENCH-FID')]),
        respond((v) => `Propuesta: Power Rack PR-200 (mide 120 x 140 x 215 cm, cabe), barra olímpica 20 kg, discos de fierro 50 kg y banco ajustable: ${clp(sumOf(v, ['RACK-PR200', 'BAR-OLY20', 'PLT-IRON-50', 'BENCH-FID']))}.`),
      ],
    },
    {
      customer: 'En realidad puedo llegar a 1,1 millones. ¿Me conviene cambiar los discos por los bumper de 100 kg?',
      agent: [
        update([fact('budget', { amount: 1_100_000, currency: 'CLP' }), replace('PLT-IRON-50', 'PLT-BUMP-100')]),
        read(CAPABILITY_IDS.productContext, { productKey: 'PLT-BUMP-100' }),
        respond((v) => `Sí: los bumper protegen el piso y suman más carga. Con el cambio quedas en ${clp(sumOf(v, ['RACK-PR200', 'BAR-OLY20', 'PLT-BUMP-100', 'BENCH-FID']))}, dentro de $1.100.000.`),
      ],
    },
    {
      customer: 'Perfecto. El despacho es a Ñuñoa. Cotízalo por favor.',
      agent: [
        read(CAPABILITY_IDS.customerContext),
        update([destination('Ñuñoa')]),
        read(CAPABILITY_IDS.shippingQuote, (v) => ({ destination: { commune: 'Ñuñoa' }, basis: 'order', items: v.workspace.selection.map((s) => ({ productId: s.productId, quantity: s.quantity })) })),
        proposeQuote(customerOnFile),
        respond((v) => `Listo: cotización ${observedQuote(v).quoteNumber} por ${clp(observedQuote(v).total.amount)} (despacho a Ñuñoa incluido), válida hasta el ${observedQuote(v).validUntil.slice(0, 10)}.`),
      ],
    },
  ],
  invariants: [
    ...always,
    { kind: 'goal_kept', matches: HOME_GYM.source },
    { kind: 'current_goal_matches', matches: HOME_GYM.source },
    { kind: 'no_goal_abandoned' },
    { kind: 'fact_history', key: BUDGET, values: [{ amount: 800_000, currency: 'CLP' }, { amount: 1_100_000, currency: 'CLP' }] },
    { kind: 'selection_equals', items: [{ productId: 'RACK-PR200', quantity: 1 }, { productId: 'BAR-OLY20', quantity: 1 }, { productId: 'PLT-BUMP-100', quantity: 1 }, { productId: 'BENCH-FID', quantity: 1 }] },
    { kind: 'delivery_equals', commune: 'Ñuñoa' },
    { kind: 'capability_used', capabilityId: CAPABILITY_IDS.catalogSearch },
    { kind: 'capability_used', capabilityId: CAPABILITY_IDS.shippingQuote },
    { kind: 'refreshed_after_expiry', capabilityId: 'catalog.*' },
    { kind: 'waited_and_resumed' },
    { kind: 'prior_response_in_context' },
    { kind: 'quotes_issued', equals: 1 },
    { kind: 'quote_cites_evidence' },
    { kind: 'one_receipt_per_execution' },
  ],
};

export const ALL_SCENARIOS: readonly SalesScenario[] = [...SCENARIOS, CENTRAL_SCENARIO];

export function scenarioById(id: string): SalesScenario {
  const found = ALL_SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase());
  if (!found) throw new Error(`unknown scenario ${id}; known: ${ALL_SCENARIOS.map((s) => s.id).join(', ')}`);
  return found;
}
