import { z } from 'zod';
import { fingerprint } from '@r4/evaluation';

/**
 * Explicit shadow execution mode (R4-H). A shadow run is never the result of
 * a missing setting: the process must declare `R4_EXECUTION_MODE=shadow`
 * (or pass the same declaration explicitly to a shadow command), and every
 * composition that could reach an external owner checks it before it wires
 * anything. Missing or any other value fails closed.
 *
 * Only `shadow` exists. There is no `production` value here: production
 * delivery is a later phase and does not get a code path in R4-H.
 *
 * What may reach a network is a separate, explicit opt-in per kind:
 *   R4_SHADOW_ALLOW_LIVE_MODEL=true   a real model provider may be called
 *   R4_SHADOW_ALLOW_LIVE_READ=true    a documented live read-only domain binding may be used
 * Without them a shadow composition is offline (scripted model, fixture domains).
 */
export const SHADOW_EXECUTION_MODE = 'shadow';
export const EXECUTION_MODE_ENV = 'R4_EXECUTION_MODE';

/** How the domain side of a suite is bound: controlled (fixture/shadow) or with live read-only owners. */
export const SHADOW_SUITE_MODES = ['controlled-shadow', 'live-read-shadow'] as const;
export type ShadowSuiteMode = (typeof SHADOW_SUITE_MODES)[number];

export class ShadowModeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ShadowModeError';
    this.code = code;
  }
}

export const shadowExecutionConfigSchema = z.strictObject({
  mode: z.literal(SHADOW_EXECUTION_MODE),
  /** Where the declaration came from (observable, recorded in every ShadowRun). */
  declaredBy: z.enum(['environment', 'command']),
  allowLiveModel: z.boolean(),
  allowLiveRead: z.boolean(),
});
export type ShadowExecutionConfig = z.infer<typeof shadowExecutionConfigSchema>;

const flag = (value: string | undefined, name: string): boolean => {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ShadowModeError('invalid_shadow_flag', `${name} must be "true" or "false"`);
};

/**
 * Reads the shadow declaration. `commandMode` is the value a shadow command
 * passes on its own command line (e.g. `--execution-mode shadow`); when both
 * the environment and the command declare a mode they must agree.
 */
export function loadShadowExecutionConfig(env: Readonly<Record<string, string | undefined>>, commandMode?: string): ShadowExecutionConfig {
  const fromEnv = env[EXECUTION_MODE_ENV];
  const declared = commandMode ?? fromEnv;
  if (declared === undefined || declared === '') {
    throw new ShadowModeError('shadow_mode_not_declared', `refusing to compose: ${EXECUTION_MODE_ENV} is not set; a shadow run must be declared explicitly (${EXECUTION_MODE_ENV}=${SHADOW_EXECUTION_MODE})`);
  }
  if (commandMode !== undefined && fromEnv !== undefined && fromEnv !== '' && fromEnv !== commandMode) {
    throw new ShadowModeError('shadow_mode_conflict', `refusing to compose: the command declares "${commandMode}" but ${EXECUTION_MODE_ENV} is "${fromEnv}"`);
  }
  if (declared !== SHADOW_EXECUTION_MODE) {
    throw new ShadowModeError('unsupported_execution_mode', `refusing to compose: execution mode "${declared}" is not supported here; only "${SHADOW_EXECUTION_MODE}" exists in R4-H`);
  }
  return shadowExecutionConfigSchema.parse({
    mode: SHADOW_EXECUTION_MODE,
    declaredBy: commandMode !== undefined ? 'command' : 'environment',
    allowLiveModel: flag(env.R4_SHADOW_ALLOW_LIVE_MODEL, 'R4_SHADOW_ALLOW_LIVE_MODEL'),
    allowLiveRead: flag(env.R4_SHADOW_ALLOW_LIVE_READ, 'R4_SHADOW_ALLOW_LIVE_READ'),
  });
}

/** Throws unless `config` is a parsed shadow declaration (the guard every composition calls first). */
export function assertShadowMode(config: unknown): ShadowExecutionConfig {
  const parsed = shadowExecutionConfigSchema.safeParse(config);
  if (!parsed.success) throw new ShadowModeError('shadow_mode_not_proven', 'refusing to compose: no proven shadow execution configuration');
  return parsed.data;
}

export function shadowConfigFingerprint(config: ShadowExecutionConfig): string {
  return fingerprint(config);
}
