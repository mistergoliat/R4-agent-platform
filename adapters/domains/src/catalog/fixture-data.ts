import type { ProductDetail } from './port.js';

/**
 * Deterministic fixture catalog of home-gym equipment (prices in CLP). Test
 * data only: it is not PesasChile's real catalog and must never be presented
 * as current commercial data outside tests and local harness runs.
 */
export interface FixtureProduct extends Omit<ProductDetail, 'recordVersion' | 'updatedAt'> {
  /** Extra search terms (synonyms, both languages). */
  readonly tags: readonly string[];
}

const clp = (amount: number) => ({ amount, currency: 'CLP' as const });

export const FIXTURE_PRODUCTS: readonly FixtureProduct[] = [
  {
    productId: 'RACK-PR200', name: 'Power Rack PR-200', category: 'racks', brand: 'IronHome', unitPrice: clp(289_990), stock: { status: 'in_stock', units: 6 },
    description: 'Jaula de potencia de 4 postes con barras de seguridad y ganchos J. Para sentadilla, press banca y dominadas.',
    weightKg: 78, footprintCm: { width: 120, depth: 140, height: 215 }, specs: { maxLoadKg: 350, pullUpBar: true, holeSpacingCm: 5 },
    compatibleWith: ['BAR-OLY20', 'BAR-OLY15', 'PULLUP-BAR', 'BENCH-FID'], alternatives: ['RACK-HR50', 'RACK-SQ100'], tags: ['rack', 'jaula', 'power rack', 'sentadilla', 'squat', 'dominadas'],
  },
  {
    productId: 'RACK-PR300', name: 'Power Rack PR-300 Pro', category: 'racks', brand: 'IronHome', unitPrice: clp(459_990), stock: { status: 'out_of_stock', units: 0 },
    description: 'Jaula de potencia reforzada con polea alta/baja integrada.',
    weightKg: 120, footprintCm: { width: 130, depth: 160, height: 225 }, specs: { maxLoadKg: 500, pullUpBar: true, cableSystem: true },
    compatibleWith: ['BAR-OLY20', 'PULLUP-BAR'], alternatives: ['RACK-PR200', 'RACK-HR50'], tags: ['rack', 'jaula', 'power rack', 'polea', 'pro'],
  },
  {
    productId: 'RACK-HR50', name: 'Half Rack HR-50', category: 'racks', brand: 'IronHome', unitPrice: clp(219_990), stock: { status: 'low_stock', units: 2 },
    description: 'Medio rack compacto con soportes de seguridad; ocupa menos fondo que una jaula completa.',
    weightKg: 55, footprintCm: { width: 125, depth: 120, height: 200 }, specs: { maxLoadKg: 300, pullUpBar: true },
    compatibleWith: ['BAR-OLY20', 'BAR-OLY15', 'BENCH-FID'], alternatives: ['RACK-PR200', 'RACK-SQ100'], tags: ['rack', 'half rack', 'medio rack', 'sentadilla', 'squat'],
  },
  {
    productId: 'RACK-SQ100', name: 'Soporte de sentadilla SQ-100', category: 'racks', brand: 'IronHome', unitPrice: clp(149_990), stock: { status: 'in_stock', units: 10 },
    description: 'Par de soportes independientes ajustables para sentadilla y press; se guardan fácilmente.',
    weightKg: 32, footprintCm: { width: 120, depth: 110, height: 180 }, specs: { maxLoadKg: 250, pullUpBar: false },
    compatibleWith: ['BAR-OLY20', 'BAR-OLY15', 'BENCH-FLAT', 'BENCH-FID'], alternatives: ['RACK-HR50'], tags: ['soporte', 'squat stand', 'sentadilla', 'rack', 'compacto'],
  },
  {
    productId: 'BAR-OLY20', name: 'Barra olímpica 20 kg (2,2 m)', category: 'barras', brand: 'SteelCo', unitPrice: clp(129_990), stock: { status: 'in_stock', units: 15 },
    description: 'Barra olímpica de 28 mm con rodamientos, mangas de 50 mm.',
    weightKg: 20, footprintCm: null, specs: { lengthCm: 220, gripDiameterMm: 28, sleeveDiameterMm: 50, maxLoadKg: 300 },
    compatibleWith: ['PLT-BUMP-100', 'PLT-BUMP-60', 'PLT-IRON-50', 'COLLARS'], alternatives: ['BAR-OLY15'], tags: ['barra', 'bar', 'olimpica', 'olympic'],
  },
  {
    productId: 'BAR-OLY15', name: 'Barra olímpica técnica 15 kg (2,01 m)', category: 'barras', brand: 'SteelCo', unitPrice: clp(109_990), stock: { status: 'in_stock', units: 4 },
    description: 'Barra olímpica de 25 mm, más corta y liviana.',
    weightKg: 15, footprintCm: null, specs: { lengthCm: 201, gripDiameterMm: 25, sleeveDiameterMm: 50, maxLoadKg: 200 },
    compatibleWith: ['PLT-BUMP-100', 'PLT-BUMP-60', 'PLT-IRON-50', 'COLLARS'], alternatives: ['BAR-OLY20'], tags: ['barra', 'bar', 'olimpica', 'tecnica', 'liviana'],
  },
  {
    productId: 'BAR-EZ', name: 'Barra Z 1,2 m', category: 'barras', brand: 'SteelCo', unitPrice: clp(39_990), stock: { status: 'in_stock', units: 20 },
    description: 'Barra curva para curl y extensiones.',
    weightKg: 7, footprintCm: null, specs: { lengthCm: 120, sleeveDiameterMm: 50 },
    compatibleWith: ['PLT-IRON-50'], alternatives: [], tags: ['barra', 'z', 'curl', 'ez'],
  },
  {
    productId: 'PLT-BUMP-100', name: 'Set discos bumper 100 kg', category: 'discos', brand: 'RubberMax', unitPrice: clp(329_990), stock: { status: 'in_stock', units: 5 },
    description: 'Discos de caucho de 50 mm: 2×5, 2×10, 2×15 y 2×20 kg.',
    weightKg: 100, footprintCm: null, specs: { pairs: '5,10,15,20', boreMm: 50 },
    compatibleWith: ['BAR-OLY20', 'BAR-OLY15'], alternatives: ['PLT-BUMP-60', 'PLT-IRON-50'], tags: ['discos', 'plates', 'bumper', 'pesas', 'caucho'],
  },
  {
    productId: 'PLT-BUMP-60', name: 'Set discos bumper 60 kg', category: 'discos', brand: 'RubberMax', unitPrice: clp(209_990), stock: { status: 'in_stock', units: 8 },
    description: 'Discos de caucho de 50 mm: 2×5, 2×10 y 2×15 kg.',
    weightKg: 60, footprintCm: null, specs: { pairs: '5,10,15', boreMm: 50 },
    compatibleWith: ['BAR-OLY20', 'BAR-OLY15'], alternatives: ['PLT-BUMP-100', 'PLT-IRON-50'], tags: ['discos', 'plates', 'bumper', 'pesas', 'caucho'],
  },
  {
    productId: 'PLT-IRON-50', name: 'Set discos de fierro 50 kg', category: 'discos', brand: 'SteelCo', unitPrice: clp(119_990), stock: { status: 'in_stock', units: 12 },
    description: 'Discos de fierro fundido de 50 mm: 2×2,5, 2×5, 2×7,5 y 2×10 kg.',
    weightKg: 50, footprintCm: null, specs: { pairs: '2.5,5,7.5,10', boreMm: 50 },
    compatibleWith: ['BAR-OLY20', 'BAR-OLY15', 'BAR-EZ'], alternatives: ['PLT-BUMP-60'], tags: ['discos', 'plates', 'fierro', 'pesas', 'hierro'],
  },
  {
    productId: 'BENCH-FID', name: 'Banco ajustable FID', category: 'bancos', brand: 'IronHome', unitPrice: clp(139_990), stock: { status: 'in_stock', units: 7 },
    description: 'Banco plano/inclinado/declinado, respaldo en 7 posiciones.',
    weightKg: 18, footprintCm: { width: 60, depth: 130, height: 45 }, specs: { maxLoadKg: 300, positions: 7 },
    compatibleWith: ['RACK-PR200', 'RACK-HR50', 'RACK-SQ100', 'DB-ADJ-24'], alternatives: ['BENCH-FLAT'], tags: ['banco', 'bench', 'ajustable', 'inclinado'],
  },
  {
    productId: 'BENCH-FLAT', name: 'Banco plano', category: 'bancos', brand: 'IronHome', unitPrice: clp(69_990), stock: { status: 'in_stock', units: 9 },
    description: 'Banco plano reforzado.',
    weightKg: 12, footprintCm: { width: 50, depth: 120, height: 45 }, specs: { maxLoadKg: 250 },
    compatibleWith: ['RACK-SQ100', 'RACK-HR50'], alternatives: ['BENCH-FID'], tags: ['banco', 'bench', 'plano'],
  },
  {
    productId: 'DB-ADJ-24', name: 'Mancuernas ajustables 2×24 kg', category: 'mancuernas', brand: 'FlexLoad', unitPrice: clp(249_990), stock: { status: 'low_stock', units: 3 },
    description: 'Par de mancuernas con selector de 2 a 24 kg cada una.',
    weightKg: 48, footprintCm: null, specs: { minKg: 2, maxKg: 24, perPair: true },
    compatibleWith: ['BENCH-FID', 'BENCH-FLAT'], alternatives: ['KB-16'], tags: ['mancuernas', 'dumbbells', 'ajustables'],
  },
  {
    productId: 'KB-16', name: 'Kettlebell 16 kg', category: 'kettlebells', brand: 'FlexLoad', unitPrice: clp(34_990), stock: { status: 'in_stock', units: 25 },
    description: 'Kettlebell de fierro fundido con base plana.',
    weightKg: 16, footprintCm: null, specs: {},
    compatibleWith: [], alternatives: ['DB-ADJ-24'], tags: ['kettlebell', 'pesa rusa'],
  },
  {
    productId: 'FLOOR-MAT', name: 'Piso de caucho 100×100×2 cm (unidad)', category: 'pisos', brand: 'RubberMax', unitPrice: clp(24_990), stock: { status: 'in_stock', units: 40 },
    description: 'Palmeta de caucho de alta densidad para proteger el piso.',
    weightKg: 18, footprintCm: { width: 100, depth: 100, height: 2 }, specs: { thicknessCm: 2 },
    compatibleWith: [], alternatives: [], tags: ['piso', 'caucho', 'goma', 'flooring', 'palmeta'],
  },
  {
    productId: 'PULLUP-BAR', name: 'Barra de dominadas para rack', category: 'accesorios', brand: 'IronHome', unitPrice: clp(29_990), stock: { status: 'in_stock', units: 11 },
    description: 'Barra multiagarre que se monta en racks compatibles.',
    weightKg: 6, footprintCm: null, specs: {},
    compatibleWith: ['RACK-PR200', 'RACK-PR300'], alternatives: [], tags: ['dominadas', 'pull up', 'accesorio'],
  },
  {
    productId: 'COLLARS', name: 'Seguros para barra olímpica (par)', category: 'accesorios', brand: 'SteelCo', unitPrice: clp(9_990), stock: { status: 'in_stock', units: 60 },
    description: 'Par de seguros de cierre rápido para mangas de 50 mm.',
    weightKg: 0.4, footprintCm: null, specs: { sleeveDiameterMm: 50 },
    compatibleWith: ['BAR-OLY20', 'BAR-OLY15', 'BAR-EZ'], alternatives: [], tags: ['seguros', 'collars', 'accesorio'],
  },
  {
    productId: 'CARDIO-ROW', name: 'Remo magnético R-10', category: 'cardio', brand: 'AeroFit', unitPrice: clp(399_990), stock: { status: 'discontinued', units: 0 },
    description: 'Remo de resistencia magnética con 8 niveles (descontinuado).',
    weightKg: 34, footprintCm: { width: 55, depth: 200, height: 55 }, specs: { levels: 8 },
    compatibleWith: [], alternatives: [], tags: ['remo', 'cardio', 'rower'],
  },
];

/** Instant the fixture records were last "updated" before any scenario mutation. */
export const FIXTURE_CATALOG_UPDATED_AT = '2026-09-01T00:00:00.000Z';
