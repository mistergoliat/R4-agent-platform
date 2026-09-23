import { z } from 'zod';
import { fingerprint } from './versioning.js';

/**
 * Identity of a model configuration as far as behavior is concerned. Two
 * configurations of the same model name are different profiles when anything
 * that can change behavior differs (output ceiling, temperature, response
 * format, provider extras such as a reasoning mode). Never carries a secret:
 * credentials are not behavior, and the schema is strict so they cannot ride
 * along.
 *
 * Quality sees only this metadata, the trajectory and usage — never a vendor
 * client — so any provider reachable through the ModelProvider SPI (a hosted
 * API or a locally served open model) is comparable over the same corpus.
 */
export const modelProfileSchema = z.strictObject({
  /** `under_test`: the model whose trajectory is evaluated. `evaluator`: a judge. */
  role: z.enum(['under_test', 'evaluator']),
  /** Adapter kind that served the model (as the deployment names it), or `scripted` / `fixture` offline. */
  provider: z.string().min(1).max(64),
  /** Logical profile name of the deployment configuration. */
  profile: z.string().min(1).max(64).nullable(),
  host: z.string().min(1).max(256).nullable(),
  model: z.string().min(1).max(200),
  maxOutputTokens: z.int().positive().nullable(),
  contextWindowTokens: z.int().positive().nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  responseFormat: z.string().min(1).max(64).nullable(),
  /** Provider request extras that change behavior (e.g. a reasoning mode). */
  extras: z.record(z.string(), z.json()),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

const FORBIDDEN_EXTRA_KEYS = /^(authorization|api[_-]?key|x-api-key|headers?|password|secret|token|bearer)$/i;

/**
 * Fingerprint over the behavior-relevant fields only: role, host and profile
 * name do not change what the model does, so they are excluded; everything
 * else is included. Stable across processes (canonical JSON).
 */
export function modelProfileFingerprint(profile: ModelProfile): string {
  const { role: _role, host: _host, profile: _name, ...behavior } = profile;
  return fingerprint(behavior);
}

export function parseModelProfile(value: unknown): ModelProfile {
  const profile = modelProfileSchema.parse(value);
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_EXTRA_KEYS.test(k)) throw new Error(`model profile extras must not carry credentials (${path}.${k})`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(profile.extras, 'extras');
  return profile;
}

/** A profile plus its fingerprint, as recorded in manifests. */
export function describeModelProfile(profile: ModelProfile): ModelProfile & { readonly fingerprint: string } {
  return { ...parseModelProfile(profile), fingerprint: modelProfileFingerprint(profile) };
}
