import { CiaVerificationConfirmClient, loadCiaVerificationConfirmConfig } from '@r4-adapters/identity-http';
import { identityVerificationInspection } from '@r4-adapters/identity-verification';
import { profileLabel, type ProductionProfile } from '@r4/live-ops';

/**
 * R4-J4-R4: the ONLY Sales module that touches the identity-verification secret surface (AT-19): the code
 * keyring and the CIA confirm client with the channel-integration credential. Only the gateway composition
 * (composeSalesGateway, sales-production@8) calls it; the worker composition only names the variables to
 * refuse them (GATEWAY_ONLY_ENV).
 */

/** Credentials only the channel gateway may hold (SEC-S4: the confirm credential; SEC-S2: the code keyring). */
export const GATEWAY_ONLY_ENV = ['R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN', 'R4_PROD_VERIFICATION_CODE_KEYS'] as const;

/**
 * The v8 gateway inspection: requested in `full`, with the code keyring and the CIA confirm client, both of
 * which exist only in this process. Missing configuration refuses the composition. A keyring that does not
 * parse, or a confirm credential the CIA rejects at runtime, still yields an inspector in `protect_only`
 * (never none): the worker then refuses every start (verification_disabled).
 */
export function salesGatewayInspection(
  profile: ProductionProfile,
  env: Readonly<Record<string, string | undefined>>,
  transport: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
) {
  const codeKeys = env.R4_PROD_VERIFICATION_CODE_KEYS?.trim();
  if (!codeKeys) throw new Error(`refusing gateway composition: ${profileLabel(profile)} requires the inbound inspector in full but R4_PROD_VERIFICATION_CODE_KEYS is not set`);
  let config: ReturnType<typeof loadCiaVerificationConfirmConfig>;
  try {
    config = loadCiaVerificationConfirmConfig(env);
  } catch (error) {
    throw new Error(`refusing gateway composition: ${profileLabel(profile)} requires the CIA confirm client: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const confirm = new CiaVerificationConfirmClient({ config, fetch: (url, init) => transport(url, init).then((response) => ({ status: response.status, headers: response.headers, body: response.body })) });
  return identityVerificationInspection({ requested: 'full', codeKeys, confirm });
}
