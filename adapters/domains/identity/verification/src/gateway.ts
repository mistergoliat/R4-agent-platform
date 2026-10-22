import type { ProductionStore } from '@r4/live-ops';
import type { Pool } from '@r4/persistence-postgres';
import { VerificationConfirmDispatcher, type ConfirmPort, type ResumePort } from './dispatcher.js';
import { VerificationInspector } from './inspector.js';
import { identityVerificationSchemaIsCurrent } from './migrate.js';
import { Keyring, SecretBox } from './secret-box.js';
import { IdentityVerificationError, IdentityVerificationStore, type VerificationMode } from './state-store.js';

/**
 * SEC-S3/S4 — the identity-verification inspection as a channel gateway plugs it in (ADR-040; decision
 * rev. 02 §9.2; plan §4). Synthetic composition only: no production profile or process composes it.
 *
 *   protect_only  redaction only (no keyring, no CIA); entering it cancels every open response and erases its code;
 *   full          redaction, sealed capture and the deferred confirm dispatcher; without a valid keyring or
 *                 without the CIA confirm client it starts in protect_only, never without an inspector.
 * The effective mode is recorded durably (the start capability, in the worker, reads it). Three consecutive
 * credential rejections open the dispatcher's breaker: the component switches to protect_only (redaction
 * continues) until an operator recomposes it. Removing the inspector (`absent`) is a composition without this
 * factory, which the gateway refuses while any protection window is open. The keyring and the confirm client
 * are handed over by the gateway's composition; this package never reads the environment.
 */
export interface IdentityVerificationInspectionOptions {
  readonly requested: VerificationMode;
  /** `id:base64(32 bytes)[,…]` — the gateway's keyring; the first seals, all open. */
  readonly codeKeys: string | null;
  /** SEC-S4: the CIA confirm client with the channel-integration credential (null: not configured). */
  readonly confirm?: ConfirmPort | null;
  /** Dispatcher tuning (tests); the defaults are plan §4.1. */
  readonly dispatcher?: { readonly pollMs?: number; readonly leaseMs?: number; readonly sweepMs?: number; readonly concurrency?: number };
}

export interface IdentityVerificationInspection {
  readonly inspector: VerificationInspector;
  readonly mode: VerificationMode;
  readonly degradedReason: string | null;
  /** Present only in `full`. */
  readonly dispatcher: VerificationConfirmDispatcher | null;
  start(): void;
  stop(): Promise<void>;
}

/** Structurally the gateway's inspection factory (the package never imports an app). */
export function identityVerificationInspection(options: IdentityVerificationInspectionOptions) {
  return async (resources: {
    readonly pool: Pool;
    readonly store: Pick<ProductionStore, 'bindingByTask' | 'taskState'>;
    readonly temporal: ResumePort;
    readonly gatewayId: string;
    readonly log: (event: string, fields: Record<string, unknown>) => void;
  }): Promise<IdentityVerificationInspection> => {
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
      if (mode === 'full' && !options.confirm) {
        mode = 'protect_only';
        box = null;
        degradedReason = 'confirm_credential_unavailable';
      }
    }
    const { responsesCancelled } = await store.setMode(mode, resources.gatewayId, degradedReason ?? `composed_${mode}`);
    resources.log('identity_verification.composed', { requested: options.requested, mode, degradedReason, responsesCancelled });
    let dispatcher: VerificationConfirmDispatcher | null = null;
    const inspector = new VerificationInspector({
      store,
      mode,
      box,
      onEvent: (event) => resources.log(event.event, { ...event }),
      onCaptured: () => dispatcher?.notify(),
    });
    if (mode === 'full' && box && options.confirm) {
      dispatcher = new VerificationConfirmDispatcher({
        store, box, confirm: options.confirm, bindings: resources.store, resume: resources.temporal, owner: resources.gatewayId, ...options.dispatcher,
        onEvent: (event) => resources.log(event.event, { ...event }),
        onBreakerOpen: async () => {
          // Emergency (plan §5): stop confirming at once; redaction continues; an operator recomposes.
          inspector.enterProtectOnly();
          await store.setMode('protect_only', resources.gatewayId, 'confirm_credential_rejected').catch(() => undefined);
          resources.log('identity_verification.protect_only_by_breaker', {});
        },
      });
    }
    return { inspector, mode, degradedReason, dispatcher, start: () => dispatcher?.start(), stop: () => dispatcher?.stop() ?? Promise.resolve() };
  };
}
