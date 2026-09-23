import { z } from 'zod';

/**
 * Quality is a vector, never one number (R4-G): each metric keeps its unit
 * and, for rates, its numerator and denominator, so "3/4" is never reported
 * as a bare 0.75 whose sample size is lost. A metric that cannot be computed
 * is `null` with a note — never 0.
 */
export const METRIC_UNITS = ['count', 'tokens', 'ms', 'ratio', 'per_turn', 'per_run', 'per_task'] as const;

export const metricValueSchema = z.strictObject({
  value: z.number().nullable(),
  unit: z.enum(METRIC_UNITS),
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  note: z.string().max(200).nullable(),
});
export type MetricValue = z.infer<typeof metricValueSchema>;
export type QualityVector = Record<string, MetricValue>;

export function count(value: number, note: string | null = null): MetricValue {
  return { value, unit: 'count', numerator: null, denominator: null, note };
}

export function measure(value: number | null, unit: MetricValue['unit'], note: string | null = null): MetricValue {
  return { value: value === null ? null : round(value), unit, numerator: null, denominator: null, note: value === null ? (note ?? 'not available') : note };
}

/** A rate keeps its parts; an empty denominator gives `null`, not 0 or 1. */
export function rate(numerator: number, denominator: number, unit: MetricValue['unit'] = 'ratio', note: string | null = null): MetricValue {
  return { value: denominator === 0 ? null : round(numerator / denominator), unit, numerator, denominator, note: denominator === 0 ? (note ?? 'empty denominator') : note };
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Below this many observations a 95th percentile is not reported: with a
 * handful of runs it would be the maximum wearing a statistical costume.
 */
export const P95_MIN_SAMPLE = 20;

export const distributionSchema = z.strictObject({
  n: z.int().nonnegative(),
  /** Observations that had no value (not averaged as zero). */
  missing: z.int().nonnegative(),
  min: z.number().nullable(),
  median: z.number().nullable(),
  mean: z.number().nullable(),
  p95: z.number().nullable(),
  max: z.number().nullable(),
  /** The raw values, in input order (missing ones omitted). */
  values: z.array(z.number()),
  note: z.string().nullable(),
});
export type Distribution = z.infer<typeof distributionSchema>;

/** Summary of a sample that ignores (and counts) missing values instead of treating them as zero. */
export function distribution(values: readonly (number | null | undefined)[]): Distribution {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const missing = values.length - present.length;
  if (present.length === 0) return { n: 0, missing, min: null, median: null, mean: null, p95: null, max: null, values: [], note: 'no values' };
  const sorted = [...present].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const p95 = sorted.length >= P95_MIN_SAMPLE ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]! : null;
  return {
    n: present.length,
    missing,
    min: sorted[0]!,
    median: round(median),
    mean: round(present.reduce((s, v) => s + v, 0) / present.length),
    p95,
    max: sorted.at(-1)!,
    values: [...present],
    note: p95 === null ? `p95 not reported below ${P95_MIN_SAMPLE} values` : null,
  };
}
