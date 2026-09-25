import { z } from 'zod';
import { fingerprint } from '@r4/contracts';

/**
 * Explicit execution modes (R4-I). Three states are distinguishable and a
 * production composition can only exist when production was declared:
 *
 *   test        nothing declared: harnesses, scenarios, CI. No channel, no delivery.
 *   shadow      R4_EXECUTION_MODE=shadow (R4-H, @r4/shadow). Never delivers.
 *   production  R4_EXECUTION_MODE=production plus complete, explicit configuration.
 *
 * A missing or unknown value never becomes production: every production
 * composition calls `loadProductionConfig` first and it fails closed.
 */
export const EXECUTION_MODE_ENV = 'R4_EXECUTION_MODE';
export const PRODUCTION_EXECUTION_MODE = 'production';
export const EXECUTION_MODES = ['test', 'shadow', 'production'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export class ProductionConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProductionConfigError';
    this.code = code;
  }
}

/** Which mode an environment declares. Unknown values are refused (never guessed). */
export function declaredExecutionMode(env: Readonly<Record<string, string | undefined>>): ExecutionMode {
  const value = env[EXECUTION_MODE_ENV];
  if (value === undefined || value === '') return 'test';
  if (value === 'shadow' || value === 'production') return value;
  throw new ProductionConfigError('unsupported_execution_mode', `${EXECUTION_MODE_ENV}="${value}" is not an execution mode (test is the absence of a declaration; shadow; production)`);
}

const hexKey = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-hex conversation key (see identity hashing)');

/**
 * Production process configuration without secrets. Channel secrets are read
 * and validated by the channel adapter's own loader; only their presence is
 * reflected here (never their values, never in a fingerprint).
 */
export const productionConfigSchema = z.strictObject({
  mode: z.literal(PRODUCTION_EXECUTION_MODE),
  /** `<profileId>@<version>` the process must be composed with (checked against the composition). */
  policyProfile: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}@[1-9][0-9]*$/),
  /** Real network calls (model, channel provider, live domain owners) require this explicit opt-in. */
  allowNetwork: z.boolean(),
  rollout: z.strictObject({
    /** Percentage of conversations (stable hash bucket) given autonomy. Explicit; the default posture is 0. */
    percent: z.number().min(0).max(100),
    allowlist: z.array(hexKey).max(1000),
    denylist: z.array(hexKey).max(1000),
  }),
  outbound: z.strictObject({
    maxAttempts: z.int().min(1).max(10),
    maxAgeMs: z.int().min(1000),
    leaseMs: z.int().min(1000),
    providerTimeoutMs: z.int().min(100).max(120_000),
    pollIntervalMs: z.int().min(10),
    holdRecheckMs: z.int().min(10),
  }),
});
export type ProductionConfig = z.infer<typeof productionConfigSchema>;

/** Secrets the production process needs, separated so they can never be serialized with the config. */
export interface ProductionSecrets {
  /** Keyed hash of channel identities (conversation keys); never persisted. */
  readonly identityHashKey: string;
}

const int = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined || value === '') return fallback;
  if (!/^-?\d+$/.test(value.trim())) throw new ProductionConfigError('invalid_production_config', `${name} must be an integer`);
  return Number(value.trim());
};

const list = (value: string | undefined): string[] => (value ? value.split(/[\s,]+/).map((v) => v.trim().toLowerCase()).filter(Boolean) : []);

/**
 * Reads and proves the production declaration. Fails closed unless:
 * the mode is `production`; a policy profile is named; the rollout is stated
 * explicitly (even when it is 0 %); the identity hashing key exists; and the
 * network opt-in is an explicit boolean.
 */
export function loadProductionConfig(env: Readonly<Record<string, string | undefined>>): { config: ProductionConfig; secrets: ProductionSecrets } {
  const mode = declaredExecutionMode(env);
  if (mode !== 'production') {
    throw new ProductionConfigError('production_mode_not_declared', `refusing to compose production: ${EXECUTION_MODE_ENV} must be "${PRODUCTION_EXECUTION_MODE}" (declared: ${mode})`);
  }
  const problems: string[] = [];
  if (!env.R4_PROD_POLICY_PROFILE) problems.push('R4_PROD_POLICY_PROFILE is required (the production policy profile id@version)');
  if (env.R4_PROD_ROLLOUT_PERCENT === undefined || env.R4_PROD_ROLLOUT_PERCENT === '') problems.push('R4_PROD_ROLLOUT_PERCENT is required and explicit (use 0 for allowlist-only canaries)');
  const identityHashKey = env.R4_PROD_IDENTITY_HASH_KEY ?? '';
  if (identityHashKey.length < 32) problems.push('R4_PROD_IDENTITY_HASH_KEY is required (at least 32 characters)');
  const network = env.R4_PROD_ALLOW_NETWORK;
  if (network !== 'true' && network !== 'false') problems.push('R4_PROD_ALLOW_NETWORK must be exactly "true" or "false"');
  if (problems.length > 0) throw new ProductionConfigError('production_config_incomplete', `refusing to compose production:\n- ${problems.join('\n- ')}`);
  const percent = Number(env.R4_PROD_ROLLOUT_PERCENT);
  const parsed = productionConfigSchema.safeParse({
    mode: PRODUCTION_EXECUTION_MODE,
    policyProfile: env.R4_PROD_POLICY_PROFILE,
    allowNetwork: network === 'true',
    rollout: { percent, allowlist: list(env.R4_PROD_ROLLOUT_ALLOWLIST), denylist: list(env.R4_PROD_ROLLOUT_DENYLIST) },
    outbound: {
      maxAttempts: int(env.R4_PROD_OUTBOUND_MAX_ATTEMPTS, 'R4_PROD_OUTBOUND_MAX_ATTEMPTS', 3),
      maxAgeMs: int(env.R4_PROD_OUTBOUND_MAX_AGE_MS, 'R4_PROD_OUTBOUND_MAX_AGE_MS', 10 * 60_000),
      leaseMs: int(env.R4_PROD_OUTBOUND_LEASE_MS, 'R4_PROD_OUTBOUND_LEASE_MS', 30_000),
      providerTimeoutMs: int(env.R4_PROD_PROVIDER_TIMEOUT_MS, 'R4_PROD_PROVIDER_TIMEOUT_MS', 10_000),
      pollIntervalMs: int(env.R4_PROD_DISPATCH_POLL_MS, 'R4_PROD_DISPATCH_POLL_MS', 1000),
      holdRecheckMs: int(env.R4_PROD_HOLD_RECHECK_MS, 'R4_PROD_HOLD_RECHECK_MS', 15_000),
    },
  });
  if (!parsed.success) throw new ProductionConfigError('invalid_production_config', `refusing to compose production:\n${z.prettifyError(parsed.error)}`);
  if (parsed.data.outbound.leaseMs <= parsed.data.outbound.providerTimeoutMs) {
    throw new ProductionConfigError('invalid_production_config', 'R4_PROD_OUTBOUND_LEASE_MS must exceed R4_PROD_PROVIDER_TIMEOUT_MS (a dispatch lease must outlive its provider call)');
  }
  return { config: parsed.data, secrets: { identityHashKey } };
}

/** Throws unless `config` is a parsed production declaration (the guard every production composition calls). */
export function assertProductionMode(config: unknown): ProductionConfig {
  const parsed = productionConfigSchema.safeParse(config);
  if (!parsed.success) throw new ProductionConfigError('production_mode_not_proven', 'refusing to compose production: no proven production configuration');
  return parsed.data;
}

/** Stable identity of the configuration (no secrets exist in it). */
export function productionConfigFingerprint(config: ProductionConfig): string {
  return fingerprint(config);
}
