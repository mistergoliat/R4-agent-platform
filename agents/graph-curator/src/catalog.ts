import type { CatalogFact } from './rules.js';

/** The one Catalog V2 read the curator needs (HttpCatalogAdapter.getProductContext satisfies it). */
export interface ProductSheetPort {
  getProductContext(productKey: string): Promise<
    | { readonly status: 'not_found' }
    | {
      readonly status: 'found';
      readonly facts: { readonly name: string; readonly status: { readonly active: boolean }; readonly category: { readonly name: string } | null; readonly specifications: readonly { readonly name: string; readonly value: string }[] };
      readonly derived: { readonly availability: { readonly sellability: string }; readonly priceSummary: { readonly finalGross: { readonly amount: number } } | null };
    }
  >;
}

export interface CatalogWalk {
  readonly sheets: Map<string, CatalogFact | 'not_found' | 'failed'>;
  readonly counts: { readonly scanned: number; readonly found: number; readonly notFound: number; readonly failed: number };
}

const keyNumber = (k: string) => Number(k.slice(1));

/**
 * ADR-058 owner decision 2: a capability in code walks the Catalog V2 sheets (Catalog has no bulk read). Every graph
 * product, then every key above the highest graph key until `tailMisses` consecutive keys are not found (new products
 * get higher ids). Reads run `concurrency` at a time; a failed read is `failed`, never a conclusion.
 */
export async function walkCatalog(port: ProductSheetPort, graphKeys: readonly string[], options: { readonly concurrency?: number; readonly tailMisses?: number } = {}): Promise<CatalogWalk> {
  const concurrency = options.concurrency ?? 2;
  const tailMisses = options.tailMisses ?? 150;
  const sheets = new Map<string, CatalogFact | 'not_found' | 'failed'>();
  const read = async (key: string): Promise<void> => {
    try {
      const c = await port.getProductContext(key);
      sheets.set(key, c.status === 'not_found' ? 'not_found' : {
        name: c.facts.name, active: c.facts.status.active, sellable: c.derived.availability.sellability === 'sellable',
        category: c.facts.category?.name ?? null, price: c.derived.priceSummary?.finalGross.amount ?? null,
        specs: Object.fromEntries(c.facts.specifications.map((s) => [s.name, s.value])),
      });
    } catch {
      sheets.set(key, 'failed');
    }
  };
  const pool = async (keys: readonly string[]) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
      while (next < keys.length) await read(keys[next++]!);
    }));
  };

  const known = [...new Set(graphKeys)].sort((a, b) => keyNumber(a) - keyNumber(b));
  const max = known.length ? keyNumber(known[known.length - 1]!) : 0;
  const below = Array.from({ length: max }, (_, i) => `P${i + 1}`).filter((k) => !sheets.has(k));
  await pool([...new Set([...known, ...below])]);
  // Above the graph: in batches, until `tailMisses` consecutive keys are not a product (a failed read counts as a miss,
  // so a catalog outage ends the walk instead of extending it).
  let misses = 0;
  for (let n = max + 1; misses < tailMisses; n += concurrency) {
    const batch = Array.from({ length: concurrency }, (_, i) => `P${n + i}`);
    await pool(batch);
    for (const k of batch) misses = typeof sheets.get(k) === 'object' ? 0 : misses + 1;
  }

  let found = 0, notFound = 0, failed = 0;
  for (const v of sheets.values()) {
    if (v === 'not_found') notFound++;
    else if (v === 'failed') failed++;
    else found++;
  }
  return { sheets, counts: { scanned: sheets.size, found, notFound, failed } };
}
