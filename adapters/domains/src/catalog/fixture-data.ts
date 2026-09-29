import type { CatalogAttribute, CatalogCategory, CatalogLifecycle, CatalogSpecification } from './port.js';

/**
 * Deterministic fixture catalog of home-gym equipment (prices in CLP, tax
 * included). Test data only: it is not PesasChile's real catalog and must
 * never be presented as current commercial data outside tests and local
 * harness runs.
 *
 * These are the OWNER's records (what a catalog-service would hold after its
 * own normalization): gross prices are stored, not computed; stock is the
 * owner's available quantity; lifecycle flags are the owner's. The fixture
 * owner derives sellability from them the way the real owner would — R4
 * never does. Keys are opaque tokens chosen by this fixture owner; SKUs are
 * deliberately different strings so nothing can mistake one for the other.
 *
 * R4-J1B removed what the owner does not have: brand as a required field,
 * record versions, footprints as structured data, curated compatibility and
 * substitutes, `low_stock` / `discontinued` stock states. Dimensions and
 * weights exist only as owner features (specifications), verbatim.
 */
export interface FixtureVariantRecord {
  readonly variantId: string;
  readonly itemKey: string;
  readonly sku: string;
  readonly attributes: readonly CatalogAttribute[];
  readonly regularGross: number;
  readonly finalGross: number;
  /** Owner's available quantity; null = the owner does not know. */
  readonly availableQuantity: number | null;
  readonly weightKg: number;
}

export interface FixtureProductRecord {
  readonly productId: string;
  readonly productKey: string;
  readonly sku: string;
  readonly name: string;
  readonly category: CatalogCategory;
  readonly brand: string | null;
  readonly shortDescription: string | null;
  readonly specifications: readonly CatalogSpecification[];
  readonly lifecycle: CatalogLifecycle;
  /** Whether the owner's policy allows ordering without stock (PrestaShop out_of_stock); null = unknown. */
  readonly backorderAllowed: boolean | null;
  /** Products without variants carry price, stock and weight here. */
  readonly regularGross: number | null;
  readonly finalGross: number | null;
  readonly promotion: { readonly kind: 'amount' | 'percentage'; readonly value: number; readonly validUntil: string | null } | null;
  readonly availableQuantity: number | null;
  readonly weightKg: number | null;
  readonly variants: readonly FixtureVariantRecord[];
  /** Co-purchase statistics (same_order); inferred evidence, never compatibility. */
  readonly frequentlyBoughtTogether: readonly { readonly productKey: string; readonly confidence: number; readonly jointCount: number }[];
  /** Extra search terms the owner indexes (synonyms, both languages). */
  readonly searchTerms: readonly string[];
}

const CATEGORIES = {
  racks: { id: '11', name: 'racks' },
  barras: { id: '12', name: 'barras' },
  discos: { id: '13', name: 'discos' },
  bancos: { id: '14', name: 'bancos' },
  mancuernas: { id: '15', name: 'mancuernas' },
  kettlebells: { id: '16', name: 'kettlebells' },
  pisos: { id: '17', name: 'pisos' },
  accesorios: { id: '18', name: 'accesorios' },
  cardio: { id: '19', name: 'cardio' },
} as const satisfies Record<string, CatalogCategory>;

const ACTIVE: CatalogLifecycle = { status: 'active', listed: true, orderable: true };
const specs = (entries: Record<string, string>): CatalogSpecification[] => Object.entries(entries).map(([name, value]) => ({ name, value }));

type Simple = Omit<FixtureProductRecord, 'variants' | 'promotion' | 'lifecycle' | 'backorderAllowed' | 'finalGross' | 'frequentlyBoughtTogether'> &
  Partial<Pick<FixtureProductRecord, 'promotion' | 'lifecycle' | 'backorderAllowed' | 'finalGross' | 'frequentlyBoughtTogether'>>;

function simple(record: Simple): FixtureProductRecord {
  return { lifecycle: ACTIVE, backorderAllowed: false, promotion: null, finalGross: record.regularGross, frequentlyBoughtTogether: [], variants: [], ...record };
}

export const FIXTURE_PRODUCTS: readonly FixtureProductRecord[] = [
  simple({
    productId: '101', productKey: 'RACK-PR200', sku: 'IH-PR200', name: 'Power Rack PR-200', category: CATEGORIES.racks, brand: 'IronHome',
    shortDescription: 'Jaula de potencia de 4 postes con barras de seguridad y ganchos J. Para sentadilla, press banca y dominadas.',
    specifications: specs({ 'Carga máxima': '350 kg', 'Barra de dominadas': 'Sí', 'Separación de perforaciones': '5 cm', 'Dimensiones armado (ancho × fondo × alto)': '120 × 140 × 215 cm', Peso: '78 kg' }),
    regularGross: 289_990, availableQuantity: 6, weightKg: 78,
    frequentlyBoughtTogether: [{ productKey: 'BAR-OLY20', confidence: 0.41, jointCount: 37 }, { productKey: 'PLT-IRON-50', confidence: 0.22, jointCount: 20 }],
    searchTerms: ['rack', 'jaula', 'power rack', 'sentadilla', 'squat', 'dominadas'],
  }),
  simple({
    productId: '102', productKey: 'RACK-PR300', sku: 'IH-PR300P', name: 'Power Rack PR-300 Pro', category: CATEGORIES.racks, brand: 'IronHome',
    shortDescription: 'Jaula de potencia reforzada con polea alta/baja integrada.',
    specifications: specs({ 'Carga máxima': '500 kg', 'Barra de dominadas': 'Sí', 'Sistema de poleas': 'Sí', Peso: '120 kg' }),
    regularGross: 459_990, availableQuantity: 0, weightKg: 120,
    searchTerms: ['rack', 'jaula', 'power rack', 'polea', 'pro'],
  }),
  simple({
    productId: '103', productKey: 'RACK-HR50', sku: 'IH-HR50', name: 'Half Rack HR-50', category: CATEGORIES.racks, brand: 'IronHome',
    shortDescription: 'Medio rack compacto con soportes de seguridad; ocupa menos fondo que una jaula completa.',
    specifications: specs({ 'Carga máxima': '300 kg', 'Barra de dominadas': 'Sí', 'Dimensiones armado (ancho × fondo × alto)': '125 × 120 × 200 cm', Peso: '55 kg' }),
    regularGross: 219_990, availableQuantity: 2, weightKg: 55,
    searchTerms: ['rack', 'half rack', 'medio rack', 'sentadilla', 'squat'],
  }),
  simple({
    productId: '104', productKey: 'RACK-SQ100', sku: 'IH-SQ100', name: 'Soporte de sentadilla SQ-100', category: CATEGORIES.racks, brand: 'IronHome',
    shortDescription: 'Par de soportes independientes ajustables para sentadilla y press; se guardan fácilmente.',
    specifications: specs({ 'Carga máxima': '250 kg', 'Barra de dominadas': 'No', Peso: '32 kg' }),
    regularGross: 149_990, availableQuantity: 10, weightKg: 32,
    searchTerms: ['soporte', 'squat stand', 'sentadilla', 'rack', 'compacto'],
  }),
  simple({
    productId: '105', productKey: 'BAR-OLY20', sku: 'SC-BO20-28', name: 'Barra olímpica 20 kg (2,2 m)', category: CATEGORIES.barras, brand: 'SteelCo',
    shortDescription: 'Barra olímpica de 28 mm con rodamientos, mangas de 50 mm.',
    specifications: specs({ Largo: '220 cm', 'Diámetro de agarre': '28 mm', 'Diámetro de mangas': '50 mm', 'Carga máxima': '300 kg', Peso: '20 kg' }),
    regularGross: 129_990, availableQuantity: 15, weightKg: 20,
    frequentlyBoughtTogether: [{ productKey: 'PLT-IRON-50', confidence: 0.38, jointCount: 44 }, { productKey: 'COLLARS', confidence: 0.35, jointCount: 40 }],
    searchTerms: ['barra', 'bar', 'olimpica', 'olympic'],
  }),
  simple({
    productId: '106', productKey: 'BAR-OLY15', sku: 'SC-BO15-25', name: 'Barra olímpica técnica 15 kg (2,01 m)', category: CATEGORIES.barras, brand: 'SteelCo',
    shortDescription: 'Barra olímpica de 25 mm, más corta y liviana.',
    specifications: specs({ Largo: '201 cm', 'Diámetro de agarre': '25 mm', 'Diámetro de mangas': '50 mm', 'Carga máxima': '200 kg', Peso: '15 kg' }),
    regularGross: 109_990, availableQuantity: 4, weightKg: 15,
    searchTerms: ['barra', 'bar', 'olimpica', 'tecnica', 'liviana'],
  }),
  simple({
    productId: '107', productKey: 'BAR-EZ', sku: 'SC-EZ120', name: 'Barra Z 1,2 m', category: CATEGORIES.barras, brand: 'SteelCo',
    shortDescription: 'Barra curva para curl y extensiones.',
    specifications: specs({ Largo: '120 cm', 'Diámetro de mangas': '50 mm', Peso: '7 kg' }),
    regularGross: 39_990, availableQuantity: 20, weightKg: 7,
    searchTerms: ['barra', 'z', 'curl', 'ez'],
  }),
  simple({
    productId: '108', productKey: 'PLT-BUMP-100', sku: 'RM-BMP100', name: 'Set discos bumper 100 kg', category: CATEGORIES.discos, brand: 'RubberMax',
    shortDescription: 'Discos de caucho de 50 mm: 2×5, 2×10, 2×15 y 2×20 kg.',
    specifications: specs({ Pares: '5, 10, 15 y 20 kg', 'Diámetro interior': '50 mm', Peso: '100 kg' }),
    regularGross: 329_990, availableQuantity: 5, weightKg: 100,
    searchTerms: ['discos', 'plates', 'bumper', 'pesas', 'caucho'],
  }),
  simple({
    productId: '109', productKey: 'PLT-BUMP-60', sku: 'RM-BMP060', name: 'Set discos bumper 60 kg', category: CATEGORIES.discos, brand: 'RubberMax',
    shortDescription: 'Discos de caucho de 50 mm: 2×5, 2×10 y 2×15 kg.',
    specifications: specs({ Pares: '5, 10 y 15 kg', 'Diámetro interior': '50 mm', Peso: '60 kg' }),
    regularGross: 209_990, availableQuantity: 8, weightKg: 60,
    searchTerms: ['discos', 'plates', 'bumper', 'pesas', 'caucho'],
  }),
  simple({
    productId: '110', productKey: 'PLT-IRON-50', sku: 'SC-FE050', name: 'Set discos de fierro 50 kg', category: CATEGORIES.discos, brand: 'SteelCo',
    shortDescription: 'Discos de fierro fundido de 50 mm: 2×2,5, 2×5, 2×7,5 y 2×10 kg.',
    specifications: specs({ Pares: '2,5, 5, 7,5 y 10 kg', 'Diámetro interior': '50 mm', Peso: '50 kg' }),
    regularGross: 119_990, availableQuantity: 12, weightKg: 50,
    frequentlyBoughtTogether: [{ productKey: 'BAR-OLY20', confidence: 0.47, jointCount: 44 }],
    searchTerms: ['discos', 'plates', 'fierro', 'pesas', 'hierro'],
  }),
  simple({
    productId: '111', productKey: 'BENCH-FID', sku: 'IH-BFID7', name: 'Banco ajustable FID', category: CATEGORIES.bancos, brand: 'IronHome',
    shortDescription: 'Banco plano/inclinado/declinado, respaldo en 7 posiciones.',
    specifications: specs({ 'Carga máxima': '300 kg', Posiciones: '7', 'Dimensiones (ancho × largo × alto)': '60 × 130 × 45 cm', Peso: '18 kg' }),
    regularGross: 139_990, availableQuantity: 7, weightKg: 18,
    searchTerms: ['banco', 'bench', 'ajustable', 'inclinado'],
  }),
  simple({
    productId: '112', productKey: 'BENCH-FLAT', sku: 'IH-BFLAT', name: 'Banco plano', category: CATEGORIES.bancos, brand: 'IronHome',
    shortDescription: 'Banco plano reforzado.',
    specifications: specs({ 'Carga máxima': '250 kg', Peso: '12 kg' }),
    regularGross: 69_990, availableQuantity: 9, weightKg: 12,
    searchTerms: ['banco', 'bench', 'plano'],
  }),
  simple({
    productId: '113', productKey: 'DB-ADJ-24', sku: 'FL-ADJ24', name: 'Mancuernas ajustables 2×24 kg', category: CATEGORIES.mancuernas, brand: 'FlexLoad',
    shortDescription: 'Par de mancuernas con selector de 2 a 24 kg cada una.',
    specifications: specs({ 'Peso mínimo por mancuerna': '2 kg', 'Peso máximo por mancuerna': '24 kg', Unidad: 'par', Peso: '48 kg' }),
    regularGross: 249_990, availableQuantity: 3, weightKg: 48,
    searchTerms: ['mancuernas', 'dumbbells', 'ajustables'],
  }),
  {
    productId: '114', productKey: 'KB-COMP', sku: 'FL-KBC', name: 'Kettlebell de competición', category: CATEGORIES.kettlebells, brand: 'FlexLoad',
    shortDescription: 'Kettlebell de acero de tamaño único; el peso se elige por variante.',
    specifications: specs({ Material: 'acero', 'Diámetro de asa': '35 mm' }),
    lifecycle: ACTIVE, backorderAllowed: false, regularGross: null, finalGross: null, promotion: null, availableQuantity: null, weightKg: null,
    variants: [
      { variantId: '1141', itemKey: 'KB-COMP-12', sku: 'FL-KBC-12', attributes: [{ group: 'Peso', value: '12 kg' }], regularGross: 44_990, finalGross: 44_990, availableQuantity: 9, weightKg: 12 },
      { variantId: '1142', itemKey: 'KB-COMP-16', sku: 'FL-KBC-16', attributes: [{ group: 'Peso', value: '16 kg' }], regularGross: 54_990, finalGross: 54_990, availableQuantity: 0, weightKg: 16 },
      { variantId: '1143', itemKey: 'KB-COMP-24', sku: 'FL-KBC-24', attributes: [{ group: 'Peso', value: '24 kg' }], regularGross: 74_990, finalGross: 74_990, availableQuantity: 4, weightKg: 24 },
    ],
    frequentlyBoughtTogether: [],
    searchTerms: ['kettlebell', 'pesa rusa', 'competicion'],
  },
  simple({
    productId: '115', productKey: 'KB-16', sku: 'FL-KB16C', name: 'Kettlebell 16 kg', category: CATEGORIES.kettlebells, brand: 'FlexLoad',
    shortDescription: 'Kettlebell de fierro fundido con base plana.',
    specifications: specs({ Peso: '16 kg' }),
    regularGross: 34_990, availableQuantity: 25, weightKg: 16,
    searchTerms: ['kettlebell', 'pesa rusa'],
  }),
  simple({
    productId: '116', productKey: 'FLOOR-MAT', sku: 'RM-PAL100', name: 'Piso de caucho 100×100×2 cm (unidad)', category: CATEGORIES.pisos, brand: 'RubberMax',
    shortDescription: 'Palmeta de caucho de alta densidad para proteger el piso.',
    specifications: specs({ Espesor: '2 cm', Medidas: '100 × 100 cm', Peso: '18 kg' }),
    regularGross: 24_990, availableQuantity: 40, weightKg: 18,
    searchTerms: ['piso', 'caucho', 'goma', 'flooring', 'palmeta'],
  }),
  simple({
    productId: '117', productKey: 'PULLUP-BAR', sku: 'IH-PUB', name: 'Barra de dominadas para rack', category: CATEGORIES.accesorios, brand: 'IronHome',
    shortDescription: 'Barra multiagarre que se monta en racks.',
    specifications: specs({ Peso: '6 kg' }),
    regularGross: 29_990, availableQuantity: 11, weightKg: 6,
    searchTerms: ['dominadas', 'pull up', 'accesorio'],
  }),
  simple({
    productId: '118', productKey: 'COLLARS', sku: 'SC-COL50', name: 'Seguros para barra olímpica (par)', category: CATEGORIES.accesorios, brand: 'SteelCo',
    shortDescription: 'Par de seguros de cierre rápido para mangas de 50 mm.',
    specifications: specs({ 'Diámetro de mangas': '50 mm', Peso: '0,4 kg' }),
    regularGross: 9_990, availableQuantity: 60, weightKg: 0.4,
    searchTerms: ['seguros', 'collars', 'accesorio'],
  }),
  simple({
    productId: '119', productKey: 'CARDIO-ROW', sku: 'AF-R10', name: 'Remo magnético R-10', category: CATEGORIES.cardio, brand: 'AeroFit',
    shortDescription: 'Remo de resistencia magnética con 8 niveles.',
    specifications: specs({ Niveles: '8', Peso: '34 kg' }),
    lifecycle: { status: 'inactive', listed: true, orderable: false },
    regularGross: 399_990, availableQuantity: 0, weightKg: 34,
    searchTerms: ['remo', 'cardio', 'rower'],
  }),
];

/** Instant the fixture records were last updated before any scenario mutation. */
export const FIXTURE_CATALOG_UPDATED_AT = '2026-09-01T00:00:00.000Z';

/** The fixture owner's declared validity window for price/stock answers. */
export const FIXTURE_CATALOG_VALIDITY_MS = 5 * 60_000;
