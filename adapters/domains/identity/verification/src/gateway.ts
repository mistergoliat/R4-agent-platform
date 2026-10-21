import type { Pool } from '@r4/persistence-postgres';
import { VerificationInspector } from './inspector.js';
import { identityVerificationSchemaIsCurrent } from './migrate.js';
import { Keyring, SecretBox } from './secret-box.js';
import { IdentityVerificationError, IdentityVerificationStore, type VerificationMode } from './state-store.js';

/**
 * SEC-S3 — the identity-verification inspection as a channel gateway plugs it in (ADR-040; decision rev.
 * 02 §9.2). Synthetic composition only: no production profile or process composes it.
 *
 *   protect_only  redaction only (no keyring); entering it cancels every open response and erases its code;
 *   full          redaction and sealed capture; without a valid keyring it starts in protect_only, never
 *                 without an inspector.
 * The effective mode is recorded durably (the start capability, in the worker, reads it). Removing the
 * inspector (`absent`) is a composition without this factory, which the gateway refuses while any
 * protection window is open. The keyring is passed by the gateway's composition and never read here.
 */
export interface IdentityVerificationInspectionOptions {
  readonly requested: VerificationMode;
  /** `id:base64(32 bytes)[,…]` — the gateway's keyring; the first seals, all open. */
  readonly codeKeys: string | null;
}

export interface IdentityVerificationInspection {
  readonly inspector: VerificationInspector;
  readonly mode: VerificationMode;
  readonly degradedReason: string | null;
  start(): void;
  stop(): Promise<void>;
}

/** Structurally the gateway's inspection factory (the package never imports an app). */
export function identityVerificationInspection(options: IdentityVerificationInspectionOptions) {
  return async (resources: { readonly pool: Pool; readonly gatewayId: string; readonly log: (event: string, fields: Record<string, unknown>) => void }): Promise<IdentityVerificationInspection> => {
    if (!(await identityVerificationSchemaIsCurrent(resources.pool))) throw new IdentityVerificationError('schema_not_current');
    // OA-07 defaults (grace 10 min, unissued 600 s, retention 24 h): S3-DEP-03.
    const store = new IdentityVerificationStore(resources.pool);
    let mode: VerificationMode = options.requested;
    let box: SecretBox | null = null;
    let degradedReason: string | null = null;
    if (options.requested === 'full') {
      try {
        box = new SecretBox(Keyring.parse(options.codeKeys ?? ''));
      } catch {
        mode = 'protect_only';
        degradedReason = 'code_keys_unavailable';
      }
    }
    const { responsesCancelled } = await store.setMode(mode, resources.gatewayId, degradedReason ?? `composed_${mode}`);
    resources.log('identity_verification.composed', { requested: options.requested, mode, degradedReason, responsesCancelled });
    const inspector = new VerificationInspector({ store, mode, box, onEvent: (event) => resources.log(event.event, { ...event }) });
    return { inspector, mode, degradedReason, start() {}, stop: () => Promise.resolve() };
  };
}
