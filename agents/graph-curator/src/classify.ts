/**
 * ADR-058 G2b: what the curator can tell about a product from its name and catalog category alone (no PRG species,
 * which Catalog V2 does not serve): its functional kind, its «Lo reemplaza» groups and the muscle groups it trains.
 * Ported from the graph review (propose-relations / propose-substitutes, owner-delegated trainer rules); the rules that
 * need the PRG species are replaced by the kind of the product's catalog siblings (see run-time callers).
 */

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/gu, '');
const short = (name: string) => name.split('|')[0]!.trim();

type KindRule = readonly [kind: string, test: (name: string, category: string) => boolean];
/** First match wins. Name and category only. */
const KIND_RULES: readonly KindRule[] = [
  ['SERVICE', (n) => /^servicio|costo log/iu.test(n)],
  ['MERCH', (n, c) => /APPAREL/u.test(c) || /gorra|morral|pulsera|shaker|botella|heavy mug|m[aá]scara de hipoxia/iu.test(n)],
  ['HYPERBARIC', (n) => /c[aá]mara hiperb/iu.test(n)],
  ['STORE_DB', (n) => /almacenamiento.*mancuerna/iu.test(n)],
  ['STORE_KB', (n) => /almacenamiento.*kettlebell/iu.test(n)],
  ['STORE_BODYPUMP', (n) => /almacenamiento.*body pump/iu.test(n)],
  ['STORE_PLATE', (n) => /almacenamiento.*disco|porta discos|soportes de discos/iu.test(n)],
  ['STORE_FIXEDBAR', (n) => /almacenamiento.*barras fijas/iu.test(n)],
  ['STORE_BAR', (n) => /almacenamiento.*barra/iu.test(n)],
  ['STORE_BALL', (n) => /balones medicinales|para balones|almacenamiento funcional/iu.test(n) && /rack/iu.test(n)],
  ['STORE_MAT', (n) => /colgador.*mat/iu.test(n)],
  ['CHALK_BOWL', (n) => /porta magnesio/iu.test(n)],
  ['MIXED', (n, c) => /\+/u.test(n) || /^pack (alpha|delta|sweat|econ|training|elite|hip thrust)|garage gym/iu.test(n) || /Packs Garage Gym/u.test(c)],
  ['CHALK', (n) => /^magnesio/iu.test(n)],
  ['CABLE_ATT', (n) => /accesorio polea|tobillera/iu.test(n)],
  ['LANDMINE_GRIP', (n) => /agarre.*landmine/iu.test(n)],
  ['LANDMINE', (n) => /landmine/iu.test(n)],
  ['SWIVEL', (n) => /swivel/iu.test(n)],
  ['HT_BELT', (n) => /cintur[oó]n hip thrust/iu.test(n)],
  ['HT_PAD', (n) => /almohadilla hip thrust/iu.test(n)],
  ['BAR_PAD', (n) => /almohadilla de barra/iu.test(n)],
  ['HT_STATION', (n) => /hip thrust|hip thruster/iu.test(n) && !/pack|cintur|almohadilla/iu.test(n)],
  ['LASTRE_BELT', (n) => /cintur[oó]n de lastre/iu.test(n)],
  ['VEST_RUN', (n) => /chaleco de lastre running/iu.test(n)],
  ['VEST', (n) => /chaleco de lastre/iu.test(n)],
  ['ANKLE_W', (n) => /pesos de tobillo/iu.test(n)],
  ['LIFT_BELT', (n) => /cintur[oó]n (de levantamiento|lumbar)/iu.test(n)],
  ['KNEE', (n) => /rodilleras/iu.test(n)],
  ['ELBOW_WRIST', (n) => /coderas|muñequeras/iu.test(n)],
  ['KTAPE', (n) => /k-?tape/iu.test(n)],
  ['CALLERA', (n) => /callera/iu.test(n)],
  ['BOX_GLOVE', (n) => /guantes?.*(boxeo|mma)|vendas? de boxeo/iu.test(n)],
  ['BOX_PADS', (n) => /manoplas|escudo de boxeo/iu.test(n)],
  ['SPARRING', (n) => /cabezal|canilleras|protector de cintura/iu.test(n)],
  ['SUSP_ANCHOR', (n) => /x-mount|anclaje/iu.test(n)],
  ['SUSP', (n) => /banda de suspensi/iu.test(n)],
  ['RINGS', (n) => /anillas/iu.test(n)],
  ['OCR', (n) => /agarre ocr|agarres ocr/iu.test(n)],
  ['CLIMB_ROPE', (n) => /soga de trepa/iu.test(n)],
  ['FINGERBOARD', (n) => /tabla de escalada/iu.test(n)],
  ['AB_STRAPS', (n) => /ab straps/iu.test(n)],
  ['PULLUP', (n) => /pull ?ups?\b|dominadas|salmon ladder/iu.test(n) && !/asistida|dual|banda/iu.test(n)],
  ['PUSHUP', (n) => /paralelas.*\b(7|10|17|34)\s?cm|push ups/iu.test(n)],
  ['DIP', (n) => /paralelas|dip\b|fondos/iu.test(n) && !/asistida|dual|pack/iu.test(n)],
  ['BAND_LOOP', (n) => /banda de resistencia (x-light|light|medium|heavy|x-heavy|super)|pack 4 bandas de resistencia/iu.test(n)],
  ['BAND_SMALL', (n) => /glute band|mini bandas|thera band|tubos? el[aá]stico|expander/iu.test(n)],
  ['AB', (n) => /rueda abdominal|core roller|abmat/iu.test(n)],
  ['CRASH', (n) => /colchonetas de impacto/iu.test(n)],
  ['MAT', (n) => /colchoneta|mat de (yoga|entrenamiento)|rollout mat/iu.test(n)],
  ['YOGA_ACC', (n) => /bloque de yoga|rueda de yoga|bal[oó]n (de )?pilates|bosu|balance pad|disco de equilibrio|discos deslizantes/iu.test(n)],
  ['RECOVERY', (n) => /foam roller|bola de masaje|pistola de masaje|botas de compresi/iu.test(n)],
  ['JUMP_ROPE', (n) => /cuerda de salto|speed rope/iu.test(n)],
  ['BATTLE', (n) => /battle rope/iu.test(n)],
  ['SLED', (n) => /trineo/iu.test(n)],
  ['MED_BALL', (n) => /bal[oó]n(es)? medicinal/iu.test(n)],
  ['SLAM', (n) => /slam ball/iu.test(n)],
  ['SANDBAG', (n) => /sand ?bag|saco b[uú]lgaro/iu.test(n)],
  ['PLYO_BOX', (n) => /caj[oó]n(es)? pliom/iu.test(n)],
  ['AGILITY', (n) => /valla|escalera de agilidad|conos|lentejas|barras de agilidad/iu.test(n)],
  ['STEP', (n) => /step aer[oó]bico/iu.test(n)],
  ['BODYPUMP', (n) => /body pump/iu.test(n)],
  ['HEEL', (n) => /elevador de talones/iu.test(n)],
  ['JACK', (n) => /deadlift jack/iu.test(n)],
  ['FARMER', (n) => /farmer/iu.test(n)],
  ['RAMP', (n) => /rampa caminata/iu.test(n)],
  ['FAN', (n) => /ventilador/iu.test(n)],
  ['TIMER', (n) => /timer/iu.test(n)],
  ['CLUB', (n) => /clubbell/iu.test(n)],
  ['MACE', (n) => /martillo thor/iu.test(n)],
  ['KB', (n) => /kettlebell/iu.test(n)],
  ['FIXED_BAR', (n) => /peso fijo/iu.test(n)],
  ['ARM_BLASTER', (n) => /arm blaster/iu.test(n)],
  ['SCOTT', (n) => /scott|preacher/iu.test(n)],
  ['SMITH', (n) => /smith|multipower/iu.test(n) && !/pack/iu.test(n)],
  ['PLATE_MACHINE', (n, c) => /M[aá]quinas con Carga de Discos/iu.test(c) && !/pack/iu.test(n)],
  ['SELECTORIZED', (n, c) => /M[aá]quinas Selectorizadas/iu.test(c)],
  ['CABLE_STATION', (n) => /crossover|polea (alta|cruzada|de muro|dual|lateral)|multifuncional trainer|dual polea/iu.test(n)],
  ['DB', (n, c) => /mancuernas ajustables|malet[ií]n/iu.test(`${n} ${c}`)],
  ['CURL_BAR', (n) => /romana|barra (ol[ií]mpica|preol[ií]mpica) "?[wz]"?\b/iu.test(n)],
  ['TURF', (n) => /pasto sint/iu.test(n)],
  ['RUBBER_FLOOR', (n) => /piso de caucho|palmeta de caucho/iu.test(n)],
  // Fallback kinds of the gap review (2026-11-20), by name only.
  ['PLATE_FRACTIONAL', (n) => /fracciona/iu.test(n)],
  ['PLATE_PACK', (n) => /^(pack|set)\s+\d/iu.test(n) && !/mancuerna|kettlebell|barras?\s/iu.test(n)],
  ['PLATE_PRE', (n) => /discos? preol[ií]mpic/iu.test(n)],
  ['TECH_BAR', (n) => /^barra/iu.test(n) && /technique|junior/iu.test(n)],
  ['SPECIALTY_BAR', (n) => /^(barra|safety squat bar|dead ?lift barra)/iu.test(n) && /hex|trap|squat bar|safety|fat|multi agarre|barra "?t"?/iu.test(n)],
  ['STRAPS', (n) => /correas de levantamiento|lifting straps/iu.test(n)],
  ['BENCH_ACC', (n) => /accesorio banco/iu.test(n)],
  ['RACK_ACC', (n) => /accesorio (alpha|delta)|accesorio jaula|j-cups|spotter|soporte de barra/iu.test(n)],
  ['EVA_FLOOR', (n) => /tatami|\beva\b/iu.test(n)],
];

/** The kind its name or category says; null: no rule (the caller may use the kind of its catalog siblings). */
export function kindByName(name: string, category: string | null): string | null {
  const n = short(name), c = category ?? '';
  return KIND_RULES.find(([, test]) => test(n, c))?.[0] ?? null;
}

/** The kind most of its catalog siblings have (≥ 3 of them and ≥ 60 %); null otherwise. */
export function kindBySiblings(siblingKinds: readonly (string | null)[]): string | null {
  const known = siblingKinds.filter((k): k is string => k !== null);
  if (known.length < 3) return null;
  const counts = new Map<string, number>();
  for (const k of known) counts.set(k, (counts.get(k) ?? 0) + 1);
  const [kind, n] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  return n / known.length >= 0.6 ? kind : null;
}

// ---- «Lo reemplaza» groups (propose-substitutes) ----

const MACHINE_KINDS = new Set(['SELECTORIZED', 'PLATE_MACHINE', 'SCOTT', 'ARM_BLASTER', 'SPECIALTY_BENCH', 'BENCH_STATION', 'CABLE_STATION', 'HT_STATION']);
const MACHINE_MUSCLE: readonly (readonly [string, RegExp])[] = [
  ['biceps', /biceps|scott|predicador|preacher|arm blaster/u], ['triceps', /triceps/u], ['pecho', /pectoral|pec fly|press de pecho|chest|multi fly/u],
  ['hombros', /hombro|shoulder|rear delt/u], ['espalda-jalon', /lat pull|polea alta|jalon|pull over|dominada.*asistida/u], ['espalda-remo', /remo|t-bar/u],
  ['cuadriceps', /cuadriceps|leg extension|leg\/curl extension/u], ['femoral', /femoral|leg curl|leg\/curl|nordico/u], ['piernas', /prensa|hack|squat machine|v-squat|belt squat|pendulo/u],
  ['gluteo', /hip thrust|hip extension|gluteo|reverse hyper|patada/u], ['aductores', /aductor|abductor/u], ['pantorrillas', /talones|pantorrilla|calf/u],
  ['abdominal', /abdominal/u], ['lumbar', /lumbar|ghd|glute ham/u], ['bulgara', /bulgara|sissy/u], ['press-banca', /banco olimpico|banco preolimpico multifuncional/u],
  ['home-gym', /home gym|multiestacion|multifuncional trainer|multi dead/u], ['polea', /polea|crossover/u],
];
const CARDIO_TYPE: readonly (readonly [string, RegExp])[] = [['trotadora', /trotadora|caminadora/u], ['spinning', /spinning/u], ['reclinada', /reclinada/u], ['estatica', /bicicleta estatica|air cycle|air bike/u], ['eliptica', /eliptica/u], ['remo-cardio', /rower|air row|remo/u], ['ski', /ski/u], ['escalera', /escalera|stepper|escaladora/u]];
const RACK_TYPE: readonly (readonly [string, RegExp])[] = [['power-rack', /power rack|wall rack|combo rack/u], ['half-rack', /half rack/u], ['soporte-sentadilla', /squat rack|atril/u]];
const LOAD: Readonly<Record<string, string>> = { DB: 'mancuerna', KB: 'kettlebell', MED_BALL: 'balon', SLAM: 'slam', SANDBAG: 'saco', CLUB: 'clubbell', MACE: 'mace', VEST: 'chaleco', ANKLE_W: 'tobillera-peso', FIXED_BAR: 'barra-fija' };
const SAME_KIND = new Set(['PULLUP', 'DIP', 'PUSHUP', 'MAT', 'JUMP_ROPE', 'GYM_GLOVE', 'LIFT_BELT', 'KNEE', 'ELBOW_WRIST', 'CALLERA', 'PLYO_BOX', 'AB', 'STRAPS', 'STORE_DB', 'STORE_PLATE', 'STORE_BALL', 'STORE_BAR', 'STORE_KB', 'HEAVY_BAG', 'BOX_GLOVE', 'STEP', 'AGILITY', 'COLLAR']);

const kgOf = (s: string): number | null => {
  const m = /(\d+(?:[.,]\d+)?)\s*(kg|lbs?)\b/u.exec(s);
  return m ? Math.round(Number(m[1]!.replace(',', '.')) * (m[2]!.startsWith('lb') ? 0.4536 : 1) * 10) / 10 : null;
};

/** The «Lo reemplaza» groups of a product: two products of a shared group replace each other. Empty: none offered. */
export function substituteGroups(name: string, kind: string | null): string[] {
  const s = fold(short(name));
  if (!kind || /2da seleccion/u.test(s) || kind === 'PLATE_PACK' || kind === 'MIXED' || /pack|set\b|accesorio/u.test(s)) return [];
  const w = kgOf(s), pair = /\bpar\b/u.test(s);
  if (MACHINE_KINDS.has(kind)) return /barra/u.test(s) ? [] : MACHINE_MUSCLE.filter(([, re]) => re.test(s)).map(([g]) => `musculo:${g}`);
  if (kind === 'TREADMILL' || kind === 'CARDIO') return CARDIO_TYPE.filter(([, re]) => re.test(s)).slice(0, 1).map(([g]) => `cardio:${g}`);
  if (kind === 'SQUAT_RACK') return RACK_TYPE.filter(([, re]) => re.test(s)).slice(0, 1).map(([g]) => `rack:${g}`);
  if (kind === 'SMITH') return ['smith'];
  if (kind === 'BENCH') return [/regulable|ajustable/u.test(s) ? 'banco:regulable' : 'banco:plano'];
  if (LOAD[kind]) return w ? [`${LOAD[kind]}:${w}kg${pair ? ':par' : ''}`] : [];
  if (kind === 'PLATE_OLY') return w ? [`disco:${/bumper|crumb|caucho|rubber/u.test(s) ? 'bumper' : 'acero'}:${w}kg${pair ? ':par' : ''}`] : [];
  if (kind === 'PLATE_PRE') return w ? [`disco-preolimpico:${w}kg${pair ? ':par' : ''}`] : [];
  if (kind === 'OLY_BAR') return w && !/hex|safety|trap|curl|romana|\bw\b|\bz\b|tecnica|infantil/u.test(s) ? [`barra-olimpica:${w}kg`] : [];
  if (kind === 'RUBBER_FLOOR') { const mm = /(\d+)\s*mm/u.exec(s)?.[1]; return mm ? [`piso:${mm}mm`] : []; }
  if (SAME_KIND.has(kind)) return [kind.toLowerCase()];
  return [];
}

// ---- muscle groups (ADR-058 Decision 8) ----

export const MUSCLE_GROUPS = ['piernas', 'gluteos', 'espalda', 'pecho', 'hombros', 'brazos', 'core', 'cuerpo_completo', 'cardio'] as const;
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

const FROM_MACHINE: Readonly<Record<string, readonly MuscleGroup[]>> = {
  biceps: ['brazos'], triceps: ['brazos'], pecho: ['pecho'], 'press-banca': ['pecho'], hombros: ['hombros'], 'espalda-jalon': ['espalda'], 'espalda-remo': ['espalda'],
  cuadriceps: ['piernas'], femoral: ['piernas'], piernas: ['piernas'], aductores: ['piernas'], pantorrillas: ['piernas'], bulgara: ['piernas', 'gluteos'],
  gluteo: ['gluteos'], abdominal: ['core'], lumbar: ['espalda', 'core'], 'home-gym': ['cuerpo_completo'], polea: ['cuerpo_completo'],
};
/** By kind, when the name says nothing more specific. Accessories, storage and floors have none (they inherit). */
const FROM_KIND: Readonly<Record<string, readonly MuscleGroup[]>> = {
  CARDIO: ['cardio'], TREADMILL: ['cardio'], JUMP_ROPE: ['cardio'], BATTLE: ['cardio', 'cuerpo_completo'], VEST_RUN: ['cardio'],
  SQUAT_RACK: ['cuerpo_completo'], SMITH: ['cuerpo_completo'], OLY_BAR: ['cuerpo_completo'], PRE_BAR: ['cuerpo_completo'], SPECIALTY_BAR: ['cuerpo_completo'], TECH_BAR: ['cuerpo_completo'],
  DB: ['cuerpo_completo'], KB: ['cuerpo_completo'], MED_BALL: ['cuerpo_completo'], SLAM: ['cuerpo_completo'], SANDBAG: ['cuerpo_completo'], CLUB: ['cuerpo_completo'], MACE: ['cuerpo_completo'],
  SLED: ['piernas', 'cuerpo_completo'], FARMER: ['cuerpo_completo'], SUSP: ['cuerpo_completo'], RINGS: ['espalda', 'pecho', 'brazos'], CABLE_STATION: ['cuerpo_completo'],
  HT_STATION: ['gluteos'], BAND_SMALL: ['gluteos'], AB: ['core'], AB_STRAPS: ['core'], PULLUP: ['espalda', 'brazos'], DIP: ['pecho', 'brazos'], PUSHUP: ['pecho'],
  CURL_BAR: ['brazos'], ARM_BLASTER: ['brazos'], SCOTT: ['brazos'], FIXED_BAR: ['cuerpo_completo'], BENCH: ['pecho'], BENCH_STATION: ['pecho'], PLYO_BOX: ['piernas'],
  BODYPUMP: ['cuerpo_completo'], VEST: ['cuerpo_completo'], LASTRE_BELT: ['espalda', 'brazos'], ANKLE_W: ['piernas', 'gluteos'],
};

/** The muscle groups a product trains, from its name (machines) or its kind; empty: none (it inherits). */
export function muscleGroups(name: string, kind: string | null): MuscleGroup[] {
  if (!kind) return [];
  const s = fold(short(name));
  if (MACHINE_KINDS.has(kind)) {
    const byName = [...new Set(MACHINE_MUSCLE.filter(([, re]) => re.test(s)).flatMap(([g]) => FROM_MACHINE[g] ?? []))];
    const specific = byName.filter((m) => m !== 'cuerpo_completo');
    if (byName.length) return MUSCLE_GROUPS.filter((m) => (specific.length ? specific : byName).includes(m));
  }
  return [...(FROM_KIND[kind] ?? [])];
}
