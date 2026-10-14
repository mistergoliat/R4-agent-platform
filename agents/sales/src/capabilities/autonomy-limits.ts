import type { CommercialBlocker, CommercialSnapshot } from './commercial-snapshot.js';

/**
 * (R4-J3E) The risk limits of autonomous quote issuance (sales-production@5).
 * They are configuration, never code defaults: production values must be
 * decided and approved by the business owner before any rollout, and a
 * composition without every one of them refuses to start.
 */
export interface AutonomousQuoteLimits {
  /** Largest quote total (gross, CLP, shipping included) issued without a human. */
  readonly maxGrossClp: number;
  /** Most quote lines (products) in one autonomous quote. */
  readonly maxLines: number;
  /** Most units of one line. */
  readonly maxUnitsPerLine: number;
  /** Most autonomous quotes over the life of one conversation. */
  readonly maxQuotesPerConversation: number;
  /** Most autonomous quotes per hour across the deployment (its database). */
  readonly maxQuotesPerHour: number;
}

export const AUTONOMOUS_QUOTE_LIMIT_ENV: Readonly<Record<keyof AutonomousQuoteLimits, string>> = Object.freeze({
  maxGrossClp: 'R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP',
  maxLines: 'R4_AUTONOMOUS_QUOTE_MAX_LINES',
  maxUnitsPerLine: 'R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE',
  maxQuotesPerConversation: 'R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION',
  maxQuotesPerHour: 'R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR',
});

/**
 * (R4-J3E-B) The limits of sales-production@6: those of @5 plus an independent
 * cap on the TOTAL units of one quote (all lines together) and the window in
 * which a customer confirmation must follow the offer it answers. Both are
 * required configuration with no default. @5 keeps exactly its five limits.
 */
export interface AutonomousQuoteLimitsV6 extends AutonomousQuoteLimits {
  /** Most units in one autonomous quote, all lines together. */
  readonly maxTotalUnits: number;
  /** Seconds within which the customer's confirmation must follow the offer message it answers. */
  readonly confirmationWindowSeconds: number;
}

export const AUTONOMOUS_QUOTE_LIMIT_ENV_V6: Readonly<Record<keyof AutonomousQuoteLimitsV6, string>> = Object.freeze({
  ...AUTONOMOUS_QUOTE_LIMIT_ENV,
  maxTotalUnits: 'R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS',
  confirmationWindowSeconds: 'R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS',
});

const BOUNDS: Readonly<Record<keyof AutonomousQuoteLimitsV6, readonly [number, number]>> = {
  maxGrossClp: [1, 1_000_000_000],
  maxLines: [1, 20],
  maxUnitsPerLine: [1, 99],
  maxQuotesPerConversation: [1, 100],
  maxQuotesPerHour: [1, 10_000],
  maxTotalUnits: [1, 1_980],
  confirmationWindowSeconds: [30, 86_400],
};

export class AutonomousQuoteLimitsError extends Error {
  readonly code = 'autonomous_quote_limits_invalid';
}

/** Reads every limit from the process environment; refuses a missing, empty, non-integer or out-of-range one (names only, never values of other variables). */
export function loadAutonomousQuoteLimits(env: Readonly<Record<string, string | undefined>>): AutonomousQuoteLimits {
  return loadLimits(env, AUTONOMOUS_QUOTE_LIMIT_ENV);
}

/** (R4-J3E-B) The sales-production@6 limits: every @5 limit plus total units and the confirmation window, all required. */
export function loadAutonomousQuoteLimitsV6(env: Readonly<Record<string, string | undefined>>): AutonomousQuoteLimitsV6 {
  return loadLimits(env, AUTONOMOUS_QUOTE_LIMIT_ENV_V6);
}

function loadLimits<K extends keyof AutonomousQuoteLimitsV6>(env: Readonly<Record<string, string | undefined>>, names: Readonly<Record<K, string>>): Record<K, number> {
  const problems: string[] = [];
  const limits = {} as Record<K, number>;
  for (const [field, name] of Object.entries(names) as [K, string][]) {
    const raw = env[name]?.trim();
    const [min, max] = BOUNDS[field];
    if (!raw) problems.push(`${name} is required`);
    else if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) problems.push(`${name} must be an integer in ${min}..${max}`);
    else limits[field] = Number(raw);
  }
  if (problems.length > 0) throw new AutonomousQuoteLimitsError(`autonomous quote limits are not configured: ${problems.join('; ')}`);
  return Object.freeze(limits);
}

/**
 * The limits a snapshot itself exceeds (amount, lines, units per line and —
 * when the limits carry it, @6 — total units). Frequency limits are measured
 * at issuance, under the decision lock.
 */
export function snapshotLimitBreaches(snapshot: CommercialSnapshot, limits: AutonomousQuoteLimits & { readonly maxTotalUnits?: number }): CommercialBlocker[] {
  const breaches: CommercialBlocker[] = [];
  if (snapshot.totals.gross > limits.maxGrossClp) breaches.push({ code: 'autonomy_limit_amount', message: `the quote total ${snapshot.totals.gross} CLP exceeds the autonomous limit of ${limits.maxGrossClp} CLP`, details: { gross: snapshot.totals.gross, limit: limits.maxGrossClp } });
  if (snapshot.lines.length > limits.maxLines) breaches.push({ code: 'autonomy_limit_lines', message: `${snapshot.lines.length} lines exceed the autonomous limit of ${limits.maxLines}`, details: { lines: snapshot.lines.length, limit: limits.maxLines } });
  for (const line of snapshot.lines) {
    if (line.quantity > limits.maxUnitsPerLine) breaches.push({ code: 'autonomy_limit_quantity', message: `${line.quantity} units of ${line.itemKey} exceed the autonomous limit of ${limits.maxUnitsPerLine} per line`, details: { itemKey: line.itemKey, quantity: line.quantity, limit: limits.maxUnitsPerLine } });
  }
  if (limits.maxTotalUnits !== undefined) {
    const units = snapshot.lines.reduce((total, line) => total + line.quantity, 0);
    if (units > limits.maxTotalUnits) breaches.push({ code: 'autonomy_limit_total_units', message: `${units} units in the quote exceed the autonomous limit of ${limits.maxTotalUnits}`, details: { units, limit: limits.maxTotalUnits } });
  }
  return breaches;
}
