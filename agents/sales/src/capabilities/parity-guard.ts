import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonicalJson } from '@r4-adapters/domains';
import type { CommercialBlocker } from './commercial-snapshot.js';

/**
 * (R4-J5 F1, owner decision P-1) The first controlled quotes use only SKUs
 * whose price, stock and commercial identity were verified against the live
 * store, and that verification must still be current when a quote is
 * previewed and again when it is issued (quote.create recomputes the
 * snapshot). This guard is composition configuration for the commercial
 * snapshot: it adds blockers, never removes one, and does not replace any
 * Quote owner control.
 *
 * The evidence is produced outside R4 (the Catalog owner's parity check) and
 * is untrusted input: anything malformed refuses composition.
 */
export const QUOTE_PARITY_ENV = { file: 'R4_QUOTE_PARITY_EVIDENCE_FILE', maxAgeSeconds: 'R4_QUOTE_PARITY_MAX_AGE_SECONDS' } as const;

const evidenceSchema = z.strictObject({
  itemKey: z.string().min(1).max(200),
  productRef: z.string().min(1).max(200),
  variantRef: z.string().min(1).max(200).nullable(),
  sku: z.string().min(1).max(100).nullable(),
  /** Tax-included unit price verified against the live store, CLP. */
  finalGross: z.int().nonnegative(),
  /** Units verified available in the live store. */
  availableQuantity: z.int().nonnegative(),
  verifiedAt: z.iso.datetime({ offset: true }),
  /** Who or what verified it (e.g. the Catalog owner's parity run id). */
  source: z.string().min(1).max(200),
});
const fileSchema = z.strictObject({ schemaVersion: z.literal(1), items: z.array(evidenceSchema).min(1).max(200) });

export type QuoteParityEvidence = z.infer<typeof evidenceSchema>;

/** What the snapshot resolved for one line, as the guard compares it. */
export interface QuoteParityLine {
  readonly itemKey: string;
  readonly productRef: string;
  readonly variantRef: string | null;
  readonly sku: string | null;
  readonly unitGross: number;
  readonly quantity: number;
}

export interface QuoteParityGuard {
  /** A blocker when the line is outside the verified set, its verification is not current, or the owner's answer differs from what was verified. */
  check(line: QuoteParityLine, now: Date): CommercialBlocker | null;
  /** SHA-256 of the canonical evidence, logged at composition: a replaced evidence file is never silent. */
  readonly fingerprint: string;
  readonly items: number;
  readonly maxAgeSeconds: number;
}

/**
 * Profiles that may compose quote.create only with the parity guard (R4-J5 F1, P-1): their composition refuses
 * without it. Sales configuration, by profile label; the F1 canary profile is added with its definition.
 */
export const QUOTE_PARITY_REQUIRED_PROFILES: ReadonlySet<string> = new Set<string>(['sales-production@12', 'sales-production@14', 'sales-production@15', 'sales-production@16']);

/** Throws when the profile requires the parity guard and none is configured (no silent fallback to unverified data). */
export function assertQuoteParityConfigured(profileLabel: string, guard: QuoteParityGuard | null | undefined, required: ReadonlySet<string> = QUOTE_PARITY_REQUIRED_PROFILES): void {
  if (required.has(profileLabel) && !guard) {
    throw new Error(`refusing production composition: ${profileLabel} issues quotes only for the parity-verified SKU set, and none is configured (${QUOTE_PARITY_ENV.file}, ${QUOTE_PARITY_ENV.maxAgeSeconds})`);
  }
}

export function createQuoteParityGuard(input: { readonly evidence: unknown; readonly maxAgeSeconds: number }): QuoteParityGuard {
  if (!Number.isSafeInteger(input.maxAgeSeconds) || input.maxAgeSeconds < 1 || input.maxAgeSeconds > 7 * 24 * 3600) {
    throw new Error(`refusing quote parity evidence: ${QUOTE_PARITY_ENV.maxAgeSeconds} must be a whole number of seconds between 1 and 604800`);
  }
  const parsed = fileSchema.safeParse(input.evidence);
  if (!parsed.success) throw new Error(`refusing quote parity evidence: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const byKey = new Map<string, QuoteParityEvidence>();
  for (const item of parsed.data.items) {
    if (byKey.has(item.itemKey)) throw new Error(`refusing quote parity evidence: duplicate itemKey ${item.itemKey}`);
    byKey.set(item.itemKey, item);
  }
  const maxAgeMs = input.maxAgeSeconds * 1000;
  return {
    fingerprint: createHash('sha256').update(canonicalJson(parsed.data)).digest('hex'),
    items: byKey.size,
    maxAgeSeconds: input.maxAgeSeconds,
    check(line, now) {
      const at = { itemKey: line.itemKey };
      const verified = byKey.get(line.itemKey);
      if (!verified) return { code: 'item_not_parity_verified', message: `${line.itemKey} is not in the parity-verified set for autonomous quotes`, details: at };
      const age = now.getTime() - Date.parse(verified.verifiedAt);
      if (age < 0 || age > maxAgeMs) return { code: 'item_parity_stale', message: `the parity verification of ${line.itemKey} is not current`, details: { ...at, verifiedAt: verified.verifiedAt } };
      const mismatch = (field: string, verifiedValue: string | number | null, current: string | number | null): CommercialBlocker => ({ code: 'item_parity_mismatch', message: `the catalog ${field} of ${line.itemKey} differs from the verified one`, details: { ...at, field, verified: verifiedValue, current } });
      if (verified.productRef !== line.productRef) return mismatch('productRef', verified.productRef, line.productRef);
      if (verified.variantRef !== line.variantRef) return mismatch('variantRef', verified.variantRef, line.variantRef);
      if (verified.sku !== line.sku) return mismatch('sku', verified.sku, line.sku);
      if (verified.finalGross !== line.unitGross) return mismatch('price', verified.finalGross, line.unitGross);
      if (line.quantity > verified.availableQuantity) return mismatch('stock', verified.availableQuantity, line.quantity);
      return null;
    },
  };
}

/** The guard from the environment, or null when no evidence file is configured (no profile requires it yet). */
export function loadQuoteParityGuard(env: Readonly<Record<string, string | undefined>>, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): QuoteParityGuard | null {
  const file = env[QUOTE_PARITY_ENV.file];
  if (!file) return null;
  const maxAgeSeconds = Number(env[QUOTE_PARITY_ENV.maxAgeSeconds]);
  let evidence: unknown;
  try {
    evidence = JSON.parse(read(file));
  } catch (error) {
    throw new Error(`refusing quote parity evidence: ${QUOTE_PARITY_ENV.file} is not readable JSON (${(error as Error).message})`, { cause: error });
  }
  return createQuoteParityGuard({ evidence, maxAgeSeconds });
}
