import { CiaVerificationConfirmClient, loadCiaVerificationConfirmConfig } from '@r4-adapters/identity-http';
import { IdentityVerificationStore, Keyring, SecretBox, VerificationInspector, identityVerificationInspection } from '@r4-adapters/identity-verification';
import { PlatformError } from '@r4/contracts';
import { profileLabel, type ProductionProfile } from '@r4/live-ops';

/**
 * R4-J4-R4: the ONLY Sales module that touches the identity-verification secret surface (AT-19): the code
 * keyring and the CIA confirm client with the channel-integration credential. Only gateway-role processes
 * call it: the gateway composition (composeSalesGateway, sales-production@8) and, in the isolated canary,
 * its single gateway and its inspected synthetic ingest (R4-J4-R5 preparation). The worker composition only
 * names the variables to refuse them (GATEWAY_ONLY_ENV).
 */

/** Credentials only the channel gateway may hold (SEC-S4: the confirm credential; SEC-S2: the code keyring). */
export const GATEWAY_ONLY_ENV = ['R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN', 'R4_PROD_VERIFICATION_CODE_KEYS'] as const;

/**
 * The v8 gateway inspection: requested in `full`, with the code keyring and the CIA confirm client, both of
 * which exist only in this process. Missing configuration refuses the composition. A keyring that does not
 * parse, or a confirm credential the CIA rejects at runtime, still yields an inspector in `protect_only`
 * (never none): the worker then refuses every start (verification_disabled). `requested: 'protect_only'` is
 * the first step of a rollback (plan §5): no keyring, no confirm client.
 */
export function salesGatewayInspection(
  profile: ProductionProfile,
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly transport?: ((url: string, init: RequestInit) => Promise<Response>) | undefined; readonly allowedHosts?: readonly string[] | undefined; readonly requested?: 'full' | 'protect_only' } = {},
) {
  if (options.requested === 'protect_only') return identityVerificationInspection({ requested: 'protect_only', codeKeys: null, confirm: null });
  const codeKeys = env.R4_PROD_VERIFICATION_CODE_KEYS?.trim();
  if (!codeKeys) throw new Error(`refusing gateway composition: ${profileLabel(profile)} requires the inbound inspector in full but R4_PROD_VERIFICATION_CODE_KEYS is not set`);
  let config: ReturnType<typeof loadCiaVerificationConfirmConfig>;
  try {
    config = loadCiaVerificationConfirmConfig(env, { allowedHosts: options.allowedHosts ?? [] });
  } catch (error) {
    throw new Error(`refusing gateway composition: ${profileLabel(profile)} requires the CIA confirm client: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const transport = options.transport ?? ((url: string, init: RequestInit) => fetch(url, init));
  const confirm = new CiaVerificationConfirmClient({ config, fetch: (url, init) => transport(url, init).then((response) => ({ status: response.status, headers: response.headers, body: response.body })) });
  return identityVerificationInspection({ requested: 'full', codeKeys, confirm });
}

/**
 * (R4-J4-R5 preparation) The inspector of the isolated canary's synthetic ingest (`sales:canary send`): a
 * gateway-role process that FOLLOWS the durable component mode written by the canary's single gateway and never
 * writes it (so a `protect_only` set by the breaker or by a rollback is never undone here). No mode recorded (no
 * gateway ever composed the component) refuses the ingest: an inspected profile never ingests without protection.
 */
export async function canaryIngressInspector(pool: ConstructorParameters<typeof IdentityVerificationStore>[0], env: Readonly<Record<string, string | undefined>>, log: (event: string, fields: Record<string, unknown>) => void): Promise<VerificationInspector> {
  const store = new IdentityVerificationStore(pool);
  const mode = await store.mode();
  if (mode === null) throw new PlatformError('precondition', 'canary_gateway_never_composed', 'no canary gateway has composed the inbound inspector on this database: start "sales:canary gateway" first');
  let box: SecretBox | null = null;
  if (mode === 'full') {
    const codeKeys = env.R4_PROD_VERIFICATION_CODE_KEYS?.trim();
    if (!codeKeys) throw new PlatformError('precondition', 'canary_ingress_keyring_missing', 'the component is in full: the synthetic ingest needs the gateway keyring (R4_PROD_VERIFICATION_CODE_KEYS) to seal captured codes');
    box = new SecretBox(Keyring.parse(codeKeys));
  }
  return new VerificationInspector({ store, mode, box, onEvent: (event) => log(event.event, { ...event }) });
}
