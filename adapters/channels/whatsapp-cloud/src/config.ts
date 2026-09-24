/**
 * WhatsApp Cloud API adapter configuration (R4-I canary number). Secrets are
 * read here, validated, and never serialized: `describe` returns only
 * presence flags and non-secret identifiers.
 *
 * Documented contracts followed (verified 2026-09-24):
 * - Webhook verification (hub.mode / hub.verify_token / hub.challenge) and
 *   `X-Hub-Signature-256` (HMAC-SHA256 of the raw payload with the App
 *   Secret, "sha256=" prefix): https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 * - Notifications payload (entry[].changes[].value.{metadata,contacts,messages,statuses}),
 *   re-delivery on non-200 (duplicates possible): https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
 *   and https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 * - Send: POST https://graph.facebook.com/{version}/{phone-number-id}/messages,
 *   Bearer token, response messages[].id; no idempotency key is documented:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */
export const WHATSAPP_CLOUD_CONTRACT_REF =
  'meta:whatsapp-cloud-api (developers.facebook.com/docs/whatsapp/cloud-api: set-up-webhooks, webhooks/components, reference/messages; graph-api/webhooks/getting-started) — semantics audited from CRM-Customer-360 native webhook';

export const WHATSAPP_CHANNEL_ID = 'whatsapp';
/** Customer-service window for free-form text after the customer's last message (Meta policy). */
export const WHATSAPP_CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GRAPH_VERSION = 'v25.0';
export const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';

export interface WhatsAppCloudConfig {
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly accessToken: string;
  /** The canary business number this R4 deployment owns end to end. */
  readonly phoneNumberId: string;
  readonly graphVersion: string;
  readonly graphBaseUrl: string;
}

export class WhatsAppConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WhatsAppConfigError';
    this.code = code;
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1';
}

/**
 * Fails closed: every secret is required (no "accept unsigned in
 * development" fallback), and a non-loopback provider URL requires the
 * explicit production network opt-in — CI and local tests can only ever
 * reach a local fake provider.
 */
export function loadWhatsAppCloudConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): WhatsAppCloudConfig {
  const missing = ['R4_WHATSAPP_APP_SECRET', 'R4_WHATSAPP_VERIFY_TOKEN', 'R4_WHATSAPP_ACCESS_TOKEN', 'R4_WHATSAPP_PHONE_NUMBER_ID'].filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new WhatsAppConfigError('whatsapp_config_incomplete', `refusing to compose the WhatsApp channel: missing ${missing.join(', ')}`);
  const phoneNumberId = env.R4_WHATSAPP_PHONE_NUMBER_ID!.trim();
  if (!/^\d{5,32}$/.test(phoneNumberId)) throw new WhatsAppConfigError('invalid_whatsapp_config', 'R4_WHATSAPP_PHONE_NUMBER_ID must be the numeric phone number id');
  const graphVersion = env.R4_WHATSAPP_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  if (!/^v\d{1,3}\.\d{1,3}$/.test(graphVersion)) throw new WhatsAppConfigError('invalid_whatsapp_config', 'R4_WHATSAPP_GRAPH_VERSION must look like v25.0');
  const rawBase = env.R4_WHATSAPP_GRAPH_BASE_URL?.trim() || DEFAULT_GRAPH_BASE_URL;
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new WhatsAppConfigError('invalid_whatsapp_config', 'R4_WHATSAPP_GRAPH_BASE_URL is not a URL');
  }
  if (!isLoopback(base) && !options.allowNetwork) throw new WhatsAppConfigError('network_not_allowed', 'refusing a non-local provider URL without R4_PROD_ALLOW_NETWORK=true');
  if (!isLoopback(base) && base.protocol !== 'https:') throw new WhatsAppConfigError('invalid_whatsapp_config', 'a non-local provider URL must use https');
  return {
    appSecret: env.R4_WHATSAPP_APP_SECRET!.trim(),
    verifyToken: env.R4_WHATSAPP_VERIFY_TOKEN!.trim(),
    accessToken: env.R4_WHATSAPP_ACCESS_TOKEN!.trim(),
    phoneNumberId,
    graphVersion,
    graphBaseUrl: base.toString().replace(/\/+$/, ''),
  };
}

/** Safe description (no secrets): for plans, manifests and readiness. */
export function describeWhatsAppConfig(config: WhatsAppCloudConfig): Record<string, string | boolean> {
  return {
    channel: WHATSAPP_CHANNEL_ID,
    graphVersion: config.graphVersion,
    graphHost: new URL(config.graphBaseUrl).host,
    phoneNumberIdSuffix: config.phoneNumberId.slice(-4),
    appSecretConfigured: config.appSecret.length > 0,
    verifyTokenConfigured: config.verifyToken.length > 0,
    accessTokenConfigured: config.accessToken.length > 0,
  };
}
