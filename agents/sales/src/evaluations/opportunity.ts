import type { DeskOpportunityInput, DeskOpportunityInputV2, DeskSignal } from '../capabilities/desk-opportunity.js';

/**
 * (ADR-062 O1) Evaluation of desk.opportunity.record: does Pesín record an opportunity when it should, and with which
 * classification (trigger, intent, segment, complexity)? A labeled set of synthetic Spanish conversations of a Chilean
 * gym-equipment store (no real customer, product or person) and a per-field accuracy scorer.
 *
 * The scorer reads RECORDED inputs (what the model passed to desk.opportunity.record in each conversation); it never
 * calls a model. How to run it (the O1 gate, ADR-062 Fases):
 *   1. On each channel's QA profile (web sales-web@21, WhatsApp sales-production@27, Instagram sales-instagram@2,
 *      Facebook sales-facebook@2), play each case of that channel (OpportunityCase.channel) as one conversation.
 *   2. Write predictions.json: { "<case id>": <the first desk.opportunity.record input of that conversation> | null }
 *      (from the action receipts of each conversation, or the QA desk's opportunities).
 *   3. npm run build && npm run eval:sales -- --opportunity predictions.json [--channel whatsapp]
 *      (--channel scores only that channel's cases; without it, every case).
 * The owner sets the accuracy threshold of the gate.
 *
 * (desk.opportunity.record@2) An opportunity exists only without intent sin_intencion: a record with intent
 * sin_intencion counts as "no opportunity". A case may also say which no-intent reason a @2 record must carry
 * (noIntent: scored as noIntentReason, so run it on the @2 profiles sales-web@22 / sales-production@28) and which
 * platform signals the conversation must produce at least (signals: scored against the recorded body's signals).
 */
export type OpportunityLabel = Pick<DeskOpportunityInput, 'trigger' | 'intent' | 'segment' | 'complexity'>;
export const OPPORTUNITY_FIELDS = ['trigger', 'intent', 'segment', 'complexity'] as const;

export const OPPORTUNITY_CHANNELS = ['web', 'whatsapp', 'instagram', 'facebook'] as const;
export type OpportunityChannel = (typeof OPPORTUNITY_CHANNELS)[number];

export interface OpportunityCase {
  readonly id: string;
  /** Where the conversation is played; absent = the web chat. */
  readonly channel?: OpportunityChannel;
  /** Visitor turns, in order; the moment Pesín records is implied by the expected trigger. */
  readonly visitor: readonly string[];
  /** null = no opportunity must be recorded (a pure question without buying intent). */
  readonly expected: OpportunityLabel | null;
  /** (@2) Without an opportunity: the reason a sin_intencion record must carry. */
  readonly noIntent?: NonNullable<DeskOpportunityInputV2['noIntentReason']>;
  /** (@2) The signals the platform must compute at least for this conversation. */
  readonly signals?: readonly DeskSignal[];
}

/** What a predictions file holds per case: the recorded model input, plus (@2) the body's signals. */
export type OpportunityPrediction = Partial<Pick<DeskOpportunityInputV2, 'trigger' | 'intent' | 'segment' | 'complexity' | 'noIntentReason'>> & { readonly signals?: readonly string[] };

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
  // WhatsApp (sales-production@27): quotes and handoffs exist here.
  { id: 'opp-wa-01-cotizacion', channel: 'whatsapp', visitor: ['Hola, quiero cotizar una bicicleta de spinning', 'Con despacho a Ñuñoa', 'Sí, dale, emítela'], expected: L('cotizacion', 'cotizacion', 'persona', 'estandar') },
  { id: 'opp-wa-02-traspaso-limite', channel: 'whatsapp', visitor: ['Necesito 3 trotadoras y 2 elípticas para el gimnasio de mi condominio', 'Cotízamelo todo con despacho', 'Sí, conéctame con una persona del equipo'], expected: L('traspaso', 'cotizacion', 'desconocido', 'proyecto') },
  { id: 'opp-wa-03-traspaso-pide-persona', channel: 'whatsapp', visitor: ['Quiero comprar un rack y una barra olímpica', 'Prefiero hablar con una persona, ¿me pueden atender?'], expected: L('traspaso', 'compra', 'persona', 'estandar') },
  { id: 'opp-wa-04-mayorista', channel: 'whatsapp', visitor: ['Buenas, somos distribuidores en el norte', '¿Qué precio por volumen tienen para 40 kettlebells?'], expected: L('consulta', 'cotizacion', 'mayorista', 'estandar') },
  { id: 'opp-wa-05-postventa', channel: 'whatsapp', visitor: ['Hola, compré un banco y me llegó sin los pernos', '¿Cómo lo soluciono?'], expected: L('consulta', 'postventa', 'persona', 'estandar') },
  { id: 'opp-wa-06-institucional', channel: 'whatsapp', visitor: ['Escribo de una universidad, vamos a renovar el gimnasio de estudiantes', 'Será por licitación pública, ¿ustedes participan?'], expected: L('consulta', 'cotizacion', 'institucional', 'proyecto') },
  { id: 'opp-wa-07-faq', channel: 'whatsapp', visitor: ['¿Hasta qué hora atienden hoy?'], expected: null },
  // Instagram (sales-instagram@2): no quote and no handoff.
  { id: 'opp-ig-01-compra', channel: 'instagram', visitor: ['Vi en su historia unas bandas elásticas, ¿qué resistencias tienen?', 'Ya, me las compro, ¡gracias!'], expected: L('conversacion', 'compra', 'persona', 'estandar') },
  { id: 'opp-ig-02-estudio-proyecto', channel: 'instagram', visitor: ['Soy coach y voy a abrir un estudio de pilates y funcional', '¿Me ayudan con todo el equipamiento? ¿Lo instalan?'], expected: L('consulta', 'compra', 'desconocido', 'proyecto') },
  { id: 'opp-ig-03-tecnica', channel: 'instagram', visitor: ['¿Cómo hago bien una sentadilla búlgara?'], expected: null },
  { id: 'opp-ig-04-servicio-tecnico', channel: 'instagram', visitor: ['Mi bici estática hace clic al pedalear', '¿Tienen servicio técnico?'], expected: L('consulta', 'servicio_tecnico', 'persona', 'estandar') },
  // Facebook (sales-facebook@2): no quote and no handoff.
  { id: 'opp-fb-01-empresa', channel: 'facebook', visitor: ['Hola, necesito 10 colchonetas para las pausas activas de la empresa', '¿Emiten factura?'], expected: L('consulta', 'compra', 'empresa', 'estandar') },
  { id: 'opp-fb-02-compra', channel: 'facebook', visitor: ['¿Tienen discos bumper de 10 kg?', 'Perfecto, los compro en la web. Gracias'], expected: L('conversacion', 'compra', 'persona', 'estandar') },
  { id: 'opp-fb-03-municipalidad', channel: 'facebook', visitor: ['Le escribo de la oficina de deportes de la municipalidad', 'Queremos máquinas de ejercicio para una plaza, ¿pueden cotizar con orden de compra?'], expected: L('consulta', 'cotizacion', 'institucional', 'proyecto') },
  { id: 'opp-fb-04-faq-despacho', channel: 'facebook', visitor: ['¿Hacen envíos a Punta Arenas?'], expected: null },
  // (@2) No buying intent, whatever words it uses: recorded (if at all) as sin_intencion with its reason, never an opportunity.
  { id: 'opp-ni-01-cuento-taza', visitor: ['Cuéntame un cuento sobre la taza mug', 'Jajaja ya, chao'], expected: null, noIntent: 'broma' },
  { id: 'opp-ni-02-kilo-papa', channel: 'whatsapp', visitor: ['¿A cuánto está el kilo de papa?'], expected: null, noIntent: 'fuera_de_alcance' },
  { id: 'opp-ni-03-q-pasa-choro', channel: 'whatsapp', visitor: ['q pasa choro'], expected: null, noIntent: 'casual' },
  { id: 'opp-ni-04-hola-solo', channel: 'instagram', visitor: ['Holaaa', 'Nada, solo saludar 👋'], expected: null, noIntent: 'casual' },
  { id: 'opp-ni-05-prueba', visitor: ['prueba', 'test 123, ¿funciona esto?'], expected: null, noIntent: 'prueba' },
  { id: 'opp-ni-06-eres-bot', channel: 'facebook', visitor: ['¿Eres un bot? A ver, dime cuánto es 2 + 2', 'Ok, solo probaba'], expected: null, noIntent: 'prueba' },
  { id: 'opp-ni-07-spam-cripto', channel: 'whatsapp', visitor: ['Gana dinero invirtiendo en cripto desde tu casa, escríbeme y te explico'], expected: null, noIntent: 'spam' },
  { id: 'opp-ni-08-spam-seo', channel: 'facebook', visitor: ['Hola, ofrecemos servicios de posicionamiento web y seguidores para su página'], expected: null, noIntent: 'spam' },
  { id: 'opp-ni-09-chiste-mancuerna', channel: 'instagram', visitor: ['¿Las mancuernas también levantan el ánimo? 😂', 'Era broma, buen día'], expected: null, noIntent: 'broma' },
  { id: 'opp-ni-10-poema', visitor: ['Escríbeme un poema de amor para mi polola', 'Ya, entonces nada'], expected: null, noIntent: 'fuera_de_alcance' },
  { id: 'opp-ni-11-tecnica-pesomuerto', channel: 'whatsapp', visitor: ['¿El peso muerto se hace con la espalda recta o un poco curva?', 'Gracias, era solo eso'], expected: null, noIntent: 'duda_tecnica' },
  { id: 'opp-ni-12-calorias', channel: 'instagram', visitor: ['¿Cuántas calorías se queman en 30 minutos de bici estática?'], expected: null, noIntent: 'duda_tecnica' },
  { id: 'opp-ni-13-gracias', visitor: ['Gracias por todo', 'Chao'], expected: null, noIntent: 'casual' },
  // (@2) Positives whose conversation leaves concrete platform signals.
  { id: 'opp-sg-01-cotiza-despacho', channel: 'whatsapp', visitor: ['Quiero cotizar 2 kettlebells de 16 kg', 'Con despacho a La Florida', 'Sí, emítela'], expected: L('cotizacion', 'cotizacion', 'persona', 'estandar'), signals: ['cotizacion', 'propuesta', 'despacho'] },
  { id: 'opp-sg-02-web-cotiza', visitor: ['Quiero cotizar una barra olímpica y 60 kg en discos', 'Sin despacho, mándamela por correo', 'Sí'], expected: L('cotizacion', 'cotizacion', 'persona', 'estandar'), signals: ['cotizacion', 'propuesta'] },
  { id: 'opp-sg-03-traspaso', channel: 'whatsapp', visitor: ['Necesito equipar un gimnasio de un hotel', 'Prefiero que me atienda una persona'], expected: L('traspaso', 'cotizacion', 'empresa', 'proyecto'), signals: ['traspaso'] },
  { id: 'opp-sg-04-producto-compra', channel: 'facebook', visitor: ['¿Qué medidas tiene el banco plano que publicaron?', 'Perfecto, lo compro hoy en la web'], expected: L('conversacion', 'compra', 'persona', 'estandar'), signals: ['producto'] },
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
  /** (@2) Over the cases with a noIntent label: a sin_intencion record with that reason. */
  readonly noIntentReason: FieldScore;
  /** (@2) Over the cases with signals: every expected signal is in the recorded body. */
  readonly signals: FieldScore;
  readonly misses: readonly { readonly caseId: string; readonly field: string; readonly expected: string | null; readonly predicted: string | null }[];
}

const score = (correct: number, total: number): FieldScore => ({ correct, total, accuracy: total === 0 ? 1 : correct / total });

/** The cases played on one channel (a case without a channel is a web case). */
export function opportunityCasesOf(channel: OpportunityChannel, set: readonly OpportunityCase[] = OPPORTUNITY_LABELED_SET): OpportunityCase[] {
  return set.filter((c) => (c.channel ?? 'web') === channel);
}

/**
 * Per-field accuracy of recorded inputs against the labeled set. A case missing from the predictions counts as "not
 * recorded"; a record with intent sin_intencion counts as "no opportunity".
 */
export function scoreOpportunityRecords(predictions: Readonly<Record<string, OpportunityPrediction | null | undefined>>, set: readonly OpportunityCase[] = OPPORTUNITY_LABELED_SET): OpportunityScore {
  const misses: { caseId: string; field: string; expected: string | null; predicted: string | null }[] = [];
  let recordCorrect = 0;
  let reasonCorrect = 0;
  let signalsCorrect = 0;
  const correct = { trigger: 0, intent: 0, segment: 0, complexity: 0 };
  for (const c of set) {
    const predicted = predictions[c.id] ?? null;
    const opportunity = predicted !== null && predicted.intent !== 'sin_intencion';
    if (opportunity === (c.expected !== null)) recordCorrect++;
    else misses.push({ caseId: c.id, field: 'record', expected: c.expected ? 'yes' : 'no', predicted: opportunity ? 'yes' : 'no' });
    if (c.noIntent) {
      if (predicted?.intent === 'sin_intencion' && predicted.noIntentReason === c.noIntent) reasonCorrect++;
      else misses.push({ caseId: c.id, field: 'noIntentReason', expected: c.noIntent, predicted: predicted?.noIntentReason ?? null });
    }
    if (c.signals) {
      if (c.signals.every((s) => predicted?.signals?.includes(s))) signalsCorrect++;
      else misses.push({ caseId: c.id, field: 'signals', expected: c.signals.join(','), predicted: predicted?.signals?.join(',') ?? null });
    }
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
    noIntentReason: score(reasonCorrect, set.filter((c) => c.noIntent).length),
    signals: score(signalsCorrect, set.filter((c) => c.signals).length),
    misses,
  };
}
