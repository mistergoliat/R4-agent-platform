import type { DeskOpportunityInput } from '../capabilities/desk-opportunity.js';

/**
 * (ADR-062 O1) Evaluation of desk.opportunity.record: does Pesín record an opportunity when it should, and with which
 * classification (trigger, intent, segment, complexity)? A labeled set of synthetic Spanish conversations of a Chilean
 * gym-equipment store (no real customer, product or person) and a per-field accuracy scorer.
 *
 * The scorer reads RECORDED inputs (what the model passed to desk.opportunity.record in each conversation); it never
 * calls a model. How to run it (the O1 gate, ADR-062 Fases):
 *   1. In web QA on sales-web@21, play each case's visitor turns as one conversation.
 *   2. Write predictions.json: { "<case id>": <the first desk.opportunity.record input of that conversation> | null }
 *      (from the action receipts of each conversation, or the QA desk's opportunities).
 *   3. npm run build && npm run eval:sales -- --opportunity predictions.json
 * The owner sets the accuracy threshold of the gate.
 */
export type OpportunityLabel = Pick<DeskOpportunityInput, 'trigger' | 'intent' | 'segment' | 'complexity'>;
export const OPPORTUNITY_FIELDS = ['trigger', 'intent', 'segment', 'complexity'] as const;

export interface OpportunityCase {
  readonly id: string;
  /** Visitor turns, in order; the moment Pesín records is implied by the expected trigger. */
  readonly visitor: readonly string[];
  /** null = no opportunity must be recorded (a pure question without buying intent). */
  readonly expected: OpportunityLabel | null;
}

const L = (trigger: OpportunityLabel['trigger'], intent: OpportunityLabel['intent'], segment: OpportunityLabel['segment'], complexity: OpportunityLabel['complexity']): OpportunityLabel => ({ trigger, intent, segment, complexity });

export const OPPORTUNITY_LABELED_SET: readonly OpportunityCase[] = Object.freeze([
  { id: 'opp-01-compra-persona', visitor: ['Hola, busco unas mancuernas ajustables para entrenar en mi depa', 'Me gustan las de 24 kg, ¿llegan a Maipú?', 'Perfecto, las agrego al carro. ¡Gracias!'], expected: L('conversacion', 'compra', 'persona', 'estandar') },
  { id: 'opp-02-cotizacion-persona', visitor: ['Quiero un banco ajustable y 40 kg en discos', '¿Me puedes mandar una cotización formal por correo?', 'Sin despacho. Sí, emítela'], expected: L('cotizacion', 'cotizacion', 'persona', 'estandar') },
  { id: 'opp-03-cotizacion-empresa', visitor: ['Necesito dos kettlebells de 12 kg y una colchoneta para la oficina', 'Es para la empresa, necesito cotización formal para pedir la factura', 'Con despacho a Providencia. Dale, emítela'], expected: L('cotizacion', 'cotizacion', 'empresa', 'estandar') },
  { id: 'opp-04-empresa-proyecto', visitor: ['Somos una empresa y queremos armar un gimnasio para los trabajadores en nuestra planta', 'Serían unos 60 m2, con máquinas y peso libre. ¿Ustedes lo instalan? Facturamos con el RUT de la empresa'], expected: L('consulta', 'cotizacion', 'empresa', 'proyecto') },
  { id: 'opp-05-mayorista-compra', visitor: ['Hola, tenemos una tienda deportiva en regiones y queremos comprar al por mayor para revender', 'Nos interesan 50 pares de mancuernas hexagonales. ¿Qué precio por volumen tienen?'], expected: L('consulta', 'compra', 'mayorista', 'estandar') },
  { id: 'opp-06-mayorista-cotizacion', visitor: ['Somos distribuidores, precio por volumen para 30 balones medicinales', 'Necesitamos la cotización con precio mayorista'], expected: L('consulta', 'cotizacion', 'mayorista', 'estandar') },
  { id: 'opp-07-institucional-proyecto', visitor: ['Escribo del departamento de deportes de la municipalidad', 'Vamos a equipar un gimnasio comunitario completo y saldrá a licitación. ¿Ustedes pueden participar?'], expected: L('consulta', 'cotizacion', 'institucional', 'proyecto') },
  { id: 'opp-08-institucional-compra', visitor: ['Soy profesora de un colegio, necesitamos 20 colchonetas para educación física', '¿Aceptan orden de compra del colegio?'], expected: L('consulta', 'compra', 'institucional', 'estandar') },
  { id: 'opp-09-proyecto-desconocido', visitor: ['Voy a abrir un estudio de entrenamiento funcional de 80 m2 y necesito equiparlo completo', '¿Ustedes hacen el diseño de la sala y el armado?'], expected: L('consulta', 'compra', 'desconocido', 'proyecto') },
  { id: 'opp-10-box-empresa-proyecto', visitor: ['Estamos abriendo un box de CrossFit, necesitamos racks, barras y discos para 10 atletas', 'Todo con factura a nombre de la sociedad. ¿Nos arman una propuesta completa?'], expected: L('consulta', 'cotizacion', 'empresa', 'proyecto') },
  { id: 'opp-11-postventa-despacho', visitor: ['Compré una trotadora la semana pasada y todavía no llega', 'El pedido ya está pagado, ¿me pueden decir qué pasó?'], expected: L('consulta', 'postventa', 'persona', 'estandar') },
  { id: 'opp-12-postventa-cambio', visitor: ['La barra que me llegó ayer viene con la rosca dañada', 'Quiero cambiarla por otra'], expected: L('consulta', 'postventa', 'persona', 'estandar') },
  { id: 'opp-13-servicio-tecnico', visitor: ['Mi elíptica hace un ruido raro cuando pedaleo', '¿Ustedes hacen mantención o reparación?'], expected: L('consulta', 'servicio_tecnico', 'persona', 'estandar') },
  { id: 'opp-14-servicio-tecnico-empresa', visitor: ['Tenemos un gimnasio y dos máquinas de poleas tienen el cable cortado', 'Necesitamos servicio técnico, facturamos como empresa'], expected: L('consulta', 'servicio_tecnico', 'empresa', 'estandar') },
  { id: 'opp-15-otra-arriendo', visitor: ['¿Ustedes arriendan equipos para un evento de un fin de semana?'], expected: L('consulta', 'otra', 'desconocido', 'estandar') },
  { id: 'opp-16-home-gym-cotizacion', visitor: ['Armar mi gimnasio en casa', 'En el garage, 3 × 4 m', '$1,5 a $4 millones', 'Ganar fuerza', 'Precio medio', 'Mándame la cotización formal a mi correo, sin despacho', 'Sí, perfecto'], expected: L('cotizacion', 'cotizacion', 'persona', 'estandar') },
  { id: 'opp-17-home-gym-carro', visitor: ['Armar mi gimnasio en casa', 'Una pieza, 2 × 2 m', 'Hasta $500 mil', 'Bajar de peso', 'Menor precio', 'Listo, lo agrego todo al carro. Gracias, chao'], expected: L('conversacion', 'compra', 'persona', 'estandar') },
  { id: 'opp-18-compra-consulta-instalacion', visitor: ['Quiero comprar este rack para mi casa', '¿Se puede anclar a un piso de madera?'], expected: L('consulta', 'compra', 'persona', 'estandar') },
  { id: 'opp-19-compra-empresa-factura', visitor: ['Necesito 6 discos de 20 kg', '¿Puedo pedir factura a nombre de mi empresa?'], expected: L('consulta', 'compra', 'empresa', 'estandar') },
  { id: 'opp-20-condominio-proyecto', visitor: ['Soy de la administración de un edificio y queremos equipar la sala de gimnasio común', '¿Nos pueden asesorar con qué máquinas poner y cotizar todo?'], expected: L('consulta', 'cotizacion', 'desconocido', 'proyecto') },
  { id: 'opp-21-faq-horario', visitor: ['¿Cuál es el horario de atención?'], expected: null },
  { id: 'opp-22-faq-despacho', visitor: ['¿Cuánto se demora más o menos el despacho a regiones?'], expected: null },
  { id: 'opp-23-faq-entrenamiento', visitor: ['¿Cuántas series debería hacer para ganar masa muscular?'], expected: null },
  { id: 'opp-24-faq-tienda-fisica', visitor: ['¿Tienen tienda física en Santiago?'], expected: null },
  { id: 'opp-25-solo-mirando', visitor: ['Hola', 'Solo estoy mirando, gracias'], expected: null },
] satisfies OpportunityCase[]);

export interface FieldScore {
  readonly correct: number;
  readonly total: number;
  readonly accuracy: number;
}

export interface OpportunityScore {
  readonly cases: number;
  /** Recorded when it should, not recorded when it should not (every case). */
  readonly record: FieldScore;
  /** Each field over the cases that must record (no record counts as wrong). */
  readonly fields: Readonly<Record<(typeof OPPORTUNITY_FIELDS)[number], FieldScore>>;
  readonly misses: readonly { readonly caseId: string; readonly field: string; readonly expected: string | null; readonly predicted: string | null }[];
}

const score = (correct: number, total: number): FieldScore => ({ correct, total, accuracy: total === 0 ? 1 : correct / total });

/** Per-field accuracy of recorded inputs against the labeled set. A case missing from the predictions counts as "not recorded". */
export function scoreOpportunityRecords(predictions: Readonly<Record<string, Partial<OpportunityLabel> | null | undefined>>, set: readonly OpportunityCase[] = OPPORTUNITY_LABELED_SET): OpportunityScore {
  const misses: { caseId: string; field: string; expected: string | null; predicted: string | null }[] = [];
  let recordCorrect = 0;
  const correct = { trigger: 0, intent: 0, segment: 0, complexity: 0 };
  for (const c of set) {
    const predicted = predictions[c.id] ?? null;
    if ((predicted === null) === (c.expected === null)) recordCorrect++;
    else misses.push({ caseId: c.id, field: 'record', expected: c.expected ? 'yes' : 'no', predicted: predicted ? 'yes' : 'no' });
    if (!c.expected) continue;
    for (const field of OPPORTUNITY_FIELDS) {
      if (predicted?.[field] === c.expected[field]) correct[field]++;
      else misses.push({ caseId: c.id, field, expected: c.expected[field], predicted: predicted?.[field] ?? null });
    }
  }
  const positives = set.filter((c) => c.expected !== null).length;
  return {
    cases: set.length,
    record: score(recordCorrect, set.length),
    fields: { trigger: score(correct.trigger, positives), intent: score(correct.intent, positives), segment: score(correct.segment, positives), complexity: score(correct.complexity, positives) },
    misses,
  };
}
